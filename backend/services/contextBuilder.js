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
  if (textChunks.length > 0) {
    contextSections.push("=== DOCUMENT EXCERPTS ===");
    const seenContents = new Set();
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

  // 2. Image references section
  if (images.length > 0) {
    contextSections.push("\n=== RELEVANT DOCUMENT DIAGRAMS / FIGURES ===");
    images.forEach((img, index) => {
      const pageInfo = img.pageNumber ? ` (Page ${img.pageNumber})` : "";
      contextSections.push(
        `[Figure ${index + 1}]: ${img.documentName}${pageInfo} - ${img.filename}`
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
