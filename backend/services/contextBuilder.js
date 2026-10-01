/**
 * Constructs the contextual prompt payload for the LLM
 * Combines retrieved text chunks, image references, and citations.
 */
export function buildRAGContext(textChunks = [], images = []) {
  if (textChunks.length === 0 && images.length === 0) {
    return {
      contextPrompt: "NO_DOCUMENTS_FOUND",
      textChunks: [],
      images: []
    };
  }

  const contextSections = [];

  // 1. Text chunks section
  const seenContents = new Set();
  if (textChunks.length > 0) {
    contextSections.push("=== DOCUMENT EXCERPTS ===");
    let sourceIndex = 1;

    textChunks.forEach((chunk) => {
      const cleanContent = (chunk.content || "").trim();
      if (!cleanContent) return;
      if (seenContents.has(cleanContent)) return;
      seenContents.add(cleanContent);

      const pageInfo = chunk.pageNumber ? ` (Page ${chunk.pageNumber})` : "";
      contextSections.push(
        `[Source ${sourceIndex}]: ${chunk.documentName}${pageInfo}\n${cleanContent}`
      );
      sourceIndex++;
    });
  }

  // 2. Visual evidence section
  if (images.length > 0) {
    contextSections.push("=== RELEVANT VISUAL EVIDENCE ===");
    images.forEach((img, index) => {
      const pageInfo = img.pageNumber ? ` (Page ${img.pageNumber})` : "";
      const captionInfo = img.caption ? `\n  Caption: ${img.caption}` : "";
      const simInfo = img.similarity ? `\n  Match Score: ${(img.similarity * 100).toFixed(0)}%` : "";

      // Build description: use stored description if available
      let descLines = [];
      if (img.description && img.description.trim()) {
        descLines.push(`  Visual Description: ${img.description.trim()}`);
      }

      // Attach same-page text chunks ONLY when they belong to that exact visual/page
      const usedKey = (c) => "__visual_ctx__" + (c.content || "").trim().slice(0, 40);

      const samePageChunks = textChunks.filter(
        (c) =>
          c.pageNumber === img.pageNumber &&
          c.documentName === img.documentName &&
          !seenContents.has(usedKey(c))
      );

      if (samePageChunks.length > 0) {
        const pageCtx = samePageChunks
          .map((c) => (c.content || "").trim())
          .filter(Boolean)
          .join(" ")
          .slice(0, 600);
        if (pageCtx) {
          descLines.push(`  Same-Page Context: ${pageCtx}`);
          samePageChunks.forEach((c) => seenContents.add(usedKey(c)));
        }
      }

      const descBlock = descLines.length > 0 ? "\n" + descLines.join("\n") : "";

      contextSections.push(
        `[Visual Evidence ${index + 1}]: ${img.documentName}${pageInfo}${captionInfo}${simInfo}${descBlock}`
      );
    });
  }

  const contextPrompt = contextSections.join("\n\n");

  return {
    contextPrompt,
    textChunks,
    images
  };
}
