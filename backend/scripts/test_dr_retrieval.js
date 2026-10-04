import { connectDB } from "../config/db.js";
import { generateTextEmbedding } from "../services/embeddingService.js";
import { retrieveWithScopeFallback } from "../services/textRetrieval.js";

async function main() {
  await connectDB();
  const q = "In the prediction probability bar chart for the DR case, which bar is higher, and what are the two categories?";
  console.log("Query:", q);
  const qEmb = await generateTextEmbedding(q);

  const res = await retrieveWithScopeFallback(qEmb, ["Eye disease"], 5, q);
  console.log(`\nRetrieved ${res.chunks.length} chunks:`);
  for (const c of res.chunks) {
    console.log(`- Page ${c.pageNumber} idx=${c.chunkIndex} [${c.sourceType || 'text'}] sim=${c.similarity} lex=${c.lexicalScore} rankScore=${c.rankingScore} doc=${c.documentName}`);
    console.log(`  Preview: ${(c.content || '').slice(0, 150).replace(/\n/g, ' ')}`);
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
