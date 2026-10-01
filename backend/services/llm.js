import axios from "axios";
import { ENV } from "../config/env.js";
import { RAG_CONFIG } from "../config/rag.js";

export const FALLBACK_MESSAGE =
  "I couldn't find enough information in the retrieved document evidence to answer that reliably.";

/**
 * Common English words that can be capitalized at the start of a sentence or phrase,
 * not representing specific domain entities.
 */
const COMMON_CAPITALIZED_WORDS = new Set([
  "the", "this", "that", "these", "those", "there", "their", "they", "then",
  "what", "when", "where", "which", "while", "whose", "why", "how",
  "with", "without", "within", "during", "after", "before", "between",
  "from", "into", "onto", "upon", "about", "above", "below", "under",
  "first", "second", "third", "finally", "additionally", "furthermore",
  "however", "although", "because", "since", "while", "whereas",
  "here", "hence", "thus", "therefore", "instead", "overall",
  "each", "every", "both", "either", "neither", "some", "any", "all",
  "most", "many", "much", "more", "less", "least", "several", "such",
  "only", "just", "also", "even", "still", "already", "soon",
  "user", "users", "page", "pages", "source", "sources", "figure", "figures",
  "table", "tables", "image", "images", "screenshot", "screenshots",
  "note", "please", "yes", "none", "true", "false",
  "model", "models", "system", "systems", "method", "methods", "data", "dataset",
  "document", "documents", "process", "training", "testing", "validation",
  "accuracy", "result", "results", "output", "input", "feature", "features",
  "class", "classes", "normal", "disease", "detection", "classification",
  "architecture", "layer", "layers", "stage", "stages"
]);

/**
 * Checks whether an answer string is the fallback or an admission of missing evidence.
 */
export function isFallbackAnswer(answer) {
  if (!answer || !answer.trim()) return true;
  const trimmed = answer.trim();
  if (trimmed === FALLBACK_MESSAGE) return true;
  if (trimmed.startsWith("I couldn't find enough information")) return true;
  if (trimmed.startsWith("I don't have enough information")) return true;
  if (/not specified in the (provided|retrieved)/i.test(trimmed)) return true;
  if (/cannot be determined from the (provided|retrieved)/i.test(trimmed)) return true;
  return false;
}

/**
 * Deterministic pre-generation evidence support gate.
 * Determines whether the currently retrieved evidence explicitly contains enough
 * information to answer this exact question, without calling an expensive or
 * hallucination-prone secondary LLM.
 *
 * @param {string} question
 * @param {string} contextPrompt
 * @returns {{ supported: boolean, reason: string }}
 */
export function checkEvidenceSupportGate(question = "", contextPrompt = "") {
  if (!contextPrompt || contextPrompt === "NO_DOCUMENTS_FOUND" || contextPrompt.trim().length === 0) {
    return { supported: false, reason: "NO_DOCUMENTS_FOUND" };
  }

  // 1. Explicit Page-Number Constraint (e.g. "page 58", "on page 99", "page 40")
  const pageMatch = question ? question.match(/\b(?:page|p\.?)\s*(\d+)\b/i) : null;
  if (pageMatch) {
    const targetPage = parseInt(pageMatch[1], 10);
    const hasPageEvidence =
      contextPrompt.includes(`(Page ${targetPage})`) ||
      contextPrompt.includes(`Page ${targetPage}`) ||
      new RegExp(`\\bPage\\s*${targetPage}\\b`, "i").test(contextPrompt);

    if (!hasPageEvidence) {
      console.log(`[Evidence Gate] Requested Page ${targetPage} not found in retrieved evidence -> UNSUPPORTED`);
      return { supported: false, reason: `TARGET_PAGE_${targetPage}_NOT_RETRIEVED` };
    }
    console.log(`[Evidence Gate] Exact page ${targetPage} match found in retrieved evidence -> SUPPORTED`);
    return { supported: true, reason: "EXACT_PAGE_MATCH" };
  }

  return { supported: true, reason: "EVIDENCE_PRESENT" };
}

/**
 * Final safety check after LLM generation:
 * If the LLM output asserts specific technical entities not present in the retrieved
 * context, catch the hallucination and replace with FALLBACK_MESSAGE.
 *
 * @param {string} answer
 * @param {string} contextPrompt
 * @returns {string}
 */
export function verifyGroundedAnswer(answer, contextPrompt) {
  if (isFallbackAnswer(answer)) {
    return FALLBACK_MESSAGE;
  }

  const tokens = answer
    .replace(/[^a-zA-Z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  const properNouns = tokens.filter(
    (w) => /^[A-Z][a-zA-Z0-9_\-]+$/.test(w) && !COMMON_CAPITALIZED_WORDS.has(w.toLowerCase())
  );

  const contextLower = contextPrompt.toLowerCase();

  for (const noun of properNouns) {
    if (noun.length >= 4 && !contextLower.includes(noun.toLowerCase())) {
      console.log(
        `[Grounding Safety Check] Hallucinated entity detected: "${noun}" not found in retrieved context -> Replaced with fallback`
      );
      return FALLBACK_MESSAGE;
    }
  }

  return answer;
}

/**
 * Builds the strict document-grounded system prompt per project specifications
 */
function buildSystemPrompt(contextPrompt) {
  return `You are a document-grounded question answering system.

Answer ONLY from the supplied retrieved evidence.

The fact that information may exist elsewhere in the original document does not authorize you to use it unless that information is present in the supplied evidence.

Never use pretrained knowledge, general knowledge, assumptions, inference, or likely/common answers.

If the supplied evidence does not explicitly support the answer, output exactly:
I couldn't find enough information in the retrieved document evidence to answer that reliably.

Do not invent details.

Do not infer missing facts.

Do not use information from pages that were not retrieved.

For visual questions, describe ONLY visual information explicitly present in RELEVANT VISUAL EVIDENCE. Never invent UI elements, buttons, icons, progress bars, user actions, labels, colors, layouts, or objects.

CONVERSATION HISTORY NOTICE:
Previous assistant messages are provided solely for conversational continuity; they are NOT authoritative document evidence. The current answer must be completely grounded in the currently provided DOCUMENT EXCERPTS and RELEVANT VISUAL EVIDENCE.

CODE FIDELITY:
- When explaining code, operations, or operators, use ONLY the exact code lines and examples explicitly present in the DOCUMENT EXCERPTS. Do NOT invent, generate, or add any other examples or code snippets.

ANSWERING STYLE (when the answer IS explicitly supported by the excerpts or visual evidence):
- Write naturally and conversationally, like a knowledgeable colleague explaining something clearly.
- Produce COMPLETE answers. Include ALL relevant details present in the retrieved evidence — do NOT summarize them away into a single sentence.
- Match the format and depth to the question type:
  * For factual questions: 2–4 sentences covering all key points found in the evidence. If the evidence has more detail, use it.
  * For UI/screenshot questions: Describe the visible components, labels, and purpose explicitly supported by the visual evidence.
  * For visual-only questions: Use the Visual Evidence block (Caption + Visual Description + Same-Page Context). Describe only what is explicitly written.
  * For diagram/flowchart/process questions: Use a numbered list or bullet points to trace the steps explicitly supported by the evidence.
  * For comparison questions: Cover each side with evidence-supported detail.
- Preserve code in fenced code blocks.
- Use selective **bold** for key terms, names, or values.
- Do NOT start with filler phrases like "Sure!", "Certainly!", or "Of course!".
- Do NOT repeat the user's question in the answer.
- Do NOT say "According to the document", "Based on the excerpts", or mention embeddings, retrieval, or internal RAG details.

${contextPrompt}
`;
}

/**
 * Generates answer from local Ollama model (non-streaming)
 */
export async function generateAnswer(question, contextPrompt, conversationHistory = []) {
  const startTime = Date.now();

  if (contextPrompt === "NO_DOCUMENTS_FOUND") {
    return FALLBACK_MESSAGE;
  }

  // 1. Pre-generation evidence gate
  const gate = checkEvidenceSupportGate(question, contextPrompt);
  if (!gate.supported) {
    console.log(`[LLM] Question "${question}" failed evidence gate (${gate.reason}). Returning fallback.`);
    return FALLBACK_MESSAGE;
  }

  // 2. Generate grounded answer
  const systemPrompt = buildSystemPrompt(contextPrompt);

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-RAG_CONFIG.historyWindow).map((m) => ({
      role: m.role,
      content: m.content
    })),
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
          temperature: RAG_CONFIG.llm.temperature,
          num_predict: RAG_CONFIG.llm.num_predict,
          top_p: RAG_CONFIG.llm.top_p
        }
      },
      { timeout: 120000 }
    );

    const answer = response.data?.message?.content || "";
    console.log(`[LLM] Generated answer in ${Date.now() - startTime}ms`);

    let cleanAnswer = answer.trim();

    // 3. Post-generation grounding safety check
    cleanAnswer = verifyGroundedAnswer(cleanAnswer, contextPrompt);

    return cleanAnswer;
  } catch (error) {
    console.error(`[LLM Error] Generation failed: ${error.message}`);
    throw new Error(`Ollama generation failed: ${error.message}`);
  }
}

/**
 * Streams answer from local Ollama model
 */
export async function streamAnswer(question, contextPrompt, conversationHistory = [], onToken) {
  if (contextPrompt === "NO_DOCUMENTS_FOUND") {
    if (onToken) onToken(FALLBACK_MESSAGE);
    return FALLBACK_MESSAGE;
  }

  // 1. Pre-generation evidence gate
  const gate = checkEvidenceSupportGate(question, contextPrompt);
  if (!gate.supported) {
    console.log(`[LLM Stream] Question "${question}" failed evidence gate (${gate.reason}). Returning fallback.`);
    if (onToken) onToken(FALLBACK_MESSAGE);
    return FALLBACK_MESSAGE;
  }

  // 2. Stream grounded answer
  const systemPrompt = buildSystemPrompt(contextPrompt);

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-RAG_CONFIG.historyWindow).map((m) => ({
      role: m.role,
      content: m.content
    })),
    { role: "user", content: question }
  ];

  const response = await axios.post(
    `${ENV.OLLAMA_BASE_URL}/api/chat`,
    {
      model: ENV.OLLAMA_LLM_MODEL,
      messages: messages,
      stream: true,
      options: {
        temperature: RAG_CONFIG.llm.temperature,
        num_predict: RAG_CONFIG.llm.num_predict,
        top_p: RAG_CONFIG.llm.top_p
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

    response.data.on("end", () => {
      const trimmed = fullAnswer.trim();
      const verified = verifyGroundedAnswer(trimmed, contextPrompt);
      resolve(verified);
    });

    response.data.on("error", (err) => {
      reject(err);
    });
  });
}
