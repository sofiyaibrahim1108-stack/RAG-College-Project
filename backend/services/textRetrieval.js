import { DocumentChunk } from "../models/DocumentChunk.js";
import { cosineSimilarity } from "../utils/similarity.js";
import { RAG_CONFIG } from "../config/rag.js";

/**
 * Standard domain-agnostic English stop words.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "it", "its",
  "this", "that", "these", "those", "i", "me", "my", "we", "our",
  "you", "your", "he", "she", "they", "them", "their", "who", "whom",
  "whose", "which", "what", "when", "where", "how", "why",
  "would", "could", "should", "will", "can", "may", "might",
  "not", "no", "so", "if", "as", "up", "out", "about", "does"
]);

/**
 * Extracts meaningful lexical terms from the query.
 * Domain-agnostic.
 * @param {string} question
 * @returns {string[]}
 */
export function extractQueryTerms(question) {
  if (!question) return [];
  return question
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * Computes generic lexical overlap and phrase-matching score between 0.0 and 1.0.
 * Prioritizes question-specific content words over scope/department name terms.
 *
 * @param {string[]} queryTerms
 * @param {string} rawQuestion
 * @param {string} content
 * @param {Set<string>} scopeTokens
 * @returns {number}
 */
/**
 * Checks if any numbers in the query fall into numeric ranges in content (e.g., 85 in "81–90").
 * Generic for grade tables, mark brackets, and numeric score ranges.
 */
function checkRangeMatch(query, content) {
  const numsInQuery = (query.match(/\b\d+\b/g) || []).map(Number);
  if (numsInQuery.length === 0) return false;
  const rangeRegex = /(\d{1,3})\s*[-–to]+\s*(\d{1,3})/gi;
  let match;
  while ((match = rangeRegex.exec(content)) !== null) {
    const low = parseInt(match[1], 10);
    const high = parseInt(match[2], 10);
    if (high > low && (high - low) <= 50) {
      for (const n of numsInQuery) {
        if (n >= low && n <= high) {
          const window = content.slice(Math.max(0, match.index - 80), match.index + 80).toLowerCase();
          if (/\b(?:mark|marks|grade|score|range|percentage|percent|point|points)\b/.test(window)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Computes generic lexical overlap and phrase-matching score between 0.0 and 1.0.
 * Prioritizes question-specific content words over scope/department name terms.
 *
 * @param {string[]} queryTerms
 * @param {string} rawQuestion
 * @param {string} content
 * @param {Set<string>} scopeTokens
 * @returns {number}
 */
function computeLexicalScore(queryTerms, rawQuestion, content, scopeTokens = new Set()) {
  if (!queryTerms || queryTerms.length === 0 || !content) return 0;
  const contentLower = content.toLowerCase();

  const contentTerms = queryTerms.filter((t) => !scopeTokens.has(t));
  const activeTerms = contentTerms.length > 0 ? contentTerms : queryTerms;

  let termMatches = 0;
  for (const term of activeTerms) {
    if (contentLower.includes(term)) {
      termMatches++;
    } else {
      const subwords = term.split(/[-_]/).filter((s) => s.length >= 3);
      if (subwords.length > 1 && subwords.some((s) => contentLower.includes(s))) {
        termMatches += 0.7;
      }
    }
  }

  let tokenCoverage = termMatches / activeTerms.length;

  // Metric & value bonus: prioritize chunks that contain actual measurements when asked
  let metricBonus = 0;
  const qLower = (rawQuestion || "").toLowerCase();
  const asksAccuracy = /\b(?:accuracy|percentage|rate|val_accuracy)\b/.test(qLower);
  if (asksAccuracy) {
    const hasMetricValue = /(?:\b\d+(\.\d+)?%|\b0\.\d{2,}\b)/.test(content);
    const hasAccuracyWord = /\b(?:accuracy|acc)\b/i.test(content);
    if (hasMetricValue && hasAccuracyWord) {
      metricBonus = 0.40;
    } else if (!hasMetricValue && hasAccuracyWord) {
      metricBonus = -0.15;
    }
  }

  if (checkRangeMatch(rawQuestion, content)) {
    metricBonus = 0.40;
  }

  // Bonus for exact sub-phrase match (>= 3 words)
  let phraseBonus = 0;
  if (queryTerms.length >= 3) {
    const cleanQ = rawQuestion.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
    if (contentLower.includes(cleanQ)) {
      phraseBonus = 0.20;
    }
  }

  return Math.min(1.0, Math.max(0, tokenCoverage + metricBonus + phraseBonus));
}

/**
 * Enterprise Hybrid Text Retrieval:
 * Semantic / Vector Similarity + Generic Lexical Matching + Metadata Filtering.
 *
 * Pipeline:
 * 1. Filter candidates by target department / document metadata (strict boundaries).
 * 2. Calculate cosine similarity against all candidates in target scope.
 * 3. Calculate content-weighted lexical relevance score.
 * 4. Combine into hybrid ranking score.
 * 5. Retrieve top candidates, rerank with page diversity, and keep top 4-5 strongest chunks.
 * 6. Never pad with irrelevant chunks.
 *
 * @param {number[]} queryEmbedding
 * @param {string[]} routedDepartments
 * @param {number} topK
 * @param {number} threshold
 * @param {string} question
 * @param {Object} filterMeta
 * @returns {Promise<Array<Object>>}
 */
export async function retrieveRelevantTextChunks(
  queryEmbedding,
  routedDepartments = [],
  topK = 5,
  threshold = RAG_CONFIG.textSimilarityThreshold,
  question = "",
  filterMeta = {}
) {
  const startTime = Date.now();

  if (!queryEmbedding || !Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    console.warn("[TextRetrieval] Empty query embedding — returning []");
    return [];
  }

  // 1. Build Metadata Query
  const mongoQuery = {};

  if (routedDepartments && routedDepartments.length > 0) {
    mongoQuery.department = { $in: routedDepartments };
  }

  if (filterMeta.documentId) {
    mongoQuery.documentId = filterMeta.documentId;
  }
  if (filterMeta.documentName) {
    mongoQuery.documentName = filterMeta.documentName;
  }

  // 2. Fetch candidate chunks
  const candidates = await DocumentChunk.find(mongoQuery)
    .select("documentId documentName pageNumber chunkIndex content department sourceType embedding")
    .lean();

  if (candidates.length === 0) {
    console.log(`[TextRetrieval] No chunks found matching query criteria [depts: ${routedDepartments.join(", ")}]`);
    return [];
  }

  // 3. Extract query terms and scope tokens
  const queryTerms = extractQueryTerms(question);
  const pageMatch = (question || "").toLowerCase().match(/\b(?:page|p\.?)\s*(\d+)\b/i);
  const targetPage = pageMatch ? parseInt(pageMatch[1], 10) : null;
  const asksVisualExplicitly = /\b(?:screenshot|image|diagram|figure|chart|confusion\s*matrix)\b/i.test(question || "");

  // Build scope tokens from routed departments/documents
  const scopeTokens = new Set();
  for (const d of routedDepartments) {
    d.toLowerCase().split(/\s+/).forEach((w) => {
      if (w.length >= 2) scopeTokens.add(w);
    });
  }
  if (filterMeta.documentName) {
    filterMeta.documentName.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).forEach((w) => {
      if (w.length >= 2) scopeTokens.add(w);
    });
  }

  // 4. Score and filter candidates
  const scoredCandidates = [];
  const seenPrefixes = new Set();

  for (const chunk of candidates) {
    if (!chunk.embedding || chunk.embedding.length === 0) continue;

    // Deduplication by content snippet
    const dedupeKey = `${chunk.documentId}_${chunk.pageNumber}_${(chunk.content || "").slice(0, 100)}`;
    if (seenPrefixes.has(dedupeKey)) continue;
    seenPrefixes.add(dedupeKey);

    const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
    const isPageMatch = targetPage !== null && chunk.pageNumber === targetPage;
    const lexicalScore = computeLexicalScore(queryTerms, question, chunk.content || "", scopeTokens);

    // Hybrid score combination (50% semantic + 50% lexical/metric + page match bonus)
    let hybridScore = (0.50 * sim) + (0.50 * lexicalScore);
    if (isPageMatch) {
      hybridScore += 0.25;
    }

    // Keep candidate if semantic similarity passes threshold OR strong lexical match with moderate similarity OR exact page match
    const passesSemantic = sim >= threshold;
    const passesLexicalHybrid = lexicalScore >= 0.35 && sim >= 0.40;
    const passesVisualOcr = chunk.sourceType === "visual_ocr" && (lexicalScore >= 0.25 || sim >= 0.42);

    if (passesSemantic || passesLexicalHybrid || isPageMatch || passesVisualOcr) {
      scoredCandidates.push({
        documentId: chunk.documentId,
        documentName: chunk.documentName,
        pageNumber: chunk.pageNumber,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        department: chunk.department,
        sourceType: chunk.sourceType || "text",
        similarity: parseFloat(sim.toFixed(4)),
        lexicalScore: parseFloat(lexicalScore.toFixed(4)),
        rankingScore: parseFloat(hybridScore.toFixed(4)),
        _isPageMatch: isPageMatch
      });
    }
  }

  // 5. Initial Sort: Rank by hybrid score (prioritizing explicit page match if requested)
  scoredCandidates.sort((a, b) => {
    if (a._isPageMatch && !b._isPageMatch) return -1;
    if (!a._isPageMatch && b._isPageMatch) return 1;
    return b.rankingScore - a.rankingScore;
  });

  // 6. Rerank & Select Top Strongest Chunks with Page Diversity
  // Take pool of top 16 candidates
  const pool = scoredCandidates.slice(0, 16);

  const seenPages = new Set();
  let ocrChunkCount = 0;
  const strongChunks = [];

  for (const c of pool) {
    // If not an explicit visual question, cap visual_ocr chunks at 1 so text chunks are not crowded out
    if (!asksVisualExplicitly && c.sourceType === "visual_ocr") {
      if (ocrChunkCount >= 1) continue;
      ocrChunkCount++;
    }

    // Enforce page diversity: at most 1 chunk per page from the same document (or 2 if page match)
    const pageKey = `${c.documentName}_p${c.pageNumber}`;
    if (!c._isPageMatch && seenPages.has(pageKey)) {
      continue;
    }
    seenPages.add(pageKey);

    strongChunks.push(c);
    if (strongChunks.length >= topK) break;
  }

  // Merge sibling chunks on the same page from candidate memory to preserve full context
  for (const c of strongChunks) {
    if (c.sourceType !== "visual_ocr" && c.pageNumber && c.documentId) {
      const pageSiblings = candidates
        .filter((cand) => String(cand.documentId) === String(c.documentId) && cand.pageNumber === c.pageNumber && cand.sourceType !== "visual_ocr")
        .sort((a, b) => a.chunkIndex - b.chunkIndex);

      if (pageSiblings.length > 1) {
        c.content = pageSiblings.map((s) => s.content).join("\n");
      }
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(
    `[TextRetrieval] Retained ${strongChunks.length} strongest chunks from ${candidates.length} candidates in ${elapsed}ms`
  );

  for (const c of strongChunks) {
    console.log(
      `[TextRetrieval]   p.${c.pageNumber ?? "?"} [${c.sourceType}] sim=${c.similarity} lex=${c.lexicalScore} rank=${c.rankingScore} doc="${c.documentName}"`
    );
  }

  return strongChunks.map(({ _isPageMatch, ...rest }) => rest);
}
