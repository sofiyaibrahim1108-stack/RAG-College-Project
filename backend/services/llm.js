import axios from "axios";
import { ENV } from "../config/env.js";
import { RAG_CONFIG } from "../config/rag.js";

/**
 * Builds the strict system prompt according to project specifications
 */
function buildSystemPrompt(contextPrompt) {
  return `You are a professional, knowledgeable AI Assistant.

Rules:
1. Answer using ONLY the provided document excerpts and diagrams.
2. Avoid speculation or ungrounded claims. If the answer is not contained in the excerpts, respond:
"I don't have enough information."
3. Formatting guidelines:
   - Provide clear, professional, moderately detailed, and easy-to-read answers in Markdown.
   - For multiple concepts:
     1. **Point**
        Explanation.
     2. **Point**
        Explanation.
   - For process or how-to questions:
     1. Step one
     2. Step two
     3. Step three
   - For comparisons: Use a clean Markdown table when comparing items, features, or technologies.
   - Do NOT force every answer into a numbered list. Use paragraphs, bullet points, or tables where appropriate.
   - Do NOT produce huge walls of text. Keep explanations crisp and readable.
4. Do NOT repeat the question.
5. Do NOT mention internal RAG implementation, "document context", or "the text states".

${contextPrompt}
`;
}

/**
 * Generates answer from local Ollama model (non-streaming)
 */
export async function generateAnswer(question, contextPrompt, conversationHistory = []) {
  const startTime = Date.now();

  if (contextPrompt === "NO_DOCUMENTS_FOUND") {
    return "I don't have enough information.";
  }

  const systemPrompt = buildSystemPrompt(contextPrompt);

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-RAG_CONFIG.historyWindow).map((m) => ({
      role: m.role,
      content: m.content
    })),
    { role: "user", content: question }
  ];

  try {
    const response = await axios.post(
      `${ENV.OLLAMA_BASE_URL}/api/chat`,
      {
        model: ENV.OLLAMA_LLM_MODEL,
        messages: messages,
        stream: false,
        options: {
          temperature: RAG_CONFIG.llm.temperature,
          num_predict: RAG_CONFIG.llm.num_predict,
          top_p: RAG_CONFIG.llm.top_p
        }
      },
      { timeout: 120000 }
    );

    const answer = response.data?.message?.content || "";
    console.log(`[LLM] Generated answer in ${Date.now() - startTime}ms`);
    return answer.trim();
  } catch (error) {
    console.error(`[LLM Error] Generation failed: ${error.message}`);
    throw new Error(`Ollama generation failed: ${error.message}`);
  }
}

/**
 * Streams answer from local Ollama model
 */
export async function streamAnswer(question, contextPrompt, conversationHistory = [], onToken) {
  if (contextPrompt === "NO_DOCUMENTS_FOUND") {
    const fallbackMsg = "I don't have enough information.";
    if (onToken) onToken(fallbackMsg);
    return fallbackMsg;
  }

  const systemPrompt = buildSystemPrompt(contextPrompt);

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-RAG_CONFIG.historyWindow).map((m) => ({
      role: m.role,
      content: m.content
    })),
    { role: "user", content: question }
  ];

  const response = await axios.post(
    `${ENV.OLLAMA_BASE_URL}/api/chat`,
    {
      model: ENV.OLLAMA_LLM_MODEL,
      messages: messages,
      stream: true,
      options: {
        temperature: RAG_CONFIG.llm.temperature,
        num_predict: RAG_CONFIG.llm.num_predict,
        top_p: RAG_CONFIG.llm.top_p
      }
    },
    {
      responseType: "stream",
      timeout: 180000
    }
  );

  let fullAnswer = "";

  return new Promise((resolve, reject) => {
    response.data.on("data", (chunk) => {
      const lines = chunk.toString().split("\n").filter((l) => l.trim() !== "");
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const token = parsed.message?.content || "";
          if (token) {
            fullAnswer += token;
            if (onToken) onToken(token);
          }
        } catch (e) {
          // ignore parsing edge chunks
        }
      }
    });

    response.data.on("end", () => {
      resolve(fullAnswer.trim());
    });

    response.data.on("error", (err) => {
      reject(err);
    });
  });
}
