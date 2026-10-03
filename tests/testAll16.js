import { connectDB } from "../backend/config/db.js";
import { ragGraph } from "../backend/graph/ragGraph.js";

const QUESTIONS = [
  { id: "Q1", q: "What input size does the DR model need?" },
  { id: "Q2", q: "How is two-stage training carried out?" },
  { id: "Q3", q: "Confusion matrix results?" },
  { id: "Q4", q: "What is the accuracy of EfficientNetB0?" },
  { id: "Q5", q: "Accuracy of EfficientNetB0?" },
  { id: "Q6", q: "Does the system classify DR severity stages? Total images?" },
  { id: "Q7", q: "Highest total marks?" },
  { id: "Q8", q: "How many students got Grade A, B, C?" },
  { id: "Q9", q: "2024-25 placements at XYZ College?" },
  { id: "Q10", q: "Grade for 85 marks at XYZ College?" },
  { id: "Q11", q: "Does DR system detect glaucoma? Highest package in 2025-26?" },
  { id: "Q12", q: "Explain var, let, const." },
  { id: "Q13", q: "What is the difference between == and ===?" },
  { id: "Q14", q: "What optimizer was used for training?" },
  { id: "Q15", q: "Who won the cricket World Cup?" },
  { id: "Q16", q: "What does the screenshot on page 58 show?" }
];

async function main() {
  await connectDB();
  console.log("================ STARTING 16 QUESTIONS TEST ================");

  for (const item of QUESTIONS) {
    console.log(`\n------------------------------------------------------------`);
    console.log(`Testing ${item.id}: "${item.q}"`);
    const t0 = Date.now();
    try {
      const res = await ragGraph.invoke({ question: item.q });
      const elapsed = Date.now() - t0;
      console.log(`[${item.id} DONE in ${elapsed}ms]`);
      console.log(`  QueryType : ${res.queryType}`);
      console.log(`  RoutedDept: ${JSON.stringify(res.routedDepartments)}`);
      console.log(`  Sources   : ${res.sources.map(s => `${s.documentName} p.${s.pageNumber}`).join(", ") || "None"}`);
      console.log(`  Images    : ${res.imageCitations.map(i => `${i.documentName} p.${i.pageNumber} (${i.filename})`).join(", ") || "None"}`);
      console.log(`  Answer    :\n${res.finalAnswer}`);
    } catch (e) {
      console.error(`[${item.id} ERROR]:`, e.message);
    }
  }
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
