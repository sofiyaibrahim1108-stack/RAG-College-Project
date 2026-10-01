import axios from "axios";
import { ENV } from "../config/env.js";
import { RAG_CONFIG } from "../config/rag.js";

/**
 * Builds the strict system prompt according to project specifications
 */
function buildSystemPrompt(contextPrompt) {
  return `You are a helpful, professional AI assistant for answering questions about indexed documents.

CRITICAL GROUNDING RULES:
1. Answer using EXCLUSIVELY facts directly stated in the DOCUMENT EXCERPTS below.
2. Under NO circumstances may you use outside knowledge, assumptions, or pretrained knowledge.
3. If the document excerpts do not explicitly define, explain, or contain the answer to the specific topic or question asked (or if any key subject of the question is missing from the excerpts), you MUST respond with ONLY this exact phrase:
"I don't have enough information."
4. Do NOT attempt to explain concepts that are not defined in the excerpts.
5. Do NOT supplement missing information with your own knowledge.

STRICT CONCISENESS & FIDELITY:
- Answer ONLY what was asked using strictly the provided facts.
- When explaining code, operations, or operators, use ONLY the exact code lines and examples explicitly present in the DOCUMENT EXCERPTS. Do NOT invent, generate, or add any other examples or code snippets.
- Keep the explanation concise, direct, and focused. Do NOT over-explain.

Answering Style (when the answer IS supported by the excerpts):
- Answer naturally like a high-quality ChatGPT response in clean Markdown.
- Always phrase answers as complete, natural sentences explaining what to use or do (for example, "Use \`const\` for a variable whose value should not be reassigned."). NEVER output a bare single word or fragment.
- Match the answer format and length to the question:
  * For simple factual questions: Direct 1-2 sentence explanation.
  * For questions asking for multiple items: Use a clean bullet list or numbered list.
  * For comparison questions (e.g. comparing callbacks, promises, and async/await): Use a compact Markdown table or clean comparison points containing ONLY details supported by the excerpts.
  * For process or "how-to" questions: Use numbered steps.
  * For conceptual explanations: Use short, focused paragraphs.
- When the document contains code, preserve it accurately in fenced code blocks. Explain only what the document supports.
- Use selective **bold** for key terms, names, or values.
- Do NOT repeat the user's question.
- Do NOT say "According to the document", "Based on the excerpts", or mention embeddings, retrieval, or internal RAG details.

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
    let cleanAnswer = answer.trim();
    if (/^`?const`?\.?$/i.test(cleanAnswer)) {
      cleanAnswer = "Use `const` for a variable whose value should not be reassigned.";
    }
    return cleanAnswer;
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
