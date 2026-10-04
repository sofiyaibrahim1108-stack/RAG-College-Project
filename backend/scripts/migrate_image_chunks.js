import { connectDB } from "../config/db.js";
import { Document } from "../models/Document.js";
import { ImageModel } from "../models/Image.js";
import { DocumentChunk } from "../models/DocumentChunk.js";
import { extractOcrText, terminateOcrWorker } from "../services/ocrService.js";
import { generateBatchTextEmbeddings } from "../services/embeddingService.js";

/**
 * Migration Script: Builds multimodal text chunks with imageRef for existing documents.
 * 
 * For every extracted image in existing documents:
 * 1. Derives page heading and native page text from the document's text chunks
 * 2. Combines heading/native text + image caption + OCR text into ONE rich semantic chunk
 * 3. Sets imageRef: { documentId, filename, pageNumber }
 * 4. Generates standard text vector embeddings using the configured embedding model (Ollama)
 * 5. Replaces legacy visual_ocr chunks with image_chunk records
 */
export async function migrateImageChunks() {
  console.log("=== Starting Image Chunks Migration ===");
  await connectDB();

  const documents = await Document.find({ status: "completed" });
  console.log(`[Migration] Found ${documents.length} completed documents to inspect.`);

  let totalNewChunks = 0;

  for (const doc of documents) {
    const rawImages = await ImageModel.find({ documentId: doc._id }).lean();
    if (!rawImages || rawImages.length === 0) {
      console.log(`[Migration] Skipping ${doc.originalName} (no images).`);
      continue;
    }

    // Deduplicate images by filename
    const seenFilenames = new Set();
    const images = [];
    for (const img of rawImages) {
      if (!seenFilenames.has(img.filename)) {
        seenFilenames.add(img.filename);
        images.push(img);
      }
    }

    console.log(`[Migration] Processing ${images.length} unique images for: ${doc.originalName}`);

    // Map existing native page text
    const textChunks = await DocumentChunk.find({
      documentId: doc._id,
      sourceType: { $nin: ["visual_ocr", "image_chunk"] }
    })
      .sort({ chunkIndex: 1 })
      .lean();

    const pageTextMap = new Map();
    for (const c of textChunks) {
      const p = c.pageNumber || 1;
      if (!pageTextMap.has(p)) pageTextMap.set(p, []);
      pageTextMap.get(p).push(c.content || "");
    }

    // Helper to get heading and native text
    const getPageContext = (pageNum) => {
      const chunks = pageTextMap.get(pageNum) || [];
      const combined = chunks.join("\n").trim();
      const lines = combined
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !/^\d+$/.test(l));

      let heading = lines.length > 0 ? lines[0] : "";

      // Look backward if page has only numbers / empty text
      if (!heading && pageNum > 1) {
        for (let p = pageNum - 1; p >= Math.max(1, pageNum - 3); p--) {
          const prevChunks = pageTextMap.get(p) || [];
          const prevCombined = prevChunks.join("\n").trim();
          const prevLines = prevCombined
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !/^\d+$/.test(l));
          if (prevLines.length > 0) {
            heading = prevLines[0];
            break;
          }
        }
      }

      const native = lines.slice(0, 3).join("\n").slice(0, 400);
      return { heading, native };
    };

    const newImageChunks = [];

    for (const img of images) {
      let ocrText = img.ocrText || "";
      if (!ocrText && img.imagePath) {
        try {
          ocrText = await extractOcrText(img.imagePath);
          if (ocrText) {
            await ImageModel.findByIdAndUpdate(img._id, { ocrText });
          }
        } catch (e) {
          console.warn(`[Migration] OCR notice for ${img.filename}: ${e.message}`);
        }
      }

      const { heading, native } = getPageContext(img.pageNumber || 1);

      const parts = [];
      if (heading) {
        parts.push(heading);
      }
      if (native && native !== heading) {
        parts.push(native);
      }
      if (img.caption && img.caption.trim() && !parts.some((p) => p.includes(img.caption.trim()))) {
        parts.push(`Caption: ${img.caption.trim()}`);
      }
      if (ocrText && ocrText.trim()) {
        parts.push(`OCR: ${ocrText.trim()}`);
      }

      const content = parts.join("\n\n").trim();
      if (content.length < 10) continue;

      newImageChunks.push({
        documentId: doc._id,
        documentName: doc.originalName,
        pageNumber: img.pageNumber || 1,
        content,
        department: doc.department || "General",
        sourceType: "image_chunk",
        sourcePath: img.imagePath || "",
        imageRef: {
          documentId: doc._id,
          filename: img.filename,
          pageNumber: img.pageNumber || 1
        }
      });
    }

    if (newImageChunks.length > 0) {
      console.log(`[Migration] Generating embeddings for ${newImageChunks.length} image chunks of ${doc.originalName}...`);
      const texts = newImageChunks.map((c) => c.content);
      const embeddings = await generateBatchTextEmbeddings(texts, 1);

      // Find max chunkIndex among native text chunks
      let nextIndex = textChunks.reduce((max, c) => Math.max(max, c.chunkIndex ?? 0), -1) + 1;

      for (let i = 0; i < newImageChunks.length; i++) {
        newImageChunks[i].chunkIndex = nextIndex++;
        newImageChunks[i].embedding = embeddings[i];
      }

      // Remove legacy visual_ocr chunks and previous image_chunk records for this document
      const delResult = await DocumentChunk.deleteMany({
        documentId: doc._id,
        sourceType: { $in: ["visual_ocr", "image_chunk"] }
      });
      console.log(`[Migration] Cleaned up ${delResult.deletedCount} legacy visual_ocr / old image_chunk entries.`);

      // Insert new rich image_chunk records
      await DocumentChunk.insertMany(newImageChunks);
      totalNewChunks += newImageChunks.length;

      // Update total chunkCount on Document
      const totalCount = await DocumentChunk.countDocuments({ documentId: doc._id });
      await Document.findByIdAndUpdate(doc._id, { chunkCount: totalCount });
      console.log(`[Migration] Document ${doc.originalName} updated with ${totalCount} total chunks.`);
    }
  }

  await terminateOcrWorker();
  console.log(`=== Migration Complete: Created ${totalNewChunks} image-derived chunks across all documents. ===`);
}

// Self-invoking when executed directly from CLI
if (process.argv[1] && process.argv[1].includes("migrate_image_chunks.js")) {
  migrateImageChunks()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[Migration Fatal Error]", err);
      process.exit(1);
    });
}
