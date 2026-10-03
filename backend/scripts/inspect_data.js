import { connectDB } from "../config/db.js";
import { DocumentChunk } from "../models/DocumentChunk.js";

async function main() {
  await connectDB();
  const chunks = await DocumentChunk.find({
    documentName: /JavaScript/i,
    pageNumber: { $in: [5, 6, 7, 8, 9, 10] }
  }).select("pageNumber content").lean();

  chunks.forEach(c => {
    console.log(`=== Page ${c.pageNumber} ===\n${c.content}\n`);
  });
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
