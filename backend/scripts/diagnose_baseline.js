import mongoose from "mongoose";
import { ENV } from "../config/env.js";
import { ragGraph } from "../graph/ragGraph.js";

const QUESTIONS = [
  {
    id: 1,
    type: "Text (Eye disease)",
    q: "What input size does the DR model need?",
    expectedDept: "Eye disease",
    expectedValueRegex: /224/i
  },
  {
    id: 2,
    type: "Text (Eye disease)",
    q: "How is two-stage training carried out?",
    expectedDept: "Eye disease",
    expectedValueRegex: /(?:stage|freeze|unfreeze|frozen|learning\s*rate)/i
  },
  {
    id: 3,
    type: "Text (Eye disease)",
    q: "What is the accuracy of EfficientNetB0?",
    expectedDept: "Eye disease",
    expectedValueRegex: /(?:96|94|87|accuracy)/i
  },
  {
    id: 4,
    type: "Text (Eye disease)",
    q: "Does the system classify DR severity stages? Total images?",
    expectedDept: "Eye disease",
    expectedValueRegex: /(?:binary|severity|stages|images|3662|3,662|dataset)/i
  },
  {
    id: 5,
    type: "Text (Eye disease)",
    q: "What optimizer was used for training?",
    expectedDept: "Eye disease",
    expectedValueRegex: /Adam/i
  },
  {
    id: 6,
    type: "Text (College info)",
    q: "2024-25 placements at XYZ College?",
    expectedDept: "College information",
    expectedValueRegex: /(?:715|placement|24\s*LPA|5\.1|LPA)/i
  },
  {
    id: 7,
    type: "Text (College info)",
    q: "Grade for 85 marks at XYZ College?",
    expectedDept: "College information",
    expectedValueRegex: /\bA\+?\b/i
  },
  {
    id: 8,
    type: "Text (Course)",
    q: "Explain var, let, const.",
    expectedDept: "Course",
    expectedValueRegex: /(?:scope|reassign|block|hoist|function)/i
  },
  {
    id: 9,
    type: "Tabular (Student info)",
    q: "Highest total marks?",
    expectedDept: "Student information",
    expectedValueRegex: /(?:261|Swati)/i
  },
  {
    id: 10,
    type: "Tabular (Critical bug)",
    q: "what was the english mark of arjun rao",
    expectedDept: "Student information",
    expectedValueRegex: /\b62\b/
  },
  {
    id: 11,
    type: "Tabular (Filter)",
    q: "Who scored more than 90 in Maths?",
    expectedDept: "Student information",
    expectedValueRegex: /(?:Diya|Rahul|Arjun|Nikhil|Swati)/i
  },
  {
    id: 12,
    type: "Follow-up (from Q3)",
    q: "What are its advantages?",
    parentIdx: 2, // index 2 is Q3
    expectedDept: "Eye disease",
    expectedValueRegex: /(?:accuracy|parameter|efficient|lightweight|performance|feature)/i
  },
  {
    id: 13,
    type: "Follow-up (from Q9)",
    q: "What about the second student?",
    parentIdx: 8, // index 8 is Q9
    expectedDept: "Student information",
    expectedValueRegex: /(?:Rohan\s*Gupta|252)/i
  },
  {
    id: 14,
    type: "Unsupported",
    q: "Who won the cricket World Cup?",
    expectedDept: null, // Expecting empty or out_of_scope
    expectedValueRegex: /(?:do not have|don't have|could not find|couldn't find|not available|insufficient|unsupported)/i
  },
  {
    id: 15,
    type: "Visual QA",
    q: "What does the screenshot on page 58 show?",
    expectedDept: "Eye disease",
    expectedValueRegex: /(?:page\s*58|DR|diabetic|moderate|file|manager|select|interface|screenshot|gui)/i
  }
];

async function runBaselineDiagnosis() {
  console.log("=== RUNNING 15-QUESTION ACCEPTANCE DIAGNOSIS WITH ASSERTIONS ===");
  await mongoose.connect(ENV.MONGO_URI);

  const results = [];
  const convIds = {};

  for (let i = 0; i < QUESTIONS.length; i++) {
    const item = QUESTIONS[i];
    console.log(`\n[${i + 1}/15] Diagnosing: "${item.q}" (${item.type})`);

    const convId = item.parentIdx !== undefined ? convIds[item.parentIdx] : null;

    const tStart = Date.now();
    let res;
    try {
      res = await ragGraph.invoke({
        question: item.q,
        conversationId: convId
      });
    } catch (err) {
      console.error(`Error invoking question ${i + 1}:`, err.message);
      res = {
        routedDepartments: [],
        routerConfidence: 0,
        retrievedChunks: [],
        finalAnswer: `ERROR: ${err.message}`,
        timings: {}
      };
    }
    const tTotal = Date.now() - tStart;

    convIds[i] = res.conversationId;

    const routedDepts = res.routedDepartments || [];
    const routerScore = res.routerConfidence !== undefined ? res.routerConfidence : (res.routerCandidates?.[0]?.confidence ?? "N/A");
    
    // Top chunks
    const chunks = res.retrievedChunks || [];
    const top5ChunksSummary = chunks.slice(0, 5).map(c => `${c.department || "?"}: ${c.documentName || "?"} p.${c.pageNumber || "?"}`).join("; ");

    // Extract timings
    const routerMs = res.timings?.router ?? 0;
    const retrievalMs = res.timings?.retrieval ?? res.timings?.textRetrieval ?? 0;
    const llmMs = res.timings?.generateAnswer ?? res.timings?.generation ?? 0;

    // Assertions: PASS only if answer contains expected value AND expected department
    const deptPassed = item.expectedDept === null
      ? (routedDepts.length === 0 || res.queryType === "out_of_scope")
      : routedDepts.some(d => d.toLowerCase().includes(item.expectedDept.toLowerCase()));

    const valPassed = item.expectedValueRegex.test(res.finalAnswer || "");
    const pass = deptPassed && valPassed;
    const passStatus = pass
      ? "PASS"
      : `FAIL (${!deptPassed ? `Dept mismatch: got [${routedDepts.join(",")}]` : ""}${!deptPassed && !valPassed ? ", " : ""}${!valPassed ? "Value missing" : ""})`;

    results.push({
      id: item.id,
      question: item.q,
      type: item.type,
      routedDepartments: routedDepts.join(", ") || "[]",
      routerScore: typeof routerScore === "number" ? routerScore.toFixed(2) : String(routerScore),
      topChunks: top5ChunksSummary || "(none)",
      routerMs,
      retrievalMs,
      llmMs,
      totalMs: tTotal,
      passStatus,
      answerSnippet: (res.finalAnswer || "").replace(/\n/g, " ").slice(0, 90)
    });

    console.log(`[Result] ${passStatus} in ${tTotal}ms (Dept: [${routedDepts.join(", ")}])`);
  }

  console.log("\n========================================================================================================================");
  console.log("FINAL 15-QUESTION DIAGNOSIS & ACCEPTANCE RESULTS TABLE");
  console.log("========================================================================================================================");
  console.table(results.map(r => ({
    ID: r.id,
    Question: r.question.length > 25 ? r.question.slice(0, 22) + "..." : r.question,
    "Status": r.passStatus,
    "Dept": r.routedDepartments,
    "R.Score": r.routerScore,
    "Router(ms)": r.routerMs,
    "Retr(ms)": r.retrievalMs,
    "LLM(ms)": r.llmMs,
    "Total(ms)": r.totalMs,
    "Answer Snippet": r.answerSnippet.length > 40 ? r.answerSnippet.slice(0, 37) + "..." : r.answerSnippet
  })));

  const totalTimes = results.map(r => r.totalMs).sort((a, b) => a - b);
  const p50 = totalTimes[Math.floor(totalTimes.length * 0.5)];
  const p95 = totalTimes[Math.floor(totalTimes.length * 0.95)];
  const passCount = results.filter(r => r.passStatus === "PASS").length;

  console.log("\n--- OVERALL SUMMARY ---");
  console.log(`Pass Rate: ${passCount} / ${results.length} (${((passCount / results.length) * 100).toFixed(1)}%)`);
  console.log(`Total Latency: p50 = ${p50}ms (${(p50/1000).toFixed(1)}s), p95 = ${p95}ms (${(p95/1000).toFixed(1)}s)`);

  await mongoose.disconnect();
}

runBaselineDiagnosis().catch(err => {
  console.error("Diagnosis error:", err);
  process.exit(1);
});
