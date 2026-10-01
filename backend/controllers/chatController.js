import { ragGraph, isVisualQuery } from "../graph/ragGraph.js";
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
    console.error(`[ChatController Error] ${error.stack || error.message}`);
    res.status(500).json({
      success: false,
      error: "An unexpected error occurred while processing your request.",
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
    sendEvent("status", { message: "Searching your documents..." });
    const routeResult = await routeDepartment(question, history);
    timings.router = Date.now() - tRouter;
    sendEvent("routed", {
      departments: routeResult.departments,
      confidence: routeResult.confidence,
      duration: timings.router
    });

    // 3. Text Embedding & Retrieval
    const tEmb = Date.now();
    const textEmb = await generateTextEmbedding(question);
    timings.textEmbedding = Date.now() - tEmb;

    const tRet = Date.now();
    const textChunks = await retrieveRelevantTextChunks(
      textEmb,
      routeResult.departments,
      undefined,
      undefined,
      question
    );
    timings.textRetrieval = Date.now() - tRet;
    const sources = formatSources(textChunks);

    // 4. Image Embedding & Retrieval via SigLIP2 (only for queries with visual/diagram intent)
    let images = [];
    let imageCitations = [];
    if (isVisualQuery(question)) {
      const tSiglip = Date.now();
      sendEvent("status", { message: "Searching visual diagrams..." });
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
    } else {
      timings.siglipEmbedding = 0;
      timings.imageRetrieval = 0;
    }

    // 5. Build context
    const tCtx = Date.now();
    const context = buildRAGContext(textChunks, images);
    timings.contextBuilder = Date.now() - tCtx;

    // 6. Stream LLM answer
    let fullAnswer = "";
    let finalSources = sources;
    let finalImageCitations = imageCitations;

    if (context.contextPrompt === "NO_DOCUMENTS_FOUND" || (textChunks.length === 0 && images.length === 0)) {
      fullAnswer = "I don't have enough information.";
      sendEvent("token", { token: fullAnswer });
      timings.llm = 0;
      finalSources = [];
      finalImageCitations = [];
    } else {
      sendEvent("status", { message: "Generating grounded response..." });
      const tLLM = Date.now();

      await streamAnswer(question, context.contextPrompt, history, (token) => {
        fullAnswer += token;
        sendEvent("token", { token });
      });
      timings.llm = Date.now() - tLLM;

      if (!fullAnswer || fullAnswer.trim().startsWith("I don't have enough information")) {
        fullAnswer = "I don't have enough information.";
        finalSources = [];
        finalImageCitations = [];
      }
    }

    timings.total = Date.now() - tTotal;

    console.log(`[Timing]`);
    console.log(`Department Router: ${timings.router ?? 0} ms`);
    console.log(`Text Embedding: ${timings.textEmbedding ?? 0} ms`);
    console.log(`Text Retrieval: ${timings.textRetrieval ?? 0} ms`);
    console.log(`Image Embedding: ${timings.siglipEmbedding ?? 0} ms`);
    console.log(`Image Retrieval: ${timings.imageRetrieval ?? 0} ms`);
    console.log(`Context Building: ${timings.contextBuilder ?? 0} ms`);
    console.log(`LLM Generation: ${timings.llm ?? 0} ms`);
    console.log(`Total: ${timings.total ?? 0} ms`);

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
      sources: finalSources,
      images: finalImageCitations,
      timings
    });

    await Conversation.findByIdAndUpdate(convId, { updatedAt: new Date() });

    // Send complete event with metadata
    sendEvent("complete", {
      messageId: assistantMsg._id,
      answer: fullAnswer,
      sources: finalSources,
      images: finalImageCitations,
      timings
    });

    res.end();
  } catch (error) {
    console.error(`[askQuestionStream error] ${error.stack || error.message}`);
    sendEvent("error", { message: "An unexpected error occurred while processing your request." });
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
