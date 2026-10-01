import { api } from "./api";

export const chatApi = {
  /**
   * Non-streaming question request
   */
  async askQuestion(question, conversationId) {
    const res = await api.post("/chat/ask", { question, conversationId });
    return res.data;
  },

  /**
   * Streaming question request via Server-Sent Events
   */
  async streamQuestion(question, conversationId, callbacks = {}, abortSignal) {
    const { onStatus, onRouted, onToken, onComplete, onError, onConversationId } = callbacks;

    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, conversationId }),
        signal: abortSignal
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const evtBlock of events) {
          if (!evtBlock.trim()) continue;

          let eventName = "message";
          let dataStr = "";

          const lines = evtBlock.split("\n");
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventName = line.substring(7).trim();
            } else if (line.startsWith("data: ")) {
              dataStr = line.substring(6);
            }
          }

          if (dataStr) {
            try {
              const data = JSON.parse(dataStr);
              if (eventName === "conversationId" && onConversationId) {
                onConversationId(data.conversationId);
              } else if (eventName === "status" && onStatus) {
                onStatus(data.message);
              } else if (eventName === "routed" && onRouted) {
                onRouted(data);
              } else if (eventName === "token" && onToken) {
                onToken(data.token);
              } else if (eventName === "complete" && onComplete) {
                onComplete(data);
              } else if (eventName === "error" && onError) {
                onError(data.message);
              }
            } catch (err) {
              console.warn("Failed to parse SSE payload", err, dataStr);
            }
          }
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        console.log("Chat generation stopped by user");
        if (onComplete) onComplete({ stopped: true });
      } else {
        console.error("Stream error", err);
        if (onError) onError(err.message);
      }
    }
  },

  /**
   * Submit like or dislike feedback on assistant message
   */
  async submitFeedback(messageId, feedback) {
    const res = await api.post(`/chat/messages/${messageId}/feedback`, { feedback });
    return res.data;
  }
};
