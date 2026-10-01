import axios from "axios";
import { ENV } from "../config/env.js";
import { Department } from "../models/Department.js";
import { Document } from "../models/Document.js";

const PROGRAMMING_REGEX =
  /\b(variable|variables|keyword|keywords|const|let|var|function|functions|closure|closures|hoisting|scope|promise|promises|callback|callbacks|async|await|reduce|filter|map|array|arrays|object|objects|string|boolean|undefined|null|symbol|bigint|try\s*\.\.\.\s*catch|catch|console\.log|datatype|datatypes|primitive|reassign|reassigned|syntax|code|coding|javascript|js|ecmascript|es6|operator|operators|loop|loops|if\s+else)\b/i;

const COLLEGE_REGEX =
  /\b(college|campus|handbook|admission|admissions|tuition|hostel|faculty|professor|dean|principal|placement|curriculum|exam|exams|semester|library|scholarship|degree|btech|mtech|engineering|course|courses|sports|canteen|cafeteria|attendance|leave)\b/i;

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
 * Dynamically queries all unique departments and their indexed document profiles from MongoDB
 */
async function getDepartmentProfiles() {
  try {
    const dbDepts = await Department.find().select("name description").lean();
    const docs = await Document.find().select("title originalName department").lean();

    const deptMap = new Map();
    for (const d of dbDepts) {
      if (d.name && d.name.trim()) {
        deptMap.set(d.name.trim(), {
          name: d.name.trim(),
          description: d.description || "",
          docs: []
        });
      }
    }

    // Attach documents to their respective departments
    for (const doc of docs) {
      if (doc.department && typeof doc.department === "string") {
        const dName = doc.department.trim();
        if (!deptMap.has(dName)) {
          deptMap.set(dName, { name: dName, description: "", docs: [] });
        }
        const profile = deptMap.get(dName);
        const docName = doc.title || doc.originalName || "";
        if (docName && !profile.docs.includes(docName)) {
          profile.docs.push(docName);
        }
      }
    }

    return Array.from(deptMap.values());
  } catch (err) {
    console.warn(`[Router] Error fetching departments: ${err.message}`);
    return [];
  }
}

/**
 * Fast direct matcher against department names, keywords, and domain patterns
 */
function fastDepartmentMatch(question, profiles = []) {
  const q = (question || "").toLowerCase();

  // 1. Direct department name inclusion (e.g. "javascript", "college information")
  const directMatches = [];
  for (const p of profiles) {
    const dLower = p.name.toLowerCase();
    if (q.includes(dLower)) {
      directMatches.push(p.name);
    }
  }
  if (directMatches.length > 0) {
    return { departments: directMatches, confidence: 0.95 };
  }

  // 2. Domain pattern detection
  const isProg = PROGRAMMING_REGEX.test(q);
  const isCol = COLLEGE_REGEX.test(q);

  if (isProg && isCol) {
    const progDept = profiles.find(
      (p) =>
        /javascript|programming|code|software/i.test(p.name) ||
        p.docs.some((doc) => /javascript|code|programming/i.test(doc))
    );
    const colDept = profiles.find(
      (p) =>
        /college|campus|university|academic/i.test(p.name) ||
        p.docs.some((doc) => /college|handbook|campus/i.test(doc))
    );
    const matched = [];
    if (progDept) matched.push(progDept.name);
    if (colDept && !matched.includes(colDept.name)) matched.push(colDept.name);
    if (matched.length > 0) {
      return { departments: matched, confidence: 0.95 };
    }
  }

  if (isProg && !isCol) {
    const progDept = profiles.find(
      (p) =>
        /javascript|programming|code|software/i.test(p.name) ||
        p.docs.some((doc) => /javascript|code|programming/i.test(doc))
    );
    if (progDept) {
      return { departments: [progDept.name], confidence: 0.95 };
    }
  }

  if (isCol && !isProg) {
    const colDept = profiles.find(
      (p) =>
        /college|campus|university|academic/i.test(p.name) ||
        p.docs.some((doc) => /college|handbook|campus/i.test(doc))
    );
    if (colDept) {
      return { departments: [colDept.name], confidence: 0.95 };
    }
  }

  return null;
}

/**
 * LLM-based Department / Topic Router
 * Dynamically queries available departments from MongoDB
 * @param {string} question
 * @param {Array<{ role: string, content: string }>} conversationHistory
 * @returns {Promise<{ departments: string[], confidence: number }>}
 */
export async function routeDepartment(question, conversationHistory = []) {
  const startTime = Date.now();
  const profiles = await getDepartmentProfiles();

  if (profiles.length === 0) {
    console.log(`[Router] No departments configured in database. Using broad search.`);
    return { departments: [], confidence: 1.0 };
  }

  const allDeptNames = profiles.map((p) => p.name);

  // 1. Fast path: Direct unambiguous matching without LLM call (0ms)
  const fastMatch = fastDepartmentMatch(question, profiles);
  if (fastMatch) {
    console.log(
      `[Router Fast-Path] Direct match to [${fastMatch.departments.join(", ")}] in ${Date.now() - startTime}ms`
    );
    return fastMatch;
  }

  // Check conversation history for reference questions (e.g. "what about that?")
  let historyText = "";
  if (conversationHistory && conversationHistory.length > 0) {
    const recent = conversationHistory.slice(-2);
    historyText = recent.map((m) => `${m.role}: ${m.content}`).join("\n");
    if (question.split(/\s+/).length <= 6) {
      const historyFastMatch = fastDepartmentMatch(historyText, profiles);
      if (historyFastMatch) {
        console.log(
          `[Router Fast-Path] Resolved from conversation history [${historyFastMatch.departments.join(", ")}] in ${Date.now() - startTime}ms`
        );
        return historyFastMatch;
      }
    }
  }

  // 2. Dynamic Department Descriptions for LLM prompt
  const deptDescriptions = profiles
    .map((p) => {
      const docsStr = p.docs.length > 0 ? ` (Documents: ${p.docs.join(", ")})` : "";
      const descStr = p.description ? ` - ${p.description}` : "";
      return `- ${p.name}${docsStr}${descStr}`;
    })
    .join("\n");

  const prompt = `You are a query router in an enterprise knowledge system.
Match the user question to the department whose indexed documents contain the answer.

Available Departments:
${deptDescriptions}

Routing Guidelines:
- Questions about programming, syntax, variables (const, let, var), operators, functions, data types, closures, hoisting, scope, callbacks, promises, async/await, and error handling belong to programming/software departments (e.g., JavaScript).
- Questions about college admissions, campus, fees, hostels, faculty, courses, handbook, and administration belong to College Information.
- If the question spans multiple departments (e.g. asks about both programming and college information), include all relevant department names in the array: {"departments": ["JavaScript", "College Information"], "confidence": 0.95}.
- If completely unrelated or none fit, return [].

User Question: "${question}"
${historyText ? `Conversation Context:\n${historyText}\n` : ""}
Return ONLY a valid JSON object: {"departments": ["Name"], "confidence": 0.95}`;

  try {
    const response = await axios.post(
      `${ENV.OLLAMA_BASE_URL}/api/generate`,
      {
        model: ENV.OLLAMA_LLM_MODEL,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.0,
          num_predict: 40
        }
      },
      { timeout: 8000 }
    );

    const rawResponse = response.data?.response || "";
    const parsed = extractJson(rawResponse);

    if (
      parsed &&
      Array.isArray(parsed.departments) &&
      typeof parsed.confidence === "number"
    ) {
      const validDepts = parsed.departments.filter((d) =>
        allDeptNames.some((avail) => avail.toLowerCase() === d.toLowerCase())
      );

      console.log(
        `[Router LLM] Classified into: [${validDepts.join(", ")}] with confidence ${parsed.confidence} (${Date.now() - startTime}ms)`
      );
      return {
        departments: validDepts,
        confidence: Math.min(1.0, Math.max(0.0, parsed.confidence))
      };
    }

    console.warn(`[Router Warning] Could not parse structured JSON from LLM: "${rawResponse}". Using broad search.`);
    return { departments: allDeptNames, confidence: 0.5 };
  } catch (error) {
    console.warn(`[Router Notice] LLM routing error (${error.message}). Using broad search.`);
    return { departments: allDeptNames, confidence: 0.5 };
  }
}
