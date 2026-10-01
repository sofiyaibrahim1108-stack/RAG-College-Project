import { StateGraph, START, END } from "@langchain/langgraph";
import { RAGStateAnnotation } from "./graphState.js";
import { Message } from "../models/Message.js";
import { Conversation } from "../models/Conversation.js";
import { routeDepartment } from "../services/router.js";
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
 * 2. Node: departmentRouter
 */
async function departmentRouterNode(state) {
  const t0 = Date.now();
  try {
    const routeResult = await routeDepartment(state.question, state.conversationHistory);
    const duration = Date.now() - t0;
    console.log(`[Timing] Router: ${duration} ms`);

    return {
      routedDepartments: routeResult.departments,
      routerConfidence: routeResult.confidence,
      timings: { router: duration }
    };
  } catch (err) {
    console.warn(`[Node: departmentRouter] Fallback triggered: ${err.message}`);
    return {
      routedDepartments: ["General"],
      routerConfidence: 0.5,
      timings: { router: Date.now() - t0 }
    };
  }
}

/**
 * 3. Node: textEmbedding
 */
async function textEmbeddingNode(state) {
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
 * 4. Node: textRetrieval
 */
async function textRetrievalNode(state) {
  const t0 = Date.now();
  try {
    const chunks = await retrieveRelevantTextChunks(
      state.queryEmbedding,
      state.routedDepartments,
      undefined,
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
 * Determines whether a query has visual/diagram intent to avoid unnecessary SigLIP calls
 */
export function isVisualQuery(question) {
  if (!question) return false;
  const visualRegex =
    /\b(diagram|diagrams|figure|figures|image|images|screenshot|screenshots|picture|pictures|flowchart|flowcharts|architecture|chart|charts|graph|graphs|illustration|illustrations|photo|photos|drawing|drawings|visual|visuals|blueprint|map|layout|ui|interface|form|screen|page\s*\d+)\b/i;
  return visualRegex.test(question);
}

/**
 * 5. Node: imageEmbedding
 */
async function imageEmbeddingNode(state) {
  if (!isVisualQuery(state.question)) {
    return {
      siglipQueryEmbedding: [],
      timings: { siglipEmbedding: 0 }
    };
  }

  const t0 = Date.now();
  try {
    const siglipEmb = await siglipClient.embedText(state.question);
    const duration = Date.now() - t0;
    console.log(`[Timing] SigLIP: ${duration} ms`);

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
 * 6. Node: imageRetrieval
 */
async function imageRetrievalNode(state) {
  if (!state.siglipQueryEmbedding || state.siglipQueryEmbedding.length === 0) {
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
      undefined,
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
 * 7. Node: contextBuilder
 */
async function contextBuilderNode(state) {
  const t0 = Date.now();
  const context = buildRAGContext(state.retrievedChunks, state.retrievedImages);
  const duration = Date.now() - t0;
  console.log(`[Timing] Context Builder: ${duration} ms`);

  return {
    contextPrompt: context.contextPrompt,
    timings: { contextBuilder: duration }
  };
}

/**
 * 8. Node: generateAnswer
 */
async function generateAnswerNode(state) {
  const t0 = Date.now();

  // Pre-LLM Evidence Support Gate
  const gate = checkEvidenceSupportGate(state.question, state.contextPrompt);
  if (!gate.supported) {
    console.log(`[Evidence Gate] Question "${state.question}" rejected: ${gate.reason}. Skipping LLM call.`);
    console.log(`[RAG Decision] Final answer decision: FALLBACK (gate rejected: ${gate.reason})`);
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
      state.conversationHistory
    );
    const duration = Date.now() - t0;
    console.log(`[Timing] LLM: ${duration} ms`);

    const isMissingInfo = isFallbackAnswer(answer);
    const finalAnswer = isMissingInfo ? FALLBACK_MESSAGE : answer;

    console.log(
      `[RAG Decision] Final answer decision: ${isMissingInfo ? "FALLBACK (unsupported)" : "ANSWER (supported)"}`
    );

    return {
      finalAnswer,
      // If the answer is that info is missing, do not show citations
      sources: isMissingInfo ? [] : state.sources,
      imageCitations: isMissingInfo ? [] : state.imageCitations,
      timings: { llm: duration }
    };
  } catch (err) {
    console.error(`[Node: generateAnswer] Error: ${err.message}`);
    return {
      finalAnswer: "An error occurred while generating the answer. Please check if Ollama is running.",
      timings: { llm: Date.now() - t0 }
    };
  }
}

/**
 * 9. Node: saveConversation
 */
async function saveConversationNode(state) {
  const t0 = Date.now();
  let convId = state.conversationId;

  try {
    // If no conversationId provided, create a new conversation
    if (!convId) {
      const titleSnippet = state.question.slice(0, 40);
      const newConv = await Conversation.create({
        title: titleSnippet || "New Conversation"
      });
      convId = newConv._id.toString();
    }

    // 1. Save user question
    await Message.create({
      conversationId: convId,
      role: "user",
      content: state.question
    });

    // 2. Save assistant answer with sources and image citations
    await Message.create({
      conversationId: convId,
      role: "assistant",
      content: state.finalAnswer,
      routedDepartments: state.routedDepartments,
      sources: state.sources,
      images: state.imageCitations,
      timings: state.timings
    });

    // Touch conversation updatedAt
    await Conversation.findByIdAndUpdate(convId, { updatedAt: new Date() });
  } catch (err) {
    console.warn(`[Node: saveConversation] Warning: ${err.message}`);
  }

  const duration = Date.now() - t0;
  const timings = state.timings || {};
  const total = Object.values(timings).reduce((acc, v) => acc + (typeof v === "number" ? v : 0), 0) + duration;

  console.log(`[Timing]`);
  console.log(`Department Router: ${timings.router ?? 0} ms`);
  console.log(`Text Embedding: ${timings.textEmbedding ?? 0} ms`);
  console.log(`Text Retrieval: ${timings.textRetrieval ?? 0} ms`);
  console.log(`Image Embedding: ${timings.siglipEmbedding ?? 0} ms`);
  console.log(`Image Retrieval: ${timings.imageRetrieval ?? 0} ms`);
  console.log(`Context Building: ${timings.contextBuilder ?? 0} ms`);
  console.log(`LLM Generation: ${timings.llm ?? 0} ms`);
  console.log(`Total: ${total} ms`);

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
    .addNode("departmentRouter", departmentRouterNode)
    .addNode("textEmbedding", textEmbeddingNode)
    .addNode("textRetrieval", textRetrievalNode)
    .addNode("imageEmbedding", imageEmbeddingNode)
    .addNode("imageRetrieval", imageRetrievalNode)
    .addNode("contextBuilder", contextBuilderNode)
    .addNode("generateAnswer", generateAnswerNode)
    .addNode("saveConversation", saveConversationNode)
    .addEdge(START, "loadConversationHistory")
    .addEdge("loadConversationHistory", "departmentRouter")
    .addEdge("departmentRouter", "textEmbedding")
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
