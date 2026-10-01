import { DocumentChunk } from "../models/DocumentChunk.js";
import { cosineSimilarity } from "../utils/similarity.js";
import { RAG_CONFIG } from "../config/rag.js";

/**
 * Department-aware text retrieval from MongoDB chunks
 * @param {number[]} queryEmbedding
 * @param {string[]} routedDepartments
 * @param {number} topK
 * @param {number} threshold
 * @returns {Promise<Array<Object>>}
 */
export async function retrieveRelevantTextChunks(
  queryEmbedding,
  routedDepartments = [],
  topK = RAG_CONFIG.topKText,
  threshold = RAG_CONFIG.textSimilarityThreshold
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

  // If candidate pool is too small (e.g. few documents in routed department), broaden search
  if (candidateChunks.length < topK) {
    const allChunks = await DocumentChunk.find({})
      .select("documentId documentName pageNumber chunkIndex content department embedding")
      .lean();
    candidateChunks = allChunks;
  }

  if (candidateChunks.length === 0) {
    console.log(`[TextRetrieval] No document chunks found in database`);
    return [];
  }

  // Calculate similarity scores
  const scoredChunks = [];
  for (let i = 0; i < candidateChunks.length; i++) {
    const chunk = candidateChunks[i];
    if (!chunk.embedding || chunk.embedding.length === 0) continue;

    const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
    // Include chunks above threshold
    if (sim >= threshold) {
      scoredChunks.push({
        documentId: chunk.documentId,
        documentName: chunk.documentName,
        pageNumber: chunk.pageNumber,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        department: chunk.department,
        similarity: parseFloat(sim.toFixed(4))
      });
    }
  }

  // Sort descending
  scoredChunks.sort((a, b) => b.similarity - a.similarity);

  // If strict threshold yielded nothing, return top 2 best results to prevent empty answers
  const finalChunks =
    scoredChunks.length > 0
      ? scoredChunks.slice(0, topK)
      : candidateChunks
          .map((c) => ({
            documentId: c.documentId,
            documentName: c.documentName,
            pageNumber: c.pageNumber,
            chunkIndex: c.chunkIndex,
            content: c.content,
            department: c.department,
            similarity: parseFloat(cosineSimilarity(queryEmbedding, c.embedding).toFixed(4))
          }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 2);

  console.log(
    `[TextRetrieval] Retrieved ${finalChunks.length} chunks across departments [${routedDepartments.join(
      ", "
    )}] in ${Date.now() - startTime}ms`
  );

  return finalChunks;
}
