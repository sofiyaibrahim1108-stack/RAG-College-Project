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
  threshold = RAG_CONFIG.imageSimilarityThreshold,
  queryText = ""
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
    .select("imageId documentId documentName pageNumber filename imagePath department embedding caption description")
    .lean();

  if (candidates.length < topK) {
    candidates = await ImageModel.find({})
      .select("imageId documentId documentName pageNumber filename imagePath department embedding caption description")
      .lean();
  }

  // If question explicitly specifies a page number, ensure matching page images are included
  const pageMatch = queryText ? queryText.match(/\b(?:page|p\.?)\s*(\d+)\b/i) : null;
  const targetPage = pageMatch ? parseInt(pageMatch[1], 10) : null;

  if (targetPage !== null) {
    const pageImgs = await ImageModel.find({ pageNumber: targetPage })
      .select("imageId documentId documentName pageNumber filename imagePath department embedding caption description")
      .lean();
    if (pageImgs.length > 0) {
      const existingKeys = new Set(candidates.map((c) => `${c.documentName}_${c.filename}`));
      for (const pi of pageImgs) {
        const key = `${pi.documentName}_${pi.filename}`;
        if (!existingKeys.has(key)) {
          candidates.unshift(pi);
          existingKeys.add(key);
        }
      }
    }
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

    let sim = cosineSimilarity(siglipQueryEmbedding, img.embedding);
    let isPageMatch = false;

    // Hybrid keyword & page number alignment bonus
    if (queryText) {
      const qLower = queryText.toLowerCase();

      // 1. Generic explicit page mention match: e.g. "page 58", "page 40"
      const pageMatch = qLower.match(/\b(?:page|p\.?)\s*(\d+)\b/i);
      if (pageMatch && parseInt(pageMatch[1], 10) === img.pageNumber) {
        sim += 0.35;
        isPageMatch = true;
      }

      // 2. Generic caption token overlap (no hardcoded keywords)
      if (img.caption) {
        const captionTerms = img.caption
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length >= 3);
        if (captionTerms.length > 0) {
          let matches = 0;
          for (const term of captionTerms) {
            if (qLower.includes(term)) matches++;
          }
          if (matches > 0) {
            sim += Math.min(0.08, (matches / captionTerms.length) * 0.08);
          }
        }
      }
    }

    if (sim >= threshold || isPageMatch) {
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
        similarity: parseFloat(sim.toFixed(4)),
        _isPageMatch: isPageMatch
      });
      seenFilenames.add(dedupeKey);
    }
  }

  // Sort: explicit page matches first, then descending by similarity
  scored.sort((a, b) => {
    if (a._isPageMatch && !b._isPageMatch) return -1;
    if (!a._isPageMatch && b._isPageMatch) return 1;
    return b.similarity - a.similarity;
  });

  const results = scored.slice(0, topK).map(({ _isPageMatch, ...rest }) => rest);

  console.log(
    `[ImageRetrieval] Retrieved ${results.length} images above threshold ${threshold} in ${Date.now() - startTime}ms`
  );

  for (const img of results) {
    console.log(
      `[ImageRetrieval]   page=${img.pageNumber ?? "?"} ` +
      `sim=${img.similarity.toFixed(4)} ` +
      `cap="${(img.caption || "").slice(0, 50)}" ` +
      `doc="${img.documentName}"`
    );
  }

  return results;
}
