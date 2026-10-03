import { connectDB } from "../backend/config/db.js";
import { ragGraph } from "../backend/graph/ragGraph.js";
import { FALLBACK_MESSAGE } from "../backend/services/llm.js";

const ACCEPTANCE_TESTS = [
  {
    id: 1,
    q: "What model is used for Diabetic Retinopathy detection?",
    expected: "EfficientNetB0 with Eye disease source"
  },
  {
    id: 2,
    q: "What optimizer was used for training?",
    expected: "Adam optimizer, Page 26 citation (or fallback if not retrieved)"
  },
  {
    id: 3,
    q: "Who won the cricket World Cup?",
    expected: "I couldn't find this in the uploaded documents."
  },
  {
    id: 4,
    q: "What does the screenshot on page 58 show?",
    expected: "Answer from Page 58 visual/screenshot evidence only"
  },
  {
    id: 5,
    q: "What is the difference between No_DR and DR?",
    expected: "Only if retrieved evidence explicitly defines them, else fallback"
  },
  {
    id: 6,
    q: "How is two-stage training carried out?",
    expected: "Stage 1 (frozen base) / Stage 2 (unfrozen fine-tuning) from evidence"
  },
  {
    id: 7,
    q: "What input size does the DR model need?",
    expected: "224x224 only if explicitly found in retrieved evidence"
  },
  {
    id: 8,
    q: "Does the system classify DR severity stages?",
    expected: "Binary classification only IF explicitly supported by document"
  },
  {
    id: 9,
    q: "Highest total marks?",
    expected: "Use CSV/tabular tool, not vector similarity"
  },
  {
    id: 10,
    q: "How many students got Grade A, B, C?",
    expected: "Use CSV/tabular tool"
  }
];

async function runAcceptanceTests() {
  await connectDB();
  console.log("================================================================================");
  console.log("🚀 STARTING SECTION 14 ACCEPTANCE TEST SUITE (10 TESTS)");
  console.log("================================================================================");

  const results = [];

  for (const item of ACCEPTANCE_TESTS) {
    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`>>> TEST ${item.id}: "${item.q}"`);
    console.log(`>>> Expected: ${item.expected}`);
    console.log(`--------------------------------------------------------------------------------`);

    const t0 = Date.now();
    try {
      const graphResult = await ragGraph.invoke({
        question: item.q
      });
      const duration = Date.now() - t0;

      console.log("RESULT:");
      console.log("  Query Type :", graphResult.queryType);
      console.log("  Routed Dept:", graphResult.routedDepartments);
      console.log("  Sources    :", graphResult.sources);
      console.log("  Images     :", graphResult.imageCitations);
      console.log("  Timings    :", JSON.stringify(graphResult.timings));
      console.log("  Answer     :\n" + graphResult.finalAnswer);
      console.log(`  Duration   : ${duration}ms`);

      results.push({
        id: item.id,
        question: item.q,
        queryType: graphResult.queryType,
        routedDepartments: graphResult.routedDepartments,
        sources: graphResult.sources,
        answer: graphResult.finalAnswer,
        timings: graphResult.timings,
        duration
      });
    } catch (err) {
      console.error(`[Test ${item.id} ERROR]:`, err.message);
      results.push({
        id: item.id,
        question: item.q,
        error: err.message
      });
    }
  }

  console.log("\n================================================================================");
  console.log("📊 SECTION 14 ACCEPTANCE TEST SUMMARY REPORT");
  console.log("================================================================================");
  for (const r of results) {
    if (r.error) {
      console.log(`❌ TEST ${r.id}: ERROR - ${r.error}`);
    } else {
      const isFallback = r.answer === FALLBACK_MESSAGE;
      console.log(
        `TEST ${r.id} [${r.queryType}] in ${r.duration}ms: ${r.answer.slice(0, 90).replace(/\n/g, " ")}...`
      );
    }
  }

  process.exit(0);
}

runAcceptanceTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});

