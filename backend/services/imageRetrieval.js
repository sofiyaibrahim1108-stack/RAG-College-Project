import { ImageModel } from "../models/Image.js";
import { cosineSimilarity } from "../utils/similarity.js";
import { RAG_CONFIG } from "../config/rag.js";

/**
 * Cross-modal image retrieval using SigLIP2 question embedding against stored image vectors
 * @param {number[]} siglipQueryEmbedding
 * @param {string[]} routedDepartments
 * @param {number} topK
 * @param {number} threshold
 * @returns {Promise<Array<Object>>}
 */
export async function retrieveRelevantImages(
  siglipQueryEmbedding,
  routedDepartments = [],
  topK = RAG_CONFIG.topKImages,
  threshold = RAG_CONFIG.imageSimilarityThreshold
) {
  const startTime = Date.now();

  if (!siglipQueryEmbedding || siglipQueryEmbedding.length === 0) {
    return [];
  }

  // Find candidate images
  const deptQuery =
    routedDepartments && routedDepartments.length > 0
      ? { department: { $in: routedDepartments } }
      : {};

  let candidates = await ImageModel.find(deptQuery)
    .select("imageId documentId documentName pageNumber filename imagePath department embedding")
    .lean();

  if (candidates.length < topK) {
    candidates = await ImageModel.find({})
      .select("imageId documentId documentName pageNumber filename imagePath department embedding")
      .lean();
  }

  if (candidates.length === 0) {
    return [];
  }

  const scored = [];
  const seenFilenames = new Set();

  for (let i = 0; i < candidates.length; i++) {
    const img = candidates[i];
    if (!img.embedding || img.embedding.length === 0) continue;

    // Duplicate prevention based on filename/document
    const dedupeKey = `${img.documentName}_${img.filename}`;
    if (seenFilenames.has(dedupeKey)) continue;

    const sim = cosineSimilarity(siglipQueryEmbedding, img.embedding);
    if (sim >= threshold) {
      scored.push({
        imageId: img.imageId,
        documentId: img.documentId,
        documentName: img.documentName,
        pageNumber: img.pageNumber,
        filename: img.filename,
        imagePath: img.imagePath,
        department: img.department,
        similarity: parseFloat(sim.toFixed(4))
      });
      seenFilenames.add(dedupeKey);
    }
  }

  // Sort descending by similarity
  scored.sort((a, b) => b.similarity - a.similarity);

  const results = scored.slice(0, topK);

  console.log(
    `[ImageRetrieval] Retrieved ${results.length} images above threshold ${threshold} in ${Date.now() - startTime}ms`
  );

  return results;
}
