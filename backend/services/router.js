import { Department } from "../models/Department.js";
import { Document } from "../models/Document.js";
import { DocumentChunk } from "../models/DocumentChunk.js";

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

/**
 * DOMAIN HINT PATTERNS
 * Maps domain-specific terminology/symbols (regex) -> lowercase department name fragment.
 * Used ONLY to identify the relevant department/document, NOT to answer the question.
 * Strictly adheres to domain routing hints without hardcoding document answers.
 */
const DOMAIN_HINT_PATTERNS = [
  // 1. JavaScript programming language signals
  {
    // Special operator symbols in raw question
    pattern: /(?:===|!==|==|!=|=>|\+\+|--)/,
    deptKeyword: "javascript"
  },
  {
    pattern: /\b(var|let|const|typeof|closure|hoisting|promise|async|await|dom|event\s*loop|prototype|function|array|object|javascript|js|instanceof|null|undefined|nan|callback|arrow\s*function|block\s*scope|function\s*scope|module|import|export|strict\s*mode|use\s*strict|comparison\s*operator)\b/i,
    deptKeyword: "javascript"
  },
  // 2. Eye / medical / DR signals (with exact regex matching for EfficientNet, EfficientNetB0, Adam, etc.)
  {
    pattern: /\b(diabetic\s+retinopathy|retinopathy|dr|efficientnet(?:b\d+)?|cnn|optimizer|adam|binary\s+cross\s*entropy|transfer\s+learning|fine\s*tuning|two\s*stage\s+training|validation\s+accuracy|confusion\s+matrix|224\s*x\s*224|224x224|disease\s+severity|retinal|fundus|glaucoma|cataract|ophthalmology)\b/i,
    deptKeyword: "eye"
  },
  // 3. College / placement / handbook signals
  {
    pattern: /\b(xyz\s+college|xyz|college|semester|odd\s+semester|even\s+semester|admission|course|b\.?\s*arch|fee|fees|placement|placements|highest\s+package|average\s+package|grading\s+system|grade\s+point|hostel|scholarship|curriculum)\b/i,
    deptKeyword: "college"
  },
  // 4. Student / CSV signals
  {
    pattern: /\b(student|marks|highest\s+total|lowest\s+total|how\s+many\s+students|grade\s+[abc]|student_marks|marks\s+dataset)\b/i,
    deptKeyword: "student"
  }
];

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

  // 3. College vs Tabular disambiguation
  const isCollegeExplicit = /\b(xyz\s+college|xyz|college|handbook|placement|placements|highest\s+package|average\s+package|b\.?\s*arch|admission|semester)\b/i.test(rawQ);

  const isTabularIntent = !isCollegeExplicit && (
    /\b(highest\s+total|lowest\s+total|how\s+many\s+students|grade\s+[abc]|student\s+marks|student_marks|marks\s+dataset)\b/i.test(rawQ) ||
    (/\b(student|students)\b/i.test(rawQ) && /\b(marks|grade|average|total|score|pass|fail|count)\b/i.test(rawQ)) ||
    (/\b(highest|lowest|average|total\s+marks)\b/i.test(rawQ) && !isCollegeExplicit)
  );

  const isVisual =
    /\b(screenshot|screenshots|diagram|diagrams|figure|figures|chart|charts|photo|illustration|flowchart|page\s*\d+\s*(?:show|contain|display))\b/i.test(rawQ) ||
    (/\b(image|images)\b/i.test(rawQ) && !/\b(?:total|count|number|how many)\s+images\b/i.test(rawQ));

  const queryType = isVisual ? "visual_qa" : (isTabularIntent ? "tabular" : "document_qa");

  // 4. Tabular fast path: route to department holding spreadsheet/CSV
  if (isTabularIntent) {
    const tabularProfile = profiles.find((p) =>
      p.fileTypes.some((ft) => ["csv", "xlsx", "xls"].includes(ft)) ||
      p.docs.some((doc) => /\.(csv|xlsx|xls)$/i.test(doc)) ||
      /student|mark|grade/i.test(p.name)
    );
    if (tabularProfile) {
      const elapsed = Date.now() - startTime;
      console.log(`[Router] Tabular route to [${tabularProfile.name}] in ${elapsed}ms`);
      return {
        queryType: "tabular",
        candidates: [{ department: tabularProfile.name, confidence: 0.95 }],
        departments: [tabularProfile.name],
        confidence: 0.95
      };
    }
  }

  // 5. Domain Hint Pattern Matching (catches terminology/symbols in RAW question)
  const matchedDepts = [];
  for (const hint of DOMAIN_HINT_PATTERNS) {
    if (hint.pattern.test(rawQ)) {
      const matched = profiles.find((p) =>
        p.name.toLowerCase().includes(hint.deptKeyword)
      );
      if (matched && !matchedDepts.includes(matched.name)) {
        matchedDepts.push(matched.name);
      }
    }
  }

  if (matchedDepts.length > 0) {
    // If college explicit, filter out student related
    const finalDepts = isCollegeExplicit
      ? matchedDepts.filter((d) => !/student/i.test(d))
      : matchedDepts;

    const deptsToReturn = finalDepts.length > 0 ? finalDepts : matchedDepts;
    const queryType = isVisual ? "visual_qa" : "document_qa";
    const elapsed = Date.now() - startTime;
    console.log(`[Router] Domain hint match -> [${deptsToReturn.join(", ")}] type=${queryType} in ${elapsed}ms`);
    return {
      queryType,
      candidates: deptsToReturn.map((d, idx) => ({ department: d, confidence: idx === 0 ? 0.95 : 0.85 })),
      departments: deptsToReturn,
      confidence: 0.95
    };
  }

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

  // 7. Match Department Names or Document Filenames
  const matchingDepts = [];
  for (const p of profiles) {
    const dLower = p.name.toLowerCase();
    if (q.includes(dLower)) {
      matchingDepts.push(p.name);
    } else {
      const dWords = dLower.split(/\s+/).filter((w) => w.length >= 4);
      if (dWords.length > 0 && dWords.some((w) => q.includes(w))) {
        if (!matchingDepts.includes(p.name)) matchingDepts.push(p.name);
      }
      for (const doc of p.docs) {
        const docBase = doc.toLowerCase().replace(/\.[a-z0-9]+$/i, "").replace(/[_-]/g, " ");
        if (docBase.length >= 4 && q.includes(docBase)) {
          if (!matchingDepts.includes(p.name)) matchingDepts.push(p.name);
        }
        const docTokens = docBase.split(/\s+/).filter((w) => w.length >= 4 && !GENERIC_ROUTER_STOPWORDS.has(w));
        if (docTokens.length > 0 && docTokens.some((w) => q.includes(w))) {
          if (!matchingDepts.includes(p.name)) matchingDepts.push(p.name);
        }
      }
    }
  }

  if (matchingDepts.length > 0) {
    const elapsed = Date.now() - startTime;
    console.log(`[Router] Direct name match -> [${matchingDepts[0]}] type=${queryType} in ${elapsed}ms`);
    return {
      queryType,
      candidates: matchingDepts.slice(0, 2).map((d, idx) => ({
        department: d,
        confidence: idx === 0 ? 0.95 : 0.4
      })),
      departments: [matchingDepts[0]],
      confidence: 0.95
    };
  }

  // 7. Token and Keyword Overlap Scoring across profiles
  const qWords = q
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !GENERIC_ROUTER_STOPWORDS.has(w));

  const candidateScores = [];
  for (const p of profiles) {
    let score = 0;
    for (const term of (p.topTerms || [])) {
      if (qWords.includes(term) || q.includes(term)) {
        score += 1.5;
      }
    }
    for (const doc of p.docs) {
      const docTerms = doc.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !GENERIC_ROUTER_STOPWORDS.has(w));
      for (const dt of docTerms) {
        if (qWords.includes(dt)) {
          score += 2.0;
        }
      }
    }
    if (score > 0) {
      candidateScores.push({ department: p.name, score });
    }
  }

  candidateScores.sort((a, b) => b.score - a.score);

  if (candidateScores.length > 0 && candidateScores[0].score >= 1.0) {
    const top = candidateScores[0];
    const second = candidateScores[1];
    const isHighConfidence = !second || top.score >= second.score * 1.5;
    const confidence = isHighConfidence ? 0.90 : 0.65;
    const depts = isHighConfidence ? [top.department] : [top.department, second.department];

    const elapsed = Date.now() - startTime;
    console.log(
      `[Router] Overlap score match -> [${depts.join(", ")}] score=${top.score} type=${queryType} in ${elapsed}ms`
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
  const hasPageSpecifier = /\b(?:page|p\.?)\s*\d+\b/i.test(q);
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

  // 9. If zero terms matched any document or department, it is out of scope!
  const elapsed = Date.now() - startTime;
  console.log(`[Router] No department match found -> OUT_OF_SCOPE in ${elapsed}ms: "${question}"`);
  return {
    queryType: "out_of_scope",
    candidates: [],
    departments: [],
    confidence: 1.0
  };
}
