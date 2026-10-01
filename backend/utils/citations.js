/**
 * Utilities for formatting and extracting citations
 */

export function formatSources(textChunks = []) {
  if (!textChunks || textChunks.length === 0) return [];

  const seen = new Set();
  const sources = [];

  for (const chunk of textChunks) {
    const key = `${chunk.documentName}_${chunk.pageNumber || 1}`;
    if (!seen.has(key)) {
      seen.add(key);
      sources.push({
        documentId: chunk.documentId,
        documentName: chunk.documentName,
        pageNumber: chunk.pageNumber || 1,
        chunkIndex: chunk.chunkIndex,
        snippet: (chunk.content || "").slice(0, 200) + "...",
        similarity: chunk.similarity
      });
    }
  }

  return sources;
}

export function formatImageCitations(images = []) {
  if (!images || images.length === 0) return [];

  return images.map((img) => ({
    imageId: img.imageId,
    documentId: img.documentId,
    documentName: img.documentName,
    pageNumber: img.pageNumber || 1,
    filename: img.filename,
    imagePath: `/api/documents/images/${img.documentId}/${img.filename}`,
    similarity: img.similarity
  }));
}
