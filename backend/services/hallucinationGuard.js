import { RAG_CONFIG } from "../config/rag.js";
import { generateTextEmbedding } from "./embeddingService.js";
import { cosineSimilarity } from "../utils/similarity.js";
import { FALLBACK_MESSAGE, isFallbackAnswer } from "./llm.js";
import { formatSources } from "../utils/citations.js";

/**
 * Splits an answer string into clean sentences, skipping fenced code blocks,
 * inline code snippets, and markdown headings.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitAnswerIntoSentences(text) {
  if (!text || typeof text !== "string") return [];

  // 1. Remove fenced code blocks (```...```)
  let cleaned = text.replace(/```[\s\S]*?```/g, " ");

  // 2. Remove inline code snippets (`...`)
  cleaned = cleaned.replace(/`[^`]+`/g, " ");

  // 3. Process lines: omit headings and horizontal rules, clean bullet markers
  const lines = cleaned.split(/\r?\n/);
  const contentLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip markdown headings (# Heading, ## Heading, etc.)
    if (/^#{1,6}\s+/.test(trimmed)) continue;
    // Skip markdown horizontal rules (---, ***, ___)
    if (/^[-*_]{3,}$/.test(trimmed)) continue;
    // Strip bullet or numbered list prefixes (*, -, +, 1., etc.)
    const cleanLine = trimmed.replace(/^([-*+]|\d+\.)\s+/, "").trim();
    if (cleanLine) {
      contentLines.push(cleanLine);
    }
  }

  const paragraph = contentLines.join(" ");
  if (!paragraph) return [];

  // 4. Split by sentence-ending punctuation followed by whitespace
  const rawSentences = paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"']|$)/)
    .map((s) => s.trim())
    .filter((s) => {
      const words = s.split(/\s+/).filter(Boolean);
      return s.length >= 10 && words.length >= 3;
    });

  return rawSentences;
}

/**
 * Shared Hallucination Guard:
 * Verifies that a generated answer is supported by the final context chunks.
 *
 * 1. Splits the answer into sentences (skipping code blocks and headings).
 * 2. Embeds each sentence and computes its max cosine similarity against the context chunks.
 * 3. supportedRatio = fraction of sentences with similarity >= answerSupportMinSim (default 0.55).
 * 4. If supportedRatio < answerSupportMinRatio (default 0.5), rejects the answer and returns
 *    standard fallback with no sources and no images.
 * 5. Otherwise keeps the answer. Sources are ONLY the chunks that were the best match
 *    for at least one kept sentence.
 * 6. Logs one line per answer: supportedRatio, number of sentences, accepted or rejected.
 *
 * @param {Object} params
 * @param {string} params.answer
 * @param {Array<Object>} params.contextChunks
 * @returns {Promise<{
 *   accepted: boolean,
 *   answer: string,
 *   sources: Array<Object>,
 *   matchingChunks: Array<Object>,
 *   supportedRatio: number,
 *   totalSentences: number,
 *   fallbackReason: string|null
 * }>}
 */
export async function verifyAnswerSupport({ answer, contextChunks = [] }) {
  if (!answer || isFallbackAnswer(answer)) {
    return {
      accepted: false,
      answer: FALLBACK_MESSAGE,
      sources: [],
      matchingChunks: [],
      supportedRatio: 0,
      totalSentences: 0,
      fallbackReason: "insufficient_evidence"
    };
  }

  const chunks = Array.isArray(contextChunks) ? contextChunks.filter(Boolean) : [];
  if (chunks.length === 0) {
    console.log(`[HallucinationGuard] supportedRatio=0.00, sentences=0, rejected`);
    return {
      accepted: false,
      answer: FALLBACK_MESSAGE,
      sources: [],
      matchingChunks: [],
      supportedRatio: 0,
      totalSentences: 0,
      fallbackReason: "unsupported_no_context_chunks"
    };
  }

  const sentences = splitAnswerIntoSentences(answer);
  if (sentences.length === 0) {
    console.log(`[HallucinationGuard] supportedRatio=0.00, sentences=0, rejected`);
    return {
      accepted: false,
      answer: FALLBACK_MESSAGE,
      sources: [],
      matchingChunks: [],
      supportedRatio: 0,
      totalSentences: 0,
      fallbackReason: "unsupported_no_sentences"
    };
  }

  const minSim = RAG_CONFIG.answerSupportMinSim ?? 0.55;
  const minRatio = RAG_CONFIG.answerSupportMinRatio ?? 0.5;

  // Ensure all context chunks have vector embeddings
  for (const chunk of chunks) {
    if (!chunk.embedding || !Array.isArray(chunk.embedding) || chunk.embedding.length === 0) {
      try {
        chunk.embedding = await generateTextEmbedding(chunk.content || "");
      } catch (err) {
        chunk.embedding = [];
      }
    }
  }

  const validChunks = chunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0);
  if (validChunks.length === 0) {
    console.log(`[HallucinationGuard] supportedRatio=0.00, sentences=${sentences.length}, rejected`);
    return {
      accepted: false,
      answer: FALLBACK_MESSAGE,
      sources: [],
      matchingChunks: [],
      supportedRatio: 0,
      totalSentences: sentences.length,
      fallbackReason: "unsupported_no_valid_embeddings"
    };
  }

  let supportedCount = 0;
  const bestMatchingChunkMap = new Map();

  for (const sentence of sentences) {
    let sEmb;
    try {
      sEmb = await generateTextEmbedding(sentence);
    } catch (e) {
      continue;
    }

    let maxSim = -Infinity;
    let bestChunk = null;

    for (const chunk of validChunks) {
      const sim = cosineSimilarity(sEmb, chunk.embedding);
      if (sim > maxSim) {
        maxSim = sim;
        bestChunk = chunk;
      }
    }

    if (maxSim >= minSim && bestChunk) {
      supportedCount++;
      const chunkKey = `${bestChunk.documentName}_p${bestChunk.pageNumber || 1}_i${bestChunk.chunkIndex ?? 0}_${bestChunk.sourceType || "text"}`;
      if (!bestMatchingChunkMap.has(chunkKey)) {
        bestMatchingChunkMap.set(chunkKey, bestChunk);
      }
    }
  }

  const supportedRatio = sentences.length > 0 ? supportedCount / sentences.length : 0;
  const accepted = supportedRatio >= minRatio;

  // Requirement 6: Log one line per answer: supportedRatio, number of sentences, accepted or rejected
  console.log(
    `[HallucinationGuard] supportedRatio=${supportedRatio.toFixed(2)}, sentences=${sentences.length}, ${accepted ? "accepted" : "rejected"}`
  );

  if (!accepted) {
    return {
      accepted: false,
      answer: FALLBACK_MESSAGE,
      sources: [],
      matchingChunks: [],
      supportedRatio,
      totalSentences: sentences.length,
      fallbackReason: "unsupported_hallucination"
    };
  }

  const matchingChunks = Array.from(bestMatchingChunkMap.values());
  const sources = formatSources(matchingChunks);

  return {
    accepted: true,
    answer,
    sources,
    matchingChunks,
    supportedRatio,
    totalSentences: sentences.length,
    fallbackReason: null
  };
}
