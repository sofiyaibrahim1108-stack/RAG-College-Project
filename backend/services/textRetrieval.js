import { DocumentChunk } from "../models/DocumentChunk.js";
import { cosineSimilarity } from "../utils/similarity.js";
import { RAG_CONFIG } from "../config/rag.js";

/**
 * Generic stop words: purely grammatical/functional words that carry no
 * topical signal. Kept minimal and domain-agnostic so any uploaded PDF
 * generalises without code changes.
 *
 * NOT included: comparison words (difference, versus…), question-type words
 * (explain, define…), or any project-specific terms. Those are meaningful
 * content words and must contribute to lexical matching.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "it", "its",
  "this", "that", "these", "those", "i", "me", "my", "we", "our",
  "you", "your", "he", "she", "they", "them", "their", "who", "whom",
  "whose", "which", "what", "when", "where", "how", "why",
  "would", "could", "should", "will", "can", "may", "might",
  "not", "no", "so", "if", "as", "up", "out", "about"
]);

/**
 * Extracts meaningful lexical terms from the question.
 * Strips punctuation, lowercases, removes stop words, and filters very
 * short tokens. Returns the set of content words — used only for ranking
 * bonus, never for hard yes/no filtering.
 *
 * @param {string} question
 * @returns {string[]}
 */
function extractQueryTerms(question) {
  if (!question) return [];
  return question
    .toLowerCase()
    .replace(/[=!<>&|~^%+\-*/?,.:;"'()\[\]{}]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Department-aware semantic text retrieval from MongoDB chunks.
 *
 * Pipeline (in order):
 *   1. Validate query embedding — return [] if missing.
 *   2. Apply department filter (hard boundary).
 *   3. Fetch candidate chunks from MongoDB.
 *   4. For each chunk: calculate cosine similarity.
 *   5. Discard chunks below RAG_CONFIG.textSimilarityThreshold.
 *   6. For chunks that pass: compute a small lexical coverage bonus from
 *      meaningful query terms (max +0.08 to ranking score).
 *   7. Deduplicate by (documentId, page, content prefix).
 *   8. Sort descending by rankingScore.
 *   9. Return top-K.  If nothing passes the threshold, return [].
 *
 * There is NO question-type specific grounding, no words[0] subject
 * assumption, and no hard-coded domain vocabulary.
 *
 * @param {number[]} queryEmbedding
 * @param {string[]} routedDepartments
 * @param {number} topK
 * @param {number} threshold
 * @param {string} question
 * @returns {Promise<Array<Object>>}
 */
export async function retrieveRelevantTextChunks(
  queryEmbedding,
  routedDepartments = [],
  topK = RAG_CONFIG.topKText,
  threshold = RAG_CONFIG.textSimilarityThreshold,
  question = ""
) {
  const startTime = Date.now();

  // ── Step 1: Validate query embedding ─────────────────────────────────────
  if (!queryEmbedding || !Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    console.warn("[TextRetrieval] Empty or invalid query embedding — returning []");
    return [];
  }

  // ── Step 2: Department filter (hard boundary, never leaked) ───────────────
  const deptQuery =
    routedDepartments && routedDepartments.length > 0
      ? { department: { $in: routedDepartments } }
      : {};

  // ── Step 3: Fetch candidates from MongoDB ────────────────────────────────
  const candidateChunks = await DocumentChunk.find(deptQuery)
    .select("documentId documentName pageNumber chunkIndex content department embedding")
    .lean();

  if (candidateChunks.length === 0) {
    if (routedDepartments && routedDepartments.length > 0) {
      console.log(
        `[TextRetrieval] No document chunks found for department(s) [${routedDepartments.join(", ")}]`
      );
    } else {
      console.log("[TextRetrieval] No document chunks found in database");
    }
    return [];
  }

  // ── Step 6 prep: extract meaningful query terms and page number for ranking ──
  const queryTerms = extractQueryTerms(question);
  const pageMatch = (question || "").toLowerCase().match(/\b(?:page|p\.?)\s*(\d+)\b/i);
  const targetPage = pageMatch ? parseInt(pageMatch[1], 10) : null;

  // ── Steps 4–7: Score, filter, deduplicate ────────────────────────────────
  const scoredChunks = [];
  const seenContentPrefix = new Set();

  for (const chunk of candidateChunks) {
    // Step 4a: Skip chunks with missing embeddings
    if (!chunk.embedding || chunk.embedding.length === 0) continue;

    // Step 4b: Cosine similarity (semantic — PRIMARY signal)
    const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
    const isPageMatch = targetPage !== null && chunk.pageNumber === targetPage;

    // Step 5: Hard threshold filter — allow chunks from explicitly requested page
    if (sim < threshold && !isPageMatch) continue;

    // Step 7: Deduplicate
    const prefixKey = `${chunk.documentId}_${chunk.pageNumber}_${(chunk.content || "").slice(0, 80)}`;
    if (seenContentPrefix.has(prefixKey)) continue;
    seenContentPrefix.add(prefixKey);

    // Step 6: Lexical bonus — small secondary signal, never overrides sim
    let lexicalBonus = 0;
    let lexicalCoverage = 0;
    if (queryTerms.length > 0) {
      const textLower = (chunk.content || "").toLowerCase();
      let matches = 0;
      for (const term of queryTerms) {
        if (textLower.includes(term)) matches++;
      }
      lexicalCoverage = matches / queryTerms.length;
      lexicalBonus = lexicalCoverage * 0.08;
    }

    const pageBonus = isPageMatch ? 0.25 : 0;

    scoredChunks.push({
      documentId: chunk.documentId,
      documentName: chunk.documentName,
      pageNumber: chunk.pageNumber,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      department: chunk.department,
      similarity: parseFloat(sim.toFixed(4)),
      rankingScore: sim + lexicalBonus + pageBonus,
      // Internal: used for sorting and logging below, not returned externally
      _lexicalCoverage: parseFloat(lexicalCoverage.toFixed(4)),
      _isPageMatch: isPageMatch
    });
  }

  // ── Step 8: Sort descending by ranking score (explicit page match prioritized) ─
  scoredChunks.sort((a, b) => {
    if (a._isPageMatch && !b._isPageMatch) return -1;
    if (!a._isPageMatch && b._isPageMatch) return 1;
    return b.rankingScore - a.rankingScore;
  });

  // ── Step 9: Take top-K ──────────────────────────────────────────────────
  const finalChunks = scoredChunks.slice(0, topK);

  // ── Logging ───────────────────────────────────────────────────────────────
  const elapsed = Date.now() - startTime;
  console.log(
    `[TextRetrieval] Retrieved ${finalChunks.length} chunks across departments [${routedDepartments.join(", ")}] in ${elapsed}ms`
  );

  for (const chunk of finalChunks) {
    console.log(
      `[TextRetrieval]   page=${chunk.pageNumber ?? "?"} ` +
      `sim=${chunk.similarity.toFixed(3)} ` +
      `lexCoverage=${chunk._lexicalCoverage.toFixed(2)} ` +
      `rankScore=${chunk.rankingScore.toFixed(3)} ` +
      `doc="${chunk.documentName}"`
    );
  }

  // Strip internal logging fields before returning
  return finalChunks.map(({ _lexicalCoverage, ...rest }) => rest);
}
