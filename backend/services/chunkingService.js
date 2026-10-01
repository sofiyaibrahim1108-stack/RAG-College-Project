import { RAG_CONFIG } from "../config/rag.js";

/**
 * Splits text into chunks using recursive separator priority:
 * 1. Double newline (paragraphs)
 * 2. Single newline (lines)
 * 3. Sentence boundaries (. ! ?)
 * 4. Words (space)
 * 5. Characters
 */
export function recursiveSplitText(
  text,
  chunkSize = RAG_CONFIG.chunkSize,
  chunkOverlap = RAG_CONFIG.chunkOverlap
) {
  if (!text || typeof text !== "string") return [];

  const separators = ["\n\n", "\n", ". ", "? ", "! ", " ", ""];
  
  function split(textToSplit, sepIndex = 0) {
    if (textToSplit.length <= chunkSize) {
      const trimmed = textToSplit.trim();
      return trimmed.length >= RAG_CONFIG.minChunkLength ? [trimmed] : [];
    }

    if (sepIndex >= separators.length) {
      // Direct hard chunking
      const chunks = [];
      let i = 0;
      while (i < textToSplit.length) {
        chunks.push(textToSplit.slice(i, i + chunkSize).trim());
        i += chunkSize - chunkOverlap;
      }
      return chunks.filter(c => c.length >= RAG_CONFIG.minChunkLength);
    }

    const sep = separators[sepIndex];
    const splits = textToSplit.split(sep);
    const result = [];
    let currentChunk = "";

    for (let i = 0; i < splits.length; i++) {
      const piece = splits[i];
      const testChunk = currentChunk ? currentChunk + sep + piece : piece;

      if (testChunk.length <= chunkSize) {
        currentChunk = testChunk;
      } else {
        if (currentChunk.trim().length >= RAG_CONFIG.minChunkLength) {
          result.push(currentChunk.trim());
        }
        // If single piece is itself too big, recurse deeper
        if (piece.length > chunkSize) {
          const subChunks = split(piece, sepIndex + 1);
          result.push(...subChunks);
          currentChunk = "";
        } else {
          currentChunk = piece;
        }
      }
    }

    if (currentChunk.trim().length >= RAG_CONFIG.minChunkLength) {
      result.push(currentChunk.trim());
    }

    return result;
  }

  return split(text);
}

/**
 * Chunks structured pages (from PDF, DOCX, TXT) into chunk objects ready for embedding & storage
 * @param {Array<{ text: string, pageNumber: number }>} pages
 * @param {Object} documentMeta
 * @returns {Array<Object>}
 */
export function chunkDocumentPages(pages, documentMeta) {
  const allChunks = [];
  let globalChunkIndex = 0;

  for (const page of pages) {
    let rawChunks = recursiveSplitText(page.text);
    if (rawChunks.length === 0 && page.text && page.text.trim().length > 0) {
      rawChunks = [page.text.trim()];
    }
    for (const chunkText of rawChunks) {
      let structuredContent = chunkText;
      // Prepend structural header if chunk doesn't already have one
      if (!chunkText.startsWith("[")) {
        if (page.sheetName) {
          structuredContent = `[Sheet: ${page.sheetName}]\n${chunkText}`;
        } else if (page.slideNumber) {
          structuredContent = `[Slide: ${page.slideNumber}]\n${chunkText}`;
        } else if (page.section) {
          structuredContent = `[Section: ${page.section}]\n${chunkText}`;
        }
      }

      allChunks.push({
        documentId: documentMeta._id,
        documentName: documentMeta.originalName,
        pageNumber: page.pageNumber || 1,
        chunkIndex: globalChunkIndex++,
        content: structuredContent,
        department: documentMeta.department || "General",
        sourceType: documentMeta.source || "upload",
        sourcePath: documentMeta.path || ""
      });
    }
  }

  return allChunks;
}
