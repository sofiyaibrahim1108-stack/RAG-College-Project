import { RAG_CONFIG } from "../config/rag.js";
import { normalizeUserQuery } from "./queryNormalizer.js";
import { generateTextEmbedding } from "./embeddingService.js";
import { retrieveWithScopeFallback } from "./textRetrieval.js";
import { buildRAGContext } from "./contextBuilder.js";
import { isFallbackAnswer } from "./llm.js";
import { formatSources } from "../utils/citations.js";

/**
 * Rewrite-on-failure retry (runs only AFTER the first attempt on the original question failed).
 *
 * - Without previous user turns: retry only when strong evidence exists (the answer was a fallback
 *   although the evidence is good), re-using the same context with a standalone rewrite.
 * - With previous user turns: the failure may be an unresolved reference, so the question is rewritten
 *   using the history and retrieval is re-run for the rewritten question.
 * - A rewrite identical to the original question is skipped.
 *
 * @param {Object} p
 * @param {(question: string, contextPrompt: string, evidenceMeta: Object) => Promise<string>} p.generate
 * @returns {Promise<null | { answer, rewrittenQ, chunks, sources, contextPrompt }>}
 */
export async function rewriteRetry({
  originalQuestion,
  history = [],
  chunks = [],
  contextPrompt = "",
  topSimilarity = 0,
  gateSupported = false,
  generate
}) {
  const hasPreviousUserTurns = Array.isArray(history) && history.some((m) => m.role === "user");
  const strongEvidence = topSimilarity >= RAG_CONFIG.strongEvidenceThreshold;
  if (!hasPreviousUserTurns && !(gateSupported && strongEvidence)) return null;

  const rewrittenQ = await normalizeUserQuery(originalQuestion, history, true);
  if (!rewrittenQ || rewrittenQ.trim().toLowerCase() === originalQuestion.trim().toLowerCase()) {
    console.log("[Rewrite Retry] Rewrite identical to original question. Skipped.");
    return null;
  }

  let useChunks = chunks;
  let useContext = contextPrompt;
  if (hasPreviousUserTurns) {
    const emb = await generateTextEmbedding(rewrittenQ);
    const retrieval = await retrieveWithScopeFallback(emb, [], 5, rewrittenQ);
    useChunks = retrieval.chunks || [];
    useContext = buildRAGContext(useChunks, [], null, rewrittenQ).contextPrompt;
  }

  const meta = { topSimilarity: Math.max(0, ...useChunks.map((c) => c.similarity || 0)) };
  const answer = await generate(rewrittenQ, useContext, meta);
  if (isFallbackAnswer(answer)) return null;

  console.log(`[Rewrite Retry] Succeeded with rewritten question: "${rewrittenQ}"`);
  return { answer, rewrittenQ, chunks: useChunks, sources: formatSources(useChunks), contextPrompt: useContext };
}
