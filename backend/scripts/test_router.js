import { connectDB } from "../config/db.js";
import { routeDepartment } from "../services/router.js";

async function main() {
  await connectDB();

  const testCases = [
    "What input size does the DR model need?",
    "How is two-stage training carried out?",
    "Confusion matrix results?",
    "What is the accuracy of EfficientNetB0?",
    "Accuracy of EfficientNetB0?",
    "Does the system classify DR severity stages? Total images?",
    "Highest total marks?",
    "How many students got Grade A, B, C?",
    "2024-25 placements at XYZ College?",
    "Grade for 85 marks at XYZ College?",
    "Does DR system detect glaucoma? Highest package in 2025-26?",
    "Explain var, let, const.",
    "What is the difference between == and ===?",
    "What optimizer was used for training?",
    "Who won the cricket World Cup?",
    "What does the screenshot on page 58 show?"
  ];

  console.log("----------------------------------------------------------------------------------");
  console.log("ROUTER TEST RESULTS");
  console.log("----------------------------------------------------------------------------------");

  for (const q of testCases) {
    const t0 = Date.now();
    const res = await routeDepartment(q);
    const ms = Date.now() - t0;
    console.log(`${String(ms).padStart(3)}ms | ${res.queryType.padEnd(12)} | [${res.departments.join(", ")}] <- "${q}"`);
  }
  console.log("----------------------------------------------------------------------------------");
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
