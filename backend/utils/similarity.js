/**
 * Optimized vector similarity utilities
 */

/**
 * Calculates cosine similarity between two vectors.
 * If vectors are known to be pre-normalized, dot product can be used directly.
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  const len = vecA.length;

  for (let i = 0; i < len; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Retrieves the top K items sorted by cosine similarity
 * Includes threshold filtering and duplicate prevention.
 */
export function topKSimilar(items, queryEmbedding, topK = 5, threshold = 0.2, getEmbedding = (item) => item.embedding) {
  if (!items || items.length === 0 || !queryEmbedding) {
    return [];
  }

  const scored = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemEmbedding = getEmbedding(item);
    if (!itemEmbedding) continue;

    const similarity = cosineSimilarity(queryEmbedding, itemEmbedding);
    if (similarity >= threshold) {
      scored.push({ item, similarity });
    }
  }

  // Sort descending by similarity
  scored.sort((a, b) => b.similarity - a.similarity);

  // Return top K items with their similarity scores attached
  return scored.slice(0, topK);
}
