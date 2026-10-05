import { ImageModel } from "../models/Image.js";
import { DocumentChunk } from "../models/DocumentChunk.js";
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
  console.log(
  `[ImageRetrieval DEBUG] Called | candidates query starting | query="${queryText}"`
);

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

      console.log(
    `[ImageRetrieval DEBUG] Candidates found: ${candidates.length}`
  );

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

  // If a specific target page was requested, restrict strictly to matching page images
  if (targetPage !== null) {
    const pageMatches = scored.filter((img) => img.pageNumber === targetPage);
    if (pageMatches.length > 0) {
      pageMatches.sort((a, b) => b.rankingScore - a.rankingScore);
      const results = pageMatches.slice(0, topK).map(({ _isPageMatch, ...rest }) => rest);
      console.log(
        `[ImageRetrieval] Retrieved ${results.length} strictly page-matched images for Page ${targetPage} in ${Date.now() - startTime}ms`
      );
      return results;
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

/**
 * Shared Multimodal Attachment Resolver
 * Resolves images to attach based on:
 * 1. Surviving image-derived chunks (with imageRef) from grounded text retrieval
 * 2. SigLIP candidate signal with relative margin over document peers
 *
 * @param {Object} options
 * @param {Array<Object>} options.survivingSources
 * @param {Array<Object>} options.retrievedChunks
 * @param {Array<Object>} [options.siglipCandidates]
 * @param {number} [options.maxImages]
 * @param {boolean} [options.isFallback]
 * @returns {Promise<Array<Object>>}
 */
export async function resolveMultimodalAttachments({
  survivingSources = [],
  retrievedChunks = [],
  maxImages = RAG_CONFIG.topKImages,
  isFallback = false,
  question = "",
  finalAnswer = ""
}) {
  if (isFallback) {
    console.log("[Multimodal] Attach: Fallback answer detected. No images attached.");
    return [];
  }

  const attached = [];
  const seenImageKeys = new Set();

  // Task 2a: If the question names a page (page filter), attach only the image(s) of that page.
  const pageMatch = (question || "").match(/\b(?:page|p\.?)\s*(\d+)\b/i);
  const targetPage = pageMatch ? parseInt(pageMatch[1], 10) : null;
  const isExplicitPageRequest = targetPage !== null;

  // Track surviving pages from the filtered sources
  const survivingPages = new Set(
    (survivingSources || []).map((s) => `${s.documentName}_p${s.pageNumber || 1}`)
  );

  // Stop words for novelty comparison
  const NOVELTY_STOP_WORDS = new Set([
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "this", "that", "it", "its"
  ]);

  const tokenize = (str) =>
    (str || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !NOVELTY_STOP_WORDS.has(w));

  // Attach images strictly via surviving image-derived chunks (Task 2a & 2b)
  for (const chunk of retrievedChunks || []) {
    if (!chunk.imageRef || !chunk.imageRef.filename) continue;
    if (chunk.sourceType !== "image_chunk") continue;

    // Task 2a: If the question names a page (page filter), attach only the image(s) of that page.
    if (isExplicitPageRequest) {
      if (chunk.pageNumber !== targetPage && chunk.imageRef?.pageNumber !== targetPage) {
        continue;
      }
    } else {
      // Task 2b: Otherwise attach only images whose own image_chunk supported the final answer.
      // Do not attach images of other sections just because they ranked in the pool.
      const pageKey = `${chunk.documentName}_p${chunk.pageNumber || 1}`;
      if (!survivingPages.has(pageKey)) {
        console.log(
          `[Multimodal] Image dropped: file "${chunk.imageRef.filename}", page ${chunk.pageNumber} (reason: page_not_in_surviving_sources)`
        );
        continue;
      }

      if (finalAnswer) {
        const answerNumbers = (finalAnswer.match(/\b\d+(?:,\d+)*(?:\.\d+)?%?\b/g) || [])
          .map((n) => n.replace(/,/g, "").toLowerCase())
          .filter((n) => n.length >= 2 || n.includes("%"));

        const chunkText = `${chunk.imageRef?.caption || ""} ${chunk.content || ""}`.toLowerCase();

        if (answerNumbers.length > 0) {
          const hasNumber = answerNumbers.some((num) => chunkText.includes(num));
          if (!hasNumber) {
            console.log(
              `[Multimodal] Image dropped: file "${chunk.imageRef.filename}", page ${chunk.pageNumber} (reason: image_chunk_does_not_support_answer_numbers)`
            );
            continue;
          }
        }
      }
    }

    // Novelty check (Requirement 4b):
    // Compute share of image OCR/caption tokens that do not appear in normal text chunks of the same page.
    // Below RAG_CONFIG.minImageNoveltyRatio, the image is a duplicate page render and is not attached.
    // Explicit page requests are exempt.
    if (!isExplicitPageRequest) {
      let pageNormalText = (retrievedChunks || [])
        .filter((c) => c.documentId === chunk.documentId && c.pageNumber === chunk.pageNumber && c.sourceType !== "image_chunk" && !c.imageRef)
        .map((c) => c.content || "")
        .join(" ");

      if (!pageNormalText && chunk.documentId) {
        try {
          const dbChunks = await DocumentChunk.find({
            documentId: chunk.documentId,
            pageNumber: chunk.pageNumber,
            sourceType: { $ne: "image_chunk" }
          }).select("content").lean();
          pageNormalText = dbChunks.map((c) => c.content || "").join(" ");
        } catch {}
      }

      const pageTokens = new Set(tokenize(pageNormalText));
      const imageText = `${chunk.imageRef.caption || ""} ${chunk.content || ""}`;
      const imageTokens = tokenize(imageText);

      if (imageTokens.length > 0 && pageTokens.size > 0) {
        const novelTokens = imageTokens.filter((t) => !pageTokens.has(t));
        const noveltyRatio = novelTokens.length / imageTokens.length;
        const minNovelty = RAG_CONFIG.minImageNoveltyRatio !== undefined ? RAG_CONFIG.minImageNoveltyRatio : 0.15;

        if (noveltyRatio < minNovelty) {
          console.log(
            `[Multimodal] Image dropped: file "${chunk.imageRef.filename}", page ${chunk.pageNumber} (reason: duplicate_page_render, noveltyRatio=${noveltyRatio.toFixed(3)} < ${minNovelty})`
          );
          continue;
        }
      }
    }

    const imgKey = `${chunk.documentName}_${chunk.imageRef.filename}`;
    if (!seenImageKeys.has(imgKey) && attached.length < maxImages) {
      seenImageKeys.add(imgKey);

      // Fetch full image metadata from ImageModel
      let dbImg = await ImageModel.findOne({
        documentId: chunk.imageRef.documentId,
        filename: chunk.imageRef.filename
      }).lean();

      const survivingChunkDesc = `chunk [p.${chunk.pageNumber} idx.${chunk.chunkIndex ?? 0}] (${chunk.sourceType || "image_chunk"})`;

      const imageCitation = {
        imageId: dbImg?.imageId || `img_${chunk.imageRef.filename}`,
        documentId: chunk.imageRef.documentId,
        documentName: chunk.documentName,
        pageNumber: chunk.imageRef.pageNumber || chunk.pageNumber || 1,
        filename: chunk.imageRef.filename,
        caption: dbImg?.caption || "",
        description: dbImg?.description || "",
        imagePath: `/api/documents/images/${chunk.imageRef.documentId}/${chunk.imageRef.filename}`,
        similarity: chunk.similarity || 1.0,
        survivingChunk: survivingChunkDesc
      };

      attached.push(imageCitation);
      console.log(
        `[Multimodal] Image attached: file "${chunk.imageRef.filename}", page ${imageCitation.pageNumber} (reason: surviving_text_chunk, score=${chunk.rankingScore || chunk.similarity || "n/a"}, source=${survivingChunkDesc})`
      );
    }
  }

  return attached;
}

