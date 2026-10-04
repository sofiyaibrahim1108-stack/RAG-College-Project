import { connectDB } from "../config/db.js";
import { ragGraph } from "../graph/ragGraph.js";

async function main() {
  await connectDB();
  const q = "In the prediction probability bar chart for the DR case, which bar is higher, and what are the two categories?";
  console.log("=== RUNNING GRAPH FOR QUERY ===");
  console.log(q);
  const state = await ragGraph.invoke({
    question: q,
    conversationHistory: []
  });

  console.log("\n=== FINAL ANSWER ===");
  console.log(state.finalAnswer);
  console.log("\n=== IMAGES ATTACHED ===");
  console.log(JSON.stringify(state.imageCitations, null, 2));
  console.log("\n=== SOURCES ===");
  console.log(JSON.stringify(state.sources, null, 2));

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
