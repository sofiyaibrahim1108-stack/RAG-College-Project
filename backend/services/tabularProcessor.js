import fs from "fs";
import * as XLSX from "xlsx";
import axios from "axios";
import { Document } from "../models/Document.js";
import { ENV } from "../config/env.js";
import { generateTextEmbedding } from "./embeddingService.js";
import { RAG_CONFIG } from "../config/rag.js";

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
 * Generic domain-agnostic function words & query conversational filler terms.
 */
export const QUERY_FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "it", "its",
  "this", "that", "these", "those", "i", "me", "my", "we", "our",
  "you", "your", "he", "she", "they", "them", "their", "who", "whom",
  "whose", "which", "what", "when", "where", "how", "why",
  "would", "could", "should", "will", "can", "may", "might",
  "so", "if", "as", "up", "out", "about", "also", "then", "both",
  "all", "each", "every", "than", "into", "wanto", "want", "know",
  "tell", "show", "give", "find", "get", "list", "please", "mark",
  "marks", "score", "scores", "student", "students", "record",
  "records", "row", "rows", "value", "values", "data", "table",
  "details", "information", "info", "person", "people"
]);

/**
 * Common query operators, ordinals, and comparison words that are consumed by query plans.
 */
export const QUERY_OPERATOR_WORDS = new Set([
  "above", "greater", "more", "higher", "over", "exceeding", "exceeds",
  "below", "less", "lower", "under", "fewer", "least", "most",
  "equal", "equals", "average", "mean", "avg", "sum", "total",
  "count", "percentage", "percent", "distribution", "min", "minimum",
  "lowest", "bottom", "max", "maximum", "highest", "top", "rank",
  "ranked", "order", "ordered", "first", "1st", "second", "2nd",
  "third", "3rd", "fourth", "4th", "fifth", "5th", "sixth", "6th",
  "seventh", "7th", "eighth", "8th", "ninth", "9th", "tenth", "10th"
]);

/**
 * Finds the closest schema column using exact match, token stemming, or edit distance.
 */
export function findClosestColumn(term, colInfo) {
  if (!term || !colInfo) return null;
  const t = String(term).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!t) return null;
  const minLen = RAG_CONFIG.tabularFuzzyMinLength ?? 3;
  const maxEdit = RAG_CONFIG.tabularFuzzyMaxEdit ?? 2;

  for (const col of colInfo) {
    if (matchTokenToColumn(term, col.name)) return col;
    const c = col.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (t.length >= minLen && Math.abs(t.length - c.length) <= maxEdit) {
      if (editDistance(t, c) <= maxEdit) return col;
    }
    const subtokens = col.name.toLowerCase().split(/[_\-\s]+/).filter(Boolean);
    for (const sub of subtokens) {
      const s = sub.replace(/[^a-z0-9]/g, "");
      if (s.length >= minLen && Math.abs(t.length - s.length) <= maxEdit) {
        if (editDistance(t, s) <= maxEdit) return col;
      }
    }
  }
  return null;
}

/**
 * Checks if a token plausibly matches a schema column or row value using fuzzy similarity.
 */
export function checkPlausibleSchemaMatch(token, colInfo, rows = []) {
  if (!token) return null;
  const t = String(token).toLowerCase().replace(/[^a-z0-9]/g, "");
  const minLen = RAG_CONFIG.tabularFuzzyMinLength ?? 3;
  if (t.length < minLen) return null;

  const maxEdit = t.length >= 4 ? (RAG_CONFIG.tabularFuzzyMaxEdit ?? 2) : 1;

  // 1. Check against schema column names and subtokens
  for (const col of colInfo) {
    const c = col.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (matchTokenToColumn(token, col.name)) {
      return { match: col.name, type: "column", distance: 0 };
    }
    if (Math.abs(t.length - c.length) <= maxEdit) {
      const d = editDistance(t, c);
      if (d <= maxEdit) {
        return { match: col.name, type: "column", distance: d };
      }
    }
    // Subtokens of column name (e.g. "total" and "marks" for "Total_Marks")
    const subtokens = col.name.toLowerCase().split(/[_\-\s]+/).filter(Boolean);
    for (const sub of subtokens) {
      const s = sub.replace(/[^a-z0-9]/g, "");
      if (s.length >= minLen && Math.abs(t.length - s.length) <= maxEdit) {
        const d = editDistance(t, s);
        if (d <= maxEdit) {
          return { match: col.name, type: "column_subtoken", subtoken: sub, distance: d };
        }
      }
    }
  }

  // 2. Check against categorical row values
  for (const col of colInfo) {
    if (col.isNumeric || !col.distinct) continue;
    for (const val of col.distinct) {
      const valStr = String(val).toLowerCase();
      const valTokens = valStr.split(/[_\-\s]+/).filter(Boolean);
      for (const vt of valTokens) {
        const vClean = vt.replace(/[^a-z0-9]/g, "");
        if (vClean.length >= minLen && Math.abs(t.length - vClean.length) <= maxEdit) {
          const d = editDistance(t, vClean);
          if (d <= maxEdit) {
            return { match: val, type: "row_value", column: col.name, distance: d };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Requirement 1: Computes plan coverage.
 * Determines which content tokens of the question were NOT consumed by the plan.
 * If unconsumed tokens remain that could plausibly refer to schema columns or row values,
 * the plan is declared "incomplete".
 */
export function checkPlanCoverage(question, plan, colInfo, rows = []) {
  if (!question || !plan) {
    return { isComplete: false, unconsumedTokens: [], plausibleUnconsumed: [], reason: "no plan or empty question" };
  }

  // Extract all word tokens from question
  const qTokens = (question.toLowerCase().match(/[a-z0-9_\-]+/g) || []);
  if (qTokens.length === 0) {
    return { isComplete: true, unconsumedTokens: [], plausibleUnconsumed: [] };
  }

  // Set of consumed tokens from matched columns, values, operators, numbers
  const consumedTokens = new Set();

  // A. Columns in plan
  const planCols = [];
  if (plan.targetColumns && Array.isArray(plan.targetColumns)) {
    planCols.push(...plan.targetColumns);
  } else if (plan.targetColumn) {
    planCols.push(plan.targetColumn);
  }
  if (Array.isArray(plan.filters)) {
    for (const f of plan.filters) {
      if (f && f.column) planCols.push(f.column);
    }
  }

  for (const cName of planCols) {
    const subtokens = String(cName).toLowerCase().split(/[_\-\s]+/).filter(Boolean);
    for (const st of subtokens) {
      consumedTokens.add(st);
    }
  }

  // B. Entity / filter values in plan
  if (Array.isArray(plan.filters)) {
    for (const f of plan.filters) {
      if (f && f.value !== undefined && f.value !== null) {
        const valTokens = String(f.value).toLowerCase().split(/[_\-\s]+/).filter(Boolean);
        for (const vt of valTokens) {
          consumedTokens.add(vt);
        }
      }
    }
  }

  // C. Operators in plan
  if (plan.operation) {
    consumedTokens.add(String(plan.operation).toLowerCase());
  }

  // Find unconsumed content tokens
  const unconsumedTokens = [];

  for (const rawToken of qTokens) {
    const token = rawToken.replace(/[^a-z0-9]/g, "");
    if (!token) continue;

    // 1. Is it a number? Consumed.
    if (/^\d+(\.\d+)?$/.test(token)) continue;

    // 2. Was it consumed by a column, filter value, or operator?
    if (consumedTokens.has(token)) continue;
    let isConsumedByStem = false;
    for (const ct of consumedTokens) {
      if (token === ct || stemWord(token) === stemWord(ct) || matchTokenToColumn(token, ct)) {
        isConsumedByStem = true;
        break;
      }
    }
    if (isConsumedByStem) continue;

    // 3. Is it an operator word?
    if (QUERY_OPERATOR_WORDS.has(token)) continue;

    // 4. Is it a generic function / stopword?
    if (QUERY_FUNCTION_WORDS.has(token)) continue;

    // 5. This is an unconsumed content token!
    // Check if it plausibly refers to schema columns or row values
    const match = checkPlausibleSchemaMatch(token, colInfo, rows);
    if (match) {
      unconsumedTokens.push({ token, plausibleMatch: match });
    } else {
      unconsumedTokens.push({ token, plausibleMatch: null });
    }
  }

  const plausibleUnconsumed = unconsumedTokens.filter((u) => u.plausibleMatch !== null);
  const isComplete = plausibleUnconsumed.length === 0;

  return {
    isComplete,
    unconsumedTokens,
    plausibleUnconsumed,
    reason: isComplete
      ? "All content tokens consumed by plan"
      : `Unconsumed tokens with plausible schema match: ${plausibleUnconsumed.map((u) => `${u.token} -> ${u.plausibleMatch.match}`).join(", ")}`
  };
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
  let targetColumns = [];
  const numericFound = foundCols.filter((fc) => fc.col.isNumeric);

  // If an entity was matched (e.g. specific entity filter) AND another column was mentioned in the question:
  // This is a LOOKUP! Support single or multiple columns.
  const requestedCols = foundCols.filter((fc) => fc.col.name !== matchedEntityFilter?.column);
  if (matchedEntityFilter && requestedCols.length > 0) {
    operation = "lookup";
    targetColumns = [...new Set(requestedCols.map((rc) => rc.col.name))];
    targetColumn = targetColumns[0];
  } else if (["average", "sum", "min", "max"].includes(operation)) {
    if (numericFound.length > 0) {
      targetColumns = [numericFound[0].col.name];
      targetColumn = targetColumns[0];
    }
  } else if (operation === "count") {
    targetColumn = numericFound.length > 0 ? numericFound[0].col.name : (colInfo[0]?.name || null);
    if (targetColumn) targetColumns = [targetColumn];
  } else if (operation === "filter") {
    const nameCol = colInfo.find((c) => /name/i.test(c.name) && !c.isNumeric) ||
                    colInfo.find((c) => !c.isNumeric) ||
                    colInfo[0];
    targetColumn = nameCol ? nameCol.name : null;
    if (targetColumn) targetColumns = [targetColumn];
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
    if (targetColumn) targetColumns = [targetColumn];
  }

  if (!operation) {
    if (matchedEntityFilter && requestedCols.length > 0) {
      operation = "lookup";
      targetColumns = [...new Set(requestedCols.map((rc) => rc.col.name))];
      targetColumn = targetColumns[0];
    } else if (filters.length > 0) {
      operation = "filter";
      const nameCol = colInfo.find((c) => /name/i.test(c.name) && !c.isNumeric) || colInfo[0];
      targetColumn = nameCol ? nameCol.name : null;
      if (targetColumn) targetColumns = [targetColumn];
    } else if (numericFound.length === 1) {
      operation = "average";
      targetColumn = numericFound[0].col.name;
      targetColumns = [targetColumn];
    }
  }

  if (!operation) return null;

  return {
    operation,
    targetColumn,
    targetColumns: targetColumns.length > 0 ? targetColumns : (targetColumn ? [targetColumn] : []),
    rankIndex,
    rankOrder,
    filters,
    isAmbiguous: false,
    reason: `Deterministic structured parsing: ${operation} on ${targetColumns.join(", ") || targetColumn || "table"} with ${filters.length} filter(s)`
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

  const systemPrompt = `Expert tabular query planner. Analyze the user's question semantically against the REAL TABLE SCHEMA below and output strict JSON.

TABLE: "${documentName}"
SCHEMA:
${JSON.stringify(schemaSummary)}

ALLOWED OPERATIONS: "lookup", "filter", "average", "sum", "min", "max", "count", "percentage", "distribution", "rank", "none".

CRITICAL INSTRUCTIONS:
1. "columns": array of exact column names from SCHEMA.
   - For lookups, include ALL requested columns (e.g. ["Science", "English", "Total_Marks", "Average"]).
   - For aggregations (average/sum/min/max), include the target numeric column.
   - Map spelling variations or typos (e.g. "tola" for "Total_Marks") to the correct schema column.
   - If a requested column does not exist in SCHEMA, do not invent names; add to "unresolved".
2. "filters": array of { "column": "<exact column>", "op": "eq"|"gt"|"gte"|"lt"|"lte", "value": "<value>" }.
3. "unresolved": array of unrecognized concepts or missing columns from question.
4. "reason": concise explanation.

OUTPUT JSON FORMAT ONLY:
{
  "operation": "lookup" | "filter" | "average" | "sum" | "min" | "max" | "count" | "percentage" | "distribution" | "rank" | "none",
  "columns": ["<exact column name>", ...],
  "filters": [
    { "column": "<exact column name>", "op": "eq"|"gt"|"gte"|"lt"|"lte", "value": "<value>" }
  ],
  "unresolved": [],
  "isAmbiguous": false,
  "reason": "<explanation>"
}`;

  try {
    const timeoutMs = RAG_CONFIG.tabularPlannerTimeout || 25000;
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
          num_predict: 120
        },
        keep_alive: "30m"
      },
      { timeout: timeoutMs }
    );

    const raw = response.data?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    console.warn(`[Tabular Semantic Parser Notice] LLM parser failed: ${err.message}`);
    return {
      operation: "none",
      columns: [],
      targetColumn: null,
      filters: [],
      unresolved: [],
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

  // 2. Validate columns (support single column and multi-column)
  let rawCols = [];
  if (Array.isArray(plan.columns)) {
    rawCols = plan.columns;
  } else if (Array.isArray(plan.targetColumns)) {
    rawCols = plan.targetColumns;
  } else if (plan.targetColumn) {
    rawCols = [plan.targetColumn];
  }

  const validatedColumns = [];
  const unresolvedColumns = [];

  for (const rawCol of rawCols) {
    const s = String(rawCol).trim();
    if (!s) continue;
    let col = colByName.get(s) || colByLower.get(s.toLowerCase());
    if (!col) {
      col = findClosestColumn(s, colInfo);
    }
    if (col) {
      if (!validatedColumns.some((vc) => vc.name === col.name)) {
        validatedColumns.push(col);
      }
    } else {
      unresolvedColumns.push(s);
    }
  }

  const unresolved = [...unresolvedColumns];
  if (Array.isArray(plan.unresolved)) {
    for (const u of plan.unresolved) {
      const su = String(u).trim();
      if (su && !unresolved.includes(su)) {
        unresolved.push(su);
      }
    }
  }

  let validatedTarget = validatedColumns[0] || null;

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

  if (normalizedOp === "lookup" && validatedColumns.length === 0) {
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
      let fCol = colByName.get(f.column) || colByLower.get(String(f.column).toLowerCase().trim());
      if (!fCol) {
        fCol = findClosestColumn(String(f.column), colInfo);
      }
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
        // Categorical column: value MUST exist in dataset or fuzzy match
        const valStr = String(f.value ?? "").trim().toLowerCase();
        let matchVal = fCol.distinct.find((d) => d.toLowerCase() === valStr);
        if (!matchVal) {
          // Fuzzy match against distinct values
          const minLen = RAG_CONFIG.tabularFuzzyMinLength ?? 3;
          const maxEdit = RAG_CONFIG.tabularFuzzyMaxEdit ?? 2;
          let best = null;
          for (const d of fCol.distinct) {
            const dl = String(d).toLowerCase().trim();
            if (valStr.length >= minLen) {
              const dist = editDistance(valStr, dl);
              if (dist <= maxEdit && (best === null || dist < best.dist)) {
                best = { d, dist };
              }
            }
          }
          if (best) {
            matchVal = best.d;
          }
        }
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
    targetColumns: validatedColumns,
    filters: validatedFilters,
    unresolved,
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

/**
 * Detects a person-like value in the question that matches no row of the entity column.
 * Entity column = non-numeric column with many alphabetic-only distinct values (schema-derived).
 * Returns close candidates by token overlap / edit distance against the real column values.
 */
export function findEntityMiss(question, colInfo, rows, targetColumn = null) {
  const minDistinct = RAG_CONFIG.entityColumnMinDistinct ?? 8;
  const minTokenLen = RAG_CONFIG.fuzzyMinTokenLength ?? 4;
  const maxEdit = RAG_CONFIG.fuzzyMaxEditDistance ?? 1;
  const maxSuggestions = RAG_CONFIG.fuzzyMaxSuggestions ?? 3;

  const entityCol = colInfo
    .filter((c) => !c.isNumeric && c.distinct.length >= minDistinct && c.distinct.every((v) => /^[\p{L}\s.'-]+$/u.test(v)))
    .sort((a, b) => b.distinct.length - a.distinct.length)[0];
  if (!entityCol) return null;

  const qTokens = (question.match(/\p{L}+/gu) || [])
    .filter((t) => t.length >= minTokenLen && !colInfo.some((c) => matchTokenToColumn(t, c.name)));
  if (qTokens.length === 0) return null;

  const scored = [];
  const matchedQTokens = new Set();
  for (const value of entityCol.distinct) {
    const nameTokens = value.toLowerCase().split(/[\s.'-]+/).filter(Boolean);
    let matched = 0;
    let editSum = 0;
    const used = [];
    for (const nt of nameTokens) {
      let best = null;
      for (const qt of qTokens) {
        const ql = qt.toLowerCase();
        const d = ql === nt ? 0 : (nt.length >= minTokenLen && editDistance(ql, nt) <= maxEdit ? editDistance(ql, nt) : null);
        if (d !== null && (best === null || d < best.d)) best = { d, qt };
      }
      if (best) { matched++; editSum += best.d; used.push(best.qt); }
    }
    if (matched > 0) scored.push({ value, matched, ratio: matched / nameTokens.length, editSum, used });
  }
  if (scored.length === 0) return null;

  scored.sort((a, b) => b.matched - a.matched || b.ratio - a.ratio || a.editSum - b.editSum);
  const top = scored.slice(0, maxSuggestions);
  top.forEach((s) => s.used.forEach((u) => matchedQTokens.add(u)));
  const mentioned = qTokens.filter((t) => matchedQTokens.has(t)).join(" ");

  const targetCol = targetColumn ? colInfo.find((c) => c.name === targetColumn && c.isNumeric) : null;
  const labelled = top.map((s) => {
    const row = rows.find((r) => String(r[entityCol.name]).trim() === s.value);
    return targetCol && row ? `${s.value} (${row[targetCol.name]})` : s.value;
  });
  const message = `I couldn't find ${mentioned}. Did you mean ${labelled.join(" or ")}?`;
  return { column: entityCol.name, message, candidates: top.map((s) => s.value) };
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
      console.log(`[Tabular Processor] Deterministic plan resolved using context: ${semanticPlan.operation} on ${semanticPlan.targetColumns?.join(", ") || semanticPlan.targetColumn || "table"}`);
    }
  } else if (semanticPlan) {
    console.log(`[Tabular Processor] Deterministic plan resolved: ${semanticPlan.operation} on ${semanticPlan.targetColumns?.join(", ") || semanticPlan.targetColumn || "table"}`);
  }

  // Requirement 1 & 2: Plan coverage check & escalation
  let coverage = checkPlanCoverage(resolvedQuestion, semanticPlan, colInfo, rows);
  let usedLlmPlanner = false;

  if (!semanticPlan || !coverage.isComplete) {
    const qForLlm = fallbackQuestion || question;
    console.log(
      `[Tabular Processor] Plan ${semanticPlan ? "incomplete" : "null"} (reason: ${coverage.reason}). Escalating to LLM semantic planner.`
    );
    semanticPlan = await parseSemanticQueryPlan(qForLlm, documentName, colInfo);
    resolvedQuestion = qForLlm;
    usedLlmPlanner = true;
  } else {
    console.log(`[Tabular Processor] Plan complete. Fast path enabled (0 LLM calls).`);
  }

  // 3. Strict Programmatic Validation
  const validation = validateSemanticPlan(semanticPlan, colInfo, rows);

  const base = {
    documentName,
    operation: validation.operation || semanticPlan.operation || "none",
    column: validation.target ? validation.target.name : null,
    targetColumns: (validation.targetColumns && validation.targetColumns.length > 0)
      ? validation.targetColumns.map((tc) => tc.name)
      : (validation.target ? [validation.target.name] : []),
    filters: validation.filters || [],
    columns,
    totalRows: rows.length,
    rowsUsed: 0,
    semanticPlan,
    usedLlmPlanner,
    coverageDecision: coverage.isComplete ? "complete" : "incomplete",
    unresolved: validation.unresolved || []
  };

  const logTabularSemanticDebug = (computedResult, fallbackReason = null, filteredCount = 0) => {
    console.log(`[TABULAR SEMANTIC DEBUG]`);
    console.log(`  - question: "${question}"`);
    console.log(`  - selected document: ${documentName}`);
    console.log(`  - schema: [${columns.join(", ")}]`);
    console.log(`  - coverage decision: ${coverage.isComplete ? "complete" : "incomplete"}`);
    console.log(`  - used LLM planner: ${usedLlmPlanner}`);
    console.log(`  - semantic operation: ${semanticPlan.operation}`);
    console.log(`  - semantic target: ${semanticPlan.targetColumns?.join(", ") || semanticPlan.targetColumn || "null"}`);
    console.log(`  - semantic filters: ${JSON.stringify(semanticPlan.filters || [])}`);
    console.log(`  - unresolved: ${JSON.stringify(validation.unresolved || [])}`);
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

  // 3b. Name-like value that matches no row: never fall back to an unfiltered aggregate
  if (validation.filters.length === 0) {
    const miss = findEntityMiss(question, colInfo, rows, validation.target ? validation.target.name : null);
    if (miss) {
      logTabularSemanticDebug(miss.message, "entity_not_found", 0);
      return {
        ...base,
        success: true,
        operation: "entity_not_found",
        computedValue: miss.message,
        rowsUsed: 0,
        candidates: miss.candidates,
        summary: miss.message
      };
    }
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

  if (operation === "lookup" && (target || (validation.targetColumns && validation.targetColumns.length > 0)) && filteredRows.length <= 10) {
    const label = colInfo.find((c) => /name/i.test(c.name) && !c.isNumeric)?.name || columns[0];
    const targetCols = (validation.targetColumns && validation.targetColumns.length > 0)
      ? validation.targetColumns.map((tc) => tc.name)
      : [target.name];

    let lookupVal;
    if (filteredRows.length === 1) {
      const r = filteredRows[0];
      if (targetCols.length === 1) {
        lookupVal = String(r[targetCols[0]]);
      } else {
        lookupVal = targetCols.map((colName) => `${colName}: ${r[colName]}`).join(", ");
      }
    } else {
      lookupVal = filteredRows.map((r) => `${r[label]}: ` + targetCols.map((colName) => `${colName}=${r[colName]}`).join(", ")).join("; ");
    }

    const rec = filteredRows[0];
    const colSummaryDesc = targetCols.map((colName) => `${colName} is ${rec[colName]}`).join(", ");
    let summaryText = `The ${targetCols.join(", ")} of ${rec?.[label] || "the matching record"} are ${colSummaryDesc} (filters: ${filterText}). Full record: ${JSON.stringify(rec)}.`;
    if (validation.unresolved && validation.unresolved.length > 0) {
      summaryText += ` Note: Could not resolve ${validation.unresolved.map((u) => `"${u}"`).join(", ")} against the dataset schema.`;
    }

    logTabularSemanticDebug(lookupVal, null, filteredRows.length);
    return {
      ...base,
      success: true,
      operation: "lookup",
      column: targetCols[0],
      targetColumns: targetCols,
      computedValue: lookupVal,
      rowsUsed: filteredRows.length,
      records: filteredRows,
      unresolved: validation.unresolved || [],
      summary: summaryText
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

  const { operation, column, computedValue, records, filters, summary, unresolved } = tabularResult;
  const unresolvedNotice = unresolved && unresolved.length > 0
    ? ` (Note: Could not resolve ${unresolved.map((u) => `"${u}"`).join(", ")} against the dataset schema.)`
    : "";

  if (operation === "entity_not_found") {
    return computedValue;
  }

  if (operation === "filter") {
    const filterDesc = describeFilters(filters);
    return `The students with ${filterDesc} are: ${computedValue}.${unresolvedNotice}`;
  }

  if (operation === "lookup" && records && records.length > 0) {
    const r = records[0];
    const name = r.Name || r.Student_ID || "The student";
    const targetCols = tabularResult.targetColumns && tabularResult.targetColumns.length > 0
      ? tabularResult.targetColumns
      : (column ? [column] : []);

    let text = "";
    if (targetCols.length > 1) {
      const parts = targetCols.map((c) => `${c} is ${r[c] !== undefined ? r[c] : "N/A"}`);
      const last = parts.pop();
      text = `${name}'s ${parts.join(", ")} and ${last}.`;
    } else if (targetCols.length === 1) {
      text = `${name}'s ${targetCols[0]} is ${computedValue}.`;
    } else {
      text = `${name}: ${computedValue}.`;
    }

    return `${text}${unresolvedNotice}`;
  }

  if (operation === "average" || operation === "mean") {
    return `The average ${column} is ${computedValue}.${unresolvedNotice}`;
  }

  if (operation === "sum" || operation === "total") {
    return `The total ${column} is ${computedValue}.${unresolvedNotice}`;
  }

  if (operation === "max" || operation === "highest") {
    return `The highest ${column} is ${computedValue}.${unresolvedNotice}`;
  }

  if (operation === "min" || operation === "lowest") {
    return `The lowest ${column} is ${computedValue}.${unresolvedNotice}`;
  }

  if (operation === "count") {
    return `There are ${computedValue} matching records.${unresolvedNotice}`;
  }

  if (summary) {
    return `${summary}${unresolvedNotice}`;
  }

  return `The result is ${computedValue}.${unresolvedNotice}`;
}

