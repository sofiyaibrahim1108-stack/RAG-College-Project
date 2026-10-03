import axios from "axios";
import { ENV } from "../config/env.js";
import { RAG_CONFIG } from "../config/rag.js";
import { extractQueryTerms } from "./textRetrieval.js";

export const FALLBACK_MESSAGE = "I couldn't find this information in the uploaded documents.";

/**
 * Checks whether an answer string is the fallback or an admission of missing evidence.
 */
export function isFallbackAnswer(answer) {
  if (!answer || !answer.trim()) return true;
  const trimmed = answer.trim();
  if (trimmed === FALLBACK_MESSAGE) return true;
  if (/^I couldn'?t find this (information )?in the uploaded documents\.?/i.test(trimmed) && trimmed.length < 120) return true;
  if (/^I couldn'?t find (this|enough information) in the uploaded documents\.?/i.test(trimmed) && trimmed.length < 120) return true;
  if (/^I don'?t have enough information/i.test(trimmed) && trimmed.length < 120) return true;
  if (/^(?:The requested information |This )?(?:cannot be determined|is not (?:specified|found|available)) (?:from|in) the (?:provided|retrieved|uploaded)/i.test(trimmed) && trimmed.length < 150) return true;
  return false;
}

/**
 * Step 4: Pre-Generation Relevance Gate.
 * Determines whether the retrieved context actually contains sufficient evidence
 * to answer the question. If no usable evidence exists, rejects immediately
 * so the final generation model is NEVER called.
 *
 * @param {string} question
 * @param {string} contextPrompt
 * @param {string} queryType
 * @returns {{ supported: boolean, reason: string }}
 */
export function checkEvidenceSupportGate(question = "", contextPrompt = "", queryType = "document_qa") {
  if (queryType === "out_of_scope") {
    return { supported: false, reason: "OUT_OF_SCOPE_QUERY" };
  }

  if (!contextPrompt || contextPrompt === "NO_DOCUMENTS_FOUND" || contextPrompt.trim().length === 0) {
    return { supported: false, reason: "NO_DOCUMENTS_FOUND" };
  }

  // If tabular calculation result is present, it is always supported
  if (contextPrompt.includes("=== TABULAR TOOL RESULT ===")) {
    return { supported: true, reason: "TABULAR_TOOL_RESULT_PRESENT" };
  }

  // 1. Explicit Page-Number Constraint (e.g. "page 58", "on page 99")
  const pageMatch = question ? question.match(/\b(?:page|p\.?)\s*(\d+)\b/i) : null;
  if (pageMatch) {
    const targetPage = parseInt(pageMatch[1], 10);
    const hasPage =
      contextPrompt.includes(`Page ${targetPage}`) ||
      new RegExp(`\\bPage\\s*${targetPage}\\b`, "i").test(contextPrompt);

    if (!hasPage) {
      console.log(`[Evidence Gate] Target Page ${targetPage} not retrieved -> UNSUPPORTED`);
      return { supported: false, reason: `TARGET_PAGE_${targetPage}_MISSING` };
    }
  }

  // 2. Lexical keyword overlap check
  const terms = extractQueryTerms(question);
  if (terms.length > 0) {
    const contextLower = contextPrompt.toLowerCase();
    const matchedTerms = terms.filter((t) => contextLower.includes(t));
    const coverage = matchedTerms.length / terms.length;

    // If zero key terms from the question exist in the retrieved evidence, reject
    if (matchedTerms.length === 0) {
      console.log(`[Evidence Gate] Zero query terms found in context -> UNSUPPORTED`);
      return { supported: false, reason: "ZERO_TERM_OVERLAP" };
    }

    // For multi-token queries (>2 terms), require at least 25% term overlap
    if (terms.length >= 3 && coverage < 0.25) {
      console.log(`[Evidence Gate] Term coverage too low (${(coverage * 100).toFixed(0)}%) -> UNSUPPORTED`);
      return { supported: false, reason: "INSUFFICIENT_TERM_OVERLAP" };
    }
  }

  return { supported: true, reason: "EVIDENCE_PRESENT" };
}

/**
 * Strict document-grounded system prompt per Section 12
 */
function buildSystemPrompt(contextPrompt) {
  return `You are a document-grounded assistant.

Answer using ONLY the retrieved evidence supplied in CONTEXT.

Never use outside knowledge to fill missing information.

Never invent:
- numbers
- names
- dates
- percentages
- examples
- code
- statistics
- technical specifications
- conclusions

If the context contains the answer, answer clearly and naturally.

If the context contains only part of the answer, or if the question contains multiple parts/topics, answer each supported part and clearly state what specific information is not found in the documents.

If the context does not support the answer at all, reply exactly:

'I couldn't find this information in the uploaded documents.'

Match the response length to the question:
- simple factual question: 1–2 sentences
- explain/how/why/difference/compare/steps/multi-topic: structured detailed answer

Preserve numbers, names, dates and technical values exactly as provided in the context.

If retrieved sources contain conflicting or different values (for example, report text stating approximately 96% validation accuracy while code or UI tables show 94%), you MUST explicitly report the conflict, state which page/source contains each value, and not silently choose one.

Use only the document relevant to the user's question.

Chat history may help understand the user's question, but chat history is NEVER a source of factual information.

Do not use previous assistant answers as evidence.

For examples and code, use only examples/code explicitly present in the retrieved context.

Do not create new examples from general knowledge.

At the end, provide the supporting source file name and page number(s) when available.

CONTEXT:
${contextPrompt}
`;
}

/**
 * Deterministic factual claim check.
 * Verifies that numbers and percentages appearing in the answer actually exist in contextPrompt or question.
 *
 * @param {string} answer
 * @param {string} contextPrompt
 * @param {string} question
 * @returns {{ valid: boolean, unsupported: string[] }}
 */
export function checkFactualTokens(answer, contextPrompt, question = "") {
  if (isFallbackAnswer(answer)) {
    return { valid: true, unsupported: [] };
  }

  const contextLower = (contextPrompt || "").toLowerCase();
  const questionLower = (question || "").toLowerCase();
  const combinedEvidence = `${contextLower} ${questionLower}`;
  const unsupported = [];

  // 1. Extract percentages (e.g. "95.2%", "96%")
  const percentages = answer.match(/\b\d+(?:\.\d+)?%/g) || [];
  for (const pct of percentages) {
    const rawVal = parseFloat(pct.replace("%", ""));
    const decimalStr = (rawVal / 100).toFixed(2);
    const decimalAlt = (rawVal / 100).toString();

    const isLiteralPresent = combinedEvidence.includes(pct.toLowerCase());
    const isDecimalPresent = combinedEvidence.includes(decimalStr) || combinedEvidence.includes(decimalAlt);

    if (!isLiteralPresent && !isDecimalPresent) {
      unsupported.push(pct);
    }
  }

  // 2. Extract multi-digit numbers (e.g. "10000", "715", "261", "224")
  // Strip code blocks and inline code so demonstrative variables (e.g. let x = 40) don't trigger false positives
  const proseOnly = answer.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]+`/g, " ");
  const numbers = proseOnly.match(/\b\d{2,}(?:,\d{3})*(?:\.\d+)?\b/g) || [];
  for (const num of numbers) {
    const rawNum = num.replace(/,/g, "");
    if (!combinedEvidence.includes(num.toLowerCase()) && !combinedEvidence.includes(rawNum)) {
      // Allow standard small integers, years, or list indices
      if (!["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "15", "20", "24", "25", "26", "30", "40", "50", "60", "70", "80", "90", "100"].includes(rawNum)) {
        unsupported.push(num);
      }
    }
  }

  return {
    valid: unsupported.length === 0,
    unsupported
  };
}

/**
 * Generates answer from local Ollama model with deterministic evidence gating.
 * EXACTLY ONE QWEN CALL PER QUESTION. NO LLM JUDGE. NO REGENERATION LOOP.
 */
export async function generateAnswer(question, contextPrompt, conversationHistory = [], queryType = "document_qa") {
  const startTime = Date.now();

  // 1. Pre-generation evidence gate (purely deterministic)
  const gate = checkEvidenceSupportGate(question, contextPrompt, queryType);
  if (!gate.supported) {
    console.log(`[Evidence Gate] Question "${question}" failed evidence gate (${gate.reason}). Returning fallback.`);
    return FALLBACK_MESSAGE;
  }

  // 2. Generate grounded answer (ONE Qwen call)
  const systemPrompt = buildSystemPrompt(contextPrompt);

  const historyMessages = (conversationHistory || []).slice(-RAG_CONFIG.historyWindow).map((m) => ({
    role: m.role,
    content: m.content
  }));

  let userContent = question;
  if (contextPrompt.includes("=== CONFLICTING EVIDENCE NOTICE ===")) {
    userContent += "\n\n(Important: The retrieved context contains conflicting accuracy values. You must report the conflict explicitly and state both figures with their source pages.)";
  }
  if (contextPrompt.includes("=== MULTI-TOPIC QUERY GUIDELINES ===")) {
    userContent += "\n\n(Important: Address each topic separately. If information for any specific item is not present in the documents, explicitly state that it was not found in the uploaded documents.)";
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...historyMessages,
    { role: "user", content: userContent }
  ];

  try {
    const response = await axios.post(
      `${ENV.OLLAMA_BASE_URL}/api/chat`,
      {
        model: ENV.OLLAMA_LLM_MODEL,
        messages: messages,
        stream: false,
        options: {
          temperature: 0.1,
          num_ctx: 8192,
          num_predict: 800
        }
      },
      { timeout: 120000 }
    );

    let answer = (response.data?.message?.content || "").trim();
    console.log(`[LLM Generation] Answer generated in ${Date.now() - startTime}ms`);

    if (isFallbackAnswer(answer)) {
      return FALLBACK_MESSAGE;
    }

    // 3. Fast deterministic factual token check (NO second LLM call)
    const tokenCheck = checkFactualTokens(answer, contextPrompt, question);
    if (!tokenCheck.valid && tokenCheck.unsupported.length > 0) {
      console.warn(
        `[Grounding Warning] Unsupported tokens detected: [${tokenCheck.unsupported.join(", ")}]. Returning fallback.`
      );
      return FALLBACK_MESSAGE;
    }

    return answer;
  } catch (error) {
    console.error(`[LLM Error] Generation failed: ${error.message}`);
    throw new Error(`Ollama generation failed: ${error.message}`);
  }
}

/**
 * Streams grounded answer from local Ollama model
 */
export async function streamAnswer(question, contextPrompt, conversationHistory = [], onToken, queryType = "document_qa") {
  // 1. Pre-generation evidence gate
  const gate = checkEvidenceSupportGate(question, contextPrompt, queryType);
  if (!gate.supported) {
    console.log(`[LLM Stream] Question "${question}" failed evidence gate (${gate.reason}). Returning fallback.`);
    if (onToken) onToken(FALLBACK_MESSAGE);
    return FALLBACK_MESSAGE;
  }

  // 2. Stream grounded answer
  const systemPrompt = buildSystemPrompt(contextPrompt);

  const historyMessages = (conversationHistory || []).slice(-RAG_CONFIG.historyWindow).map((m) => ({
    role: m.role,
    content: m.content
  }));

  let userStreamContent = question;
  if (contextPrompt.includes("=== CONFLICTING EVIDENCE NOTICE ===")) {
    userStreamContent += "\n\n(Important: The retrieved context contains conflicting accuracy values. You must report the conflict explicitly and state both figures with their source pages.)";
  }
  if (contextPrompt.includes("=== MULTI-TOPIC QUERY GUIDELINES ===")) {
    userStreamContent += "\n\n(Important: Address each topic separately. If information for any specific item is not present in the documents, explicitly state that it was not found in the uploaded documents.)";
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...historyMessages,
    { role: "user", content: userStreamContent }
  ];

  const response = await axios.post(
    `${ENV.OLLAMA_BASE_URL}/api/chat`,
    {
      model: ENV.OLLAMA_LLM_MODEL,
      messages: messages,
      stream: true,
      options: {
        temperature: 0.1,
        num_ctx: 8192,
        num_predict: 800
      }
    },
    {
      responseType: "stream",
      timeout: 180000
    }
  );

  let fullAnswer = "";

  return new Promise((resolve, reject) => {
    response.data.on("data", (chunk) => {
      const lines = chunk.toString().split("\n").filter((l) => l.trim() !== "");
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const token = parsed.message?.content || "";
          if (token) {
            fullAnswer += token;
            if (onToken) onToken(token);
          }
        } catch (e) {
          // ignore parsing edge chunks
        }
      }
    });

    response.data.on("end", async () => {
      const trimmed = fullAnswer.trim();
      if (isFallbackAnswer(trimmed)) {
        resolve(FALLBACK_MESSAGE);
        return;
      }

      // Grounding validation
      const tokenCheck = checkFactualTokens(trimmed, contextPrompt, question);
      if (!tokenCheck.valid) {
        console.warn(`[Stream Grounding] Unsupported numbers/tokens found: ${tokenCheck.unsupported.join(", ")}`);
        resolve(FALLBACK_MESSAGE);
        return;
      }

      resolve(trimmed);
    });

    response.data.on("error", (err) => {
      reject(err);
    });
  });
}
