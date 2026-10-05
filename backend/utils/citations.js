/**
 * Utilities for formatting and extracting citations
 */

export function formatSources(textChunks = []) {
  if (!textChunks || textChunks.length === 0) return [];

  const seen = new Map();

  for (const chunk of textChunks) {
    const key = `${chunk.documentName}_${chunk.pageNumber || 1}_${chunk.chunkIndex ?? 0}_${chunk.sourceType || "text"}`;
    if (!seen.has(key)) {
      seen.set(key, {
        documentId: chunk.documentId,
        documentName: chunk.documentName,
        department: chunk.department,
        pageNumber: chunk.pageNumber || 1,
        chunkIndex: chunk.chunkIndex,
        sourceType: chunk.sourceType || "text",
        snippet: (chunk.content || "").slice(0, 200) + "...",
        similarity: chunk.similarity,
        imageRef: chunk.imageRef || null
      });
    }
  }

  return Array.from(seen.values());
}

export function formatImageCitations(images = []) {
  if (!images || images.length === 0) return [];

  return images.map((img) => ({
    imageId: img.imageId,
    documentId: img.documentId,
    documentName: img.documentName,
    pageNumber: img.pageNumber || 1,
    filename: img.filename,
    caption: img.caption || "",
    description: img.description || "",
    imagePath: `/api/documents/images/${img.documentId}/${img.filename}`,
    similarity: img.similarity
  }));
}
