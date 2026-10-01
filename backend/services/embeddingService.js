import axios from "axios";
import { ENV } from "../config/env.js";

// In-memory LRU/map cache for repeated text snippets (e.g. repeated queries)
const embeddingCache = new Map();
const MAX_CACHE_SIZE = 1000;

/**
 * Generates vector embedding for a single text using local Ollama model
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function generateTextEmbedding(text) {
  const cleanText = (text || "").trim();
  if (!cleanText) {
    throw new Error("Text cannot be empty for embedding generation");
  }

  // Check cache
  if (embeddingCache.has(cleanText)) {
    return embeddingCache.get(cleanText);
  }

  try {
    const response = await axios.post(
      `${ENV.OLLAMA_BASE_URL}/api/embeddings`,
      {
        model: ENV.OLLAMA_EMBED_MODEL,
        prompt: cleanText
      },
      { timeout: 30000 }
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
    console.error(`[EmbeddingService Error] Failed to generate embedding: ${error.message}`);
    throw new Error(`Embedding generation failed: ${error.message}`);
  }
}

/**
 * Generates vector embeddings for a list of texts sequentially/in batches
 * @param {string[]} texts
 * @param {number} concurrency
 * @returns {Promise<number[][]>}
 */
export async function generateBatchTextEmbeddings(texts, concurrency = 4) {
  const results = new Array(texts.length);

  for (let i = 0; i < texts.length; i += concurrency) {
    const chunk = texts.slice(i, i + concurrency);
    const promises = chunk.map((text, idx) =>
      generateTextEmbedding(text).then((emb) => {
        results[i + idx] = emb;
      })
    );
    await Promise.all(promises);
  }

  return results;
}
