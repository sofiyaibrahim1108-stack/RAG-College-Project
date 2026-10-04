import { connectDB } from "../backend/config/db.js";
import { ragGraph } from "../backend/graph/ragGraph.js";

async function main() {
  await connectDB();
  console.log("================================================================================");
  console.log("TEST: Conflict-Handling Regression Test (EfficientNetB0 Accuracy)");
  console.log("================================================================================");

  const question = "What is the accuracy of EfficientNetB0?";
  console.log(`Question: "${question}"`);

  const t0 = Date.now();
  const res = await ragGraph.invoke({ question });
  const duration = Date.now() - t0;

  console.log(`Completed in ${duration}ms`);
  console.log("Query Type :", res.queryType);
  console.log("Routed Dept:", res.routedDepartments);
  console.log("Sources    :", res.sources);
  console.log("Images     :", res.imageCitations);
  console.log("Answer     :\n" + res.finalAnswer);

  const ans = res.finalAnswer || "";
  const has94 = /94%/i.test(ans);
  const has96 = /96%/i.test(ans);
  const isEyeDept = res.routedDepartments.includes("Eye disease");

  let passed = true;
  const errors = [];

  if (!has94) {
    passed = false;
    errors.push("Answer missing 94% figure");
  }
  if (!has96) {
    passed = false;
    errors.push("Answer missing 96% figure");
  }
  if (!isEyeDept) {
    passed = false;
    errors.push("Routed departments missing Eye disease");
  }

  console.log("================================================================================");
  if (passed) {
    console.log("✅ testSingle.js PASSED");
  } else {
    console.error("❌ testSingle.js FAILED:", errors.join("; "));
  }
  console.log("================================================================================");

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
