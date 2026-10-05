import { ragGraph } from "../graph/ragGraph.js";
import { Message } from "../models/Message.js";
import { FALLBACK_MESSAGE } from "../services/llm.js";

/**
 * Executes standard RAG query via compiled LangGraph (Non-streaming)
 */
export async function askQuestion(req, res) {
  try {
    const { question, conversationId } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({
        error: "Question cannot be empty"
      });
    }

    console.log(
      `[ChatController] Incoming question: "${question}" (conv: ${
        conversationId || "new"
      })`
    );

    const result = await ragGraph.invoke({
      question: question.trim(),
      conversationId: conversationId || null
    });

    res.json({
      success: true,
      conversationId: result.conversationId,
      answer: result.finalAnswer,
      queryType: result.queryType,
      routedDepartments: result.routedDepartments,
      candidates: result.routerCandidates,
      confidence: result.routerConfidence,
      sources: result.sources,
      images: result.imageCitations,
      fallbackReason: result.fallbackReason || null,
      timings: result.timings
    });
  } catch (error) {
    console.error(
      `[ChatController Error] ${error.stack || error.message}`
    );

    res.status(500).json({
      success: false,
      error: "An unexpected error occurred while processing your request.",
      fallbackAnswer: FALLBACK_MESSAGE
    });
  }
}

/**
 * Server-Sent Events (SSE) streaming endpoint via LangGraph
 * chatController is a thin API + streaming wrapper ONLY.
 */
export async function askQuestionStream(req, res) {
  const { question, conversationId } = req.body;

  if (!question || !question.trim()) {
    return res.status(400).json({
      error: "Question cannot be empty"
    });
  }

  // SSE HEADERS
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sendEvent = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      console.warn(`[SSE sendEvent notice] ${e.message}`);
    }
  };

  try {
    await ragGraph.invoke({
      question: question.trim(),
      conversationId: conversationId || null,
      onEvent: sendEvent
    });
  } catch (error) {
    console.error(`[ChatController Stream Error] ${error.stack || error.message}`);
    sendEvent("error", { message: error.message });
  } finally {
    res.end();
  }
}

/**
 * Message feedback handler
 */
export async function submitFeedback(req, res) {
  try {
    const { messageId } = req.params;
    const { feedback } = req.body;

    if (!["like", "dislike", null].includes(feedback)) {
      return res.status(400).json({
        error: "Invalid feedback value"
      });
    }

    const message = await Message.findByIdAndUpdate(
      messageId,
      { feedback },
      { new: true }
    );

    if (!message) {
      return res.status(404).json({
        error: "Message not found"
      });
    }

    res.json({
      success: true,
      message
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
}