import { StateGraph, START, END } from "@langchain/langgraph";
import { RAGStateAnnotation } from "./graphState.js";
import { Message } from "../models/Message.js";
import { Conversation } from "../models/Conversation.js";
import { routeDepartment } from "../services/router.js";
import { processTabularQuery } from "../services/tabularProcessor.js";
import { generateTextEmbedding } from "../services/embeddingService.js";
import { retrieveRelevantTextChunks } from "../services/textRetrieval.js";
import { siglipClient } from "../services/siglipClient.js";
import { retrieveRelevantImages } from "../services/imageRetrieval.js";
import { buildRAGContext } from "../services/contextBuilder.js";
import { generateAnswer, FALLBACK_MESSAGE, isFallbackAnswer, checkEvidenceSupportGate } from "../services/llm.js";
import { formatSources, formatImageCitations } from "../utils/citations.js";

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
        content: m.content
      }));
    } catch (err) {
      console.warn(`[Node: loadHistory] Warning: ${err.message}`);
    }
  }

  return {
    conversationHistory: history,
    timings: { history: Date.now() - t0 }
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
    console.log(`[Timing] Router: ${duration} ms (Type: ${routeResult.queryType}, Depts: [${routeResult.departments.join(", ")}])`);

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
    const result = await processTabularQuery(state.question, state.routedDepartments);
    const duration = Date.now() - t0;
    console.log(`[Timing] Tabular Tool: ${duration} ms`);

    return {
      tabularResult: result,
      timings: { tabular: duration }
    };
  } catch (err) {
    console.warn(`[Node: tabular] Notice: ${err.message}`);
    return {
      tabularResult: null,
      timings: { tabular: Date.now() - t0 }
    };
  }
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
    const embedding = await generateTextEmbedding(state.question);
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

  const t0 = Date.now();
  try {
    const chunks = await retrieveRelevantTextChunks(
      state.queryEmbedding,
      state.routedDepartments,
      5,
      undefined,
      state.question
    );
    const duration = Date.now() - t0;
    console.log(`[Timing] Text Retrieval: ${duration} ms`);

    return {
      retrievedChunks: chunks,
      sources: formatSources(chunks),
      timings: { textRetrieval: duration }
    };
  } catch (err) {
    console.error(`[Node: textRetrieval] Error: ${err.message}`);
    return {
      retrievedChunks: [],
      sources: [],
      timings: { textRetrieval: Date.now() - t0 }
    };
  }
}

/**
 * Determines whether a query has visual/diagram intent to run SigLIP
 */
export function isVisualQuery(question) {
  if (!question) return false;
  const visualRegex =
    /\b(diagram|diagrams|figure|figures|image|images|screenshot|screenshots|picture|pictures|flowchart|flowcharts|chart|charts|photo|visual|confusion matrix|page\s*\d+\s*(?:show|contain|display))\b/i;
  return visualRegex.test(question);
}

/**
 * 6. Node: imageEmbedding
 */
async function imageEmbeddingNode(state) {
  const shouldEmbed = state.queryType === "visual_qa" || isVisualQuery(state.question);
  if (!shouldEmbed || state.queryType === "out_of_scope") {
    return {
      siglipQueryEmbedding: [],
      timings: { siglipEmbedding: 0 }
    };
  }

  const t0 = Date.now();
  try {
    const siglipEmb = await siglipClient.embedText(state.question);
    const duration = Date.now() - t0;
    console.log(`[Timing] SigLIP Embedding: ${duration} ms`);

    return {
      siglipQueryEmbedding: siglipEmb,
      timings: { siglipEmbedding: duration }
    };
  } catch (err) {
    console.warn(`[Node: imageEmbedding] Notice: ${err.message}`);
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
  const shouldRetrieve = state.queryType === "visual_qa" || isVisualQuery(state.question);
  if (!shouldRetrieve || state.queryType === "out_of_scope") {
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
    console.log(`[Timing] Image Retrieval: ${duration} ms`);

    return {
      retrievedImages: images,
      imageCitations: formatImageCitations(images),
      timings: { imageRetrieval: duration }
    };
  } catch (err) {
    console.warn(`[Node: imageRetrieval] Notice: ${err.message}`);
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
  const context = buildRAGContext(state.retrievedChunks, state.retrievedImages, state.tabularResult);
  const duration = Date.now() - t0;
  console.log(`[Timing] Context Builder: ${duration} ms`);

  return {
    contextPrompt: context.contextPrompt,
    timings: { contextBuilder: duration }
  };
}

/**
 * 9. Node: generateAnswer
 */
async function generateAnswerNode(state) {
  const t0 = Date.now();

  // Out of scope gate check
  if (state.queryType === "out_of_scope") {
    console.log(`[Evidence Gate] Query type is out_of_scope -> Returning fallback without calling generation model`);
    return {
      finalAnswer: FALLBACK_MESSAGE,
      sources: [],
      imageCitations: [],
      timings: { llm: 0 }
    };
  }

  // Pre-LLM Evidence Support Gate
  const gate = checkEvidenceSupportGate(state.question, state.contextPrompt, state.queryType);
  if (!gate.supported) {
    console.log(`[Evidence Gate] Question "${state.question}" rejected: ${gate.reason}. Skipping LLM call.`);
    return {
      finalAnswer: FALLBACK_MESSAGE,
      sources: [],
      imageCitations: [],
      timings: { llm: 0 }
    };
  }

  try {
    const answer = await generateAnswer(
      state.question,
      state.contextPrompt,
      state.conversationHistory,
      state.queryType
    );
    const duration = Date.now() - t0;
    console.log(`[Timing] LLM: ${duration} ms`);

    const isMissing = isFallbackAnswer(answer);
    const finalAnswer = isMissing ? FALLBACK_MESSAGE : answer;

    return {
      finalAnswer,
      sources: isMissing ? [] : state.sources,
      imageCitations: isMissing ? [] : state.imageCitations,
      timings: { llm: duration }
    };
  } catch (err) {
    console.error(`[Node: generateAnswer] Error: ${err.message}`);
    return {
      finalAnswer: FALLBACK_MESSAGE,
      timings: { llm: Date.now() - t0 }
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
      const titleSnippet = state.question.slice(0, 40);
      const newConv = await Conversation.create({
        title: titleSnippet || "New Conversation"
      });
      convId = newConv._id.toString();
    }

    await Message.create({
      conversationId: convId,
      role: "user",
      content: state.question
    });

    await Message.create({
      conversationId: convId,
      role: "assistant",
      content: state.finalAnswer,
      routedDepartments: state.routedDepartments,
      sources: state.sources,
      images: state.imageCitations,
      timings: state.timings
    });

    await Conversation.findByIdAndUpdate(convId, { updatedAt: new Date() });
  } catch (err) {
    console.warn(`[Node: saveConversation] Warning: ${err.message}`);
  }

  const duration = Date.now() - t0;
  const timings = state.timings || {};
  const total = Object.values(timings).reduce((acc, v) => acc + (typeof v === "number" ? v : 0), 0) + duration;

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
    .addEdge("loadConversationHistory", "router")
    .addEdge("router", "tabular")
    .addEdge("tabular", "textEmbedding")
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
