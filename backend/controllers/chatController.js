import { ragGraph } from "../graph/ragGraph.js";
import { Message } from "../models/Message.js";
import { Conversation } from "../models/Conversation.js";
import { routeDepartment } from "../services/router.js";
import { generateTextEmbedding } from "../services/embeddingService.js";
import { retrieveRelevantTextChunks } from "../services/textRetrieval.js";
import { siglipClient } from "../services/siglipClient.js";
import { retrieveRelevantImages } from "../services/imageRetrieval.js";
import { buildRAGContext } from "../services/contextBuilder.js";
import { streamAnswer } from "../services/llm.js";
import { formatSources, formatImageCitations } from "../utils/citations.js";

/**
 * Executes standard RAG query via compiled LangGraph
 */
export async function askQuestion(req, res) {
  try {
    const { question, conversationId } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ error: "Question cannot be empty" });
    }

    console.log(`[ChatController] Incoming question: "${question}" (conv: ${conversationId || "new"})`);

    const result = await ragGraph.invoke({
      question: question.trim(),
      conversationId: conversationId || null
    });

    res.json({
      success: true,
      conversationId: result.conversationId,
      answer: result.finalAnswer,
      routedDepartments: result.routedDepartments,
      confidence: result.routerConfidence,
      sources: result.sources,
      images: result.imageCitations,
      timings: result.timings
    });
  } catch (error) {
    console.error(`[ChatController Error] ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
      fallbackAnswer: "An unexpected error occurred while processing your request."
    });
  }
}

/**
 * Server-Sent Events (SSE) streaming endpoint for real-time ChatGPT-like generation
 */
export async function askQuestionStream(req, res) {
  const { question, conversationId } = req.body;
  if (!question || !question.trim()) {
    return res.status(400).json({ error: "Question cannot be empty" });
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const timings = {};
  const tTotal = Date.now();

  try {
    let convId = conversationId;
    if (!convId) {
      const newConv = await Conversation.create({
        title: question.trim().slice(0, 40)
      });
      convId = newConv._id.toString();
    }
    sendEvent("conversationId", { conversationId: convId });

    // 1. Load recent history
    const t0 = Date.now();
    const recentMsgs = await Message.find({ conversationId: convId })
      .sort({ createdAt: -1 })
      .limit(6)
      .lean();
    const history = recentMsgs.reverse().map((m) => ({ role: m.role, content: m.content }));
    timings.history = Date.now() - t0;

    // 2. Department Router
    const tRouter = Date.now();
    sendEvent("status", { message: "Routing to domain expertise..." });
    const routeResult = await routeDepartment(question, history);
    timings.router = Date.now() - tRouter;
    sendEvent("routed", {
      departments: routeResult.departments,
      confidence: routeResult.confidence,
      duration: timings.router
    });

    // 3. Text Embedding & Retrieval
    const tEmb = Date.now();
    sendEvent("status", { message: "Generating embeddings..." });
    const textEmb = await generateTextEmbedding(question);
    timings.textEmbedding = Date.now() - tEmb;

    const tRet = Date.now();
    sendEvent("status", { message: "Retrieving relevant knowledge excerpts..." });
    const textChunks = await retrieveRelevantTextChunks(textEmb, routeResult.departments);
    timings.textRetrieval = Date.now() - tRet;
    const sources = formatSources(textChunks);

    // 4. Image Embedding & Retrieval via SigLIP2
    const tSiglip = Date.now();
    sendEvent("status", { message: "Searching relevant visual diagrams..." });
    let images = [];
    let imageCitations = [];
    try {
      const siglipEmb = await siglipClient.embedText(question);
      timings.siglipEmbedding = Date.now() - tSiglip;

      const tImgRet = Date.now();
      images = await retrieveRelevantImages(siglipEmb, routeResult.departments);
      timings.imageRetrieval = Date.now() - tImgRet;
      imageCitations = formatImageCitations(images);
    } catch (e) {
      console.warn(`[Stream SigLIP notice] ${e.message}`);
    }

    // 5. Build context
    const tCtx = Date.now();
    const context = buildRAGContext(textChunks, images);
    timings.contextBuilder = Date.now() - tCtx;

    // 6. Stream LLM answer
    sendEvent("status", { message: "Formulating grounded response..." });
    const tLLM = Date.now();
    let fullAnswer = "";

    await streamAnswer(question, context.contextPrompt, history, (token) => {
      fullAnswer += token;
      sendEvent("token", { token });
    });
    timings.llm = Date.now() - tLLM;
    timings.total = Date.now() - tTotal;

    // 7. Save conversation
    await Message.create({
      conversationId: convId,
      role: "user",
      content: question
    });

    const assistantMsg = await Message.create({
      conversationId: convId,
      role: "assistant",
      content: fullAnswer,
      routedDepartments: routeResult.departments,
      sources,
      images: imageCitations,
      timings
    });

    await Conversation.findByIdAndUpdate(convId, { updatedAt: new Date() });

    // Send complete event with metadata
    sendEvent("complete", {
      messageId: assistantMsg._id,
      answer: fullAnswer,
      sources,
      images: imageCitations,
      timings
    });

    res.end();
  } catch (error) {
    console.error(`[askQuestionStream error] ${error.message}`);
    sendEvent("error", { message: error.message });
    res.end();
  }
}

/**
 * Message feedback handler (like / dislike)
 */
export async function submitFeedback(req, res) {
  try {
    const { messageId } = req.params;
    const { feedback } = req.body;

    if (!["like", "dislike", null].includes(feedback)) {
      return res.status(400).json({ error: "Invalid feedback value" });
    }

    const message = await Message.findByIdAndUpdate(
      messageId,
      { feedback },
      { new: true }
    );

    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    res.json({ success: true, message });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
