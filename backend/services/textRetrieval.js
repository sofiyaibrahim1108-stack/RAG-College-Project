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

  // Domain-agnostic relevance bonuses
  let phraseBonus = 0;
  let metricBonus = 0;

  // 1. Exact Continuous Phrase Matching (2 or more contiguous terms from query)
  if (activeTerms.length >= 2) {
    for (let i = 0; i < activeTerms.length - 1; i++) {
      const bigram = `${activeTerms[i]} ${activeTerms[i + 1]}`;
      if (contentLower.includes(bigram)) {
        phraseBonus = Math.max(phraseBonus, 0.25);
        if (i < activeTerms.length - 2) {
          const trigram = `${bigram} ${activeTerms[i + 2]}`;
          if (contentLower.includes(trigram)) {
            phraseBonus = Math.max(phraseBonus, 0.35);
          }
        }
      }
    }
  }

  // 2. Numeric range & exact number check from query
  if (checkRangeMatch(rawQuestion, content)) {
    metricBonus = Math.max(metricBonus, 0.35);
  } else {
    const numsInQ = (rawQuestion || "").match(/\b\d+\b/g) || [];
    if (numsInQ.length > 0 && numsInQ.some((n) => content.includes(n))) {
      metricBonus = Math.max(metricBonus, 0.20);
    }
  }

  // 3. Exact Sub-phrase / Full Question match bonus
  if (queryTerms.length >= 3) {
    const cleanQ = rawQuestion.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
    if (cleanQ.length >= 10 && contentLower.includes(cleanQ)) {
      phraseBonus = Math.max(phraseBonus, 0.40);
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

  // 6. Rerank & Select Top Strongest Chunks with Page Diversity & Department Balance
  const seenPages = new Set();
  let ocrChunkCount = 0;
  const strongChunks = [];

  const isValidChunk = (c) => {
    if (!c._isPageMatch && c.rankingScore < 0.40 && c.lexicalScore < 0.15 && c.similarity < 0.40) {
      return false;
    }
    if (!asksVisualExplicitly && c.sourceType === "visual_ocr" && ocrChunkCount >= 1) {
      return false;
    }
    const pageKey = `${c.documentName}_p${c.pageNumber}`;
    if (!c._isPageMatch && seenPages.has(pageKey)) {
      return false;
    }
    return true;
  };

  const addChunk = (c) => {
    if (c.sourceType === "visual_ocr") ocrChunkCount++;
    seenPages.add(`${c.documentName}_p${c.pageNumber}`);
    strongChunks.push(c);
  };

  // If multiple departments were routed, guarantee top representation from each department
  if (routedDepartments && routedDepartments.length > 1) {
    for (const dept of routedDepartments) {
      let deptAdded = 0;
      for (const c of scoredCandidates) {
        if (c.department === dept && isValidChunk(c)) {
          addChunk(c);
          deptAdded++;
          if (deptAdded >= 2) break;
        }
      }
    }
  }

  // Fill remaining slots up to topK by best ranking score
  for (const c of scoredCandidates) {
    if (strongChunks.length >= topK) break;
    if (!strongChunks.includes(c) && isValidChunk(c)) {
      addChunk(c);
    }
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

/**
 * Evaluates whether retrieved chunks contain sufficient evidence for the given question.
 * Generic across all domains, document types, and questions.
 *
 * @param {Array<Object>} chunks
 * @param {string} question
 * @returns {{ sufficient: boolean, reason: string, coverageRatio: number, topScore: number }}
 */
export function isEvidenceSufficient(chunks, question) {
  if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
    return { sufficient: false, reason: "no_chunks", coverageRatio: 0, topScore: 0 };
  }

  const topSimilarity = Math.max(...chunks.map((c) => c.similarity || 0));
  const topRanking = Math.max(...chunks.map((c) => c.rankingScore || 0));
  const topScore = Math.max(topSimilarity, topRanking);

  // If even the best chunk has very low similarity/ranking score
  if (topScore < 0.48) {
    return { sufficient: false, reason: "low_score", coverageRatio: 0, topScore };
  }

  // Extract meaningful query content terms
  const queryTerms = extractQueryTerms(question);
  if (queryTerms.length === 0) {
    return { sufficient: topScore >= 0.55, reason: topScore >= 0.55 ? "sufficient" : "low_score", coverageRatio: 1, topScore };
  }

  // Check content term coverage across retrieved chunks
  const combinedContent = chunks.map((c) => (c.content || "").toLowerCase()).join(" ");
  let matchedCount = 0;
  for (const term of queryTerms) {
    if (combinedContent.includes(term)) {
      matchedCount++;
    } else {
      const root = term.replace(/(?:ing|ed|es|s)$/i, "");
      if (root.length >= 3 && combinedContent.includes(root)) {
        matchedCount++;
      }
    }
  }

  const coverageRatio = matchedCount / queryTerms.length;

  // Decisive sufficiency: strong score and good query term coverage
  if (topScore >= 0.68 && coverageRatio >= 0.50) {
    return { sufficient: true, reason: "strong_evidence", coverageRatio, topScore };
  }

  // Moderate score with at least 40% coverage
  if (topScore >= 0.55 && coverageRatio >= 0.40) {
    return { sufficient: true, reason: "moderate_evidence", coverageRatio, topScore };
  }

  // If coverage ratio is poor (< 35%), the chunks are likely missing the question's core subject
  if (coverageRatio < 0.35 && topScore < 0.82) {
    return { sufficient: false, reason: "poor_term_coverage", coverageRatio, topScore };
  }

  return { sufficient: topScore >= 0.60, reason: topScore >= 0.60 ? "score_pass" : "insufficient_coverage", coverageRatio, topScore };
}

/**
 * Generic routing safety net.
 * Router scoping is a targeted optimization. If the initial scoped retrieval returns
 * zero chunks or clearly insufficient evidence, or if broad retrieval reveals significantly
 * better evidence, automatically widen to broad retrieval.
 *
 * @param {number[]} queryEmbedding
 * @param {string[]} routedDepartments
 * @param {number} topK
 * @param {string} question
 * @returns {Promise<{ chunks: Array<Object>, widened: boolean }>}
 */
export async function retrieveWithScopeFallback(queryEmbedding, routedDepartments = [], topK = 5, question = "") {
  // If no routed departments specified, search broadly across all documents
  if (!routedDepartments || routedDepartments.length === 0) {
    const broad = await retrieveRelevantTextChunks(queryEmbedding, [], topK, undefined, question);
    return { chunks: broad, widened: false };
  }

  // 1. Scoped retrieval within the routed departments
  const scoped = await retrieveRelevantTextChunks(queryEmbedding, routedDepartments, topK, undefined, question);
  const scopedEval = isEvidenceSufficient(scoped, question);

  // If scoped retrieval is decisively strong, preserve targeted retrieval (do not search everything)
  if (scopedEval.sufficient && scopedEval.topScore >= 0.70 && scopedEval.coverageRatio >= 0.55) {
    console.log(`[TextRetrieval] Scoped retrieval [${routedDepartments.join(", ")}] sufficient: top=${scopedEval.topScore.toFixed(3)}, cov=${(scopedEval.coverageRatio * 100).toFixed(0)}%`);
    return { chunks: scoped, widened: false };
  }

  // 2. If scoped retrieval has 0 chunks, low score, or insufficient coverage:
  // Automatically fall back to broader retrieval across all departments
  console.log(
    `[TextRetrieval] Scoped evidence insufficient or marginal [${routedDepartments.join(", ")}] (${scopedEval.reason}, top=${scopedEval.topScore.toFixed(3)}, cov=${(scopedEval.coverageRatio * 100).toFixed(0)}%) -> falling back to broad retrieval`
  );

  const broad = await retrieveRelevantTextChunks(queryEmbedding, [], topK, undefined, question);
  const broadEval = isEvidenceSufficient(broad, question);

  // Broad wins if scoped was empty/insufficient, OR broad has better ranking score/coverage
  const broadIsBetter =
    !scopedEval.sufficient ||
    broadEval.topScore > scopedEval.topScore ||
    (broadEval.coverageRatio > scopedEval.coverageRatio && broadEval.topScore >= scopedEval.topScore - 0.05);

  if (broad.length > 0 && broadIsBetter) {
    console.log(
      `[TextRetrieval] Broad retrieval accepted: top=${broadEval.topScore.toFixed(3)}, cov=${(broadEval.coverageRatio * 100).toFixed(0)}% (vs scoped top=${scopedEval.topScore.toFixed(3)}, cov=${(scopedEval.coverageRatio * 100).toFixed(0)}%)`
    );
    return { chunks: broad, widened: true };
  }

  return { chunks: scoped, widened: false };
}
