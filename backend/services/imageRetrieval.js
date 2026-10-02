import { ImageModel } from "../models/Image.js";
import { cosineSimilarity } from "../utils/similarity.js";
import { RAG_CONFIG } from "../config/rag.js";

/**
 * Cross-modal image retrieval using SigLIP2 question embedding against stored image vectors
 * Combined with exact page number matching and OCR text term overlap.
 *
 * @param {number[]} siglipQueryEmbedding
 * @param {string[]} routedDepartments
 * @param {number} topK
 * @param {number} threshold
 * @param {string} queryText
 * @param {Object} filterMeta
 * @returns {Promise<Array<Object>>}
 */
export async function retrieveRelevantImages(
  siglipQueryEmbedding,
  routedDepartments = [],
  topK = RAG_CONFIG.topKImages,
  threshold = RAG_CONFIG.imageSimilarityThreshold,
  queryText = "",
  filterMeta = {}
) {
  const startTime = Date.now();

  // Find candidate images strictly within the target scope
  const mongoQuery = {};

  if (routedDepartments && routedDepartments.length > 0) {
    mongoQuery.department = { $in: routedDepartments };
  }

  if (filterMeta.documentId) {
    mongoQuery.documentId = filterMeta.documentId;
  }
  if (filterMeta.documentName) {
    mongoQuery.documentName = filterMeta.documentName;
  }

  let candidates = await ImageModel.find(mongoQuery)
    .select("imageId documentId documentName pageNumber filename imagePath department embedding caption description ocrText")
    .lean();

  if (candidates.length === 0) {
    return [];
  }

  // If question explicitly specifies a page number, prioritize matching page images
  const pageMatch = queryText ? queryText.match(/\b(?:page|p\.?)\s*(\d+)\b/i) : null;
  const targetPage = pageMatch ? parseInt(pageMatch[1], 10) : null;

  const scored = [];
  const seenFilenames = new Set();
  const qLower = (queryText || "").toLowerCase();

  for (let i = 0; i < candidates.length; i++) {
    const img = candidates[i];
    if (!img.embedding || img.embedding.length === 0) continue;

    const dedupeKey = `${img.documentName}_${img.filename}`;
    if (seenFilenames.has(dedupeKey)) continue;

    let sim = 0;
    if (siglipQueryEmbedding && siglipQueryEmbedding.length > 0) {
      sim = cosineSimilarity(siglipQueryEmbedding, img.embedding);
    }

    const isPageMatch = targetPage !== null && img.pageNumber === targetPage;
    let lexicalBonus = 0;

    // OCR / Caption text alignment bonus
    const textPool = `${img.caption || ""} ${img.ocrText || ""} ${img.description || ""}`.toLowerCase();
    const queryTokens = qLower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3);

    if (queryTokens.length > 0) {
      let matches = 0;
      for (const t of queryTokens) {
        if (textPool.includes(t)) matches++;
      }
      if (matches > 0) {
        lexicalBonus = (matches / queryTokens.length) * 0.15;
      }
    }

    const rankingScore = sim + lexicalBonus + (isPageMatch ? 0.35 : 0);

    if (sim >= threshold || isPageMatch || lexicalBonus >= 0.10) {
      scored.push({
        imageId: img.imageId,
        documentId: img.documentId,
        documentName: img.documentName,
        pageNumber: img.pageNumber,
        filename: img.filename,
        imagePath: img.imagePath,
        department: img.department,
        caption: img.caption || "",
        description: img.description || "",
        ocrText: img.ocrText || "",
        similarity: parseFloat(sim.toFixed(4)),
        rankingScore: parseFloat(rankingScore.toFixed(4)),
        _isPageMatch: isPageMatch
      });
      seenFilenames.add(dedupeKey);
    }
  }

  // Sort: explicit page matches first, then descending by ranking score
  scored.sort((a, b) => {
    if (a._isPageMatch && !b._isPageMatch) return -1;
    if (!a._isPageMatch && b._isPageMatch) return 1;
    return b.rankingScore - a.rankingScore;
  });

  const results = scored.slice(0, topK).map(({ _isPageMatch, ...rest }) => rest);

  console.log(
    `[ImageRetrieval] Retrieved ${results.length} scoped images in ${Date.now() - startTime}ms`
  );

  for (const img of results) {
    console.log(
      `[ImageRetrieval]   p.${img.pageNumber ?? "?"} sim=${img.similarity} rank=${img.rankingScore} cap="${(img.caption || "").slice(0, 40)}" doc="${img.documentName}"`
    );
  }

  return results;
}
