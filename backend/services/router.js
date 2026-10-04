import { Department } from "../models/Department.js";
import { Document } from "../models/Document.js";
import { DocumentChunk } from "../models/DocumentChunk.js";
import { ImageModel } from "../models/Image.js";
import { matchTokenToColumn, loadRows, analyseColumns, stemWord } from "./tabularProcessor.js";

/**
 * Centralized Generic Router Configuration
 * No domain-specific keywords, department names, or test fixtures.
 */
export const ROUTER_CONFIG = {
  MIN_CONFIDENCE_THRESHOLD: 0.85, // Below this, search all departments (broad search)
  MIN_CHUNK_OCCURRENCES_IDENTIFIER: 2, // Required distinct chunks for model/acronym
  MIN_PHRASE_OCCURRENCES: 2,
  TERM_SPECIFICITY_RATIO: 0.70, // Term must be >= 70% in this department
  SAMPLE_CHUNKS_PER_DEPT: 200, // MongoDB $sample size
  WEIGHTS: {
    EXACT_DEPT_NAME: 5.0,
    DEPT_NAME_TOKEN: 1.5,
    DOC_NAME_TOKEN: 2.0,
    TABULAR_COLUMN_MATCH: 4.5,
    TABULAR_CELL_MATCH: 4.0,
    TABULAR_OPERATOR_MATCH: 3.0,
    DISTINCTIVE_PHRASE: 3.5,
    DISTINCTIVE_TERM: 1.5,
    MODEL_IDENTIFIER: 3.0,
    ACRONYM: 2.5,
    CODE_SYNTAX: 4.0
  }
};

/**
 * Standard domain-agnostic English stop words.
 */
const GENERIC_ROUTER_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "it", "its",
  "this", "that", "these", "those", "i", "me", "my", "we", "our",
  "you", "your", "he", "she", "they", "them", "their", "who", "whom",
  "whose", "which", "what", "when", "where", "how", "why",
  "would", "could", "should", "will", "can", "may", "might",
  "not", "no", "so", "if", "as", "up", "out", "about", "does",
  "each", "other", "into", "more", "such", "than", "then", "some", "only",
  "tell", "show", "give", "find", "explain", "describe", "between", "difference"
]);

const UPPER_STOPWORDS = new Set([
  "THE", "AND", "FOR", "OF", "IN", "ON", "AT", "TO", "IS", "IT",
  "BY", "AS", "AN", "OR", "BE", "NO", "ALL", "NOT", "WITH", "FROM", "THIS", "THAT"
]);

// Generic follow-up & pronoun patterns
const FOLLOW_UP_PRONOUNS_REGEX = /\b(it|its|they|them|this|that|these|those)\b/i;
const FOLLOW_UP_PHRASES_REGEX = /\b(what about|how does it|what are its|explain further|tell me more|what is the result|what is the accuracy|what are the advantages|how does that|tell me about it)\b/i;

// Generic comparison & aggregate operator pattern for tabular reasoning
const GENERIC_OPERATOR_REGEX = /\b(above|below|between|more\s+than|less\s+than|greater\s+than|higher|lower|equal|highest|lowest|maximum|max|minimum|min|average|mean|sum|total|count|how\s+many|percentage|percent|distribution)\b/i;

// Escapes special regex characters in dynamic strings
export function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// In-memory precomputed department profiles
let cachedProfiles = null;
let lastCacheTime = 0;
let buildingPromise = null;

/**
 * Invalidate cached profiles when documents or departments are updated.
 * Automatically initiates profile recomputation in the background.
 */
export function invalidateDepartmentProfilesCache() {
  cachedProfiles = null;
  lastCacheTime = 0;
  buildingPromise = null;
  // Precompute warm profiles asynchronously
  buildDepartmentProfiles().catch((err) => {
    console.warn(`[Router Precompute Warning] ${err.message}`);
  });
}

/**
 * Checks whether a query has genuine visual intent (not image counters).
 * Completely generic without domain-specific terms.
 */
export function isVisualQuery(question) {
  if (!question) return false;
  const q = question.toLowerCase();

  // Explicit non-visual counter / metadata questions about images
  if (/\b(?:how many|number of|total|count of|image count|count)\s+images?\b/i.test(q)) {
    return false;
  }
  if (/\bimages?\s+(?:are in|in the dataset|in dataset)\b/i.test(q)) {
    return false;
  }

  // Generic visual inspection patterns
  const genuineVisualPatterns = [
    /\b(?:show|display|view)\s+(?:me\s+)?(?:the\s+)?(?:[a-z_\-]+\s+)?(?:image|figure|diagram|screenshot|photo|picture)\b/i,
    /\b(?:what does|what do)\s+the\s+(?:diagram|figure|image|screenshot|chart|flowchart)\s+show\b/i,
    /\bexplain\s+the\s+(?:figure|diagram|image|screenshot|chart)\b/i,
    /\bwhat is shown in the\s+(?:screenshot|image|diagram|figure)\b/i,
    /\bdescribe\s+the\s+(?:image|figure|diagram|screenshot)\b/i,
    /\bfigure\s*\d+\b/i,
    /\bdiagram\s+on\s+page\s*\d+\b/i,
    /\bpage\s*\d+\s*(?:show|contain|display|screenshot|figure|diagram)\b/i,
    /\b(?:screenshot|screenshots|flowchart|flowcharts)\b/i
  ];

  return genuineVisualPatterns.some((regex) => regex.test(q));
}

/**
 * Precomputes department profiles from MongoDB data.
 * Derives acronyms, model identifiers, distinctive phrases, unigrams,
 * and tabular schema columns + cell values dynamically without hardcoding.
 */
export async function buildDepartmentProfiles() {
  if (buildingPromise) return buildingPromise;

  buildingPromise = (async () => {
    const startTime = Date.now();

    try {
      const dbDepts = await Department.find().select("name description").lean();
    const docs = await Document.find({ status: "completed" }).select("title originalName department fileType path").lean();

    const deptMap = new Map();
    for (const d of dbDepts) {
      if (d.name && d.name.trim()) {
        const name = d.name.trim();
        deptMap.set(name, {
          name,
          description: d.description || "",
          docs: [],
          fileTypes: [],
          tabularDocs: [],
          tabularColumns: [],
          tabularCellValues: new Set(),
          isTabular: false,
          isCode: false,
          rawAcronymMap: new Map(), // acronym -> chunkCount
          rawModelMap: new Map(), // modelId -> chunkCount
          termFreq: new Map(),
          phraseFreq: new Map()
        });
      }
    }

    // Associate documents with department profiles
    for (const doc of docs) {
      const dName = doc.department ? doc.department.trim() : "";
      if (!dName) continue;
      if (!deptMap.has(dName)) {
        deptMap.set(dName, {
          name: dName,
          description: "",
          docs: [],
          fileTypes: [],
          tabularDocs: [],
          tabularColumns: [],
          tabularCellValues: new Set(),
          isTabular: false,
          isCode: false,
          rawAcronymMap: new Map(),
          rawModelMap: new Map(),
          termFreq: new Map(),
          phraseFreq: new Map()
        });
      }

      const profile = deptMap.get(dName);
      const docName = doc.title || doc.originalName || "";
      if (docName && !profile.docs.includes(docName)) {
        profile.docs.push(docName);
      }

      const fType = (doc.fileType || "").toLowerCase();
      if (fType && !profile.fileTypes.includes(fType)) {
        profile.fileTypes.push(fType);
      }

      // Check code file types from fileType or filename extension
      if (/\.(?:js|ts|jsx|tsx|py|java|cpp|c|cs|html|css|sh|rb|go)$/i.test(doc.originalName || "") ||
          ["js", "ts", "py", "java", "cpp", "c", "cs", "html", "css"].includes(fType)) {
        profile.isCode = true;
      }

      // Extract schema and sample cell values for tabular datasets
      if (["csv", "xlsx", "xls"].includes(fType) && doc.path) {
        profile.isTabular = true;
        profile.tabularDocs.push(doc);
        try {
          const rows = loadRows(doc);
          if (rows && rows.length > 0) {
            const cols = analyseColumns(rows);
            for (const col of cols) {
              if (!profile.tabularColumns.some((c) => c.name === col.name)) {
                profile.tabularColumns.push({
                  name: col.name,
                  isNumeric: col.isNumeric,
                  distinct: col.distinct || []
                });
              }
              // Store non-numeric sample cell values
              if (!col.isNumeric && col.distinct) {
                for (const d of col.distinct) {
                  const cleaned = String(d || "").trim().toLowerCase();
                  if (cleaned && cleaned.length >= 2) {
                    profile.tabularCellValues.add(cleaned);
                  }
                }
              }
            }
          }
        } catch (e) {
          // ignore unreadable spreadsheet
        }
      }
    }

    // Global term, acronym, and model tracking across departments
    const globalTermCounts = new Map();
    const globalAcronymDepts = new Map(); // acronym -> Set of deptNames
    const globalModelDepts = new Map(); // modelId -> Set of deptNames

    for (const [deptName, profile] of deptMap.entries()) {
      // Unbiased sampling using aggregate $sample (up to 200 chunks per dept)
      let chunks = [];
      try {
        chunks = await DocumentChunk.aggregate([
          { $match: { department: deptName } },
          { $sample: { size: ROUTER_CONFIG.SAMPLE_CHUNKS_PER_DEPT } },
          { $project: { content: 1 } }
        ]);
      } catch (err) {
        chunks = await DocumentChunk.find({ department: deptName })
          .select("content")
          .limit(ROUTER_CONFIG.SAMPLE_CHUNKS_PER_DEPT)
          .lean();
      }

      for (const chunk of chunks) {
        const text = chunk.content || "";

        // 1. Acronyms (uppercase 2-6 letters)
        const rawAcronyms = new Set(text.match(/\b[A-Z]{2,6}\b/g) || []);
        for (const a of rawAcronyms) {
          if (!GENERIC_ROUTER_STOPWORDS.has(a.toLowerCase()) && !UPPER_STOPWORDS.has(a)) {
            profile.rawAcronymMap.set(a, (profile.rawAcronymMap.get(a) || 0) + 1);
            if (!globalAcronymDepts.has(a)) globalAcronymDepts.set(a, new Set());
            globalAcronymDepts.get(a).add(deptName);
          }
        }

        // 2. Alphanumeric technical / model identifiers (digits + letters)
        const rawModels = new Set(text.match(/\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9_\-]{2,}\b/g) || []);
        for (const m of rawModels) {
          if (!/^\d+(?:st|nd|rd|th)$/i.test(m)) {
            profile.rawModelMap.set(m, (profile.rawModelMap.get(m) || 0) + 1);
            if (!globalModelDepts.has(m)) globalModelDepts.set(m, new Set());
            globalModelDepts.get(m).add(deptName);
          }
        }

        // 3. Unigrams & Bigrams
        const words = text
          .toLowerCase()
          .replace(/[^a-z0-9_\-\s]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length >= 3 && !GENERIC_ROUTER_STOPWORDS.has(w));

        for (let i = 0; i < words.length; i++) {
          const w = words[i];
          profile.termFreq.set(w, (profile.termFreq.get(w) || 0) + 1);
          globalTermCounts.set(w, (globalTermCounts.get(w) || 0) + 1);

          if (i < words.length - 1) {
            const bigram = `${w} ${words[i + 1]}`;
            profile.phraseFreq.set(bigram, (profile.phraseFreq.get(bigram) || 0) + 1);
          }
        }
      }
    }

    // Finalize department profiles with strict uniqueness filters
    const finalProfiles = [];
    for (const [deptName, profile] of deptMap.entries()) {
      // Keep acronyms that appear in >= N chunks AND are unique to this department
      const validAcronyms = new Set();
      for (const [acr, count] of profile.rawAcronymMap.entries()) {
        const deptsWithAcr = globalAcronymDepts.get(acr);
        if (count >= ROUTER_CONFIG.MIN_CHUNK_OCCURRENCES_IDENTIFIER && deptsWithAcr && deptsWithAcr.size === 1) {
          validAcronyms.add(acr);
        }
      }

      // Keep model identifiers that appear in >= N chunks AND are unique to this department
      const validModels = new Set();
      for (const [mId, count] of profile.rawModelMap.entries()) {
        const deptsWithModel = globalModelDepts.get(mId);
        if (count >= ROUTER_CONFIG.MIN_CHUNK_OCCURRENCES_IDENTIFIER && deptsWithModel && deptsWithModel.size === 1) {
          validModels.add(mId.toLowerCase());
        }
      }

      // Keep frequent department bigrams appearing >= N times
      const validPhrases = Array.from(profile.phraseFreq.entries())
        .filter(([_, count]) => count >= ROUTER_CONFIG.MIN_PHRASE_OCCURRENCES)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100)
        .map(([p]) => p);

      // Department-distinctive terms (>= 70% of occurrences belong to this department)
      const validTerms = new Set();
      for (const [term, count] of profile.termFreq.entries()) {
        const total = globalTermCounts.get(term) || count;
        if (count >= 2 && count / total >= ROUTER_CONFIG.TERM_SPECIFICITY_RATIO) {
          validTerms.add(term);
        }
      }

      // Pre-tokenized department name and document names
      const deptNameTokens = deptName
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !GENERIC_ROUTER_STOPWORDS.has(w));

      const docCleanTokens = profile.docs
        .map((doc) =>
          doc
            .toLowerCase()
            .replace(/\.[a-z0-9]+$/i, "")
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length >= 4 && !GENERIC_ROUTER_STOPWORDS.has(w))
        )
        .flat();

      finalProfiles.push({
        name: deptName,
        description: profile.description,
        docs: profile.docs,
        isTabular: profile.isTabular,
        isCode: profile.isCode,
        tabularColumns: profile.tabularColumns,
        tabularCellValues: profile.tabularCellValues,
        deptNameTokens: new Set(deptNameTokens),
        docCleanTokens: new Set(docCleanTokens),
        acronymsSet: validAcronyms,
        modelIdentifiersSet: validModels,
        distinctivePhrases: validPhrases,
        distinctiveTermsSet: validTerms
      });
    }

    cachedProfiles = finalProfiles;
    lastCacheTime = Date.now();
    console.log(`[Router] Precomputed ${cachedProfiles.length} department profiles in ${Date.now() - startTime}ms`);
    return cachedProfiles;
  } catch (err) {
    console.warn(`[Router] Error building department profiles: ${err.message}`);
    return cachedProfiles || [];
  } finally {
    buildingPromise = null;
  }
  })();

  return buildingPromise;
}

/**
 * Returns warm department profiles from cache or computes them if uninitialized.
 */
export async function getDepartmentProfiles() {
  if (cachedProfiles && cachedProfiles.length > 0) {
    return cachedProfiles;
  }
  const profiles = await buildDepartmentProfiles();
  return Array.isArray(profiles) ? profiles : [];
}


/**
 * FAST DETERMINISTIC ROUTER (0-2ms, NO LLM CALLS)
 * Determines target department/document source and query type.
 *
 * Query Types:
 * - document_qa
 * - tabular
 * - visual_qa
 * - out_of_scope
 *
 * @param {string} question
 * @param {Array<{ role: string, content: string, routedDepartments?: string[] }>} conversationHistory
 * @returns {Promise<{ queryType: string, candidates: Array<{ department: string, confidence: number }>, departments: string[], confidence: number }>}
 */
export async function routeDepartment(question, conversationHistory = []) {
  const startTime = Date.now();
  let rawQ = question || "";
  const isFollowUp = FOLLOW_UP_PRONOUNS_REGEX.test(rawQ) || FOLLOW_UP_PHRASES_REGEX.test(rawQ);
  if (isFollowUp && conversationHistory && conversationHistory.length > 0) {
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const msg = conversationHistory[i];
      if (msg.role === "user" && msg.content && msg.content !== rawQ) {
        rawQ = `${msg.content.trim()} ${rawQ}`;
        break;
      }
    }
  }
  const q = rawQ.trim().toLowerCase();

  // 1. Fetch Department Profiles
  const profiles = await getDepartmentProfiles();
  if (profiles.length === 0) {
    const elapsed = Date.now() - startTime;
    console.log(`[Router] No departments found. Broad search in ${elapsed}ms`);
    return {
      queryType: "document_qa",
      candidates: [],
      departments: [],
      confidence: 0.5
    };
  }

  // 2. Media / Visual Intent
  const isVisual = isVisualQuery(rawQ);

  // 3. Generic Page Specifier Check (Metadata filter)
  const pageMatch = rawQ.match(/\b(?:page|p\.?)\s*(\d+)\b/i);
  if (pageMatch) {
    const targetPage = parseInt(pageMatch[1], 10);
    try {
      let targetDoc = await DocumentChunk.findOne({ pageNumber: targetPage }).select("department").lean();
      if (!targetDoc) {
        targetDoc = await ImageModel.findOne({ pageNumber: targetPage }).select("department").lean();
      }
      if (targetDoc && targetDoc.department) {
        const elapsed = Date.now() - startTime;
        console.log(`[Router] Page ${targetPage} specifier resolved to department [${targetDoc.department}] in ${elapsed}ms`);
        return {
          queryType: "document_qa",
          candidates: [{ department: targetDoc.department, confidence: 0.95 }],
          departments: [targetDoc.department],
          confidence: 0.95
        };
      }
    } catch (e) {}
  }

  // 4. Tokenize question terms for fast Set lookups (no dynamic regex compilation)
  const qWords = q
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !GENERIC_ROUTER_STOPWORDS.has(w));

  const qWordsSet = new Set(qWords);

  // Raw uppercase tokens for acronym matching
  const rawTokens = rawQ.split(/[^A-Za-z0-9_\-]+/).filter(Boolean);

  // Bigrams array for phrase matching
  const qBigrams = [];
  for (let i = 0; i < qWords.length - 1; i++) {
    qBigrams.push(`${qWords[i]} ${qWords[i + 1]}`);
  }

  // Code syntax check
  const hasCodeOperators = /(?:===|!==|=>|\+\+|--|\b(?:var|let|const|console\.log|function)\b)/.test(rawQ);

  // Generic tabular operator check
  const hasTabularOp = GENERIC_OPERATOR_REGEX.test(rawQ);
  const isExplicitTableWord = /\b(dataset|spreadsheet|csv|table\s+rows?|tabular|excel)\b/i.test(rawQ);

  // 5. Score all department profiles
  const candidateScores = [];

  for (const p of profiles) {
    let score = 0;
    let tabularSignal = 0;

    // A. Model / Alphanumeric Identifiers ($O(1)$ set lookup)
    for (const token of qWords) {
      if (p.modelIdentifiersSet.has(token)) {
        score += ROUTER_CONFIG.WEIGHTS.MODEL_IDENTIFIER;
      }
    }

    // B. Acronyms Match ($O(1)$ set lookup)
    for (const token of rawTokens) {
      if (p.acronymsSet.has(token)) {
        score += ROUTER_CONFIG.WEIGHTS.ACRONYM;
      }
    }

    // C. Dynamic Distinctive Multi-word Phrases Match
    for (const phrase of p.distinctivePhrases) {
      if (q.includes(phrase)) {
        score += ROUTER_CONFIG.WEIGHTS.DISTINCTIVE_PHRASE;
      }
    }

    // D. Dynamic Distinctive Terms Match ($O(1)$ set lookup)
    for (const w of qWords) {
      if (p.distinctiveTermsSet.has(w)) {
        score += ROUTER_CONFIG.WEIGHTS.DISTINCTIVE_TERM;
      }
    }

    // E. Department Name Tokens ($O(1)$ set lookup)
    for (const dt of p.deptNameTokens) {
      if (qWordsSet.has(dt)) {
        score += ROUTER_CONFIG.WEIGHTS.DEPT_NAME_TOKEN;
      }
    }
    if (q.includes(p.name.toLowerCase())) {
      score += ROUTER_CONFIG.WEIGHTS.EXACT_DEPT_NAME;
    }

    // F. Document Name Tokens ($O(1)$ set lookup with stemming)
    for (const dt of p.docCleanTokens) {
      if (qWordsSet.has(dt) || qWords.some((w) => stemWord(w) === stemWord(dt))) {
        score += ROUTER_CONFIG.WEIGHTS.DOC_NAME_TOKEN;
      }
    }

    // G. Tabular Intent & Column Matching for Tabular Departments
    if (p.isTabular) {
      let matchedColCount = 0;
      for (const col of p.tabularColumns) {
        for (const w of qWords) {
          if (matchTokenToColumn(w, col.name)) {
            const isOperatorName = /^(?:average|avg|mean|total|sum|count|percentage|status)$/i.test(col.name);
            matchedColCount += isOperatorName ? 0.5 : 1;
            break;
          }
        }
      }

      if (matchedColCount > 0) {
        tabularSignal += matchedColCount * ROUTER_CONFIG.WEIGHTS.TABULAR_COLUMN_MATCH;
        score += matchedColCount * ROUTER_CONFIG.WEIGHTS.TABULAR_COLUMN_MATCH;
      }

      // Check categorical cell values (e.g. entities like names, locations, statuses)
      for (const cellVal of p.tabularCellValues) {
        if (cellVal.length >= 3 && q.includes(cellVal)) {
          tabularSignal += ROUTER_CONFIG.WEIGHTS.TABULAR_CELL_MATCH;
          score += ROUTER_CONFIG.WEIGHTS.TABULAR_CELL_MATCH;
          break;
        }
      }

      // Comparison/operator language attached to this tabular department
      if (hasTabularOp && (matchedColCount > 0 || score > 0)) {
        tabularSignal += ROUTER_CONFIG.WEIGHTS.TABULAR_OPERATOR_MATCH;
        score += ROUTER_CONFIG.WEIGHTS.TABULAR_OPERATOR_MATCH;
      }
      if (isExplicitTableWord) {
        tabularSignal += ROUTER_CONFIG.WEIGHTS.TABULAR_OPERATOR_MATCH;
        score += ROUTER_CONFIG.WEIGHTS.TABULAR_OPERATOR_MATCH;
      }
    }

    // H. Code operators bonus (only if department actually has code documents)
    if (hasCodeOperators && p.isCode) {
      score += ROUTER_CONFIG.WEIGHTS.CODE_SYNTAX;
    }

    if (score > 0) {
      candidateScores.push({ department: p.name, score, tabularSignal, isTabular: p.isTabular });
    }
  }

  candidateScores.sort((a, b) => b.score - a.score);

  // 6. Check for strong Tabular Intent
  const topCandidate = candidateScores[0];
  const isMultiTopicQuestion = /\b(and\s+also|as\s+well\s+as|both\b.+and\b)\b/i.test(rawQ);

  if (topCandidate && topCandidate.isTabular && topCandidate.tabularSignal >= 3.0 && !isMultiTopicQuestion) {
    const elapsed = Date.now() - startTime;
    console.log(`[Router] Tabular route to [${topCandidate.department}] (signal=${topCandidate.tabularSignal}) in ${elapsed}ms`);
    return {
      queryType: "tabular",
      candidates: [{ department: topCandidate.department, confidence: 0.95 }],
      departments: [topCandidate.department],
      confidence: 0.95
    };
  }

  // 7. Check if we matched with strong confidence (>= 2.5 score)
  if (candidateScores.length > 0 && candidateScores[0].score >= 2.5) {
    const top = candidateScores[0];
    const second = candidateScores[1];

    // Multi-department question support
    const isMultiDepartment =
      second &&
      second.score >= 2.5 &&
      second.score >= top.score * 0.45 &&
      isMultiTopicQuestion;

    const depts = isMultiDepartment ? [top.department, second.department] : [top.department];
    const confidence = isMultiDepartment ? 0.85 : (top.score >= 3.5 ? 0.95 : 0.85);

    const determinedQueryType = top.isTabular && top.tabularSignal > 0 ? "tabular" : "document_qa";
    const elapsed = Date.now() - startTime;
    console.log(
      `[Router] Dynamic match -> [${depts.join(", ")}] score=${top.score}${second ? ` (2nd=${second.score})` : ""} type=${determinedQueryType} in ${elapsed}ms`
    );

    return {
      queryType: determinedQueryType,
      candidates: candidateScores.slice(0, 2).map((c) => ({
        department: c.department,
        confidence: c.department === top.department ? confidence : 0.5
      })),
      departments: depts,
      confidence
    };
  }

  // 8. Conversation-Aware Routing (Follow-up & pronoun-based resolution)
  if (isFollowUp && conversationHistory && conversationHistory.length > 0) {
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const msg = conversationHistory[i];
      if (msg.routedDepartments && Array.isArray(msg.routedDepartments) && msg.routedDepartments.length > 0) {
        const elapsed = Date.now() - startTime;
        console.log(
          `[Router] Follow-up "${rawQ}" inherited department [${msg.routedDepartments.join(", ")}] from message history in ${elapsed}ms`
        );
        return {
          queryType: "document_qa",
          candidates: msg.routedDepartments.map((d) => ({ department: d, confidence: 0.85 })),
          departments: msg.routedDepartments,
          confidence: 0.85
        };
      }
      if (msg.role === "user" && msg.content && msg.content !== rawQ) {
        try {
          const prevRoute = await routeDepartment(msg.content, []);
          if (prevRoute && prevRoute.departments && prevRoute.departments.length > 0) {
            const elapsed = Date.now() - startTime;
            console.log(
              `[Router] Follow-up "${rawQ}" inherited department [${prevRoute.departments.join(", ")}] from previous question in ${elapsed}ms`
            );
            return {
              queryType: prevRoute.queryType,
              candidates: prevRoute.departments.map((d) => ({ department: d, confidence: 0.85 })),
              departments: prevRoute.departments,
              confidence: 0.85
            };
          }
        } catch (e) {}
      }
    }
  }

  // 9. Fallback: Below confidence threshold (< 0.85) -> return departments: []
  // Widen search to all departments so retrieval decides.
  const elapsed = Date.now() - startTime;
  console.log(`[Router] Low confidence / unrouted -> broad search (departments: []) in ${elapsed}ms`);
  return {
    queryType: "document_qa",
    candidates: [],
    departments: [],
    confidence: 0.5
  };
}

export { routeDepartment as routeQuery };
