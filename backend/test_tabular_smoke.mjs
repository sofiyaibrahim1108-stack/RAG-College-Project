import {
  parseDeterministicQueryPlan,
  checkPlanCoverage,
  analyseColumns,
  loadRows,
  validateSemanticPlan,
  formatTabularTemplateAnswer,
  parseSemanticQueryPlan
} from "./services/tabularProcessor.js";

const sampleDoc = {
  path: "d:/Development/RAG-College/backend/uploads/documents/1791093176744_student_marks_dataset.csv",
  originalName: "student_marks_dataset.csv"
};

const rows = loadRows(sampleDoc);
const colInfo = analyseColumns(rows);

console.log("Schema Columns:", colInfo.map(c => c.name));

const tests = [
  "i wanto know the science and english and also a tola mark then average of ananya iyer",
  "i want to know rhea sen maths and science mark?",
  "Which students have Math below 60?"
];

for (const q of tests) {
  console.log("\n========================================");
  console.log("QUESTION:", q);
  const plan = parseDeterministicQueryPlan(q, colInfo);
  console.log("DETERMINISTIC PLAN:", plan ? {
    operation: plan.operation,
    targetColumn: plan.targetColumn,
    targetColumns: plan.targetColumns,
    filters: plan.filters
  } : null);
  const coverage = checkPlanCoverage(q, plan, colInfo, rows);
  console.log("COVERAGE:", {
    isComplete: coverage.isComplete,
    reason: coverage.reason,
    plausibleUnconsumed: coverage.plausibleUnconsumed,
    unconsumedTokens: coverage.unconsumedTokens
  });

  if (!coverage.isComplete) {
    console.log("--> Escalating to LLM semantic planner...");
    const t0 = Date.now();
    const llmPlan = await parseSemanticQueryPlan(q, sampleDoc.originalName, colInfo);
    console.log(`LLM PLAN (${Date.now() - t0}ms):`, llmPlan);
    const validation = validateSemanticPlan(llmPlan, colInfo, rows);
    console.log("VALIDATION:", {
      valid: validation.valid,
      operation: validation.operation,
      targetColumns: validation.targetColumns?.map(c => c.name),
      filters: validation.filters,
      unresolved: validation.unresolved
    });
  }
}
