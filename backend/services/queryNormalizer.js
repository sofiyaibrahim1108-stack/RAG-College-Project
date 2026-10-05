import axios from "axios";
import { ENV } from "../config/env.js";
import { RAG_CONFIG } from "../config/rag.js";

/**
 * General query normalization service.
 * Rewrites the user message into a clean, standalone question using LLM:
 * 1. Turns imperative commands ("show me X") into questions ("What does X show?").
 * 2. Resolves pronouns ("he", "she", "it", "his", "her", "they") and elliptical follow-ups using previous conversation turns.
 * 3. Falls back to original question on error or timeout.
 *
 * @param {string} question
 * @param {Array<Object>} conversationHistory
 * @returns {Promise<string>}
 */
export async function normalizeUserQuery(question, conversationHistory = [], forceRewrite = false) {
  if (!question || typeof question !== "string" || !question.trim()) {
    return question || "";
  }

  const trimmed = question.trim();
  const recentHistory = (conversationHistory || []).slice(-4);

  const historyText = recentHistory
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n");

  const promptContent = historyText
    ? `Conversation history:
${historyText}

User follow-up message: "${trimmed}"

Rewrite the user follow-up message into a complete, standalone question ending with a question mark. Resolve all pronouns (he, she, his, her, they, it) and ellipses using the conversation history.
CRITICAL: Do NOT answer the question or make assertions. Output ONLY the standalone question ending with a question mark.`
    : `User input: "${trimmed}"

If the input is an imperative command like "show me X", rewrite it as a question like "What is X?" or "What does X show?".
If it is already a complete, standalone question, return it UNCHANGED and verbatim.
CRITICAL: Do NOT answer the question or make assertions. Output ONLY the standalone question.`;

  const messages = [
    {
      role: "system",
      content: "You are a query reformulator. Your job is to output a standalone question ending with a question mark. You must NEVER answer questions or output assertions."
    },
    {
      role: "user",
      content: promptContent
    }
  ];

  const t0 = Date.now();
  try {
    const res = await axios.post(
      `${ENV.OLLAMA_BASE_URL}/api/chat`,
      {
        model: ENV.OLLAMA_LLM_MODEL,
        messages,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 80,
          num_ctx: 1024
        },
        keep_alive: "30m"
      },
      { timeout: RAG_CONFIG.queryRewriteTimeoutMs ?? 5000 }
    );

    const rewritten = (res.data?.message?.content || "").trim().replace(/^["']|["']$/g, "");
    if (rewritten && rewritten.length >= 3 && rewritten.length <= trimmed.length * 3 + 50) {
      console.log(`[QueryNormalization] Rewrote "${trimmed}" -> "${rewritten}" in ${Date.now() - t0}ms`);
      return rewritten;
    }
    return trimmed;
  } catch (err) {
    console.warn(`[QueryNormalization] Notice: ${err.message}. Using original query.`);
    return trimmed;
  }
}
