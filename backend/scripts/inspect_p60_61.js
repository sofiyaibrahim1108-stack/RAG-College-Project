import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { DocumentChunk } from "../models/DocumentChunk.js";
import { generateTextEmbedding } from "../services/embeddingService.js";
import { cosineSimilarity } from "../utils/similarity.js";

async function main() {
  await connectDB();
  const q = "In the prediction probability bar chart for the DR case, which bar is higher, and what are the two categories?";
  console.log("Query:", q);
  const qEmb = await generateTextEmbedding(q);

  const chunks = await DocumentChunk.find({
    documentName: "Eye disease.pdf",
    pageNumber: { $in: [59, 60, 61, 62] }
  }).lean();

  for (const c of chunks) {
    const sim = cosineSimilarity(qEmb, c.embedding);
    console.log(`\n=== Page ${c.pageNumber} [${c.sourceType || 'text'}] idx=${c.chunkIndex} (sim=${sim.toFixed(4)}) ===`);
    console.log(`ImageRef:`, c.imageRef?.filename);
    console.log(c.content);
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
