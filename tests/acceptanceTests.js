import { connectDB } from "../backend/config/db.js";
import { ragGraph } from "../backend/graph/ragGraph.js";
import { routeDepartment } from "../backend/services/router.js";
import { processTabularQuery } from "../backend/services/tabularProcessor.js";
import { generateTextEmbedding } from "../backend/services/embeddingService.js";
import { retrieveRelevantTextChunks } from "../backend/services/textRetrieval.js";
import { buildRAGContext } from "../backend/services/contextBuilder.js";
import { checkEvidenceSupportGate, generateAnswer, checkFactualTokens, runLlmJudge, FALLBACK_MESSAGE } from "../backend/services/llm.js";

const TEST_QUESTIONS = [
  { id: 1, q: "What input size does the DR model need?" },
  { id: 2, q: "How is two-stage training carried out?" },
  { id: 3, q: "Confusion matrix results?" },
  { id: 4, q: "Accuracy of EfficientNetB0?" },
  { id: 5, q: "Does the system classify DR severity stages? Total images?" },
  { id: 6, q: "Highest total marks?" },
  { id: 7, q: "How many students got Grade A, B, C?" },
  { id: 8, q: "2024-25 placements at XYZ College?" },
  { id: 9, q: "Grade for 85 marks at XYZ College?" },
  { id: 10, q: "Does DR system detect glaucoma? Highest package in 2025-26?" },
  { id: 11, q: "Explain var, let, const." }
];

async function runAcceptanceTests() {
  await connectDB();
  console.log("================================================================================");
  console.log("🚀 STARTING ACCEPTANCE TEST SUITE (11 TESTS)");
  console.log("================================================================================");

  const results = [];

  for (const item of TEST_QUESTIONS) {
    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`>>> RUNNING TEST ${item.id}: "${item.q}"`);
    console.log(`--------------------------------------------------------------------------------`);

    const t0 = Date.now();

    // 1. Router
    const route = await routeDepartment(item.q);
    const routedSource = route.departments.join(", ") || "None (Broad / Out of Scope)";
    const queryType = route.queryType;

    let tabularResult = null;
    if (queryType === "tabular") {
      tabularResult = await processTabularQuery(item.q, route.departments);
    }

    // 2. Retrieval
    let retrievedChunks = [];
    let queryEmbedding = [];
    if (queryType !== "out_of_scope") {
      try {
        queryEmbedding = await generateTextEmbedding(item.q);
        retrievedChunks = await retrieveRelevantTextChunks(
          queryEmbedding,
          route.departments,
          5,
          0.45,
          item.q
        );
      } catch (e) {
        console.warn(`[Test ${item.id}] Retrieval notice: ${e.message}`);
      }
    }

    const retrievedDocs = [...new Set(retrievedChunks.map((c) => c.documentName))];
    const retrievedPages = [...new Set(retrievedChunks.map((c) => c.pageNumber))];
    const relevanceScores = retrievedChunks.map((c) => ({
      p: c.pageNumber,
      sim: c.similarity,
      lex: c.lexicalScore,
      rank: c.rankingScore
    }));

    // 3. Build Context
    const context = buildRAGContext(retrievedChunks, [], tabularResult);
    const finalContext = context.contextPrompt;

    // 4. Evidence Gate & Generation
    let llmAnswer = "";
    const gate = checkEvidenceSupportGate(item.q, finalContext, queryType);

    if (!gate.supported) {
      llmAnswer = FALLBACK_MESSAGE;
    } else {
      llmAnswer = await generateAnswer(item.q, finalContext, [], queryType);
    }

    // 5. Grounding Result
    const tokenCheck = checkFactualTokens(llmAnswer, finalContext);
    const judgeUnsupported = await runLlmJudge(llmAnswer, finalContext);
    const groundingPassed = tokenCheck.valid && judgeUnsupported.length === 0;

    const finalSources = llmAnswer === FALLBACK_MESSAGE ? [] : retrievedChunks.map((c) => `${c.documentName} (Page ${c.pageNumber})`);

    // Required prints per Step 13
    console.log("QUESTION:", item.q);
    console.log("ROUTED SOURCE:", routedSource);
    console.log("QUERY TYPE:", queryType);
    console.log("RETRIEVED DOCUMENTS:", retrievedDocs.length > 0 ? retrievedDocs : (tabularResult ? [tabularResult.documentName] : "None"));
    console.log("RETRIEVED PAGES:", retrievedPages.length > 0 ? retrievedPages : (tabularResult ? ["CSV Dataset"] : "None"));
    console.log("RETRIEVED CHUNKS COUNT:", retrievedChunks.length);
    console.log("RELEVANCE SCORES:", JSON.stringify(relevanceScores));
    console.log("FINAL CONTEXT:\n", finalContext.slice(0, 500) + (finalContext.length > 500 ? "..." : ""));
    console.log("LLM ANSWER:\n", llmAnswer);
    console.log("GROUNDING RESULT:", {
      gatePassed: gate.supported,
      tokenCheckPassed: tokenCheck.valid,
      unsupportedTokens: tokenCheck.unsupported,
      unsupportedJudgeClaims: judgeUnsupported,
      grounded: groundingPassed
    });
    console.log("FINAL SOURCES:", finalSources.slice(0, 4));
    console.log(`DURATION: ${Date.now() - t0}ms`);

    results.push({
      testId: item.id,
      question: item.q,
      queryType,
      answer: llmAnswer,
      grounded: groundingPassed,
      gatePassed: gate.supported
    });
  }

  console.log("\n================================================================================");
  console.log("📊 ACCEPTANCE TEST SUMMARY REPORT");
  console.log("================================================================================");
  for (const r of results) {
    console.log(`Test ${r.testId} [${r.queryType}]: ${r.answer.slice(0, 100).replace(/\n/g, " ")}...`);
  }

  process.exit(0);
}

runAcceptanceTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
