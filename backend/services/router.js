import axios from "axios";
import { ENV } from "../config/env.js";
import { Department } from "../models/Department.js";
import { Document } from "../models/Document.js";

/**
 * Cleanly extracts JSON from an LLM response string
 */
function extractJson(text) {
  if (!text) return null;
  // Match json inside ```json ... ``` or first { ... }
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : text.trim();
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    return null;
  }
}

/**
 * Dynamically queries all unique departments from MongoDB Department collection
 */
async function getAvailableDepartments() {
  try {
    const dbDepts = await Department.find().select("name description").lean();
    const deptNames = new Set(dbDepts.map((d) => d.name.trim()));

    // Also include any distinct departments from indexed documents as safety fallback
    const docDepts = await Document.distinct("department");
    for (const d of docDepts) {
      if (d && typeof d === "string" && d.trim()) {
        deptNames.add(d.trim());
      }
    }

    return Array.from(deptNames);
  } catch (err) {
    console.warn(`[Router] Error fetching departments: ${err.message}`);
    return [];
  }
}

/**
 * Dynamic fallback classifier matching against actual database departments
 */
function fallbackDepartmentClassification(question, availableDepts = []) {
  const q = (question || "").toLowerCase();
  const matched = [];

  for (const dept of availableDepts) {
    const dLower = dept.toLowerCase();
    if (q.includes(dLower)) {
      matched.push(dept);
    }
  }

  return {
    departments: [...new Set(matched)],
    confidence: matched.length > 0 ? 0.7 : 0.0
  };
}

/**
 * LLM-based Department / Topic Router
 * Dynamically queries available departments from MongoDB Department collection
 * @param {string} question
 * @param {Array<{ role: string, content: string }>} conversationHistory
 * @returns {Promise<{ departments: string[], confidence: number }>}
 */
export async function routeDepartment(question, conversationHistory = []) {
  const startTime = Date.now();
  const availableDeptsList = await getAvailableDepartments();

  // If no departments exist in database, do not invent departments
  if (availableDeptsList.length === 0) {
    console.log(`[Router] No departments configured in database. Using broad search.`);
    return { departments: [], confidence: 1.0 };
  }

  const availableDepts = availableDeptsList.join(", ");

  const recentHistorySnippet = conversationHistory
    .slice(-3)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const prompt = `You are a high-accuracy query router in an enterprise knowledge system.
Analyze the user's question and recent conversation history, then identify which knowledge department(s) the question belongs to.
You can choose ONE or MULTIPLE departments from the available list if the question spans across multiple domains.
If none specifically fit, return an empty array []. Do NOT invent departments not in the list.

Available Departments: [${availableDepts}]

User Question: "${question}"
${recentHistorySnippet ? `Recent Context:\n${recentHistorySnippet}\n` : ""}

CRITICAL: Return valid JSON ONLY. No markdown explanation, no commentary.
Format:
{
  "departments": ["DepartmentName"],
  "confidence": 0.95
`;

  try {
    const response = await axios.post(
      `${ENV.OLLAMA_BASE_URL}/api/generate`,
      {
        model: ENV.OLLAMA_LLM_MODEL,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.0,
          num_predict: 80
        }
      },
      { timeout: 15000 }
    );

    const rawResponse = response.data?.response || "";
    const parsed = extractJson(rawResponse);

    if (
      parsed &&
      Array.isArray(parsed.departments) &&
      parsed.departments.length > 0 &&
      typeof parsed.confidence === "number"
    ) {
      console.log(
        `[Router] Classified into: [${parsed.departments.join(", ")}] with confidence ${parsed.confidence} (${Date.now() - startTime}ms)`
      );
      return {
        departments: parsed.departments,
        confidence: Math.min(1.0, Math.max(0.0, parsed.confidence))
      };
    }

    console.warn(`[Router Warning] Could not parse structured JSON from LLM: "${rawResponse}". Using fallback.`);
    return fallbackDepartmentClassification(question, availableDeptsList);
  } catch (error) {
    console.warn(`[Router Error] LLM routing failed (${error.message}). Using fallback classification.`);
    return fallbackDepartmentClassification(question, availableDeptsList);
  }
}
