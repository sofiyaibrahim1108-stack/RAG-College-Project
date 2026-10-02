import axios from "axios";
import { ENV } from "../config/env.js";
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

/**
 * Cleanly extracts JSON from an LLM response string
 */
function extractJson(text) {
  if (!text) return null;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : text.trim();
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    return null;
  }
}

/**
 * Dynamically queries all unique departments and their indexed document profiles from MongoDB.
 * Computes prominent keywords and acronyms automatically from MongoDB chunks without hardcoding.
 */
export async function getDepartmentProfiles() {
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

    // Attach documents to their respective departments
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
          .limit(100)
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
            .slice(0, 15)
            .map(([w]) => w);

          if (!profile.description || profile.description.trim().length === 0) {
            const combined = [...new Set([...profile.acronyms, ...profile.topTerms.slice(0, 8)])];
            profile.description = `Key Topics: ${combined.join(", ")}`;
          }
        }
      } catch (e) {
        // ignore
      }
    }

    return Array.from(deptMap.values());
  } catch (err) {
    console.warn(`[Router] Error fetching departments: ${err.message}`);
    return [];
  }
}

/**
 * Fast direct matcher against dynamically discovered department names, document names, and indexed acronyms
 */
function fastRouterMatch(question, profiles = []) {
  const q = (question || "").toLowerCase();

  // Detect explicit visual intent (exclude questions asking about counts like "total images")
  const isVisual =
    /\b(screenshot|screenshots|diagram|diagrams|figure|figures|chart|charts|photo|illustration|confusion matrix|flowchart|page\s*\d+\s*(?:show|contain|display))\b/i.test(q) ||
    (/\b(image|images)\b/i.test(q) && !/\b(?:total|count|number|how many)\s+images\b/i.test(q));

  // Detect explicit tabular calculation intent
  const isTabular = /\b(highest|lowest|average total|grade distribution|how many students|max marks|min marks|total marks|highest total)\b/i.test(q);

  // 1. Direct dynamic acronym match (e.g. \bDR\b, \bJS\b, \bXYZ\b)
  for (const p of profiles) {
    for (const acr of (p.acronyms || [])) {
      // Short acronyms (<= 3 chars) match case-sensitively to avoid matching English words
      const isMatch = acr.length <= 3
        ? new RegExp(`\\b${acr}\\b`).test(question)
        : new RegExp(`\\b${acr}\\b`, "i").test(question);

      if (isMatch) {
        let queryType = "document_qa";
        if (isTabular) queryType = "tabular";
        else if (isVisual) queryType = "visual_qa";

        return {
          queryType,
          candidates: [{ department: p.name, confidence: 0.95 }],
          departments: [p.name],
          confidence: 0.95
        };
      }
    }
  }

  // 2. Direct department name or document name match
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
        const docTokens = docBase.split(/\s+/).filter((w) => w.length >= 4);
        if (docTokens.length > 0 && docTokens.some((w) => q.includes(w))) {
          if (!matchingDepts.includes(p.name)) matchingDepts.push(p.name);
        }
      }
    }
  }

  if (matchingDepts.length > 0) {
    let queryType = "document_qa";
    if (isTabular) queryType = "tabular";
    else if (isVisual) queryType = "visual_qa";

    const candidates = matchingDepts.slice(0, 2).map((d, idx) => ({
      department: d,
      confidence: idx === 0 ? 0.95 : 0.4
    }));

    return {
      queryType,
      candidates,
      departments: [matchingDepts[0]],
      confidence: 0.95
    };
  }

  // 3. Tabular department matching
  if (isTabular) {
    const tabularProfile = profiles.find((p) =>
      p.fileTypes.some((ft) => ["csv", "xlsx", "xls"].includes(ft)) ||
      p.docs.some((doc) => /\.(csv|xlsx|xls)$/i.test(doc))
    );
    if (tabularProfile) {
      return {
        queryType: "tabular",
        candidates: [{ department: tabularProfile.name, confidence: 0.95 }],
        departments: [tabularProfile.name],
        confidence: 0.95
      };
    }
  }

  // 4. Dynamic top-terms overlap scoring (0ms fallback before calling LLM)
  const candidateScores = [];
  const qWords = q
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !GENERIC_ROUTER_STOPWORDS.has(w));

  for (const p of profiles) {
    let score = 0;
    for (const term of (p.topTerms || [])) {
      if (qWords.includes(term) || q.includes(term)) {
        score += 1;
      }
    }
    for (const doc of p.docs) {
      const docTerms = doc.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
      for (const dt of docTerms) {
        if (dt.length >= 4 && qWords.includes(dt)) {
          score += 1.5;
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

    let queryType = "document_qa";
    if (isTabular) queryType = "tabular";
    else if (isVisual) queryType = "visual_qa";

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

  return null;
}

/**
 * Enterprise Router: Determines target department/document source and query type.
 * Returns top 2 candidate sources with confidence.
 * If top candidate confidence is low (< 0.70), both are searched.
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
  const profiles = await getDepartmentProfiles();

  if (profiles.length === 0) {
    console.log(`[Router] No departments configured in database. Using broad search.`);
    return {
      queryType: "document_qa",
      candidates: [],
      departments: [],
      confidence: 1.0
    };
  }

  const allDeptNames = profiles.map((p) => p.name);

  // 1. Fast dynamic match without LLM call
  const fastMatch = fastRouterMatch(question, profiles);
  if (fastMatch) {
    console.log(
      `[Router Fast-Path] Direct match to [${fastMatch.departments.join(", ")}] type=${fastMatch.queryType} in ${Date.now() - startTime}ms`
    );
    return fastMatch;
  }

  // Conversation history reference context (used ONLY to resolve pronouns/references, NOT as facts)
  let historyText = "";
  if (conversationHistory && conversationHistory.length > 0) {
    const recent = conversationHistory.slice(-2);
    historyText = recent.map((m) => `${m.role}: ${m.content}`).join("\n");
  }

  // 2. Dynamic Department Descriptions for LLM prompt
  const deptDescriptions = profiles
    .map((p) => {
      const docsStr = p.docs.length > 0 ? ` (Documents: ${p.docs.join(", ")})` : "";
      const descStr = p.description ? ` - ${p.description}` : "";
      return `- "${p.name}"${docsStr}${descStr}`;
    })
    .join("\n");

  const prompt = `You are a query classifier and router in an enterprise knowledge system.
Given the user question and the available departments/documents, determine:
1. "queryType": exactly one of ["document_qa", "tabular", "visual_qa", "out_of_scope"]
   - "tabular": questions asking for calculations (highest, lowest, average, total, count, sum, ranking, distribution) from CSV/spreadsheet files.
   - "visual_qa": questions asking about screenshots, images, diagrams, confusion matrix, figures, charts, or what is shown on a specific page.
   - "document_qa": questions seeking factual information, concepts, explanations, steps, training, or code from uploaded documents.
   - "out_of_scope": ONLY questions completely unrelated to any uploaded department/document (e.g. cricket, celebrity gossip, world history, politics, outside trivia).
2. "candidates": top 2 candidate departments from the Available Departments list with confidence scores (0.0 to 1.0).

Available Departments and Documents:
${deptDescriptions}

Routing Instructions:
- Questions asking about neural network training, model architecture, medical screening, or disease systems belong to the corresponding technical department (e.g. Eye disease).
- Questions asking about programming language syntax, variables, keywords, functions, or JavaScript belong to the software/code department (e.g. JavaScript).
- Questions about college admissions, handbook, courses, placements, hostel, or college rules belong to College Information.
- If uncertain between two departments, list both in candidates.
- Never answer the question. Only classify and route.

User Question: "${question}"
${historyText ? `Recent Conversation Context:\n${historyText}\n` : ""}

Return ONLY a valid JSON object matching this schema:
{"queryType": "document_qa", "candidates": [{"department": "Name", "confidence": 0.95}, {"department": "Name2", "confidence": 0.40}]}`;

  try {
    const response = await axios.post(
      `${ENV.OLLAMA_BASE_URL}/api/generate`,
      {
        model: ENV.OLLAMA_LLM_MODEL,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.0,
          num_predict: 120
        }
      },
      { timeout: 45000 }
    );

    const rawResponse = response.data?.response || "";
    const parsed = extractJson(rawResponse);

    if (parsed) {
      let queryType = parsed.queryType || "document_qa";
      if (!["document_qa", "tabular", "visual_qa", "out_of_scope"].includes(queryType)) {
        queryType = "document_qa";
      }

      // Check if question asks about visual features
      if (/\b(screenshot|screenshots|diagram|figure|confusion matrix)\b/i.test(question)) {
        queryType = "visual_qa";
      }

      let candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
      candidates = candidates
        .filter((c) => c && typeof c.department === "string")
        .map((c) => {
          const matchedName = allDeptNames.find(
            (avail) => avail.toLowerCase() === c.department.trim().toLowerCase()
          );
          return matchedName ? { department: matchedName, confidence: Number(c.confidence) || 0.5 } : null;
        })
        .filter(Boolean);

      if (queryType === "out_of_scope" || candidates.length === 0) {
        console.log(`[Router LLM] Classified as OUT_OF_SCOPE in ${Date.now() - startTime}ms`);
        return {
          queryType: "out_of_scope",
          candidates: [],
          departments: [],
          confidence: 1.0
        };
      }

      const topConfidence = candidates[0].confidence;

      // If top confidence is low (< 0.70) and there's a second candidate, search both! Never hard-filter on a low-confidence guess.
      let departmentsToSearch = [];
      if (candidates.length >= 2 && topConfidence < 0.70) {
        departmentsToSearch = [candidates[0].department, candidates[1].department];
        console.log(
          `[Router LLM] Low confidence (${topConfidence.toFixed(2)}). Searching both top candidates: [${departmentsToSearch.join(", ")}]`
        );
      } else {
        departmentsToSearch = [candidates[0].department];
      }

      console.log(
        `[Router LLM] Routed queryType="${queryType}", depts=[${departmentsToSearch.join(", ")}], topConfidence=${topConfidence} in ${Date.now() - startTime}ms`
      );

      return {
        queryType,
        candidates,
        departments: departmentsToSearch,
        confidence: topConfidence
      };
    }

    console.warn(`[Router Warning] Could not parse JSON from LLM: "${rawResponse}". Using broad search.`);
    return {
      queryType: "document_qa",
      candidates: allDeptNames.map((d) => ({ department: d, confidence: 0.5 })),
      departments: allDeptNames,
      confidence: 0.5
    };
  } catch (error) {
    console.warn(`[Router Notice] LLM routing error (${error.message}). Using broad search.`);
    return {
      queryType: "document_qa",
      candidates: allDeptNames.map((d) => ({ department: d, confidence: 0.5 })),
      departments: allDeptNames,
      confidence: 0.5
    };
  }
}
