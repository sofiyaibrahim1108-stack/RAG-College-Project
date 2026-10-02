import { connectDB } from "../config/db.js";
import { ImageModel } from "../models/Image.js";
import { DocumentChunk } from "../models/DocumentChunk.js";
import { extractOcrText, terminateOcrWorker } from "../services/ocrService.js";
import { generateTextEmbedding } from "../services/embeddingService.js";

async function backfill() {
  console.log("[Backfill] Connecting to MongoDB...");
  await connectDB();

  const images = await ImageModel.find({});
  console.log(`[Backfill] Found ${images.length} images to check/enrich with OCR.`);

  for (const img of images) {
    if (!img.imagePath) continue;
    console.log(`[Backfill] Extracting OCR for ${img.filename} (Page ${img.pageNumber} of ${img.documentName})...`);
    const ocrText = await extractOcrText(img.imagePath);

    if (ocrText) {
      img.ocrText = ocrText;
      // Also update description if it was minimal
      if (!img.description || img.description.length < 10) {
        img.description = ocrText.slice(0, 500);
      }
      await img.save();

      // Check if chunk already exists
      const existingChunk = await DocumentChunk.findOne({
        documentId: img.documentId,
        sourceType: "visual_ocr",
        sourcePath: img.imagePath
      });

      if (!existingChunk && ocrText.trim().length >= 10) {
        console.log(`[Backfill] Generating embedding for OCR chunk: ${img.filename}...`);
        const content = `[Visual Screenshot Evidence (Page ${img.pageNumber})]:\n${ocrText.trim()}`;
        try {
          const emb = await generateTextEmbedding(content);
          const maxChunk = await DocumentChunk.findOne({ documentId: img.documentId })
            .sort({ chunkIndex: -1 })
            .select("chunkIndex")
            .lean();
          const nextIndex = (maxChunk?.chunkIndex ?? 0) + 1;

          await DocumentChunk.create({
            documentId: img.documentId,
            documentName: img.documentName,
            pageNumber: img.pageNumber || 1,
            chunkIndex: nextIndex,
            content,
            department: img.department || "General",
            sourceType: "visual_ocr",
            sourcePath: img.imagePath,
            embedding: emb
          });
          console.log(`[Backfill] Created visual OCR chunk for ${img.filename}`);
        } catch (e) {
          console.warn(`[Backfill] Failed embedding chunk for ${img.filename}: ${e.message}`);
        }
      }
    }
  }

  await terminateOcrWorker();
  console.log("[Backfill] OCR enrichment complete!");
  process.exit(0);
}

backfill().catch((err) => {
  console.error("[Backfill Error]", err);
  process.exit(1);
});
