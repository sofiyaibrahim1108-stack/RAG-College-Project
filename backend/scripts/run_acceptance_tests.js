import { connectDB } from "../config/db.js";
import { ragGraph } from "../graph/ragGraph.js";

const ACCEPTANCE_TESTS = [
  {
    id: 1,
    question: "What input size does the DR model need?",
    expected: "EfficientNetB0, 224x224",
  },
  {
    id: 2,
    question: "How is two-stage training carried out?",
    expected: "Stage 1: base frozen, head trained. Stage 2: unfrozen last layers, smaller LR. Eye disease.pdf",
  },
  {
    id: 3,
    question: "Confusion matrix results?",
    expected: "[[353,10],[18,351]], 28 misclassified of 732",
  },
  {
    id: 4,
    question: "Accuracy of EfficientNetB0?",
    expected: "Conflict: ~96% in report vs 94% in code/UI. No invented 95.2%",
  },
  {
    id: 5,
    question: "Does the system classify DR severity stages? Total images?",
    expected: "Binary classification only. Total dataset size not stated in uploaded docs",
  },
  {
    id: 6,
    question: "Highest total marks?",
    expected: "Swati Pandey, 261, average 87, Grade A",
  },
  {
    id: 7,
    question: "How many students got Grade A, B, C?",
    expected: "A = 11, B = 15, C = 4",
  },
  {
    id: 8,
    question: "2024-25 placements at XYZ College?",
    expected: "715 placed, highest 24 LPA, average 5.1 LPA",
  },
  {
    id: 9,
    question: "Grade for 85 marks at XYZ College?",
    expected: "A+, grade point 9 (XYZ College Handbook)",
  },
  {
    id: 10,
    question: "Does DR system detect glaucoma? Highest package in 2025-26?",
    expected: "Not available in uploaded documents",
  },
  {
    id: 11,
    question: "Explain var, let, const.",
    expected: "Detailed answer using JavaScript guide",
  },
  {
    id: 12,
    question: "What is the difference between == and ===?",
    expected: "Grounded JavaScript guide answer",
  },
  {
    id: 13,
    question: "What is the accuracy of EfficientNetB0?",
    expected: "Routes to Eye disease, reports ~96% vs 94%",
  },
  {
    id: 14,
    question: "What optimizer was used for training?",
    expected: "Routes to Eye disease, Adam optimizer",
  },
  {
    id: 15,
    question: "Who won the cricket World Cup?",
    expected: "OUT_OF_SCOPE -> I couldn't find this information in the uploaded documents.",
  },
  {
    id: 16,
    question: "What does the screenshot on page 58 show?",
    expected: "Page 58 visual evidence (Selecting image from file manager / Moderate DR)",
  },
];

async function runTests() {
  await connectDB();
  console.log("================================================================================");
  console.log("STARTING FULL END-TO-END ACCEPTANCE TEST SUITE (16 REAL PIPELINE TESTS)");
  console.log("================================================================================\n");

  const results = [];

  for (const test of ACCEPTANCE_TESTS) {
    console.log(`>>> TEST #${test.id}: "${test.question}"`);
    console.log(`Expected: ${test.expected}`);
    const t0 = Date.now();

    try {
      const res = await ragGraph.invoke({ question: test.question });
      const duration = Date.now() - t0;

      console.log(`Answer:\n${res.finalAnswer}\n`);
      console.log(`Routed Departments: [${(res.routedDepartments || []).join(", ")}]`);
      console.log(`Query Type: ${res.queryType}`);
      console.log(`Timings: Router: ${res.timings?.router || 0}ms, Retrieval: ${res.timings?.retrieval || res.timings?.textRetrieval || 0}ms, Evidence Gate: ${res.timings?.evidenceGate || 0}ms, Generation: ${res.timings?.generation || res.timings?.llm || 0}ms, Total: ${duration}ms`);
      if (res.sources?.length > 0) {
        console.log(`Sources: ${res.sources.map(s => `${s.documentName} p.${s.pageNumber}`).join("; ")}`);
      }
      if (res.imageCitations?.length > 0) {
        console.log(`Image Citations: ${res.imageCitations.map(i => `${i.documentName} p.${i.pageNumber} (${i.caption || i.filename})`).join("; ")}`);
      }
      console.log("--------------------------------------------------------------------------------\n");

      results.push({
        id: test.id,
        question: test.question,
        expected: test.expected,
        answer: res.finalAnswer,
        depts: res.routedDepartments,
        queryType: res.queryType,
        timings: res.timings,
        duration,
        sources: res.sources,
        images: res.imageCitations
      });
    } catch (err) {
      console.error(`ERROR in Test #${test.id}: ${err.message}\n`);
      results.push({
        id: test.id,
        question: test.question,
        error: err.message,
        duration: Date.now() - t0
      });
    }
  }

  console.log("================================================================================");
  console.log("ACCEPTANCE TEST SUMMARY COMPLETED");
  console.log("================================================================================");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("Fatal Test Suite Error:", err);
  process.exit(1);
});
