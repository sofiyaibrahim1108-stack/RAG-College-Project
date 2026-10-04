import { connectDB } from "../backend/config/db.js";
import { ragGraph } from "../backend/graph/ragGraph.js";

async function main() {
  await connectDB();
  console.log("================================================================================");
  console.log("TEST: B.Arch Grounding Regression Test");
  console.log("================================================================================");

  const question = "What is the fee for the B.Arch. program at XYZ College?";
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

  const answer = res.finalAnswer || "";
  const sources = res.sources || [];

  // Verifications
  const claims85k = /85[,.]?000/i.test(answer);
  const mentionsUnavailable = /not provide|not listed|couldn'?t find|not found/i.test(answer) && /B\.?Arch/i.test(answer);
  const falseCitations = sources.some(s => /85[,.]?000|B\.E|B\.Tech/i.test(s.snippet || ""));

  let passed = true;
  const errors = [];

  if (claims85k) {
    passed = false;
    errors.push("Answer falsely claims 85,000 for B.Arch");
  }

  if (!mentionsUnavailable) {
    passed = false;
    errors.push("Answer does not indicate that B.Arch is not provided/listed");
  }

  if (falseCitations) {
    passed = false;
    errors.push("Sources falsely imply B.E./B.Tech fee is B.Arch fee");
  }

  console.log("================================================================================");
  if (passed) {
    console.log("✅ testBArch.js PASSED");
  } else {
    console.error("❌ testBArch.js FAILED:", errors.join("; "));
  }
  console.log("================================================================================");

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
