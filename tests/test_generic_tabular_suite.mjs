import {
  parseDeterministicQueryPlan,
  validateSemanticPlan,
  executePlan,
  formatTabularTemplateAnswer,
  loadRows,
  analyseColumns
} from "../backend/services/tabularProcessor.js";
import assert from "assert";

console.log("=== RUNNING COMPREHENSIVE TABULAR DATA TEST SUITE ===");

const studentDoc = {
  path: "d:/Development/RAG-College/backend/uploads/documents/1791093176744_student_marks_dataset.csv",
  originalName: "student_marks_dataset.csv"
};

const empDoc = {
  path: "d:/Development/RAG-College/backend/scratch/employees.xlsx",
  originalName: "employees.xlsx"
};

const studentRows = loadRows(studentDoc);
const studentColInfo = analyseColumns(studentRows);

const empRows = loadRows(empDoc);
const empColInfo = analyseColumns(empRows);

console.log(`Loaded student dataset: ${studentRows.length} rows, columns: ${studentColInfo.map(c => c.name).join(", ")}`);
console.log(`Loaded employee dataset: ${empRows.length} rows, columns: ${empColInfo.map(c => c.name).join(", ")}`);

let passed = 0;
let failed = 0;

function runTest(desc, fn) {
  try {
    const t0 = performance.now();
    fn();
    const dur = (performance.now() - t0).toFixed(2);
    console.log(`  [PASS] (${dur}ms) ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${desc}\n         ${err.message}`);
    failed++;
  }
}

function runPipeline(question, colInfo, rows, docName, history = []) {
  const plan = parseDeterministicQueryPlan(question, colInfo, rows, history);
  if (!plan) return { success: false, error: "No plan" };
  const validation = validateSemanticPlan(plan, colInfo, rows);
  const result = executePlan(docName, plan, validation, rows, colInfo, question);
  const formatted = formatTabularTemplateAnswer(result, question);
  return { plan, validation, result, formatted };
}

// --------------------------------------------------------------------------
// 1. Phrasing Invariance (Different phrasings of highest average)
// --------------------------------------------------------------------------
console.log("\n--- Category 1: Natural Language Phrasing Invariance ---");
const phrasings = [
  "Who has the highest average?",
  "Which student has the best average?",
  "Who scored the highest average?",
  "Which student performed best based on average?"
];
for (const q of phrasings) {
  runTest(`Phrasing: "${q}"`, () => {
    const { result, formatted } = runPipeline(q, studentColInfo, studentRows, studentDoc.originalName);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.computedValue, "87");
    assert.ok(formatted.includes("Swati Pandey"), `Expected Swati Pandey in "${formatted}"`);
    assert.ok(formatted.includes("87"), `Expected 87 in "${formatted}"`);
  });
}

// --------------------------------------------------------------------------
// 2. Different Columns in Same Dataset
// --------------------------------------------------------------------------
console.log("\n--- Category 2: Different Columns (Math, Science, English, Average) ---");
runTest("Lookup: Ananya Iyer Math", () => {
  const { result, formatted } = runPipeline("What is Ananya Iyer's Math mark?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "54");
  assert.ok(formatted.includes("54"));
});

runTest("Lookup: Ananya Iyer Science", () => {
  const { result, formatted } = runPipeline("What is Ananya Iyer's Science mark?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "93");
  assert.ok(formatted.includes("93"));
});

runTest("Lookup: Ananya Iyer Average", () => {
  const { result, formatted } = runPipeline("What is Ananya Iyer's average?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "75.67");
  assert.ok(formatted.includes("75.67"));
});

runTest("Average: English score", () => {
  const { result, formatted } = runPipeline("What is the average English score?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "70.17");
  assert.ok(formatted.includes("70.17"));
});

// --------------------------------------------------------------------------
// 3. Different Dataset Generalization (Employee Records)
// --------------------------------------------------------------------------
console.log("\n--- Category 3: Dataset Generalization (Employees Schema) ---");
runTest("Employee Max: highest salary", () => {
  const { result, formatted } = runPipeline("Who has the highest salary?", empColInfo, empRows, empDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "95000");
  assert.ok(formatted.includes("Alice Smith"), `Expected Alice Smith in "${formatted}"`);
});

runTest("Employee Average: average salary", () => {
  const { result, formatted } = runPipeline("What is the average salary?", empColInfo, empRows, empDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "80000");
  assert.ok(formatted.includes("80000"));
});

runTest("Employee Max: highest rating", () => {
  const { result, formatted } = runPipeline("Which employee has the highest rating?", empColInfo, empRows, empDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "4.9");
  assert.ok(formatted.includes("Diana Prince"));
});

runTest("Employee Count: employees in HR", () => {
  const { result, formatted } = runPipeline("How many employees are in HR?", empColInfo, empRows, empDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "2");
  assert.ok(formatted.includes("2"));
});

runTest("Employee Filter: more than 5 years experience", () => {
  const { result, formatted } = runPipeline("Show employees with more than 5 years experience.", empColInfo, empRows, empDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.ok(formatted.includes("Alice Smith") && formatted.includes("Diana Prince") && formatted.includes("Fiona Gallagher"));
});

// --------------------------------------------------------------------------
// 4. Aggregations (Count, Sum, Avg, Median, Min, Max)
// --------------------------------------------------------------------------
console.log("\n--- Category 4: Numeric Aggregations ---");
runTest("Count: total students", () => {
  const { result, formatted } = runPipeline("How many students are there?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "30");
  assert.ok(formatted.includes("30"));
});

runTest("Count: students with Grade A", () => {
  const { result, formatted } = runPipeline("How many students got Grade A?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "11");
  assert.ok(formatted.includes("11"));
});

runTest("Sum: total Math score", () => {
  const { result, formatted } = runPipeline("What is the total Math score?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "2047");
  assert.ok(formatted.includes("2047"));
});

runTest("Median: median Math score", () => {
  const { result, formatted } = runPipeline("What is the median Math score?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "65.5");
  assert.ok(formatted.includes("65.5"));
});

runTest("Min: lowest Math mark", () => {
  const { result, formatted } = runPipeline("Who has the lowest Math mark?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "41");
  assert.ok((formatted.includes("Priyanka Saxena") || formatted.includes("Akash Nambiar")) && formatted.includes("41"));
});

runTest("Max: highest in Science", () => {
  const { result, formatted } = runPipeline("Who scored highest in Science?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "98");
  assert.ok(formatted.includes("Ishita Roy") && formatted.includes("98"));
});

// --------------------------------------------------------------------------
// 5. Filtering & Categorical Matching
// --------------------------------------------------------------------------
console.log("\n--- Category 5: Filtering & Conditions ---");
runTest("Filter: Math below 60", () => {
  const { result, formatted } = runPipeline("Which students scored below 60 in Math?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.ok(formatted.includes("Ananya Iyer") && formatted.includes("Sneha Reddy"));
});

runTest("Filter: Science above 80", () => {
  const { result, formatted } = runPipeline("Show students with Science above 80.", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.ok(formatted.includes("Aarav Sharma") && formatted.includes("Ananya Iyer") && formatted.includes("Rhea Sen"));
});

runTest("Filter: total who passed", () => {
  const { result, formatted } = runPipeline("How many students passed?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "30");
  assert.ok(formatted.includes("30"));
});

// --------------------------------------------------------------------------
// 6. Sorting, Top-N, Bottom-N
// --------------------------------------------------------------------------
console.log("\n--- Category 6: Sorting & Ranking ---");
runTest("Sort: students by Average", () => {
  const { result, formatted } = runPipeline("Sort students by Average.", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.ok(formatted.includes("Swati Pandey") && formatted.includes("Rohan Gupta"));
});

runTest("Top-N: top 5 students", () => {
  const { result, formatted } = runPipeline("Show the top 5 students.", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.limit, 5);
  assert.ok(formatted.includes("Swati Pandey"));
});

runTest("Bottom-N: bottom 3 students by Math", () => {
  const { result, formatted } = runPipeline("Show bottom 3 students by Math.", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.limit, 3);
  assert.ok(formatted.includes("Priyanka Saxena") && formatted.includes("Akash Nambiar"));
});

// --------------------------------------------------------------------------
// 7. Difference & Comparisons
// --------------------------------------------------------------------------
console.log("\n--- Category 7: Differences & Comparisons ---");
runTest("Difference: highest and lowest Math scores", () => {
  const { result, formatted } = runPipeline("What is the difference between the highest and lowest Math scores?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "58"); // 99 - 41 = 58
  assert.ok(formatted.includes("58"));
});

runTest("Difference: Math and Science for Rhea Sen", () => {
  const { result, formatted } = runPipeline("What is the difference between Math and Science for Rhea Sen?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "35"); // |50 - 85| = 35
  assert.ok(formatted.includes("35"));
});

runTest("Compare: Math and Science for Rhea Sen", () => {
  const { result, formatted } = runPipeline("Compare Math and Science for Rhea Sen.", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.ok(formatted.includes("Science is 35 points higher") || formatted.includes("Science is higher by 35"));
});

// --------------------------------------------------------------------------
// 8. Percentage & Group By
// --------------------------------------------------------------------------
console.log("\n--- Category 8: Percentage & Group By ---");
runTest("Percentage: students passed", () => {
  const { result, formatted } = runPipeline("What percentage of students passed?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "100%");
  assert.ok(formatted.includes("100%"));
});

runTest("Group By: Salary by Department", () => {
  const { result, formatted } = runPipeline("Show average Salary by Department.", empColInfo, empRows, empDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.ok(formatted.includes("Engineering") && formatted.includes("HR") && formatted.includes("Marketing"));
});

// --------------------------------------------------------------------------
// 9. Error Handling & No Hallucination (Missing Column / Missing Entity)
// --------------------------------------------------------------------------
console.log("\n--- Category 9: Schema Awareness & Missing Entities ---");
runTest("Missing Column: Zoology mark", () => {
  const { result, formatted } = runPipeline("What is the Zoology mark?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.operation, "column_not_found");
  assert.ok(/zoology/i.test(formatted), `Expected zoology in "${formatted}"`);
});

runTest("Missing Entity: Bruce Wayne's Math mark", () => {
  const { result, formatted } = runPipeline("What is the Math mark for Bruce Wayne?", studentColInfo, studentRows, studentDoc.originalName);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.operation, "entity_not_found");
  assert.ok(formatted.includes("Bruce Wayne"));
});

// --------------------------------------------------------------------------
// 10. Multi-Turn Follow-up Questions & Pronoun Resolution
// --------------------------------------------------------------------------
console.log("\n--- Category 10: Multi-Turn Conversation & Pronoun Resolution ---");
runTest("Follow-up: 'And her average?' after user mentions Ananya Iyer", () => {
  const history = [
    { role: "user", content: "What is Ananya Iyer's Math mark?" },
    { role: "assistant", content: "Ananya Iyer's Math mark is 54." }
  ];
  const { result, formatted } = runPipeline("And her average?", studentColInfo, studentRows, studentDoc.originalName, history);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "75.67");
  assert.ok(formatted.includes("Ananya Iyer"));
  assert.ok(formatted.includes("75.67"));
});

runTest("Follow-up: 'What is her Science mark?' after assistant names Swati Pandey", () => {
  const history = [
    { role: "user", content: "Who has the highest average?" },
    { role: "assistant", content: "Swati Pandey has the highest average with 87." }
  ];
  const { result, formatted } = runPipeline("What is her Science mark?", studentColInfo, studentRows, studentDoc.originalName, history);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.computedValue, "78");
  assert.ok(formatted.includes("Swati Pandey"));
  assert.ok(formatted.includes("78"));
});

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
console.log("\n==================================================");
console.log(`TOTAL TESTS: ${passed + failed}`);
console.log(`PASSED:      ${passed}`);
console.log(`FAILED:      ${failed}`);
console.log("==================================================");

if (failed > 0) {
  process.exit(1);
} else {
  console.log("ALL TABULAR QA TEST SUITE TESTS PASSED PERFECTLY!");
}
