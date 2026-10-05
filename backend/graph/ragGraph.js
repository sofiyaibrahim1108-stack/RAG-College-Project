import { StateGraph, START, END } from "@langchain/langgraph";
import { RAGStateAnnotation } from "./graphState.js";
import { Message } from "../models/Message.js";
import { Conversation } from "../models/Conversation.js";
import { routeDepartment } from "../services/router.js";
import { processTabularQuery, formatTabularTemplateAnswer } from "../services/tabularProcessor.js";
import { generateTextEmbedding } from "../services/embeddingService.js";
import { retrieveWithScopeFallback } from "../services/textRetrieval.js";
import { siglipClient } from "../services/siglipClient.js";
import { retrieveRelevantImages, resolveMultimodalAttachments } from "../services/imageRetrieval.js";
import { buildRAGContext } from "../services/contextBuilder.js";
import { generateAnswerDetailed, FALLBACK_MESSAGE, isFallbackAnswer, checkEvidenceSupportGate, filterSupportingSources, verifyAnswerGrounding } from "../services/llm.js";
import { formatSources, formatImageCitations } from "../utils/citations.js";
import { RAG_CONFIG } from "../config/rag.js";
import { rewriteRetry } from "../services/rewriteRetry.js";
import { verifyAnswerSupport } from "../services/hallucinationGuard.js";

/**
 * 1. Node: loadConversationHistory
 */
async function loadConversationHistoryNode(state) {
  const t0 = Date.now();
  let history = state.conversationHistory || [];

  if (state.conversationId && history.length === 0) {
    try {
      const recentMsgs = await Message.find({ conversationId: state.conversationId })
        .sort({ createdAt: -1 })
        .limit(6)
        .lean();

      history = recentMsgs.reverse().map((m) => ({
        role: m.role,
        content: m.content,
        routedDepartments: m.routedDepartments || []
      }));
    } catch (err) {
      console.warn(`[Node: loadHistory] Warning: ${err.message}`);
    }
  }

  return {
    conversationHistory: history,
    originalQuestion: state.originalQuestion || state.question,
    timings: { history: Date.now() - t0 }
  };
}

/**
 * 1.5. Node: normalizeQuery
 * Rewrites user message into a standalone question (turns commands like "show me X" into "what does X show",
 * and resolves follow-up pronouns using previous turns).
 * Keeps originalQuestion for display and logging.
 */
async function normalizeQueryNode(state) {
  // The original question always runs first. A rewrite (with history) happens only after the first
  // attempt fails, inside generateAnswerNode via rewriteRetry.
  const original = state.originalQuestion || state.question;
  return {
    question: original,
    originalQuestion: original
  };
}

/**
 * 2. Node: router
 * Determines target source/department and queryType (document_qa, tabular, visual_qa, out_of_scope)
 */
async function routerNode(state) {
  const t0 = Date.now();
  try {
    const routeResult = await routeDepartment(state.question, state.conversationHistory);
    const duration = Date.now() - t0;
    console.log(`[Router] ${duration}ms (Type: ${routeResult.queryType}, Depts: [${routeResult.departments.join(", ")}])`);

    return {
      queryType: routeResult.queryType,
      routedDepartments: routeResult.departments,
      routerCandidates: routeResult.candidates,
      routerConfidence: routeResult.confidence,
      timings: { router: duration }
    };
  } catch (err) {
    console.warn(`[Node: router] Fallback triggered: ${err.message}`);
    return {
      queryType: "document_qa",
      routedDepartments: [],
      routerCandidates: [],
      routerConfidence: 0.5,
      timings: { router: Date.now() - t0 }
    };
  }
}

/**
 * 3. Node: tabular
 * For CSV/Excel questions, deterministic calculation node calculates from actual dataset
 */
async function tabularNode(state) {
  if (state.queryType !== "tabular") {
    return { tabularResult: null, timings: { tabular: 0 } };
  }

  const t0 = Date.now();
  try {
    // Requirement 1a: Pass the ORIGINAL user question (not the rewritten one) to the tabular route.
    // Requirement 3: If deterministic parser cannot resolve the original question (e.g. follow-up with pronouns),
    // fallbackQuestion allows resolving from the rewritten standalone query without LLM planning.
    const originalQ = state.originalQuestion || state.question;
    const fallbackQ = state.question !== originalQ ? state.question : "";
    const result = await processTabularQuery(originalQ, state.routedDepartments, [], fallbackQ, state.conversationHistory || []);
    const duration = Date.now() - t0;
    console.log(`[Timing] Tabular Tool: ${duration} ms`);

    if (result && result.success && result.computedValue !== null) {
      return {
        tabularResult: result,
        timings: { tabular: duration }
      };
    }

    // Fallback: If tabular query cannot be resolved or computed, route to document QA
    console.log(`[Node: tabular] Tabular query unresolved -> falling back to document_qa and widening scope`);
    return {
      queryType: "document_qa",
      routedDepartments: [],
      routerConfidence: 0.5,
      tabularResult: null,
      timings: { tabular: duration }
    };
  } catch (err) {
    console.warn(`[Node: tabular] Notice: ${err.message}`);
    return {
      queryType: "document_qa",
      routedDepartments: [],
      routerConfidence: 0.5,
      tabularResult: null,
      timings: { tabular: Date.now() - t0 }
    };
  }
}

/**
 * Resolves pronoun and reference follow-up questions dynamically from conversation context.
 */
function resolveFollowUpQuery(question, history = []) {
  if (!history || history.length === 0) return question;
  const hasPronoun = /\b(it|its|they|them|this|that|these|those)\b/i.test(question);
  const isShortFollowUp = /\b(what about|how does it|what are its|explain further|tell me more|what is the result|what is the accuracy|what are the advantages|how does that|tell me about it)\b/i.test(question);
  if (!hasPronoun && !isShortFollowUp) return question;

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user" && history[i].content && history[i].content !== question) {
      return `${history[i].content.trim()} ${question}`;
    }
  }
  return question;
}

/**
 * 4. Node: textEmbedding
 */
async function textEmbeddingNode(state) {
  if (state.queryType === "out_of_scope") {
    return { queryEmbedding: [], timings: { textEmbedding: 0 } };
  }

  const t0 = Date.now();
  try {
    const effectiveQuery = resolveFollowUpQuery(state.question, state.conversationHistory);
    const embedding = await generateTextEmbedding(effectiveQuery);
    const duration = Date.now() - t0;
    console.log(`[Timing] Text Embedding: ${duration} ms`);

    return {
      queryEmbedding: embedding,
      timings: { textEmbedding: duration }
    };
  } catch (err) {
    console.error(`[Node: textEmbedding] Error: ${err.message}`);
    return {
      queryEmbedding: [],
      timings: { textEmbedding: Date.now() - t0 }
    };
  }
}

/**
 * 5. Node: textRetrieval
 */
async function textRetrievalNode(state) {
  if (state.queryType === "out_of_scope" || !state.queryEmbedding || state.queryEmbedding.length === 0) {
    return { retrievedChunks: [], sources: [], timings: { textRetrieval: 0 } };
  }

  // Skip unrelated text retrieval for strict visual QA queries referring to a screenshot/image
  const isStrictVisual = state.queryType === "visual_qa" &&
    /\b(screenshot|describe\s+only\s+the\s+visual|visual\s+elements|do\s+not\s+use\s+surrounding\s+text)\b/i.test(state.question);
  if (isStrictVisual) {
    return { retrievedChunks: [], sources: [], timings: { textRetrieval: 0 } };
  }

  const t0 = Date.now();
  try {
    const effectiveQuery = resolveFollowUpQuery(state.question, state.conversationHistory);
    const { chunks, widened } = await retrieveWithScopeFallback(
      state.queryEmbedding,
      state.routedDepartments,
      5,
      effectiveQuery
    );
    const duration = Date.now() - t0;
    console.log(`[Retrieval] ${duration}ms${widened ? " (widened beyond routed scope)" : ""}`);

    const update = {
      retrievedChunks: chunks,
      sources: formatSources(chunks),
      timings: { textRetrieval: duration, retrieval: duration }
    };

    // Derive department from top-k vector/cosine retrieval hits (majority / score-weighted)
    if (widened || !state.routedDepartments || state.routedDepartments.length === 0) {
      const deptWeights = new Map();
      for (const c of chunks) {
        if (c.department) {
          const score = c.rankingScore || c.similarity || 1;
          deptWeights.set(c.department, (deptWeights.get(c.department) || 0) + score);
        }
      }
      const sortedDepts = [...deptWeights.entries()].sort((a, b) => b[1] - a[1]);
      if (sortedDepts.length > 0) {
        update.routedDepartments = [sortedDepts[0][0]];
      }
    }

    return update;
  } catch (err) {
    console.error(`[Node: textRetrieval] Error: ${err.message}`);
    return {
      retrievedChunks: [],
      sources: [],
      timings: { textRetrieval: Date.now() - t0, retrieval: Date.now() - t0 }
    };
  }
}

/**
 * 6. Node: imageEmbedding
 */
async function imageEmbeddingNode(state) {
  if (state.queryType !== "visual_qa") {
    return {
      siglipQueryEmbedding: [],
      timings: { siglipEmbedding: 0 }
    };
  }

  const t0 = Date.now();
  try {
    const siglipEmb = await siglipClient.embedText(state.question);
    const duration = Date.now() - t0;
    return {
      siglipQueryEmbedding: siglipEmb,
      timings: { siglipEmbedding: duration }
    };
  } catch (err) {
    return {
      siglipQueryEmbedding: [],
      timings: { siglipEmbedding: Date.now() - t0 }
    };
  }
}

/**
 * 7. Node: imageRetrieval
 */
async function imageRetrievalNode(state) {
  if (state.queryType !== "visual_qa" || !state.siglipQueryEmbedding || state.siglipQueryEmbedding.length === 0) {
    return {
      retrievedImages: [],
      imageCitations: [],
      timings: { imageRetrieval: 0 }
    };
  }

  const t0 = Date.now();
  try {
    const images = await retrieveRelevantImages(
      state.siglipQueryEmbedding,
      state.routedDepartments,
      3,
      undefined,
      state.question
    );
    const duration = Date.now() - t0;

    return {
      retrievedImages: images,
      imageCitations: formatImageCitations(images),
      timings: { imageRetrieval: duration }
    };
  } catch (err) {
    return {
      retrievedImages: [],
      imageCitations: [],
      timings: { imageRetrieval: Date.now() - t0 }
    };
  }
}

/**
 * 8. Node: contextBuilder
 */
async function contextBuilderNode(state) {
  const t0 = Date.now();
  const context = buildRAGContext(state.retrievedChunks, state.retrievedImages, state.tabularResult, state.question);
  const duration = Date.now() - t0;
  console.log(`[ContextBuilder] ${duration}ms`);

  const survivingChunks = context.textChunks || [];
  return {
    contextPrompt: context.contextPrompt,
    retrievedChunks: survivingChunks,
    sources: formatSources(survivingChunks),
    timings: { contextBuilder: duration }
  };
}

/**
 * 9. Node: generateAnswer
 */
async function generateAnswerNode(state) {
  const t0 = Date.now();

  // Out of scope gate check
  const tGate = Date.now();
  if (state.queryType === "out_of_scope") {
    const gateDuration = Date.now() - tGate;
    console.log(`[Evidence Gate] ${gateDuration}ms (out_of_scope)`);
    console.log(`[Generation] 0ms`);
    return {
      finalAnswer: FALLBACK_MESSAGE,
      fallbackReason: "out_of_scope",
      sources: [],
      imageCitations: [],
      routedDepartments: [],
      timings: { evidenceGate: gateDuration, generation: 0, llm: 0 }
    };
  }

  // Pre-LLM Evidence Sufficiency Check (lexical + semantic signal)
  const topSimilarity = Math.max(0, ...(state.retrievedChunks || []).map((c) => c.similarity || 0));
  const evidenceMeta = { topSimilarity };
  const gate = checkEvidenceSupportGate(state.question, state.contextPrompt, state.queryType, evidenceMeta);
  const gateDuration = Date.now() - tGate;
  console.log(`[Evidence Gate] ${gateDuration}ms (result=${gate.reason}, topSim=${topSimilarity.toFixed(3)})`);

  // A gate rejection is a failed first attempt: skip generation but still allow one rewrite retry.
  const gateRejected = !gate.supported;
  if (gateRejected) {
    console.log(`[Evidence Gate] Question "${state.question}" rejected: ${gate.reason}. Skipping first LLM call.`);
  }

  // Task 1b: For a successful deterministic tabular result, build the answer text from a template
  // using the tool result, with no LLM call. Keep the grounding checks consistent.
  const tool = state.tabularResult;
  if (tool && tool.success && tool.computedValue !== null && tool.operation !== "preview") {
    const templateAnswer = formatTabularTemplateAnswer(tool, state.question);
    const grounding = verifyAnswerGrounding(templateAnswer, state.contextPrompt || tool.summary, state.question);
    if (grounding.valid) {
      console.log(`[Generation] 0ms (deterministic tabular template, 0 LLM calls)`);
      const fromDataset = (state.sources || []).filter((s) => s.documentName === tool.documentName);
      const finalSources = fromDataset.length > 0
        ? fromDataset.slice(0, 1)
        : [{ documentName: tool.documentName, pageNumber: 1, chunkIndex: 0, snippet: tool.summary?.slice(0, 200) }];

      const matchingChunk = (state.retrievedChunks || []).find((c) => c.documentName === tool.documentName);
      const dept = matchingChunk?.department || (state.routedDepartments && state.routedDepartments[0]);
      const effectiveDepartments = dept ? [dept] : (state.routedDepartments || []);

      return {
        finalAnswer: templateAnswer,
        fallbackReason: null,
        sources: finalSources,
        imageCitations: [],
        routedDepartments: effectiveDepartments,
        timings: { evidenceGate: 0, generation: 0, llm: 0 }
      };
    }
  }

  try {
    const tGen = Date.now();
    let answer = FALLBACK_MESSAGE;
    let reason = gate.reason;
    let answerWasGenerated = false;

    if (!gateRejected) {
      ({ answer, reason } = await generateAnswerDetailed(
        state.question,
        state.contextPrompt,
        state.conversationHistory,
        state.queryType,
        evidenceMeta
      ));
      answerWasGenerated = true;
    }
    let genDuration = Date.now() - tGen;
    console.log(`[Generation] ${genDuration}ms${reason ? ` (withheld: ${reason})` : ""}`);

    let isMissing = isFallbackAnswer(answer);
    let retryDuration = 0;
    let usedChunks = state.retrievedChunks;
    let usedSources = state.sources;
    let guardMatchingChunks = usedChunks;

    if (!isMissing) {
      const guard = await verifyAnswerSupport({
        answer,
        contextChunks: usedChunks
      });

      if (!guard.accepted) {
        isMissing = true;
        reason = guard.fallbackReason || "unsupported_hallucination";
        answer = guard.answer;
      } else {
        usedSources = guard.sources;
        usedChunks = guard.matchingChunks;
        guardMatchingChunks = guard.matchingChunks;
      }
    }

    // Rewrite retry: run ONLY when retrieval or evidence was insufficient before any answer was generated
    if (isMissing && !answerWasGenerated && state.queryType !== "out_of_scope") {
      const tRetry = Date.now();
      const retry = await rewriteRetry({
        originalQuestion: state.originalQuestion || state.question,
        history: state.conversationHistory,
        chunks: state.retrievedChunks,
        contextPrompt: state.contextPrompt,
        topSimilarity,
        gateSupported: gate.supported,
        generate: async (q, ctx, meta) => {
          const r = await generateAnswerDetailed(q, ctx, state.conversationHistory, state.queryType, meta);
          reason = r.reason;
          return r.answer;
        }
      });
      retryDuration = Date.now() - tRetry;
      if (retry) {
        const retryGuard = await verifyAnswerSupport({
          answer: retry.answer,
          contextChunks: retry.chunks
        });

        if (!retryGuard.accepted) {
          answer = retryGuard.answer;
          reason = retryGuard.fallbackReason || "unsupported_hallucination";
          isMissing = true;
        } else {
          answer = retryGuard.answer;
          usedChunks = retryGuard.matchingChunks;
          usedSources = retryGuard.sources;
          guardMatchingChunks = retryGuard.matchingChunks;
          isMissing = false;
        }
        console.log(`[Generation Retry] ${retryDuration}ms`);
      }
    }

    const finalAnswer = isMissing ? FALLBACK_MESSAGE : answer;
    const fallbackReason = isMissing ? (reason || "insufficient_evidence") : null;

    const tGrounding = Date.now();
    let finalSources = isMissing ? [] : usedSources;
    const groundingDuration = Date.now() - tGrounding;
    console.log(`[Grounding] ${groundingDuration}ms`);

    let finalImageCitations = [];
    let effectiveDepartments = [];

    if (!isMissing) {
      // Document QA with shared Multimodal image attachment
      finalImageCitations = await resolveMultimodalAttachments({
        survivingSources: finalSources,
        retrievedChunks: guardMatchingChunks,
        maxImages: RAG_CONFIG.topKImages,
        isFallback: isMissing,
        question: state.originalQuestion || state.question,
        finalAnswer
      });

      const sourceDepts = [...new Set((finalSources || []).map((s) => s.department).filter(Boolean))];
      const chunkDepts = [...new Set((state.retrievedChunks || []).map((c) => c.department).filter(Boolean))];

      if (state.routedDepartments && state.routedDepartments.length > 0) {
        effectiveDepartments = state.routedDepartments;
      } else {
        effectiveDepartments = sourceDepts.length > 0 ? sourceDepts : chunkDepts;
      }
    }

    console.log(`[Stage Timings] retrieval: ${state.timings?.textRetrieval || 0}ms | generation: ${genDuration}ms | retry: ${retryDuration}ms | grounding: ${groundingDuration}ms`);

    return {
      finalAnswer,
      fallbackReason,
      sources: finalSources,
      imageCitations: finalImageCitations,
      routedDepartments: effectiveDepartments,
      timings: { evidenceGate: gateDuration, generation: genDuration, retry: retryDuration, grounding: groundingDuration, llm: genDuration }
    };
  } catch (err) {
    console.error(`[Node: generateAnswer] Error: ${err.message}`);
    return {
      finalAnswer: FALLBACK_MESSAGE,
      fallbackReason: "insufficient_evidence",
      sources: [],
      imageCitations: [],
      routedDepartments: [],
      timings: { evidenceGate: gateDuration, generation: Date.now() - t0, llm: Date.now() - t0 }
    };
  }
}

/**
 * 10. Node: saveConversation
 */
async function saveConversationNode(state) {
  const t0 = Date.now();
  let convId = state.conversationId;

  try {
    if (!convId) {
      const titleSnippet = (state.originalQuestion || state.question).slice(0, 40);
      const newConv = await Conversation.create({
        title: titleSnippet || "New Conversation"
      });
      convId = newConv._id.toString();
    }

    await Message.create({
      conversationId: convId,
      role: "user",
      content: state.originalQuestion || state.question
    });

    await Message.create({
      conversationId: convId,
      role: "assistant",
      content: state.finalAnswer,
      routedDepartments: state.routedDepartments,
      sources: state.sources,
      images: state.imageCitations,
      timings: { ...(state.timings || {}), fallbackReason: state.fallbackReason }
    });

    await Conversation.findByIdAndUpdate(convId, { updatedAt: new Date() });
  } catch (err) {
    console.warn(`[Node: saveConversation] Warning: ${err.message}`);
  }

  const duration = Date.now() - t0;
  const timings = state.timings || {};
  const total = Object.values(timings).reduce((acc, v) => acc + (typeof v === "number" ? v : 0), 0) + duration;
  console.log(`[Total] ${total}ms`);

  return {
    conversationId: convId,
    timings: { saveConversation: duration, total }
  };
}

/**
 * Build and compile the LangGraph workflow
 */
export function createRAGGraph() {
  const workflow = new StateGraph(RAGStateAnnotation)
    .addNode("loadConversationHistory", loadConversationHistoryNode)
    .addNode("normalizeQuery", normalizeQueryNode)
    .addNode("router", routerNode)
    .addNode("tabular", tabularNode)
    .addNode("textEmbedding", textEmbeddingNode)
    .addNode("textRetrieval", textRetrievalNode)
    .addNode("imageEmbedding", imageEmbeddingNode)
    .addNode("imageRetrieval", imageRetrievalNode)
    .addNode("contextBuilder", contextBuilderNode)
    .addNode("generateAnswer", generateAnswerNode)
    .addNode("saveConversation", saveConversationNode)
    .addEdge(START, "loadConversationHistory")
    .addEdge("loadConversationHistory", "normalizeQuery")
    .addEdge("normalizeQuery", "router")
    .addEdge("router", "tabular")
    .addConditionalEdges("tabular", (state) => {
      if (state.tabularResult && state.tabularResult.success && state.tabularResult.computedValue !== null) {
        return "contextBuilder";
      }
      return "textEmbedding";
    })
    .addEdge("textEmbedding", "textRetrieval")
    .addEdge("textRetrieval", "imageEmbedding")
    .addEdge("imageEmbedding", "imageRetrieval")
    .addEdge("imageRetrieval", "contextBuilder")
    .addEdge("contextBuilder", "generateAnswer")
    .addEdge("generateAnswer", "saveConversation")
    .addEdge("saveConversation", END);

  return workflow.compile();
}

// Singleton compiled graph
export const ragGraph = createRAGGraph();
