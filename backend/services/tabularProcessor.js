import fs from "fs";
import * as XLSX from "xlsx";
import axios from "axios";
import { Document } from "../models/Document.js";
import { ENV } from "../config/env.js";
import { generateTextEmbedding } from "./embeddingService.js";

/**
 * Deterministic tabular tool for CSV / spreadsheet datasets with
 * schema-grounded semantic query understanding.
 *
 * Pipeline:
 *   1. Dynamically inspect actual table schema (headers, inferred types, distinct/sample values).
 *   2. Semantic Query Understanding: Use local LLM with JSON mode to produce a semantic plan
 *      against the ACTUAL schema (zero keyword dictionaries or regex pattern lists).
 *   3. Strict Programmatic Validation: The LLM output is NOT authoritative; every field,
 *      column, data type, and filter value is strictly verified against real table data.
 *   4. Deterministic JavaScript Execution: Math is computed over all matching rows in memory.
 *   5. Authoritative Structured Output: Prevents LLM arithmetic or raw-row substitution.
 */

// Allowed execution contract enum
export const ALLOWED_OPERATIONS = new Set([
  "average",
  "sum",
  "min",
  "max",
  "count",
  "percentage",
  "distribution",
  "lookup",
  "filter",
  "rank",
  "none"
]);

function parseNum(val) {
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  if (typeof val === "string" && val.trim() !== "") {
    const cleaned = val.replace(/[,\s%₹$]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    return parseFloat(cleaned);
  }
  return null;
}

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "N/A";
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(2)));
}

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

// ---------- dynamic schema inspection ----------

export function analyseColumns(rows) {
  if (!rows || rows.length === 0) return [];
  const columns = Object.keys(rows[0] || {});
  return columns.map((name) => {
    const values = rows.map((r) => r[name]);
    const nonEmpty = values.filter((v) => String(v ?? "").trim() !== "");
    const numericCount = nonEmpty.filter((v) => parseNum(v) !== null).length;
    const isNumeric = nonEmpty.length > 0 && numericCount / nonEmpty.length >= 0.8;
    const distinct = isNumeric ? [] : [...new Set(nonEmpty.map((v) => String(v).trim()))];
    const sampleValues = isNumeric
      ? nonEmpty.slice(0, 3).map((v) => parseNum(v))
      : distinct.slice(0, 5);

    return {
      name,
      isNumeric,
      distinct,
      sampleValues
    };
  });
}

export function loadRows(doc) {
  const workbook = XLSX.read(fs.readFileSync(doc.path), { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

function escRe(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Standard Levenshtein edit distance for generic typo and plural tolerance.
 */
function editDistance(a, b) {
  if (!a) return b ? b.length : 0;
  if (!b) return a.length;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Generic linguistic suffix normalizer (strips English inflections without domain rules).
 */
export function stemWord(w) {
  if (!w || w.length <= 3) return w;
  if (w.endsWith("ies") && w.length >= 5) return w.slice(0, -3) + "y";
  if (w.endsWith("es") && w.length >= 5) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length >= 4) return w.slice(0, -1);
  if (w.endsWith("ing") && w.length >= 6) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length >= 5) return w.slice(0, -2);
  return w;
}

/**
 * Matches a query token to a schema column name using generic normalization:
 * lowercase, alphanumeric stripping, suffix stemming, and edit distance.
 */
export function matchTokenToColumn(token, colName) {
  if (!token || !colName) return false;
  const t = token.toLowerCase().replace(/[^a-z0-9]/g, "");
  const c = colName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!t || !c) return false;
  if (t === c) return true;

  // Generic stem match
  const tStem = stemWord(t);
  const cStem = stemWord(c);
  if (tStem.length >= 3 && cStem.length >= 3) {
    if (tStem === cStem) return true;
    const tBase = tStem.endsWith("e") ? tStem.slice(0, -1) : tStem;
    const cBase = cStem.endsWith("e") ? cStem.slice(0, -1) : cStem;
    if (tBase === cBase) return true;
  }

  // Edit distance (only for words of length >= 5 with distance 1)
  if (Math.abs(t.length - c.length) <= 1 && t.length >= 5 && c.length >= 5) {
    if (editDistance(t, c) <= 1) return true;
  }
  return false;
}

function normalizeOp(opStr) {
  const s = String(opStr).toLowerCase().trim();
  if (/^(?:above|greater(?:\s+than)?|more(?:\s+than)?|higher(?:\s+than)?|over|exceeding|exceeds|>)$/.test(s)) return "gt";
  if (/^(?:at\s+least|>=|min\s+of)$/.test(s)) return "gte";
  if (/^(?:below|less(?:\s+than)?|lower(?:\s+than)?|under|fewer(?:\s+than)?|<)$/.test(s)) return "lt";
  if (/^(?:at\s+most|<=|max\s+of)$/.test(s)) return "lte";
  if (/^(?:equal(?:\s+to)?|equals|==|=)$/.test(s)) return "eq";
  return null;
}

/**
 * Fast deterministic parser for structured queries.
 * Identifies column names, comparison operators, thresholds, and target operations directly from table schema.
 */
export function parseDeterministicQueryPlan(question, colInfo) {
  if (!question || !colInfo || colInfo.length === 0) return null;
  const q = question.trim();
  const qWords = q.split(/[\s,?.!;:()\[\]"]+/).filter(Boolean);

  const colByName = new Map();
  const colByLower = new Map();
  for (const c of colInfo) {
    colByName.set(c.name, c);
    colByLower.set(c.name.toLowerCase().trim(), c);
  }

  // 1. Identify all column mentions in question using exact regex + generic token matching
  const foundCols = [];
  const seenColNames = new Set();

  for (const col of colInfo) {
    // 1A. Direct regex match
    const patternStr = escRe(col.name).replace(/[_\-\s]+/g, "[\\s_\\-]+");
    const re = new RegExp(`\\b${patternStr}\\b`, "gi");
    let m = re.exec(q);
    if (m) {
      foundCols.push({ col, index: m.index, length: m[0].length, matchedText: m[0] });
      seenColNames.add(col.name);
      continue;
    }

    // 1B. Generic normalization / stem / edit-distance token match
    for (let i = 0; i < qWords.length; i++) {
      const w = qWords[i];
      if (matchTokenToColumn(w, col.name)) {
        foundCols.push({ col, index: q.toLowerCase().indexOf(w.toLowerCase()), length: w.length, matchedText: w });
        seenColNames.add(col.name);
        break;
      }
      if (i < qWords.length - 1) {
        const bigram = `${w} ${qWords[i + 1]}`;
        if (matchTokenToColumn(bigram, col.name)) {
          foundCols.push({ col, index: q.toLowerCase().indexOf(bigram.toLowerCase()), length: bigram.length, matchedText: bigram });
          seenColNames.add(col.name);
          break;
        }
      }
    }
  }

  // Sort identified columns by their appearance position in the question
  foundCols.sort((a, b) => a.index - b.index);

  // 2. Identify operation
  let operation = null;
  if (/\b(?:how\s+many|count\s+of|number\s+of|total\s+number\s+of)\b/i.test(q)) {
    operation = "count";
  } else if (/\b(?:highest|maximum|max|top|greatest|most|best)\b/i.test(q)) {
    operation = "max";
  } else if (/\b(?:lowest|minimum|min|least|bottom|worst)\b/i.test(q)) {
    operation = "min";
  } else if (/\b(?:average|mean|avg)\b/i.test(q)) {
    operation = "average";
  } else if (/\b(?:sum\s+of|total\s+sum)\b/i.test(q)) {
    operation = "sum";
  } else if (/\b(?:percentage|percent|%)\b/i.test(q)) {
    operation = "percentage";
  } else if (/\b(?:which|who|list|names?\s+of|find|show|give\s+me)\b/i.test(q)) {
    operation = "filter";
  }

  const opTokens = "above|greater(?:\\s+than)?|more(?:\\s+than)?|higher(?:\\s+than)?|over|exceeding|exceeds|below|less(?:\\s+than)?|lower(?:\\s+than)?|under|fewer(?:\\s+than)?|at\\s+least|at\\s+most|[><]=?";

  // 3. Extract filters
  const filters = [];

  // Pattern A1: Prefix Shared condition over multiple columns
  const prefixSharedRegex = new RegExp(
    `(?:scored\\s+|have\\s+|got\\s+|with\\s+)?(${opTokens})\\s*(\\d+(?:\\.\\d+)?)\\s+(?:in\\s+|for\\s+)?(?:both\\s+)?([^,.?!]+)`,
    "i"
  );
  const prefixMatch = prefixSharedRegex.exec(q);
  if (prefixMatch) {
    const rawOp = prefixMatch[1];
    const threshold = parseFloat(prefixMatch[2]);
    const op = normalizeOp(rawOp);
    const scopeSegment = prefixMatch[3];

    const colsInSegment = [];
    for (const c of colInfo) {
      if (matchTokenToColumn(scopeSegment, c.name) || new RegExp(`\\b${escRe(c.name)}\\b`, "i").test(scopeSegment)) {
        colsInSegment.push(c);
      }
    }

    if (colsInSegment.length >= 1 && op && !Number.isNaN(threshold)) {
      for (const c of colsInSegment) {
        if (c.isNumeric) {
          filters.push({ column: c.name, op, value: threshold });
        }
      }
    }
  }

  // Pattern B: Independent column conditions (e.g. "Math above 80", "more than 90 in Maths")
  if (filters.length === 0) {
    for (const col of colInfo) {
      if (!col.isNumeric) continue;

      // Col followed by op + num
      for (let i = 0; i < qWords.length; i++) {
        if (matchTokenToColumn(qWords[i], col.name)) {
          const afterText = q.slice(q.toLowerCase().indexOf(qWords[i].toLowerCase()) + qWords[i].length);
          const postM = new RegExp(`^\\s*(?:score|mark|marks)?\\s*(?:is|are|of|scored|got)?\\s*(${opTokens})\\s*(\\d+(?:\\.\\d+)?)`, "i").exec(afterText);
          if (postM) {
            const op = normalizeOp(postM[1]);
            const num = parseFloat(postM[2]);
            if (op && !Number.isNaN(num)) {
              filters.push({ column: col.name, op, value: num });
              break;
            }
          }
        }
      }

      // Op + num followed by col (e.g. "more than 90 in Maths")
      const preRe = new RegExp(`(${opTokens})\\s*(\\d+(?:\\.\\d+)?)\\s*(?:in|for|on)?\\s*([a-zA-Z0-9_\\-]+)`, "i");
      const preM = preRe.exec(q);
      if (preM) {
        const op = normalizeOp(preM[1]);
        const num = parseFloat(preM[2]);
        const targetWord = preM[3];
        if (op && !Number.isNaN(num) && matchTokenToColumn(targetWord, col.name)) {
          filters.push({ column: col.name, op, value: num });
        }
      }
    }
  }

  // Pattern C: Categorical column matching (e.g. distinct entities like person names, "Pass", "East")
  let matchedEntityFilter = null;
  for (const col of colInfo) {
    if (col.isNumeric || !col.distinct) continue;
    for (const d of col.distinct) {
      if (!d) continue;
      const strVal = String(d).trim();
      if (!strVal) continue;

      let isMatch = false;
      const dPattern = escRe(strVal).replace(/[_\-\s]+/g, "[\\s_\\-]+");

      if (strVal.length <= 2) {
        // Categorical values of 1-2 characters (like Grade A/B/C) must match ONLY if:
        // (1) The column name from the schema appears next to the value in the question, OR
        // (2) The value appears as an exact uppercase standalone token. Plain article "a" must never create a filter.
        const colPattern = escRe(col.name).replace(/[_\-\s]+/g, "[\\s_\\-]+");
        const nearColRe = new RegExp(`(?:\\b${colPattern}\\s*(?:is|equals|:|==|=|-)?\\s*${dPattern}\\b|\\b${dPattern}\\s+${colPattern}\\b)`, "i");
        const exactUpperRe = new RegExp(`\\b${dPattern}\\b`); // Exact uppercase (case-sensitive)
        if (nearColRe.test(q) || exactUpperRe.test(q)) {
          isMatch = true;
        }
      } else {
        const dRe = new RegExp(`\\b${dPattern}\\b`, "i");
        if (dRe.test(q)) {
          isMatch = true;
        }
      }

      if (isMatch) {
        const f = { column: col.name, op: "eq", value: d };
        filters.push(f);
        if (/name|student|person|user|product|item|employee|order/i.test(col.name) || strVal.length >= 3) {
          matchedEntityFilter = f;
        }
      }
    }
  }

  // If query contains personal/possessive pronouns but no entity was identified,
  // it is an unresolved follow-up and cannot be deterministically answered without resolved context
  const hasUnresolvedPronoun = /\b(he|she|they|his|her|their|him|them)\b/i.test(q) && !matchedEntityFilter;
  if (hasUnresolvedPronoun) {
    return null;
  }

  // 4. Resolve operation and target column
  let targetColumn = null;
  const numericFound = foundCols.filter((fc) => fc.col.isNumeric);

  // If an entity was matched (e.g. specific entity filter) AND another column was mentioned in the question:
  // This is a single-cell LOOKUP!
  const requestedCol = foundCols.find((fc) => fc.col.name !== matchedEntityFilter?.column);
  if (matchedEntityFilter && requestedCol) {
    operation = "lookup";
    targetColumn = requestedCol.col.name;
  } else if (["average", "sum", "min", "max"].includes(operation)) {
    if (numericFound.length > 0) {
      targetColumn = numericFound[0].col.name;
    }
  } else if (operation === "count") {
    targetColumn = numericFound.length > 0 ? numericFound[0].col.name : (colInfo[0]?.name || null);
  } else if (operation === "filter") {
    const nameCol = colInfo.find((c) => /name/i.test(c.name) && !c.isNumeric) ||
                    colInfo.find((c) => !c.isNumeric) ||
                    colInfo[0];
    targetColumn = nameCol ? nameCol.name : null;
  }

  // Ordinal rank extraction (e.g. "second student", "2nd highest", "top student", "3rd")
  const ORDINAL_MAP = {
    first: 1, "1st": 1,
    second: 2, "2nd": 2,
    third: 3, "3rd": 3,
    fourth: 4, "4th": 4,
    fifth: 5, "5th": 5,
    sixth: 6, "6th": 6,
    seventh: 7, "7th": 7,
    eighth: 8, "8th": 8,
    ninth: 9, "9th": 9,
    tenth: 10, "10th": 10
  };
  const ordinalMatch = /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|ninth|9th|tenth|10th)\b/i.exec(q);
  const rankIndex = ordinalMatch ? ORDINAL_MAP[ordinalMatch[1].toLowerCase()] : null;
  const rankOrder = /\b(lowest|bottom|min|minimum|worst|least)\b/i.test(q) ? "asc" : "desc";

  if (rankIndex && (rankIndex > 1 || /\b(?:rank|ranked|student|record|person|row|highest|lowest)\b/i.test(q))) {
    operation = "rank";
    const targetNumericCol = numericFound.length > 0
      ? numericFound[0].col.name
      : (colInfo.find((c) => c.isNumeric && /total|score|mark|amount|revenue/i.test(c.name))?.name ||
         colInfo.find((c) => c.isNumeric)?.name || null);
    targetColumn = targetNumericCol;
  }

  if (!operation) {
    if (matchedEntityFilter && requestedCol) {
      operation = "lookup";
      targetColumn = requestedCol.col.name;
    } else if (filters.length > 0) {
      operation = "filter";
      const nameCol = colInfo.find((c) => /name/i.test(c.name) && !c.isNumeric) || colInfo[0];
      targetColumn = nameCol ? nameCol.name : null;
    } else if (numericFound.length === 1) {
      operation = "average";
      targetColumn = numericFound[0].col.name;
    }
  }

  if (!operation) return null;

  return {
    operation,
    targetColumn,
    rankIndex,
    rankOrder,
    filters,
    isAmbiguous: false,
    reason: `Deterministic structured parsing: ${operation} on ${targetColumn || "table"} with ${filters.length} filter(s)`
  };
}

// ---------- semantic query understanding via local LLM ----------

/**
 * Prompts the local LLM with the actual table schema and the user question
 * to extract a structured query plan in JSON mode.
 */
export async function parseSemanticQueryPlan(question, documentName, colInfo) {
  const schemaSummary = colInfo.map((c) => ({
    column: c.name,
    type: c.isNumeric ? "numeric" : "categorical",
    samples: c.sampleValues
  }));

  const systemPrompt = `You are an expert tabular query planner.
Analyze the user's question semantically against the REAL TABLE SCHEMA provided below.

TABLE: "${documentName}"
SCHEMA:
${JSON.stringify(schemaSummary, null, 2)}

ALLOWED OPERATIONS:
- "average": computes mean/average of a numeric column
- "sum": computes sum/total of a numeric column
- "min": finds minimum/lowest value of a numeric column
- "max": finds maximum/highest value of a numeric column
- "count": counts rows matching criteria
- "percentage": computes percentage of rows matching criteria
- "distribution": groups row counts by a categorical column
- "lookup": retrieves specific cell value(s) for a filtered entity
- "none": if the question cannot be answered from this table or is not an analytical query

CRITICAL INSTRUCTIONS:
1. "targetColumn" MUST be an exact column name from the SCHEMA above, or null if the requested concept does not exist.
   - If the user asks about a subject/concept not in the schema (e.g. asking about "History" when no History column exists), "targetColumn" MUST be null. NEVER invent column names. NEVER substitute another subject.
   - Do NOT choose a column simply because its name matches the operation (e.g. if the user asks for "average Math mark", targetColumn is "Math", NOT a column named "Average").
2. "filters": extract any row filter criteria mentioned in the question against real schema columns.
   - "column" must be an exact schema column name.
   - "op" must be one of: "eq", "gt", "gte", "lt", "lte".
   - "value" must be the literal filter value (must exist in that categorical column, or be a valid number).
3. "isAmbiguous": true if multiple columns equally match the concept or the request is unclear.
4. "reason": explain the semantic mapping or why a column is missing.

OUTPUT JSON FORMAT ONLY:
{
  "operation": "average" | "sum" | "min" | "max" | "count" | "percentage" | "distribution" | "lookup" | "none",
  "targetColumn": "<exact column name from schema, or null>",
  "filters": [
    { "column": "<exact column name>", "op": "eq"|"gt"|"gte"|"lt"|"lte", "value": "<value>" }
  ],
  "isAmbiguous": false,
  "reason": "<explanation>"
}`;

  try {
    const response = await axios.post(
      `${ENV.OLLAMA_BASE_URL}/api/chat`,
      {
        model: ENV.OLLAMA_LLM_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question }
        ],
        stream: false,
        format: "json",
        options: {
          temperature: 0.0,
          num_predict: 250
        },
        keep_alive: "30m"
      },
      { timeout: 35000 }
    );

    const raw = response.data?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    console.warn(`[Tabular Semantic Parser Notice] LLM parser failed: ${err.message}`);
    return {
      operation: "none",
      targetColumn: null,
      filters: [],
      isAmbiguous: false,
      reason: `LLM semantic parsing failed: ${err.message}`
    };
  }
}

// ---------- semantic embedding ranking / fallback ----------

/**
 * Calculates semantic similarity between query concept and actual schema columns.
 * Used as an auxiliary verification signal; never creates new column names.
 */
export async function rankColumnsSemantically(question, colInfo) {
  try {
    const qEmb = await generateTextEmbedding(question);
    const scored = [];
    for (const col of colInfo) {
      const cEmb = await generateTextEmbedding(col.name);
      const sim = cosineSimilarity(qEmb, cEmb);
      scored.push({ col, similarity: sim });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored;
  } catch (err) {
    return colInfo.map((col) => ({ col, similarity: 0.5 }));
  }
}

// ---------- programmatic plan validation ----------

/**
 * Validates the semantic plan strictly against real schema data.
 * The LLM output is NOT authoritative.
 */
export function validateSemanticPlan(plan, colInfo, rows) {
  if (!plan || typeof plan !== "object") {
    return { valid: false, reason: "invalid plan structure from semantic parser" };
  }

  if (plan.isAmbiguous) {
    return { valid: false, reason: plan.reason || "query is ambiguous against schema" };
  }

  // 1. Validate operation belongs to execution contract enum
  const rawOp = String(plan.operation || "").toLowerCase().trim();
  const normalizedOp = rawOp === "mean" || rawOp === "avg" ? "average" : rawOp;
  if (!ALLOWED_OPERATIONS.has(normalizedOp) || normalizedOp === "none") {
    return { valid: false, reason: plan.reason || `unsupported or non-computable operation "${plan.operation}"` };
  }

  const colByName = new Map();
  const colByLower = new Map();
  for (const c of colInfo) {
    colByName.set(c.name, c);
    colByLower.set(c.name.toLowerCase().trim(), c);
  }

  // 2. Validate target column against real schema
  let validatedTarget = null;
  if (plan.targetColumn) {
    const rawTarget = String(plan.targetColumn).trim();
    validatedTarget = colByName.get(rawTarget) || colByLower.get(rawTarget.toLowerCase());
    if (!validatedTarget) {
      return {
        valid: false,
        reason: `targetColumn "${plan.targetColumn}" does not exist in table schema`
      };
    }
  }

  const needsNumeric = ["average", "sum", "min", "max"].includes(normalizedOp);
  if (needsNumeric) {
    if (!validatedTarget) {
      return {
        valid: false,
        reason: plan.reason || `operation "${normalizedOp}" requires a valid numeric column from the schema, none resolved`
      };
    }
    if (!validatedTarget.isNumeric) {
      return {
        valid: false,
        reason: `targetColumn "${validatedTarget.name}" is not numeric in table schema`
      };
    }
  }

  if (normalizedOp === "distribution") {
    if (!validatedTarget) {
      return { valid: false, reason: `distribution requires a categorical column for grouping` };
    }
    if (validatedTarget.isNumeric) {
      return { valid: false, reason: `targetColumn "${validatedTarget.name}" is numeric; distribution requires a categorical column` };
    }
  }

  if (normalizedOp === "lookup" && !validatedTarget) {
    return { valid: false, reason: `lookup requires a target column to retrieve` };
  }

  if (normalizedOp === "filter" && !validatedTarget) {
    validatedTarget = colInfo.find((c) => /name/i.test(c.name) && !c.isNumeric) ||
                      colInfo.find((c) => !c.isNumeric) ||
                      colInfo[0];
  }

  if (normalizedOp === "rank") {
    if (!validatedTarget) {
      validatedTarget = colInfo.find((c) => c.isNumeric && /total|score|mark|amount|revenue/i.test(c.name)) ||
                        colInfo.find((c) => c.isNumeric) ||
                        colInfo[0];
    }
    if (!validatedTarget || !validatedTarget.isNumeric) {
      return { valid: false, reason: "rank operation requires a numeric column in table schema" };
    }
  }

  // 3. Validate filters strictly against real columns and dataset values
  const validatedFilters = [];
  if (Array.isArray(plan.filters)) {
    for (const f of plan.filters) {
      if (!f || !f.column) continue;
      const fCol = colByName.get(f.column) || colByLower.get(String(f.column).toLowerCase().trim());
      if (!fCol) {
        return { valid: false, reason: `filter column "${f.column}" does not exist in table schema` };
      }
      const allowedOps = new Set(["eq", "gt", "gte", "lt", "lte"]);
      const op = allowedOps.has(f.op) ? f.op : "eq";

      if (fCol.isNumeric) {
        const numVal = parseNum(f.value);
        if (numVal === null) {
          return { valid: false, reason: `filter value "${f.value}" for numeric column "${fCol.name}" is not a valid number` };
        }
        validatedFilters.push({ column: fCol.name, op, value: numVal });
      } else {
        // Categorical column: value MUST exist in dataset
        const valStr = String(f.value ?? "").trim().toLowerCase();
        const matchVal = fCol.distinct.find((d) => d.toLowerCase() === valStr);
        if (!matchVal) {
          return {
            valid: false,
            reason: `filter value "${f.value}" does not exist in categorical column "${fCol.name}"`
          };
        }
        validatedFilters.push({ column: fCol.name, op: "eq", value: matchVal });
      }
    }
  }

  return {
    valid: true,
    operation: normalizedOp,
    target: validatedTarget,
    filters: validatedFilters,
    reason: plan.reason || null
  };
}

// ---------- row filtering & formatting ----------

export function applyFilters(rows, filters) {
  if (!filters || filters.length === 0) return rows;
  const byCol = new Map();
  for (const f of filters) {
    if (!byCol.has(f.column)) byCol.set(f.column, []);
    byCol.get(f.column).push(f);
  }
  return rows.filter((row) =>
    [...byCol.entries()].every(([col, fs]) =>
      fs.some((f) => {
        if (f.op === "eq") return String(row[col] ?? "").trim().toLowerCase() === String(f.value).toLowerCase();
        const n = parseNum(row[col]);
        if (n === null) return false;
        if (f.op === "gt") return n > f.value;
        if (f.op === "gte") return n >= f.value;
        if (f.op === "lt") return n < f.value;
        if (f.op === "lte") return n <= f.value;
        return false;
      })
    )
  );
}

export function describeFilters(filters) {
  if (!filters || filters.length === 0) return "none (all rows)";
  const sym = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
  const byCol = new Map();
  for (const f of filters) {
    if (!byCol.has(f.column)) byCol.set(f.column, []);
    byCol.get(f.column).push(`${f.column} ${sym[f.op]} ${f.value}`);
  }
  return [...byCol.values()].map((parts) => (parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0])).join(" AND ");
}

// ---------- main entry point ----------

export async function processTabularQuery(question = "", targetDepartments = [], targetDocuments = [], fallbackQuestion = "") {
  const baseQuery = { fileType: { $in: ["csv", "xlsx", "xls"] }, status: "completed" };
  let docs = [];
  if (targetDepartments && targetDepartments.length > 0) {
    docs = await Document.find({ ...baseQuery, department: { $in: targetDepartments } }).sort({ createdAt: -1 }).lean();
  }
  if (docs.length === 0) {
    docs = await Document.find(baseQuery).sort({ createdAt: -1 }).lean();
  }
  docs = docs.filter((d) => d.path && fs.existsSync(d.path));
  if (docs.length === 0) {
    return { success: false, error: "No tabular document found in uploaded files." };
  }

  // 1. Pick the best matching tabular document by schema inspection
  let best = null;
  for (const doc of docs) {
    let rows;
    try { rows = loadRows(doc); } catch { continue; }
    if (!rows || rows.length === 0) continue;
    const colInfo = analyseColumns(rows);
    best = { doc, rows, colInfo };
    break; // Use the most relevant/uploaded tabular dataset
  }

  if (!best || !best.rows || best.rows.length === 0) {
    return { success: false, error: "Dataset is empty or unreadable." };
  }

  const { doc, rows, colInfo } = best;
  const documentName = doc.originalName;
  const columns = colInfo.map((c) => c.name);

  // 2. Query Understanding: Attempt fast deterministic parsing first
  let semanticPlan = parseDeterministicQueryPlan(question, colInfo);
  let resolvedQuestion = question;

  if (!semanticPlan && fallbackQuestion && fallbackQuestion !== question) {
    semanticPlan = parseDeterministicQueryPlan(fallbackQuestion, colInfo);
    if (semanticPlan) {
      resolvedQuestion = fallbackQuestion;
      console.log(`[Tabular Processor] Deterministic plan resolved using context: ${semanticPlan.operation} on ${semanticPlan.targetColumn || "table"}`);
    }
  } else if (semanticPlan) {
    console.log(`[Tabular Processor] Deterministic plan resolved: ${semanticPlan.operation} on ${semanticPlan.targetColumn || "table"}`);
  }

  if (!semanticPlan) {
    // Fall back to semantic LLM plan for complex questions
    const qForLlm = fallbackQuestion || question;
    semanticPlan = await parseSemanticQueryPlan(qForLlm, documentName, colInfo);
    resolvedQuestion = qForLlm;
  }

  // 3. Strict Programmatic Validation
  const validation = validateSemanticPlan(semanticPlan, colInfo, rows);

  const base = {
    documentName,
    operation: validation.operation || semanticPlan.operation || "none",
    column: validation.target ? validation.target.name : null,
    filters: validation.filters || [],
    columns,
    totalRows: rows.length,
    rowsUsed: 0,
    semanticPlan
  };

  const logTabularSemanticDebug = (computedResult, fallbackReason = null, filteredCount = 0) => {
    console.log(`[TABULAR SEMANTIC DEBUG]`);
    console.log(`  - question: "${question}"`);
    console.log(`  - selected document: ${documentName}`);
    console.log(`  - schema: [${columns.join(", ")}]`);
    console.log(`  - semantic operation: ${semanticPlan.operation}`);
    console.log(`  - semantic target: ${semanticPlan.targetColumn || "null"}`);
    console.log(`  - semantic filters: ${JSON.stringify(semanticPlan.filters || [])}`);
    console.log(`  - validation: ${validation.valid ? "passed" : "rejected"}`);
    console.log(`  - validation reason: ${validation.reason || "valid"}`);
    console.log(`  - rows before filters: ${rows.length}`);
    console.log(`  - rows after filters: ${filteredCount}`);
    console.log(`  - computed result: ${computedResult !== null ? computedResult : "unresolved"}`);
    if (fallbackReason) {
      console.log(`  - fallback reason: ${fallbackReason}`);
    }
  };

  if (!validation.valid) {
    logTabularSemanticDebug(null, validation.reason, 0);
    return {
      ...base,
      success: false,
      computedValue: null,
      error: validation.reason,
      summary: `The table tool could not compute this: ${validation.reason}. Available columns in ${documentName}: ${columns.join(", ")}.`
    };
  }

  // 4. Apply validated filters
  const { operation, target } = validation;
  const filteredRows = applyFilters(rows, validation.filters);
  const filterText = describeFilters(validation.filters);

  if (filteredRows.length === 0) {
    if (operation === "count") {
      logTabularSemanticDebug("0", null, 0);
      return {
        ...base,
        success: true,
        computedValue: "0",
        rowsUsed: 0,
        summary: `Number of rows matching (${filterText}) = 0 out of ${rows.length} rows.`
      };
    }
    if (operation === "filter") {
      logTabularSemanticDebug("None", null, 0);
      return {
        ...base,
        success: true,
        computedValue: "None",
        rowsUsed: 0,
        records: [],
        summary: `No records match the filters (${filterText}) out of ${rows.length} rows.`
      };
    }
    const reason = `no rows match the filters (${filterText})`;
    logTabularSemanticDebug(null, reason, 0);
    return {
      ...base,
      success: false,
      computedValue: null,
      error: reason,
      summary: `The table tool could not compute this: ${reason}. Available columns in ${documentName}: ${columns.join(", ")}.`
    };
  }

  // 5. Deterministic JavaScript Execution
  const needsNumeric = ["average", "sum", "min", "max"].includes(operation);

  if (needsNumeric) {
    const nums = filteredRows.map((r) => ({ row: r, n: parseNum(r[target.name]) })).filter((x) => x.n !== null);
    if (nums.length === 0) {
      const reason = `column ${target.name} has no numeric values in the matching rows`;
      logTabularSemanticDebug(null, reason, filteredRows.length);
      return {
        ...base,
        success: false,
        computedValue: null,
        error: reason,
        summary: `The table tool could not compute this: ${reason}.`
      };
    }

    const label = colInfo.find((c) => /name/i.test(c.name) && !c.isNumeric)?.name || columns[0];
    if (operation === "average" || operation === "sum") {
      const sum = nums.reduce((a, x) => a + x.n, 0);
      const value = operation === "average" ? sum / nums.length : sum;
      const formula = operation === "average"
        ? `sum(${target.name}) / count = ${fmt(sum)} / ${nums.length}`
        : `sum(${target.name}) over ${nums.length} rows`;
      const computedValue = fmt(value);

      logTabularSemanticDebug(computedValue, null, nums.length);
      return {
        ...base,
        success: true,
        column: target.name,
        computedValue,
        rowsUsed: nums.length,
        summary: `${operation === "average" ? "Average" : "Sum"} of ${target.name} = ${computedValue} (${formula}; rows used: ${nums.length} of ${rows.length}; filters: ${filterText}).`
      };
    }

    const extreme = operation === "max" ? Math.max(...nums.map((x) => x.n)) : Math.min(...nums.map((x) => x.n));
    const holders = nums.filter((x) => x.n === extreme).map((x) => x.row);
    const computedValue = fmt(extreme);

    logTabularSemanticDebug(computedValue, null, nums.length);
    return {
      ...base,
      success: true,
      column: target.name,
      computedValue,
      rowsUsed: nums.length,
      records: holders,
      summary: `${operation === "max" ? "Highest" : "Lowest"} ${target.name} = ${computedValue} across ${nums.length} rows (filters: ${filterText}). Row(s) with this value: ${holders.map((h) => h[label]).join(", ")}. Full record(s): ${JSON.stringify(holders)}`
    };
  }

  if (operation === "distribution") {
    const counts = {};
    for (const r of filteredRows) {
      const v = String(r[target.name] ?? "").trim();
      if (v) counts[v] = (counts[v] || 0) + 1;
    }
    const breakdown = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${target.name} ${k}: ${v}`).join(", ");
    logTabularSemanticDebug(breakdown, null, filteredRows.length);
    return {
      ...base,
      success: true,
      column: target.name,
      counts,
      computedValue: breakdown,
      rowsUsed: filteredRows.length,
      summary: `Count of rows per ${target.name}: ${breakdown} (rows used: ${filteredRows.length} of ${rows.length}; filters: ${filterText}).`
    };
  }

  if (operation === "count") {
    const countVal = String(filteredRows.length);
    logTabularSemanticDebug(countVal, null, filteredRows.length);
    return {
      ...base,
      success: true,
      computedValue: countVal,
      rowsUsed: filteredRows.length,
      summary: `Number of rows matching (${filterText}) = ${countVal} out of ${rows.length} rows.`
    };
  }

  if (operation === "percentage") {
    if (validation.filters.length === 0) {
      const reason = "no condition was identified to compute a percentage of";
      logTabularSemanticDebug(null, reason, filteredRows.length);
      return {
        ...base,
        success: false,
        computedValue: null,
        error: reason,
        summary: `The table tool could not compute this: ${reason}.`
      };
    }
    const pct = (filteredRows.length / rows.length) * 100;
    const pctVal = `${fmt(pct)}%`;
    logTabularSemanticDebug(pctVal, null, filteredRows.length);
    return {
      ...base,
      success: true,
      computedValue: pctVal,
      rowsUsed: filteredRows.length,
      summary: `Percentage of rows matching (${filterText}) = ${pctVal} (${filteredRows.length} / ${rows.length}).`
    };
  }

  if (operation === "lookup" && target && filteredRows.length <= 10) {
    const label = colInfo.find((c) => /name/i.test(c.name) && !c.isNumeric)?.name || columns[0];
    const vals = filteredRows.map((r) => `${r[label]}: ${target.name} = ${r[target.name]}`);
    const lookupVal = filteredRows.length === 1 ? String(filteredRows[0][target.name]) : (vals.length > 0 ? vals.join(", ") : null);
    logTabularSemanticDebug(lookupVal, null, filteredRows.length);
    return {
      ...base,
      success: true,
      operation: "lookup",
      column: target.name,
      computedValue: lookupVal,
      rowsUsed: filteredRows.length,
      records: filteredRows,
      summary: `The ${target.name} of ${filteredRows[0]?.[label] || "the matching record"} is ${lookupVal} (filters: ${filterText}). Full record: ${JSON.stringify(filteredRows[0])}.`
    };
  }

  if (operation === "filter") {
    const label = (target && !target.isNumeric)
      ? target.name
      : (colInfo.find((c) => /name/i.test(c.name) && !c.isNumeric)?.name || columns[0]);
    const names = filteredRows.map((r) => String(r[label] ?? "")).filter(Boolean);
    const computedValue = names.length > 0 ? names.join(", ") : "None";
    const details = filteredRows.map((r) => {
      const parts = validation.filters.map((f) => `${f.column}: ${r[f.column]}`).join(", ");
      return parts ? `${r[label]} (${parts})` : String(r[label]);
    }).join("; ");

    logTabularSemanticDebug(computedValue, null, filteredRows.length);
    return {
      ...base,
      success: true,
      operation: "filter",
      column: label,
      computedValue,
      rowsUsed: filteredRows.length,
      records: filteredRows,
      summary: `Matching records (${filterText}): ${details}. Total matching: ${filteredRows.length} out of ${rows.length} rows.`
    };
  }

  if (operation === "rank" && target) {
    const order = semanticPlan.rankOrder || "desc";
    const rankIndex = semanticPlan.rankIndex || 1;
    const nums = filteredRows
      .map((r) => ({ row: r, n: parseNum(r[target.name]) }))
      .filter((x) => x.n !== null);

    nums.sort((a, b) => (order === "asc" ? a.n - b.n : b.n - a.n));

    if (nums.length >= rankIndex) {
      const selected = nums[rankIndex - 1];
      const label = colInfo.find((c) => /name/i.test(c.name) && !c.isNumeric)?.name || columns[0];
      const rankOrdinal = rankIndex === 2 ? "2nd" : rankIndex === 3 ? "3rd" : `${rankIndex}th`;
      const computedValue = `${selected.row[label]} with ${selected.n} ${target.name}`;

      logTabularSemanticDebug(computedValue, null, nums.length);
      return {
        ...base,
        success: true,
        operation: "rank",
        column: target.name,
        computedValue,
        rowsUsed: nums.length,
        records: [selected.row],
        summary: `The ${rankOrdinal} highest by ${target.name} is ${selected.row[label]} with ${selected.n} ${target.name} (full record: ${JSON.stringify(selected.row)}).`
      };
    }
  }

  // Fallback for preview / unhandled operations
  logTabularSemanticDebug(null, "preview_only", filteredRows.length);
  return {
    ...base,
    success: false,
    operation: "preview",
    computedValue: null,
    summary: `Dataset ${documentName} contains ${rows.length} rows with columns: ${columns.join(", ")}.`
  };
}

/**
 * Task 1b: For a successful deterministic tabular result, builds answer text
 * from a structured template using the tool result, with no LLM call.
 *
 * @param {Object} tabularResult
 * @param {string} question
 * @returns {string}
 */
export function formatTabularTemplateAnswer(tabularResult, question = "") {
  if (!tabularResult || !tabularResult.success || tabularResult.computedValue === null) {
    return null;
  }

  const { operation, column, computedValue, records, filters, summary } = tabularResult;

  if (operation === "filter") {
    const filterDesc = describeFilters(filters);
    const colName = column || "records";
    return `The students with ${filterDesc} are: ${computedValue}.`;
  }

  if (operation === "lookup" && records && records.length > 0) {
    const r = records[0];
    const name = r.Name || r.Student_ID || "The student";
    return `${name}'s ${column} is ${computedValue}.`;
  }

  if (operation === "average" || operation === "mean") {
    return `The average ${column} is ${computedValue}.`;
  }

  if (operation === "sum" || operation === "total") {
    return `The total ${column} is ${computedValue}.`;
  }

  if (operation === "max" || operation === "highest") {
    return `The highest ${column} is ${computedValue}.`;
  }

  if (operation === "min" || operation === "lowest") {
    return `The lowest ${column} is ${computedValue}.`;
  }

  if (operation === "count") {
    return `There are ${computedValue} matching records.`;
  }

  if (summary) {
    return summary;
  }

  return `The result is ${computedValue}.`;
}

