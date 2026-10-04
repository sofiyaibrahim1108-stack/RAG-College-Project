import { Department } from "../models/Department.js";
import { Document } from "../models/Document.js";
import { DocumentChunk } from "../models/DocumentChunk.js";
import { ImageModel } from "../models/Image.js";

const GENERIC_ROUTER_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "it", "its",
  "this", "that", "these", "those", "i", "me", "my", "we", "our",
  "you", "your", "he", "she", "they", "them", "their", "who", "whom",
  "whose", "which", "what", "when", "where", "how", "why",
  "would", "could", "should", "will", "can", "may", "might",
  "not", "no", "so", "if", "as", "up", "out", "about", "does",
  "all", "any", "rag", "page", "pages", "sample", "document", "testing",
  "each", "other", "into", "more", "such", "than", "then", "some", "only"
]);

const UPPER_STOPWORDS = new Set([
  "PAGE", "THE", "AND", "FOR", "OF", "IN", "ON", "AT", "TO", "IS", "IT",
  "BY", "AS", "AN", "OR", "BE", "NO", "ALL", "NOT", "RAG", "WITH", "FROM", "THIS", "THAT"
]);

// Known out-of-scope trivia keywords that have no support in uploaded documents
const KNOWN_OUT_OF_SCOPE_REGEX = /\b(cricket|world cup|ipl|football|fifa|olympics|bollywood|hollywood|celebrity|president|prime minister|election|weather forecast|horoscope|zodiac)\b/i;

// Cache profiles in memory to avoid querying MongoDB on every single question
let cachedProfiles = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 60000; // 1 minute cache

/**
 * Dynamically queries all unique departments and their indexed document profiles from MongoDB.
 * Computes prominent keywords and acronyms automatically from MongoDB chunks without hardcoding.
 */
export async function getDepartmentProfiles() {
  const now = Date.now();
  if (cachedProfiles && (now - lastCacheTime) < CACHE_TTL_MS) {
    return cachedProfiles;
  }

  try {
    const dbDepts = await Department.find().select("name description").lean();
    const docs = await Document.find({ status: "completed" }).select("title originalName department fileType").lean();

    const deptMap = new Map();
    for (const d of dbDepts) {
      if (d.name && d.name.trim()) {
        deptMap.set(d.name.trim(), {
          name: d.name.trim(),
          description: d.description || "",
          docs: [],
          fileTypes: [],
          acronyms: [],
          topTerms: []
        });
      }
    }

    for (const doc of docs) {
      if (doc.department && typeof doc.department === "string") {
        const dName = doc.department.trim();
        if (!deptMap.has(dName)) {
          deptMap.set(dName, { name: dName, description: "", docs: [], fileTypes: [], acronyms: [], topTerms: [] });
        }
        const profile = deptMap.get(dName);
        const docName = doc.title || doc.originalName || "";
        if (docName && !profile.docs.includes(docName)) {
          profile.docs.push(docName);
        }
        if (doc.fileType && !profile.fileTypes.includes(doc.fileType)) {
          profile.fileTypes.push(doc.fileType);
        }
      }
    }

    // Extract dynamic acronyms and key terms from chunks for each department
    for (const profile of deptMap.values()) {
      try {
        const sampleChunks = await DocumentChunk.find({ department: profile.name })
          .limit(80)
          .select("content")
          .lean();

        if (sampleChunks.length > 0) {
          const rawText = sampleChunks.map((c) => c.content || "").join(" ");

          // 1. Dynamic Acronyms (uppercase 2-6 letter words appearing >= 3 times)
          const rawAcronyms = rawText.match(/\b[A-Z]{2,6}\b/g) || [];
          const acrFreqs = {};
          rawAcronyms.forEach((a) => {
            const aLower = a.toLowerCase();
            if (!GENERIC_ROUTER_STOPWORDS.has(aLower) && !UPPER_STOPWORDS.has(a)) {
              acrFreqs[a] = (acrFreqs[a] || 0) + 1;
            }
          });
          profile.acronyms = Object.entries(acrFreqs)
            .filter(([_, count]) => count >= 3)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([a]) => a);

          // 2. Dynamic Top Terms
          const words = rawText.toLowerCase().replace(/[^a-z0-9_\-\s]/g, " ").split(/\s+/).filter(
            (w) => w.length >= 3 && !GENERIC_ROUTER_STOPWORDS.has(w)
          );
          const freqs = {};
          words.forEach((w) => { freqs[w] = (freqs[w] || 0) + 1; });
          profile.topTerms = Object.entries(freqs)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([w]) => w);
        }
      } catch (e) {
        // ignore
      }
    }

    cachedProfiles = Array.from(deptMap.values());
    lastCacheTime = now;
    return cachedProfiles;
  } catch (err) {
    console.warn(`[Router] Error fetching departments: ${err.message}`);
    return [];
  }
}

/**
 * FAST DETERMINISTIC ROUTER (0-5ms, NO LLM CALLS)
 * Determines target department/document source and query type.
 *
 * Query Types:
 * - document_qa
 * - tabular
 * - visual_qa
 * - out_of_scope
 *
 * @param {string} question
 * @param {Array<{ role: string, content: string }>} conversationHistory
 * @returns {Promise<{ queryType: string, candidates: Array<{ department: string, confidence: number }>, departments: string[], confidence: number }>}
 */
export async function routeDepartment(question, conversationHistory = []) {
  const startTime = Date.now();
  const rawQ = question || "";
  const q = rawQ.trim().toLowerCase();

  // 1. Immediate Out-of-Scope Check for common outside trivia
  if (KNOWN_OUT_OF_SCOPE_REGEX.test(q)) {
    const elapsed = Date.now() - startTime;
    console.log(`[Router] Immediate OUT_OF_SCOPE detection in ${elapsed}ms: "${question}"`);
    return {
      queryType: "out_of_scope",
      candidates: [],
      departments: [],
      confidence: 1.0
    };
  }

  // 2. Fetch Department Profiles
  const profiles = await getDepartmentProfiles();
  if (profiles.length === 0) {
    const elapsed = Date.now() - startTime;
    console.log(`[Router] No departments found. Broad search in ${elapsed}ms`);
    return {
      queryType: "document_qa",
      candidates: [],
      departments: [],
      confidence: 1.0
    };
  }

  // 3. Media / Visual Intent
  const isVisual =
    /\b(screenshot|screenshots|diagram|diagrams|figure|figures|chart|charts|photo|illustration|flowchart|page\s*\d+\s*(?:show|contain|display))\b/i.test(rawQ) ||
    (/\b(image|images)\b/i.test(rawQ) && !/\b(?:total|count|number|how many)\s+images\b/i.test(rawQ));

  // 4. Generic Tabular Intent Detection
  const tabularProfile = profiles.find((p) =>
    p.fileTypes.some((ft) => ["csv", "xlsx", "xls"].includes(ft)) ||
    p.docs.some((doc) => /\.(csv|xlsx|xls)$/i.test(doc))
  );

  let isTabularIntent = false;
  if (tabularProfile) {
    const isExplicitTableWord = /\b(dataset|spreadsheet|csv|table\s+rows?|tabular|excel)\b/i.test(rawQ);
    const isAggregateOp = /\b(average|mean|highest|maximum|max|lowest|minimum|min|sum|count|distribution|percentage)\b/i.test(rawQ);
    if (isExplicitTableWord) {
      isTabularIntent = true;
    } else if (isAggregateOp) {
      // Check if question terms overlap with tabular profile's top terms or doc name
      const qTokens = rawQ.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !GENERIC_ROUTER_STOPWORDS.has(w));
      const hasTabularTermOverlap = (tabularProfile.topTerms || []).some((t) => qTokens.includes(t)) ||
        (tabularProfile.name && qTokens.some((t) => tabularProfile.name.toLowerCase().includes(t)));
      if (hasTabularTermOverlap) {
        isTabularIntent = true;
      }
    }
  }

  const queryType = isVisual ? "visual_qa" : (isTabularIntent ? "tabular" : "document_qa");

  // Tabular route: if question explicitly has tabular aggregate intent, route to tabular department
  if (isTabularIntent && tabularProfile) {
    const elapsed = Date.now() - startTime;
    console.log(`[Router] Tabular route to [${tabularProfile.name}] in ${elapsed}ms`);
    return {
      queryType: "tabular",
      candidates: [{ department: tabularProfile.name, confidence: 0.95 }],
      departments: [tabularProfile.name],
      confidence: 0.95
    };
  }

  // 5. Code Syntax Check (e.g., ===, !==, =>, ++, --)
  const hasCodeOperators = /(?:===|!==|=>|\+\+|--)/.test(rawQ);

  // 6. Match Exact Acronyms (e.g., \bDR\b, \bXYZ\b, \bJS\b)
  for (const p of profiles) {
    for (const acr of (p.acronyms || [])) {
      const isMatch = acr.length <= 3
        ? new RegExp(`\\b${acr}\\b`).test(rawQ)
        : new RegExp(`\\b${acr}\\b`, "i").test(rawQ);

      if (isMatch) {
        const elapsed = Date.now() - startTime;
        console.log(`[Router] Acronym match [${acr}] -> [${p.name}] in ${elapsed}ms`);
        return {
          queryType: isVisual ? "visual_qa" : "document_qa",
          candidates: [{ department: p.name, confidence: 0.95 }],
          departments: [p.name],
          confidence: 0.95
        };
      }
    }
  }

  // 6. Direct Full Name Match (full department name or full document title mentioned in question)
  for (const p of profiles) {
    const dLower = p.name.toLowerCase();
    if (dLower.length >= 3 && q.includes(dLower)) {
      const elapsed = Date.now() - startTime;
      console.log(`[Router] Exact department name match -> [${p.name}] type=${queryType} in ${elapsed}ms`);
      return {
        queryType,
        candidates: [{ department: p.name, confidence: 0.95 }],
        departments: [p.name],
        confidence: 0.95
      };
    }
    for (const doc of p.docs) {
      const docBase = doc.toLowerCase().replace(/\.[a-z0-9]+$/i, "").replace(/[_-]/g, " ");
      if (docBase.length >= 5 && q.includes(docBase)) {
        const elapsed = Date.now() - startTime;
        console.log(`[Router] Exact document title match -> [${p.name}] type=${queryType} in ${elapsed}ms`);
        return {
          queryType,
          candidates: [{ department: p.name, confidence: 0.95 }],
          departments: [p.name],
          confidence: 0.95
        };
      }
    }
  }

  // 7. Dynamic Token and Keyword Overlap Scoring across profiles
  const qWords = q
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !GENERIC_ROUTER_STOPWORDS.has(w));

  const candidateScores = [];
  for (const p of profiles) {
    let score = 0;

    // Code operators bonus if programming syntax present
    if (hasCodeOperators) {
      const isCodeDept = p.docs.some((d) => /\.(js|ts|py|java|cpp|c|html|css)/i.test(d)) ||
        /javascript|code|programming|script/i.test(p.name);
      if (isCodeDept) score += 3.0;
    }

    // Match individual words from department name
    const dTokens = p.name.toLowerCase().split(/\s+/).filter((w) => w.length >= 3 && !GENERIC_ROUTER_STOPWORDS.has(w));
    for (const dt of dTokens) {
      if (qWords.includes(dt)) {
        score += 1.5;
      }
    }

    // Match document filename tokens
    for (const doc of p.docs) {
      const docTerms = doc.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !GENERIC_ROUTER_STOPWORDS.has(w));
      for (const dt of docTerms) {
        if (qWords.includes(dt)) {
          score += 2.0;
        }
      }
    }

    // Match dynamic chunk top terms
    for (const term of (p.topTerms || [])) {
      if (qWords.includes(term) || q.includes(term)) {
        score += 1.5;
      }
    }

    if (score > 0) {
      candidateScores.push({ department: p.name, score });
    }
  }

  candidateScores.sort((a, b) => b.score - a.score);

  if (candidateScores.length > 0 && candidateScores[0].score >= 1.5) {
    const top = candidateScores[0];
    const second = candidateScores[1];
    const isHighConfidence = !second || top.score >= second.score * 1.5;
    const confidence = isHighConfidence ? 0.90 : 0.65;
    const depts = isHighConfidence ? [top.department] : [top.department, second.department];

    const elapsed = Date.now() - startTime;
    console.log(
      `[Router] Dynamic overlap match -> [${depts.join(", ")}] score=${top.score} type=${queryType} in ${elapsed}ms`
    );

    return {
      queryType,
      candidates: candidateScores.slice(0, 2).map((c) => ({
        department: c.department,
        confidence: c.department === top.department ? confidence : 0.5
      })),
      departments: depts,
      confidence
    };
  }

  // 8. If question specifies a page number or visual intent, search broadly across departments
  const pageMatch = rawQ.match(/\b(?:page|p\.?)\s*(\d+)\b/i);
  const hasPageSpecifier = !!pageMatch;

  if (isVisual && hasPageSpecifier) {
    const targetPage = parseInt(pageMatch[1], 10);
    try {
      const targetImg = await ImageModel.findOne({ pageNumber: targetPage }).select("department").lean();
      if (targetImg && targetImg.department) {
        const elapsed = Date.now() - startTime;
        console.log(`[Router] Visual query resolved to department [${targetImg.department}] for Page ${targetPage} in ${elapsed}ms`);
        return {
          queryType: "visual_qa",
          candidates: [{ department: targetImg.department, confidence: 0.95 }],
          departments: [targetImg.department],
          confidence: 0.95
        };
      }
    } catch (e) {
      // Fall through to broad search if image query encounters error
    }
  }

  if (isVisual || hasPageSpecifier) {
    const elapsed = Date.now() - startTime;
    console.log(`[Router] Visual/Page query without explicit department -> broad search type=${queryType} in ${elapsed}ms`);
    return {
      queryType: isVisual ? "visual_qa" : "document_qa",
      candidates: profiles.map((p) => ({ department: p.name, confidence: 0.8 })),
      departments: profiles.map((p) => p.name),
      confidence: 0.8
    };
  }

  // 9. Fallback to broad search across all departments
  // Specific evidence sufficiency and term grounding are validated by the Evidence Support Gate
  const elapsed = Date.now() - startTime;
  console.log(`[Router] No specific department keyword matched -> broad search type=${queryType} in ${elapsed}ms`);
  return {
    queryType: isVisual ? "visual_qa" : "document_qa",
    candidates: profiles.map((p) => ({ department: p.name, confidence: 0.7 })),
    departments: profiles.map((p) => p.name),
    confidence: 0.7
  };
}
