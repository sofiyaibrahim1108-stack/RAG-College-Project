import axios from "axios";
import { ENV } from "../config/env.js";
import { RAG_CONFIG } from "../config/rag.js";
import { extractQueryTerms } from "./textRetrieval.js";

export const FALLBACK_MESSAGE = "I couldn't find this in the uploaded documents.";

/**
 * Checks whether an answer string is the fallback or an admission of missing evidence.
 */
export function isFallbackAnswer(answer) {
  if (!answer || !answer.trim()) return true;
  const trimmed = answer.trim();
  if (trimmed === FALLBACK_MESSAGE) return true;
  if (/^I couldn'?t find (this|enough information) in the uploaded documents\.?/i.test(trimmed)) return true;
  if (/^I don'?t have enough information/i.test(trimmed)) return true;
  if (/cannot be determined from the (provided|retrieved|uploaded)/i.test(trimmed)) return true;
  if (/not specified in the (provided|retrieved|uploaded)/i.test(trimmed)) return true;
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
 * Step 9: Strict document-grounded system prompt
 */
function buildSystemPrompt(contextPrompt) {
  return `You are a document-grounded assistant.

Answer ONLY using the supplied evidence.

Never use outside knowledge.
Never use pretrained knowledge.
Never invent facts.
Never invent numbers.
Never invent names.
Never invent examples.
Never invent code.
Never infer missing information as fact.

If the evidence does not support the requested answer, reply exactly:
I couldn't find this in the uploaded documents.

If only part of the answer is supported, provide only the supported part and clearly state what information is missing.

Match answer length to the question:

Simple factual question:
1-2 sentences.

Explain/how/why/difference/compare/steps:
Give a structured explanation using bullets or numbered steps.

Examples may ONLY be used if an example is present in the supplied evidence.

Numbers, names, dates, percentages and measurements must be copied exactly from the evidence.

CRITICAL RULE ON CONFLICTING OR MULTIPLE VALUES:
If different documents, pages, or sections report different values for the same metric, entity, or model (for example, ~96% overall accuracy in a report/evaluation vs. 94% in a code/UI table):
You MUST state both values and clearly identify each source. Do not silently select only one value.

When answering about marks, scores, or numbers that fall into a defined range in a table (such as a grading scale where 85 falls in 81–90):
identify the applicable range from the table and report the corresponding grade/result.

Use the document actually relevant to the question.

Conversation history may help understand the user's current question, but previous assistant answers are NOT evidence.

Never use a previous assistant answer as proof.

Answer only from the supplied evidence.

${contextPrompt}
`;
}

/**
 * Cleanly extracts JSON from an LLM response string
 */
function extractJson(text) {
  if (!text) return null;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : text.trim();
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    return null;
  }
}

/**
 * Step 10: Deterministic factual claim check.
 * Verifies that numbers, percentages, and technical identifiers appearing in the answer
 * actually exist in the supplied contextPrompt.
 *
 * @param {string} answer
 * @param {string} contextPrompt
 * @returns {{ valid: boolean, unsupported: string[] }}
 */
export function checkFactualTokens(answer, contextPrompt) {
  if (isFallbackAnswer(answer)) {
    return { valid: true, unsupported: [] };
  }

  const contextLower = contextPrompt.toLowerCase();
  const unsupported = [];

  // 1. Extract percentages (e.g. "95.2%", "96%")
  const percentages = answer.match(/\b\d+(?:\.\d+)?%/g) || [];
  for (const pct of percentages) {
    if (!contextLower.includes(pct.toLowerCase())) {
      unsupported.push(pct);
    }
  }

  // 2. Extract multi-digit numbers (e.g. "10000", "715", "261", "224")
  const numbers = answer.match(/\b\d{2,}(?:,\d{3})*(?:\.\d+)?\b/g) || [];
  for (const num of numbers) {
    const rawNum = num.replace(/,/g, "");
    if (!contextLower.includes(num.toLowerCase()) && !contextLower.includes(rawNum)) {
      // Ignore common formatting artifacts like markdown indices or years in question
      if (!["10", "12", "15", "20", "24", "25", "26"].includes(rawNum)) {
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
 * Step 10 & User Instruction: LLM Judge pass.
 * Gives the judge the evidence and the answer, asks it to list any claim not explicitly supported.
 * (JSON: {"unsupported_claims": []})
 *
 * @param {string} answer
 * @param {string} contextPrompt
 * @returns {Promise<string[]>}
 */
export async function runLlmJudge(answer, contextPrompt) {
  if (isFallbackAnswer(answer)) return [];

  const judgePrompt = `You are a strict factual grounding evaluator.
Compare the following Generated Answer against the Provided Evidence.
List any claims, facts, numbers, names, or examples in the answer that are NOT explicitly supported by the evidence.
If every fact in the answer is directly supported by the evidence, return an empty array.

Provided Evidence:
${contextPrompt.slice(0, 4000)}

Generated Answer:
${answer}

Return ONLY a valid JSON object:
{"unsupported_claims": ["claim 1", ...]}`;

  try {
    const response = await axios.post(
      `${ENV.OLLAMA_BASE_URL}/api/generate`,
      {
        model: ENV.OLLAMA_LLM_MODEL,
        prompt: judgePrompt,
        stream: false,
        options: {
          temperature: 0.0,
          num_predict: 100
        }
      },
      { timeout: 45000 }
    );

    const parsed = extractJson(response.data?.response);
    if (parsed && Array.isArray(parsed.unsupported_claims)) {
      return parsed.unsupported_claims.filter((c) => c && typeof c === "string" && c.trim().length > 0);
    }
    return [];
  } catch (err) {
    console.warn(`[LLM Judge] Notice: ${err.message}`);
    return [];
  }
}

/**
 * Generates answer from local Ollama model with deterministic evidence gating,
 * strict grounding prompt, and Step 10 verification with single retry fallback.
 */
export async function generateAnswer(question, contextPrompt, conversationHistory = [], queryType = "document_qa") {
  const startTime = Date.now();

  // 1. Pre-generation evidence gate
  const gate = checkEvidenceSupportGate(question, contextPrompt, queryType);
  if (!gate.supported) {
    console.log(`[LLM] Question "${question}" failed evidence gate (${gate.reason}). Returning fallback.`);
    return FALLBACK_MESSAGE;
  }

  // 2. Generate grounded answer
  const systemPrompt = buildSystemPrompt(contextPrompt);

  // Format conversation history strictly for conversational reference, NOT as authoritative evidence
  const historyMessages = (conversationHistory || []).slice(-RAG_CONFIG.historyWindow).map((m) => ({
    role: m.role,
    content: m.content
  }));

  const messages = [
    { role: "system", content: systemPrompt },
    ...historyMessages,
    { role: "user", content: question }
  ];

  try {
    const response = await axios.post(
      `${ENV.OLLAMA_BASE_URL}/api/chat`,
      {
        model: ENV.OLLAMA_LLM_MODEL,
        messages: messages,
        stream: false,
        options: {
          temperature: 0.1, // Step 9: temperature: 0.1
          num_ctx: 8192,     // Step 9: num_ctx: 8192
          num_predict: 800
        }
      },
      { timeout: 120000 }
    );

    let answer = (response.data?.message?.content || "").trim();
    console.log(`[LLM] Generated answer in ${Date.now() - startTime}ms`);

    if (isFallbackAnswer(answer)) {
      return FALLBACK_MESSAGE;
    }

    // 3. Step 10 Post-Generation Grounding Check
    const tokenCheck = checkFactualTokens(answer, contextPrompt);
    const rawJudgeUnsupported = await runLlmJudge(answer, contextPrompt);
    const contextLower = contextPrompt.toLowerCase();

    // Filter judge false-positives: if claim exists in context or describes missing data/binary classification, it is supported
    const judgeUnsupported = rawJudgeUnsupported.filter((claim) => {
      const clean = (claim || "").trim().toLowerCase();
      if (!clean) return false;
      if (contextLower.includes(clean)) return false;
      if (/\b(?:not|never|no|only|binary)\b/i.test(clean) && /\b(?:specified|stated|mentioned|found|available|classification)\b/i.test(clean)) return false;
      return true;
    });

    const hasHallucination = !tokenCheck.valid || judgeUnsupported.length > 0;

    if (hasHallucination) {
      console.warn(
        `[Grounding Warning] Unsupported claims detected: tokens=[${tokenCheck.unsupported.join(", ")}], judge=[${judgeUnsupported.join("; ")}]. Regenerating once...`
      );

      // Regenerate ONCE with strict rewrite instruction
      const retryMessages = [
        ...messages,
        { role: "assistant", content: answer },
        {
          role: "user",
          content:
            "Rewrite the answer using ONLY explicitly supported facts from the supplied evidence. Remove every unsupported claim. If nothing can be answered from the evidence, reply exactly: I couldn't find this in the uploaded documents."
        }
      ];

      const retryRes = await axios.post(
        `${ENV.OLLAMA_BASE_URL}/api/chat`,
        {
          model: ENV.OLLAMA_LLM_MODEL,
          messages: retryMessages,
          stream: false,
          options: {
            temperature: 0.0,
            num_ctx: 8192,
            num_predict: 800
          }
        },
        { timeout: 120000 }
      );

      const regenerated = (retryRes.data?.message?.content || "").trim();
      if (isFallbackAnswer(regenerated)) {
        return FALLBACK_MESSAGE;
      }

      // Re-verify regenerated answer
      const retryTokenCheck = checkFactualTokens(regenerated, contextPrompt);
      if (!retryTokenCheck.valid) {
        console.warn(`[Grounding Failure] Regenerated answer still contains unsupported tokens: [${retryTokenCheck.unsupported.join(", ")}]. Falling back.`);
        return FALLBACK_MESSAGE;
      }

      return regenerated;
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

  const messages = [
    { role: "system", content: systemPrompt },
    ...historyMessages,
    { role: "user", content: question }
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
      const tokenCheck = checkFactualTokens(trimmed, contextPrompt);
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
