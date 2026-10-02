/**
 * Constructs the contextual prompt payload for the LLM
 * Combines retrieved text chunks, image references, and deterministic tabular tool results.
 * Clearly separates evidence categories with precise document and page citations.
 *
 * @param {Array<Object>} textChunks
 * @param {Array<Object>} images
 * @param {Object|null} tabularResult
 * @returns {{ contextPrompt: string, textChunks: Array<Object>, images: Array<Object>, tabularResult: Object|null }}
 */
export function buildRAGContext(textChunks = [], images = [], tabularResult = null) {
  const hasChunks = Array.isArray(textChunks) && textChunks.length > 0;
  const hasImages = Array.isArray(images) && images.length > 0;
  const hasTabular = tabularResult && tabularResult.success;

  if (!hasChunks && !hasImages && !hasTabular) {
    return {
      contextPrompt: "NO_DOCUMENTS_FOUND",
      textChunks: [],
      images: [],
      tabularResult: null
    };
  }

  const contextSections = [];

  // 1. Tabular Tool Result Section (Deterministic dataset calculations)
  if (hasTabular) {
    contextSections.push("=== TABULAR TOOL RESULT ===");
    contextSections.push(
      `Document: ${tabularResult.documentName}\nOperation: ${tabularResult.operation}\nCalculation Result:\n${tabularResult.summary}`
    );
  }

  // 2. Document Excerpts Section
  const seenContents = new Set();
  if (hasChunks) {
    contextSections.push("=== DOCUMENT EXCERPTS ===");
    let sourceIndex = 1;

    textChunks.forEach((chunk) => {
      const cleanContent = (chunk.content || "").trim();
      if (!cleanContent) return;
      if (seenContents.has(cleanContent)) return;
      seenContents.add(cleanContent);

      const pageStr = chunk.pageNumber ? `Page ${chunk.pageNumber}` : "Page 1";
      contextSections.push(
        `[Source ${sourceIndex}] Document: ${chunk.documentName} | ${pageStr}\n${cleanContent}`
      );
      sourceIndex++;
    });
  }

  // 3. Relevant Visual Evidence Section
  if (hasImages) {
    contextSections.push("=== RELEVANT VISUAL EVIDENCE ===");
    images.forEach((img, index) => {
      const pageStr = img.pageNumber ? `Page ${img.pageNumber}` : "Page 1";
      const lines = [];

      lines.push(`[Visual Evidence ${index + 1}] Document: ${img.documentName} | ${pageStr} | File: ${img.filename}`);

      if (img.caption && img.caption.trim()) {
        lines.push(`Caption: ${img.caption.trim()}`);
      }

      // Include OCR text extracted directly from inside the screenshot/image
      if (img.ocrText && img.ocrText.trim()) {
        lines.push(`OCR Extracted Text from Screenshot:\n${img.ocrText.trim()}`);
      }

      if (img.description && img.description.trim() && (!img.ocrText || !img.description.includes(img.ocrText.slice(0, 50)))) {
        lines.push(`Visual Description: ${img.description.trim()}`);
      }

      // Attach same-page text chunks ONLY from the exact same document and exact same page
      if (hasChunks) {
        const samePageChunks = textChunks.filter(
          (c) =>
            c.pageNumber === img.pageNumber &&
            c.documentName === img.documentName &&
            !c.content?.startsWith("[Visual Screenshot Evidence")
        );

        if (samePageChunks.length > 0) {
          const samePageText = samePageChunks
            .map((c) => (c.content || "").trim())
            .filter(Boolean)
            .join("\n")
            .slice(0, 500);

          if (samePageText) {
            lines.push(`Same-Page Context:\n${samePageText}`);
          }
        }
      }

      contextSections.push(lines.join("\n"));
    });
  }

  const contextPrompt = contextSections.join("\n\n");

  return {
    contextPrompt,
    textChunks: textChunks || [],
    images: images || [],
    tabularResult
  };
}
