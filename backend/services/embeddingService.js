import axios from "axios";
import { ENV } from "../config/env.js";

// In-memory LRU/map cache for repeated text snippets (e.g. repeated queries)
const embeddingCache = new Map();
const MAX_CACHE_SIZE = 1000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generates vector embedding for a single text using local Ollama model.
 * Includes retry handling with backoff for transient HTTP 500, timeout, or connection issues.
 * @param {string} text
 * @param {number} maxRetries
 * @returns {Promise<number[]>}
 */
export async function generateTextEmbedding(text, maxRetries = 3) {
  const cleanText = (text || "").trim();
  if (!cleanText) {
    throw new Error("Text cannot be empty for embedding generation");
  }

  // Check cache
  if (embeddingCache.has(cleanText)) {
    return embeddingCache.get(cleanText);
  }

  // Bound prompt text length (max 1500 chars) to stay safely within Ollama embedding context limit (512 tokens)
  const MAX_EMBED_CHARS = 1500;
  let promptText = cleanText.length > MAX_EMBED_CHARS ? cleanText.slice(0, MAX_EMBED_CHARS) : cleanText;

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(
        `${ENV.OLLAMA_BASE_URL}/api/embeddings`,
        {
          model: ENV.OLLAMA_EMBED_MODEL,
          prompt: promptText
        },
        { timeout: 45000 }
      );

      const embedding = response.data?.embedding;
      if (!embedding || !Array.isArray(embedding)) {
        throw new Error("Invalid embedding response from Ollama");
      }

      // Maintain cache size
      if (embeddingCache.size >= MAX_CACHE_SIZE) {
        const firstKey = embeddingCache.keys().next().value;
        embeddingCache.delete(firstKey);
      }
      embeddingCache.set(cleanText, embedding);

      return embedding;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const isRetryable =
        !status || status >= 500 || error.code === "ECONNRESET" || error.code === "ETIMEDOUT";

      if (error.response?.data?.error?.includes("context length") && promptText.length > 400) {
        promptText = promptText.slice(0, Math.floor(promptText.length * 0.7));
        console.warn(`[EmbeddingService] Prompt exceeded context length. Truncated to ${promptText.length} chars and retrying...`);
        continue;
      }

      if (attempt < maxRetries && isRetryable) {
        const backoffMs = attempt * 1000;
        console.warn(
          `[EmbeddingService] Attempt ${attempt}/${maxRetries} failed (${error.message}). Retrying in ${backoffMs}ms...`
        );
        await delay(backoffMs);
      } else {
        break;
      }
    }
  }

  console.error(`[EmbeddingService Error] Failed to generate embedding: ${lastError.message}`);
  throw new Error(`Embedding generation failed: ${lastError.message}`);
}

/**
 * Generates vector embeddings for a list of texts.
 * Clamps concurrency to 1 (sequential) to prevent local Ollama HTTP 500 overload.
 * @param {string[]} texts
 * @param {number} concurrency
 * @returns {Promise<number[][]>}
 */
export async function generateBatchTextEmbeddings(texts, concurrency = 1) {
  const safeConcurrency = Math.min(Math.max(1, Number(concurrency) || 1), 1);
  const results = new Array(texts.length);

  for (let i = 0; i < texts.length; i += safeConcurrency) {
    const chunk = texts.slice(i, i + safeConcurrency);
    const promises = chunk.map((text, idx) =>
      generateTextEmbedding(text).then((emb) => {
        results[i + idx] = emb;
      })
    );
    await Promise.all(promises);
  }

  return results;
}

