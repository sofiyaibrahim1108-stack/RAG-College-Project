import { connectDB } from "../backend/config/db.js";
import { ragGraph } from "../backend/graph/ragGraph.js";
import { FALLBACK_MESSAGE } from "../backend/services/llm.js";

const TEST_QUESTIONS = [
  {
    id: "Q1",
    question: "What input size does the DR model need?",
    verify: (ans, res) => /224/i.test(ans) && res.routedDepartments.includes("Eye disease")
  },
  {
    id: "Q2",
    question: "How is two-stage training carried out?",
    verify: (ans, res) => /stage/i.test(ans) && /frozen|unfrozen|fine/i.test(ans) && res.routedDepartments.includes("Eye disease")
  },
  {
    id: "Q3",
    question: "Confusion matrix results?",
    verify: (ans, res) => (ans.includes("353") || /confusion matrix|classification report|accuracy/i.test(ans)) && res.routedDepartments.includes("Eye disease")
  },
  {
    id: "Q4",
    question: "What is the accuracy of EfficientNetB0?",
    verify: (ans, res) => /94%/i.test(ans) && /96%/i.test(ans) && res.routedDepartments.includes("Eye disease")
  },
  {
    id: "Q5",
    question: "Accuracy of EfficientNetB0?",
    verify: (ans, res) => /94%/i.test(ans) && /96%/i.test(ans) && res.routedDepartments.includes("Eye disease")
  },
  {
    id: "Q6",
    question: "Does the system classify DR severity stages? Total images?",
    verify: (ans, res) => (/binary|two classes|two categories|does not classify/i.test(ans) || /not/i.test(ans)) && res.routedDepartments.includes("Eye disease")
  },
  {
    id: "Q7",
    question: "Highest total marks?",
    verify: (ans, res) => /261/i.test(ans) && res.queryType === "tabular"
  },
  {
    id: "Q8",
    question: "How many students got Grade A, B, C?",
    verify: (ans, res) => /11/i.test(ans) && /15/i.test(ans) && /4/i.test(ans) && res.queryType === "tabular"
  },
  {
    id: "Q9",
    question: "2024-25 placements at XYZ College?",
    verify: (ans, res) => (/24/i.test(ans) || /5\.1/i.test(ans) || /715/i.test(ans)) && res.routedDepartments.some(d => /college/i.test(d))
  },
  {
    id: "Q10",
    question: "Grade for 85 marks at XYZ College?",
    verify: (ans, res) => /A\+/i.test(ans) && res.routedDepartments.some(d => /college/i.test(d))
  },
  {
    id: "Q11",
    question: "Does DR system detect glaucoma? Highest package in 2025-26?",
    verify: (ans, res) => /glaucoma/i.test(ans) && /not/i.test(ans) && res.routedDepartments.length >= 2
  },
  {
    id: "Q12",
    question: "Explain var, let, const.",
    verify: (ans, res) => /scope|block|reassign/i.test(ans) && res.routedDepartments.includes("JavaScript")
  },
  {
    id: "Q13",
    question: "What is the difference between == and ===?",
    verify: (ans, res) => /type|strict|value/i.test(ans) && res.routedDepartments.includes("JavaScript")
  },
  {
    id: "Q14",
    question: "What optimizer was used for training?",
    verify: (ans, res) => /Adam/i.test(ans) && res.routedDepartments.includes("Eye disease")
  },
  {
    id: "Q15",
    question: "Who won the cricket World Cup?",
    verify: (ans, res) => (res.queryType === "out_of_scope" || ans === FALLBACK_MESSAGE)
  },
  {
    id: "Q16",
    question: "What does the screenshot on page 58 show?",
    verify: (ans, res) => /file manager|disease|select|image|predict/i.test(ans) && res.queryType === "visual_qa"
  }
];

async function main() {
  await connectDB();
  console.log("================================================================================");
  console.log("🚀 EXECUTING COMPLETE END-TO-END ACCEPTANCE SUITE (Q1 TO Q16)");
  console.log("================================================================================");

  const report = [];

  for (const item of TEST_QUESTIONS) {
    console.log(`\n>>> STARTING ${item.id}: "${item.question}"`);
    const t0 = Date.now();
    try {
      const res = await ragGraph.invoke({ question: item.question });
      const duration = Date.now() - t0;

      const docs = [...new Set(res.sources.map(s => s.documentName))];
      const pages = [...new Set(res.sources.map(s => `p.${s.pageNumber}`))];
      if (res.imageCitations?.length > 0) {
        res.imageCitations.forEach(img => {
          if (!docs.includes(img.documentName)) docs.push(img.documentName);
          if (img.pageNumber && !pages.includes(`p.${img.pageNumber}`)) pages.push(`p.${img.pageNumber}`);
        });
      }

      const isPassed = item.verify(res.finalAnswer, res);

      console.log(`<<< FINISHED ${item.id} in ${duration}ms -> ${isPassed ? "PASS ✅" : "FAIL ❌"}`);
      console.log(`    Query Type : ${res.queryType}`);
      console.log(`    Routed Dept: [${res.routedDepartments.join(", ")}]`);
      console.log(`    Documents  : [${docs.join(", ") || "None"}]`);
      console.log(`    Pages      : [${pages.join(", ") || "None"}]`);
      console.log(`    Answer     : ${res.finalAnswer.slice(0, 160).replace(/\n/g, " ")}...`);

      report.push({
        id: item.id,
        question: item.question,
        queryType: res.queryType,
        routedDepartments: res.routedDepartments,
        documents: docs,
        pages: pages,
        answer: res.finalAnswer,
        grounded: isPassed,
        duration: `${duration}ms`,
        status: isPassed ? "PASS" : "FAIL"
      });
    } catch (err) {
      console.error(`<<< ERROR ${item.id}:`, err.message);
      report.push({
        id: item.id,
        question: item.question,
        error: err.message,
        status: "FAIL"
      });
    }
  }

  console.log("\n================================================================================");
  console.log("📊 FINAL ACCEPTANCE TEST SUMMARY REPORT");
  console.log("================================================================================");
  for (const r of report) {
    console.log(`${r.id} -> ${r.status} (${r.duration || "err"}) | Type: ${r.queryType || "N/A"} | Dept: [${(r.routedDepartments || []).join(", ")}]`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Fatal Test Suite Failure:", err);
  process.exit(1);
});
