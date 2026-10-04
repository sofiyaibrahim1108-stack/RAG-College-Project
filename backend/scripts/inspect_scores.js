import { connectDB } from "../config/db.js";
import { DocumentChunk } from "../models/DocumentChunk.js";
import { generateTextEmbedding } from "../services/embeddingService.js";
import { cosineSimilarity } from "../utils/similarity.js";
import { extractQueryTerms, computeLexicalScore } from "../services/textRetrieval.js";

async function evaluate(q) {
  console.log("\n========================================================");
  console.log("Query:", q);
  const qEmb = await generateTextEmbedding(q);
  const qTerms = extractQueryTerms(q);

  const chunks = await DocumentChunk.find({
    documentName: "Eye disease.pdf",
    pageNumber: { $in: [59, 60, 61, 62] }
  }).lean();

  const scored = [];
  for (const c of chunks) {
    const sim = cosineSimilarity(qEmb, c.embedding);
    const lex = computeLexicalScore(qTerms, q, c.content || "", new Set(["eye", "disease"]));
    const hybrid = (0.5 * sim) + (0.5 * lex);
    scored.push({ page: c.pageNumber, type: c.sourceType || "text", idx: c.chunkIndex, sim, lex, hybrid });
  }

  scored.sort((a, b) => b.hybrid - a.hybrid);
  for (const s of scored) {
    console.log(`Page ${s.page} [${s.type}] idx=${s.idx}: sim=${s.sim.toFixed(4)}, lex=${s.lex.toFixed(4)}, hybrid=${s.hybrid.toFixed(4)}`);
  }
}

async function main() {
  await connectDB();
  await evaluate("In the prediction probability bar chart for the DR case, which bar is higher, and what are the two categories?");
  await evaluate("In the sample output where no disease is detected, what is the confidence percentage and what risk message is shown?");
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
