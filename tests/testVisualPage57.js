import { connectDB } from "../backend/config/db.js";
import { ragGraph } from "../backend/graph/ragGraph.js";

async function main() {
  await connectDB();
  console.log("================================================================================");
  console.log("TEST: Visual QA Page 57 Regression Test");
  console.log("================================================================================");

  const question = "Describe only the visual elements visible in the screenshot on page 57. Do not use surrounding text or general knowledge.";
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
  const images = res.imageCitations || [];

  let passed = true;
  const errors = [];

  // 1. query type = visual_qa
  if (res.queryType !== "visual_qa") {
    passed = false;
    errors.push(`Expected queryType visual_qa, got ${res.queryType}`);
  }

  // 2. requested page = 57 & visual source = Eye disease.pdf page 57
  const hasPage57Image = images.some(img => img.pageNumber === 57 && /Eye disease/i.test(img.documentName));
  if (!hasPage57Image) {
    passed = false;
    errors.push("Expected visual citation for Eye disease.pdf page 57");
  }

  // 3. no unrelated department/document citations
  const allDocs = [...new Set([...sources.map(s => s.documentName), ...images.map(i => i.documentName)])];
  const unrelatedDocs = allDocs.filter(d => !/Eye disease/i.test(d));
  if (unrelatedDocs.length > 0) {
    passed = false;
    errors.push(`Found unrelated document citations: ${unrelatedDocs.join(", ")}`);
  }

  const unrelatedDepts = (res.routedDepartments || []).filter(d => !/Eye disease/i.test(d));
  if (unrelatedDepts.length > 0) {
    passed = false;
    errors.push(`Found unrelated routed departments: ${unrelatedDepts.join(", ")}`);
  }

  const otherPages = images.filter(img => img.pageNumber !== 57);
  if (otherPages.length > 0) {
    passed = false;
    errors.push(`Found images from other pages: ${otherPages.map(p => p.pageNumber).join(", ")}`);
  }

  // 4. answer should not contain duplicate repeated elements
  const lines = answer.split("\n").map(l => l.trim()).filter(Boolean);
  const listItems = lines
    .filter(l => /^(?:\d+[\.\)]|[-*•])\s+/.test(l))
    .map(l => l.replace(/^(?:\d+[\.\)]|[-*•])\s+/, "").toLowerCase().replace(/[^a-z0-9]/g, ""));

  const duplicates = listItems.filter((item, idx) => item.length > 5 && listItems.indexOf(item) !== idx);
  if (duplicates.length > 0) {
    passed = false;
    errors.push(`Answer contains duplicate repeated elements: ${duplicates.join(", ")}`);
  }

  console.log("================================================================================");
  if (passed) {
    console.log("✅ testVisualPage57.js PASSED");
  } else {
    console.error("❌ testVisualPage57.js FAILED:", errors.join("; "));
  }
  console.log("================================================================================");

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
