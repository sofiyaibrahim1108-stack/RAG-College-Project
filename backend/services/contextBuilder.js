/**
 * Constructs the contextual prompt payload for the LLM
 * Combines retrieved text chunks, image references, and deterministic tabular tool results.
 * Clearly separates evidence categories with precise document and page citations.
 *
 * @param {Array<Object>} textChunks
 * @param {Array<Object>} images
 * @param {Object|null} tabularResult
 * @param {string} question
 * @returns {{ contextPrompt: string, textChunks: Array<Object>, images: Array<Object>, tabularResult: Object|null }}
 */
export function buildRAGContext(textChunks = [], images = [], tabularResult = null, question = "") {
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
  // For aggregate operations the tool result is the ONLY authoritative evidence from that dataset:
  // raw rows are withheld so the LLM cannot substitute one row's value for the aggregate.
  const isAggregateTool = hasTabular && tabularResult.operation !== "preview" && tabularResult.computedValue !== null;
  if (hasTabular && tabularResult.computedValue !== null) {
    contextSections.push("=== AUTHORITATIVE TABULAR TOOL RESULT ===");
    const computedLine = tabularResult.computedValue !== null && tabularResult.computedValue !== undefined
      ? `\nComputed Value: ${tabularResult.computedValue}`
      : "";
    contextSections.push(
      `Document: ${tabularResult.documentName}\nOperation: ${tabularResult.operation}${computedLine}\nCalculation Result:\n${tabularResult.summary}\n\n` +
      `CRITICAL DIRECTIVE:\n` +
      `The value above (${tabularResult.computedValue}) was computed programmatically across all relevant rows of the full dataset.\n` +
      `You MUST report this exact computed value as the answer. Do not recompute it, estimate it, or replace it with any number from an individual row.`
    );
  }
  if (isAggregateTool) {
    textChunks = (textChunks || []).filter((c) => c.documentName !== tabularResult.documentName);
  }
  const hasTextAfterTool = Array.isArray(textChunks) && textChunks.length > 0;

  // Determine if this is a strict visual QA question focused on a screenshot or visual elements
  const isStrictVisualQA = hasImages && (
    /\b(screenshot|describe\s+only\s+the\s+visual|visual\s+elements|do\s+not\s+use\s+surrounding\s+text)\b/i.test(question) ||
    (/\b(?:page|p\.?)\s*\d+\b/i.test(question) && /\b(?:show|contain|display|screenshot|image)\b/i.test(question))
  );

  // 2. Document Excerpts Section (omitted for strict visual QA to prevent surrounding text leakage)
  const seenContents = new Set();
  if (hasTextAfterTool && !isStrictVisualQA) {
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

      // Attach same-page text chunks ONLY if not strict visual QA
      if (hasChunks && !isStrictVisualQA) {
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

    if (isStrictVisualQA) {
      contextSections.push(`=== STRICT VISUAL QA GUIDELINES ===
The user requested visual description grounded ONLY in the requested image.
Base your answer exclusively on the visual elements, labels, buttons, and text visibly present in the screenshot/image above.
Do not use surrounding document text or external knowledge.
List each visual element at most once without repeating duplicate elements.`);
    }
  }

  // 4. Multi-Topic / Multi-Question Guidance (generic multi-question detection)
  const isMultiTopic = Boolean(question) &&
    question.includes("?") && question.indexOf("?") < question.length - 2;
  if (isMultiTopic) {
    contextSections.push(`=== MULTI-TOPIC QUERY GUIDELINES ===
The user's question covers multiple separate questions/topics. Address EACH question separately:
1. Address what is explicitly supported in the retrieved evidence for each topic.
2. If any requested information is not present in the retrieved evidence, explicitly state that it was not found in the uploaded documents rather than guessing.`);
  }

  const contextPrompt = contextSections.join("\n\n");

  return {
    contextPrompt,
    textChunks: textChunks || [],
    images: images || [],
    tabularResult
  };
}
