import { DocumentChunk } from "../models/DocumentChunk.js";
import { cosineSimilarity } from "../utils/similarity.js";
import { RAG_CONFIG } from "../config/rag.js";

const STOP_WORDS = new Set([
  "what", "is", "the", "of", "in", "and", "how", "it", "from", "to", "for", "a", "an", "are", "can",
  "why", "did", "my", "does", "with", "show", "between", "instead", "about", "explain",
  "tell", "me", "which", "that", "this", "there", "their", "they", "when", "where", "who", "whom",
  "whose", "by", "on", "at", "or", "be", "been", "being", "have", "has", "had", "do", "doing",
  "done", "would", "should", "could", "give", "example", "please", "use", "using", "work", "works",
  "compare", "comparison", "difference", "different", "versus", "vs"
]);

/**
 * Verifies whether the retrieved candidate chunks contain the subjects of inquiry
 */
function checkEntityGrounding(question, chunks) {
  if (!question || !chunks || chunks.length === 0) return chunks;

  const cleanQ = question.toLowerCase();
  const words = cleanQ
    .replace(/[=!<>&|~^%+\-*/?,.:;"'()\[\]{}]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

  const combinedCandidateText = chunks.map((c) => (c.content || "").toLowerCase()).join(" ");

  // 1. Comparison queries: "difference between X and Y", "compare X and Y", "X vs Y", "how is X different from Y"
  const isComparison = /\b(difference|compare|versus|vs|different)\b/i.test(question);
  if (isComparison && words.length >= 2) {
    const missingTerms = words.filter((term) => !combinedCandidateText.includes(term));
    if (missingTerms.length > 0) {
      console.log(`[TextRetrieval Grounding] Comparison query lacks supporting text for: [${missingTerms.join(", ")}]`);
      return [];
    }
  }

  // 2. Definition queries: "what is X", "what are X", "define X", "explain X"
  const isDefinition = /\b(what\s+is|what\s+are|define|explain)\b/i.test(question);
  if (isDefinition && words.length >= 1) {
    const primarySubject = words[0];
    if (!combinedCandidateText.includes(primarySubject)) {
      console.log(`[TextRetrieval Grounding] Subject "${primarySubject}" not found in candidate documents.`);
      return [];
    }
  }

  return chunks;
}

/**
 * Department-aware text retrieval from MongoDB chunks
 * @param {number[]} queryEmbedding
 * @param {string[]} routedDepartments
 * @param {number} topK
 * @param {number} threshold
 * @param {string} question
 * @returns {Promise<Array<Object>>}
 */
export async function retrieveRelevantTextChunks(
  queryEmbedding,
  routedDepartments = [],
  topK = RAG_CONFIG.topKText,
  threshold = RAG_CONFIG.textSimilarityThreshold,
  question = ""
) {
  const startTime = Date.now();

  // Build department filter (support name or ID)
  const deptQuery =
    routedDepartments && routedDepartments.length > 0
      ? { department: { $in: routedDepartments } }
      : {};

  // First fetch department-targeted chunks
  let candidateChunks = await DocumentChunk.find(deptQuery)
    .select("documentId documentName pageNumber chunkIndex content department embedding")
    .lean();

  // If no candidate chunks in routed department, do not arbitrarily leak unrelated departments
  if (candidateChunks.length === 0) {
    if (routedDepartments && routedDepartments.length > 0) {
      console.log(`[TextRetrieval] No document chunks found for department(s) [${routedDepartments.join(", ")}]`);
      return [];
    }
    console.log(`[TextRetrieval] No document chunks found in database`);
    return [];
  }

  // Verify entity grounding for the question before calculating similarities
  if (question) {
    candidateChunks = checkEntityGrounding(question, candidateChunks);
    if (candidateChunks.length === 0) {
      console.log(`[TextRetrieval] 0 chunks passed entity grounding for question: "${question}"`);
      return [];
    }
  }

  // Extract key search terms for lexical boost
  const queryTerms = (question || "")
    .toLowerCase()
    .replace(/[=!<>&|~^%+\-*/?,.:;"'()\[\]{}]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

  // Calculate similarity scores and filter strictly by threshold
  const scoredChunks = [];
  const seenContentPrefix = new Set();

  for (let i = 0; i < candidateChunks.length; i++) {
    const chunk = candidateChunks[i];
    if (!chunk.embedding || chunk.embedding.length === 0) continue;

    const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
    // Include only chunks meeting or exceeding the relevance threshold
    if (sim >= threshold) {
      // Avoid duplicate chunks with identical prefix
      const prefixKey = `${chunk.documentId}_${chunk.pageNumber}_${(chunk.content || "").slice(0, 80)}`;
      if (seenContentPrefix.has(prefixKey)) continue;
      seenContentPrefix.add(prefixKey);

      let lexicalBonus = 0;
      if (queryTerms.length > 0) {
        const textLower = (chunk.content || "").toLowerCase();
        let matches = 0;
        for (const term of queryTerms) {
          if (textLower.includes(term)) matches++;
        }
        lexicalBonus = (matches / queryTerms.length) * 0.08;
      }

      scoredChunks.push({
        documentId: chunk.documentId,
        documentName: chunk.documentName,
        pageNumber: chunk.pageNumber,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        department: chunk.department,
        similarity: parseFloat(sim.toFixed(4)),
        rankingScore: sim + lexicalBonus
      });
    }
  }

  // Sort descending by ranking score (vector similarity + lexical coverage)
  scoredChunks.sort((a, b) => b.rankingScore - a.rankingScore);

  // Take topK relevant chunks only - NEVER force unrelated or below-threshold chunks
  const finalChunks = scoredChunks.slice(0, topK);

  console.log(
    `[TextRetrieval] Retrieved ${finalChunks.length} chunks across departments [${routedDepartments.join(
      ", "
    )}] in ${Date.now() - startTime}ms`
  );

  return finalChunks;
}
