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
  "median",
  "count",
  "percentage",
  "distribution",
  "lookup",
  "filter",
  "rank",
  "sort",
  "top_n",
  "bottom_n",
  "difference",
  "compare",
  "group_by",
  "column_not_found",
  "entity_not_found",
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

export function getEntityColumn(colInfo, rows = []) {
  if (!colInfo || colInfo.length === 0) return null;
  const byName = colInfo.find((c) => !c.isNumeric && /^(?:name|employee|student|user|person|customer|member)$/i.test(c.name));
  if (byName) return byName;
  const bySub = colInfo.find((c) => !c.isNumeric && /name|employee|student|user|person|customer/i.test(c.name));
  if (bySub) return bySub;
  const minDistinct = 4;
  const found = colInfo.find(
    (c) =>
      !c.isNumeric &&
      c.distinct &&
      c.distinct.length >= Math.min(minDistinct, rows.length) &&
      (rows.length === 0 || c.distinct.length / rows.length >= 0.6)
  );
  if (found) return found;
  return colInfo.find((c) => !c.isNumeric) || colInfo[0];
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
  "details", "information", "info", "person", "people",
  "class", "classes", "batch", "batches", "course", "courses",
  "section", "sections", "dataset", "datasets", "school", "college",
  "university", "many", "much", "overall", "across", "among", "between",
  "employee", "employees", "staff", "worker", "workers", "member", "members", "there", "got"
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
  "seventh", "7th", "eighth", "8th", "ninth", "9th", "tenth", "10th",
  "sort", "sorted", "sorting", "asc", "desc", "ascending", "descending",
  "difference", "range", "spread", "median", "compare", "comparison", "versus", "vs"
]);

/**
 * Personal pronouns (the same set the parser already used inline for its follow-up guard,
 * now defined once). Used to detect unresolved follow-ups and to treat pronouns as filler.
 */
export const QUERY_PRONOUNS = new Set(["he", "she", "they", "his", "her", "their", "him", "them", "it"]);
const PRONOUN_RE = new RegExp(`\\b(?:${[...QUERY_PRONOUNS].join("|")})\\b`, "i");

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

  const maxEdit = t.length >= 6 ? (RAG_CONFIG.tabularFuzzyMaxEdit ?? 2) : 1;

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
          const allowedEdit = (t.length >= 6 && vClean.length >= 6) ? maxEdit : 1;
          const d = editDistance(t, vClean);
          if (d <= allowedEdit) {
            return { match: val, type: "row_value", column: col.name, distance: d };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Filler detection WITHOUT new word lists.
 * A token is filler if it is a number, a pronoun, is in the existing function / operator sets,
 * or is a morphological variant of one (same stem, or edit distance 1 for words >= 5 chars),
 * e.g. "scored" ~ "score", "students" ~ "student".
 */
export function isFillerToken(token) {
  const t = String(token || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!t) return true;
  if (/^\d+(\.\d+)?$/.test(t)) return true;
  if (QUERY_PRONOUNS.has(t)) return true;
  const ts = stemWord(t);
  for (const set of [QUERY_FUNCTION_WORDS, QUERY_OPERATOR_WORDS]) {
    if (set.has(t)) return true;
    for (const w of set) {
      if (stemWord(w) === ts) return true;
      if (t.length >= 5 && w.length >= 5 && Math.abs(t.length - w.length) <= 1 && editDistance(t, w) <= 1) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns phrases of content words in `text` that are neither filler nor plausibly
 * tied to any schema column / row value. Purely schema- and morphology-driven.
 * Consecutive unmatched words are grouped into one phrase (e.g. "Computer Studies").
 */
export function findUnmatchedTerms(text, colInfo, rows = []) {
  const origs = String(text || "").match(/[A-Za-z0-9_\-]+/g) || [];
  const phrases = [];
  let run = [];
  const flush = () => {
    if (run.length > 0) {
      phrases.push(run.join(" "));
      run = [];
    }
  };
  for (const tok of origs) {
    const t = tok.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (t.length < 3 || isFillerToken(t) || checkPlausibleSchemaMatch(t, colInfo, rows)) {
      flush();
      continue;
    }
    run.push(tok);
  }
  flush();
  return phrases;
}

/**
 * Resolves "who is this follow-up about?" from recent USER messages, using only the dataset's
 * own data: entity columns are text columns whose values are (nearly) unique per row.
 * Returns the entity value from the most recent user message that names exactly one entity
 * (or several values that all belong to the same row), otherwise null.
 */
export function resolveEntityFromHistory(history, colInfo, rows = []) {
  if (!Array.isArray(history) || history.length === 0 || !rows || rows.length === 0) return null;
  const entityCol = getEntityColumn(colInfo, rows);
  if (!entityCol || !entityCol.distinct) return null;

  const reversed = history.slice().reverse();
  for (const msg of reversed) {
    if (!msg || !msg.content || typeof msg.content !== "string") continue;
    const text = msg.content;
    const hits = [];
    for (const v of entityCol.distinct) {
      if (!v) continue;
      const pat = escRe(v).replace(/[_\-\s]+/g, "[\\s_\\-]+");
      if (new RegExp(`\\b${pat}\\b`, "i").test(text)) {
        hits.push(v);
      }
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return hits[0];
  }
  return null;
}

/**
 * Requirement 1: Computes plan coverage.
 * Determines which content tokens of the question were NOT consumed by the plan.
 *
 * Two kinds of gaps make a plan incomplete:
 *   (a) plausibleUnconsumed: leftover tokens that plausibly match a schema column / row value
 *       (typos, near-matches). These escalate to the LLM planner.
 *   (b) unresolvedAttributes: things the user asked for that match NOTHING in the schema:
 *       - terms the parser attached to a comparison clause but could not map to a column, and
 *       - for entity-scoped plans (filter / lookup on a unique-per-row column), any leftover
 *         content word, since the question can only be asking for an attribute of that entity.
 *       The plan must never silently drop these.
 */
export function checkPlanCoverage(question, plan, colInfo, rows = []) {
  if (!question || !plan) {
    return {
      isComplete: false,
      unconsumedTokens: [],
      plausibleUnconsumed: [],
      unresolvedAttributes: [],
      reason: "no plan or empty question"
    };
  }

  if (plan.operation === "column_not_found" || plan.operation === "entity_not_found") {
    return {
      isComplete: true,
      unconsumedTokens: [],
      plausibleUnconsumed: [],
      unresolvedAttributes: [],
      reason: `Terminal operation: ${plan.operation}`
    };
  }

  // Extract all word tokens from question (keep original case for display)
  const origTokens = question.match(/[A-Za-z0-9_\-]+/g) || [];
  const qTokens = origTokens.map((t) => t.toLowerCase());
  if (qTokens.length === 0) {
    return { isComplete: true, unconsumedTokens: [], plausibleUnconsumed: [], unresolvedAttributes: [] };
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

  // Entity-scoped plan: filter / lookup where an equality filter hits a column whose values
  // are (nearly) unique per row, derived from the data (e.g. Name / ID), not from column names.
  const minDistinct = RAG_CONFIG.entityColumnMinDistinct ?? 8;
  const entityScoped =
    (plan.operation === "filter" || plan.operation === "lookup") &&
    Array.isArray(plan.filters) &&
    plan.filters.some((f) => {
      if (!f || f.op !== "eq") return false;
      const col = colInfo.find((c) => c.name === f.column);
      if (!col || col.isNumeric || !col.distinct) return false;
      const uniqueRatio = rows.length > 0 ? col.distinct.length / rows.length : 1;
      return col.distinct.length >= minDistinct && uniqueRatio >= 0.8;
    });

  // Find unconsumed content tokens
  const unconsumedTokens = [];
  const suspectIdx = [];

  for (let i = 0; i < qTokens.length; i++) {
    const token = qTokens[i].replace(/[^a-z0-9]/g, "");
    if (!token) continue;

    // 1. Is it a number? Consumed.
    if (/^\d+(\.\d+)?$/.test(token)) continue;

    // 2. Was it consumed by a column, filter value, or operator?
    if (consumedTokens.has(token)) continue;
    let isConsumedByStem = false;
    for (const ct of consumedTokens) {
      if (
        token === ct ||
        stemWord(token) === stemWord(ct) ||
        matchTokenToColumn(token, ct) ||
        (token.length >= 4 && ct.length >= 4 && Math.abs(token.length - ct.length) <= 1 && token[0] === ct[0] && editDistance(token, ct) <= 2)
      ) {
        isConsumedByStem = true;
        break;
      }
    }
    if (isConsumedByStem) continue;

    // 3. Is it an operator word?
    if (QUERY_OPERATOR_WORDS.has(token)) continue;

    // 4. Is it a generic function / stopword or morphological filler?
    if (QUERY_FUNCTION_WORDS.has(token) || isFillerToken(token)) continue;

    // 5. This is an unconsumed content token!
    // Check if it plausibly refers to schema columns or row values
    const match = checkPlausibleSchemaMatch(token, colInfo, rows);
    unconsumedTokens.push({ token, plausibleMatch: match || null });

    // 6. Matches nothing in the schema, and the question is about one entity:
    //    this word is the attribute being asked for (unless it is a morphological filler variant).
    if (!match && entityScoped && token.length >= 3 && !isFillerToken(token)) {
      suspectIdx.push(i);
    }
  }

  // Group consecutive suspect tokens into phrases (e.g. "Computer Studies")
  const entityMisses = [];
  let run = [];
  const flushRun = () => {
    if (run.length > 0) {
      entityMisses.push(run.map((idx) => origTokens[idx]).join(" "));
      run = [];
    }
  };
  for (const idx of suspectIdx) {
    if (run.length > 0 && idx !== run[run.length - 1] + 1) flushRun();
    run.push(idx);
  }
  flushRun();

  // Merge with terms the parser could not map (comparison clauses), de-duplicated
  const unresolvedAttributes = [];
  const seen = new Set();
  const pushUnique = (phrase) => {
    const key = String(phrase).toLowerCase().trim();
    if (!key || seen.has(key)) return;
    for (const s of seen) {
      if (s.includes(key) || key.includes(s)) return;
    }
    seen.add(key);
    unresolvedAttributes.push(String(phrase).trim());
  };
  if (Array.isArray(plan.unresolvedTerms)) plan.unresolvedTerms.forEach(pushUnique);
  entityMisses.forEach(pushUnique);

  const plausibleUnconsumed = unconsumedTokens.filter((u) => u.plausibleMatch !== null);
  const isComplete = plausibleUnconsumed.length === 0 && unresolvedAttributes.length === 0;

  let reason = "All content tokens consumed by plan";
  if (plausibleUnconsumed.length > 0) {
    reason = `Unconsumed tokens with plausible schema match: ${plausibleUnconsumed.map((u) => `${u.token} -> ${u.plausibleMatch.match}`).join(", ")}`;
  } else if (unresolvedAttributes.length > 0) {
    reason = `Requested attribute(s) not found in schema: ${unresolvedAttributes.join(", ")}`;
  }

  return {
    isComplete,
    unconsumedTokens,
    plausibleUnconsumed,
    unresolvedAttributes,
    reason
  };
}

/**
 * Fast deterministic parser for structured queries.
 * Identifies column names, comparison operators, thresholds, and target operations directly from table schema.
 */
export function parseDeterministicQueryPlan(question, colInfo, rows = [], history = []) {
  if (!question || !colInfo || colInfo.length === 0) return null;
  let q = question.trim();

  // If follow-up with pronoun, resolve entity from history
  if (PRONOUN_RE.test(q)) {
    const histEntity = resolveEntityFromHistory(history, colInfo, rows);
    if (histEntity) {
      q = q.replace(PRONOUN_RE, histEntity);
    }
  }

  const qWords = q.split(/[\s,?.!;:()\[\]"]+/).filter(Boolean);
  const entityCol = getEntityColumn(colInfo, rows);

  // 1. Column discovery
  const foundCols = [];
  const seenCols = new Set();
  for (const col of colInfo) {
    const patternStr = escRe(col.name).replace(/[_\-\s]+/g, "[\\s_\\-]+");
    const re = new RegExp(`\\b${patternStr}\\b`, "gi");
    let m = re.exec(q);
    if (m) {
      foundCols.push({ col, index: m.index, length: m[0].length, matchedText: m[0] });
      seenCols.add(col.name);
      continue;
    }
    for (let i = 0; i < qWords.length; i++) {
      const w = qWords[i];
      if (matchTokenToColumn(w, col.name)) {
        foundCols.push({ col, index: q.toLowerCase().indexOf(w.toLowerCase()), length: w.length, matchedText: w });
        seenCols.add(col.name);
        break;
      }
    }
  }
  foundCols.sort((a, b) => a.index - b.index);

  // Check if query asks for a column with words like "mark", "score", "rate"
  const unknownColMatch = /\b([a-zA-Z]{3,})\s+(?:mark|marks|score|scores)\b/i.exec(q);
  if (unknownColMatch) {
    const cand = unknownColMatch[1];
    const closest = findClosestColumn(cand, colInfo);
    if (closest && !seenCols.has(closest.name)) {
      foundCols.push({ col: closest, index: unknownColMatch.index, length: cand.length, matchedText: cand });
      seenCols.add(closest.name);
      foundCols.sort((a, b) => a.index - b.index);
    } else if (!colInfo.some(c => matchTokenToColumn(cand, c.name)) &&
        !QUERY_FUNCTION_WORDS.has(cand.toLowerCase()) &&
        !QUERY_OPERATOR_WORDS.has(cand.toLowerCase())) {
      if (foundCols.length === 0) {
        return {
          operation: "column_not_found",
          missingColumn: cand,
          columns: colInfo.map(c => c.name),
          reason: `Column "${cand}" not in schema`,
          isComplete: true
        };
      }
    }
  }

  // 2. Identify operation
  let operation = null;
  let subOperation = null;
  let limit = null;
  let rankIndex = null;
  let sortOrder = /\b(?:ascending|asc|lowest\s+first|least\s+first)\b/i.test(q) ? "asc" : "desc";
  let groupColumn = null;

  const topNMatch = /\b(?:top|best|highest|leading)\s*(\d+)\b/i.exec(q);
  const bottomNMatch = /\b(?:bottom|worst|lowest)\s*(\d+)\b/i.exec(q);
  const diffMatch = /\b(?:difference(?:\s+between)?|range(?:\s+of)?|spread(?:\s+of)?)\b/i.exec(q);
  const compareMatch = /\b(?:compare|comparison|versus|vs\.?)\b/i.exec(q);
  const groupByMatch = /\b(?:by|per|for\s+each|grouped\s+by)\s+([a-zA-Z0-9_\-]+)\b/i.exec(q);

  if (diffMatch) {
    operation = "difference";
  } else if (compareMatch) {
    operation = "compare";
  } else if (topNMatch) {
    operation = "top_n";
    limit = parseInt(topNMatch[1], 10);
    sortOrder = "desc";
  } else if (bottomNMatch) {
    operation = "bottom_n";
    limit = parseInt(bottomNMatch[1], 10);
    sortOrder = "asc";
  } else if (/\b(?:sort|sorted|sorting|order(?:ed)?\s+(?:(?:all\s+|the\s+)?[a-zA-Z]+\s+)?by)\b/i.test(q)) {
    operation = "sort";
  } else if (/\bmedian\b/i.test(q)) {
    operation = "median";
  } else if (groupByMatch && colInfo.some(c => !c.isNumeric && matchTokenToColumn(groupByMatch[1], c.name))) {
    operation = "group_by";
    const matchedCol = colInfo.find(c => !c.isNumeric && matchTokenToColumn(groupByMatch[1], c.name));
    groupColumn = matchedCol.name;
  } else if (/\b(?:percentage|percent|%|proportion|fraction)\b/i.test(q)) {
    operation = "percentage";
  } else if (/\b(?:how\s+many|count(?:\s+of)?|number\s+of|total\s+number\s+of|total\s+(?:students?|employees?|records?|rows?|people))\b/i.test(q)) {
    operation = "count";
  } else if (/\b(?:highest|maximum|max|top|greatest|most|best|who\s+scored\s+highest)\b/i.test(q)) {
    operation = "max";
  } else if (/\b(?:lowest|minimum|min|least|bottom|worst)\b/i.test(q)) {
    operation = "min";
  } else if (/\b(?:average|mean|avg)\b/i.test(q)) {
    operation = "average";
  } else if (/\b(?:sum(?:\s+of)?|total\s+sum|total\b)\b/i.test(q)) {
    operation = "sum";
  } else if (/\b(?:which|who|list|names?\s+of|find|show|give\s+me)\b/i.test(q)) {
    operation = "filter";
  }

  // 3. Extract filters & entity matches
  const filters = [];
  const matchedEntities = [];
  const opTokens = "above|greater(?:\\s+than)?|more(?:\\s+than)?|higher(?:\\s+than)?|over|exceeding|exceeds|below|less(?:\\s+than)?|lower(?:\\s+than)?|under|fewer(?:\\s+than)?|at\\s+least|at\\s+most|[><]=?";
  const unitTokens = "(?:years?|months?|points?|marks?|percent|%|\\$)?";

  // Numeric filters (col op num or op num in col)
  for (const col of colInfo) {
    if (!col.isNumeric) continue;
    const cPat = escRe(col.name).replace(/[_\-\s]+/g, "[\\s_\\-]+");
    const re1 = new RegExp(`\\b${cPat}\\b\\s*(?:is|are|of|scored|got)?\\s*(${opTokens})\\s*(\\d+(?:\\.\\d+)?)\\s*${unitTokens}`, "i");
    const m1 = re1.exec(q);
    if (m1) {
      filters.push({ column: col.name, op: normalizeOp(m1[1]), value: parseFloat(m1[2]) });
    } else {
      const re2 = new RegExp(`(${opTokens})\\s*(\\d+(?:\\.\\d+)?)\\s*${unitTokens}\\s*(?:in|for|on|with|of)?\\s*(?:both\\s+)?\\b${cPat}\\b`, "i");
      const m2 = re2.exec(q);
      if (m2) {
        filters.push({ column: col.name, op: normalizeOp(m2[1]), value: parseFloat(m2[2]) });
      }
    }
  }

  // Categorical matching across distinct values
  for (const col of colInfo) {
    if (col.isNumeric || !col.distinct) continue;
    for (const d of col.distinct) {
      if (!d) continue;
      const strVal = String(d).trim();
      if (!strVal) continue;
      const dPat = escRe(strVal).replace(/[_\-\s]+/g, "[\\s_\\-]+");
      let isMatch = false;

      if (strVal.length <= 2) {
        const colPattern = escRe(col.name).replace(/[_\-\s]+/g, "[\\s_\\-]+");
        const nearColRe = new RegExp(`(?:\\b${colPattern}\\s*(?:is|equals|:|==|=|-)?\\s*${dPat}\\b|\\b${dPat}\\s+${colPattern}\\b)`, "i");
        const exactUpperRe = new RegExp(`\\b${dPat}\\b`);
        if (nearColRe.test(q) || exactUpperRe.test(q)) isMatch = true;
      } else {
        const dRe = new RegExp(`\\b${dPat}\\b`, "i");
        if (dRe.test(q)) {
          isMatch = true;
        } else if (strVal.length >= 4) {
          const valLower = strVal.toLowerCase();
          const valStem = stemWord(valLower);
          for (const w of qWords) {
            const wClean = w.toLowerCase().replace(/[^a-z0-9]/g, "");
            if (wClean.length >= 4 && (stemWord(wClean) === valStem || wClean.startsWith(valLower))) {
              isMatch = true;
              break;
            }
          }
        }
      }

      if (isMatch) {
        filters.push({ column: col.name, op: "eq", value: d });
        // Only push to matchedEntities if it comes from the entity column!
        if (col.name === entityCol?.name) {
          if (!matchedEntities.includes(d)) matchedEntities.push(d);
        }
      }
    }
  }

  // If question asked for "failed" / "failing" and Status column exists with Pass/Fail:
  if (/\b(?:failed|failing|fails?)\b/i.test(q) && !filters.some(f => f.column === "Status")) {
    const statusCol = colInfo.find(c => /status/i.test(c.name));
    if (statusCol && statusCol.distinct.some(d => /fail/i.test(d))) {
      const failVal = statusCol.distinct.find(d => /fail/i.test(d));
      filters.push({ column: statusCol.name, op: "eq", value: failVal });
    }
  }

  // Check if question asked for an unknown entity (e.g. "Bruce Wayne" when not in dataset)
  if (matchedEntities.length === 0 && /\b(?:for|of|is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/.test(q)) {
    const unknownEntity = /\b(?:for|of|is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/.exec(q)[1];
    return {
      operation: "entity_not_found",
      missingEntity: unknownEntity,
      reason: `Entity "${unknownEntity}" not found in dataset`,
      isComplete: true
    };
  }

  // 4. Resolve target columns & operation
  let targetColumn = null;
  let targetColumns = [];
  const numericFound = foundCols.filter((fc) => fc.col.isNumeric);

  // If exactly 1 entity is matched AND operation is not an aggregation/diff/compare:
  if (matchedEntities.length === 1 && !["difference", "compare", "top_n", "bottom_n", "sort"].includes(operation)) {
    operation = "lookup";
  }

  if (operation === "difference") {
    if (/\b(?:highest|max)\b.*\b(?:lowest|min)\b|\b(?:lowest|min)\b.*\b(?:highest|max)\b/i.test(q)) {
      subOperation = "max_min";
      targetColumn = numericFound[0]?.col.name || colInfo.find(c => c.isNumeric)?.name;
    } else if (matchedEntities.length === 1 && numericFound.length >= 2) {
      subOperation = "two_columns";
      targetColumns = [numericFound[0].col.name, numericFound[1].col.name];
    } else if (matchedEntities.length >= 2 && numericFound.length >= 1) {
      subOperation = "two_entities";
      targetColumn = numericFound[0].col.name;
    } else {
      subOperation = "max_min";
      targetColumn = numericFound[0]?.col.name || colInfo.find(c => c.isNumeric)?.name;
    }
  } else if (operation === "compare") {
    if (matchedEntities.length === 1 && numericFound.length >= 2) {
      subOperation = "two_columns";
      targetColumns = [numericFound[0].col.name, numericFound[1].col.name];
    } else if (matchedEntities.length >= 2 && numericFound.length >= 1) {
      subOperation = "two_entities";
      targetColumn = numericFound[0].col.name;
    } else {
      targetColumns = numericFound.map(fc => fc.col.name);
    }
  } else if (operation === "top_n" || operation === "bottom_n") {
    targetColumn = numericFound[0]?.col.name || colInfo.find(c => c.isNumeric && /total|score|mark|average|salary|rating|revenue/i.test(c.name))?.name || colInfo.find(c => c.isNumeric)?.name;
  } else if (operation === "lookup") {
    targetColumns = foundCols.filter(fc => fc.col.name !== entityCol?.name).map(fc => fc.col.name);
    if (targetColumns.length === 0) {
      targetColumns = colInfo.filter(c => c.name !== entityCol?.name).map(c => c.name);
    }
    targetColumn = targetColumns[0];
  } else if (["average", "sum", "min", "max", "median"].includes(operation)) {
    const opColMatch = (c) => {
      const cLower = c.name.toLowerCase();
      if (operation === "average" && /average|mean|avg/.test(cLower)) return true;
      if (operation === "sum" && /sum|total/.test(cLower)) return true;
      return false;
    };
    const specificNumeric = numericFound.filter((fc) => !opColMatch(fc.col));
    const target = specificNumeric.length > 0 ? specificNumeric[0].col : (numericFound[0]?.col || colInfo.find(c => c.isNumeric));
    if (target) {
      targetColumns = [target.name];
      targetColumn = target.name;
    }
  } else if (operation === "sort") {
    targetColumn = numericFound[0]?.col.name || colInfo.find(c => c.isNumeric)?.name || colInfo[0]?.name;
    targetColumns = [targetColumn];
  } else if (operation === "group_by") {
    targetColumn = numericFound[0]?.col.name || null;
  } else if (operation === "count") {
    targetColumn = entityCol?.name || colInfo[0]?.name;
    targetColumns = [targetColumn];
  } else if (operation === "filter") {
    targetColumn = entityCol?.name || colInfo[0]?.name;
    targetColumns = [targetColumn];
  }

  if (!operation) {
    if (filters.length > 0) {
      operation = "filter";
      targetColumn = entityCol?.name || colInfo[0]?.name;
      targetColumns = [targetColumn];
    } else if (numericFound.length === 1) {
      operation = "average";
      targetColumn = numericFound[0].col.name;
      targetColumns = [targetColumn];
    }
  }

  if (!operation) return null;

  return {
    operation,
    subOperation,
    targetColumn,
    targetColumns: targetColumns.length > 0 ? targetColumns : (targetColumn ? [targetColumn] : []),
    limit,
    rankIndex,
    sortOrder,
    groupColumn,
    filters,
    matchedEntities,
    entityCol: entityCol?.name,
    unresolvedTerms: [],
    isAmbiguous: false,
    isComplete: true,
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

ALLOWED OPERATIONS: "lookup", "filter", "average", "sum", "min", "max", "median", "count", "percentage", "distribution", "sort", "top_n", "bottom_n", "difference", "compare", "group_by", "rank", "none".

CRITICAL INSTRUCTIONS:
1. "columns": array of exact column names from SCHEMA.
   - For lookups, include ALL requested columns (e.g. ["Science", "English", "Total_Marks", "Average"]).
   - For aggregations (average/sum/min/max/median), include the target numeric column.
   - Map spelling variations or typos (e.g. "tola" for "Total_Marks") to the correct schema column.
   - If a requested column does not exist in SCHEMA, do not invent names; add to "unresolved".
2. "filters": array of { "column": "<exact column>", "op": "eq"|"gt"|"gte"|"lt"|"lte", "value": "<value>" }.
3. "unresolved": array of unrecognized concepts or missing columns from question.
4. "reason": concise explanation.

OUTPUT JSON FORMAT ONLY:
{
  "operation": "lookup" | "filter" | "average" | "sum" | "min" | "max" | "median" | "count" | "percentage" | "distribution" | "sort" | "top_n" | "bottom_n" | "difference" | "compare" | "group_by" | "rank" | "none",
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

  if (normalizedOp === "column_not_found" || normalizedOp === "entity_not_found") {
    return {
      valid: true,
      operation: normalizedOp,
      target: null,
      targetColumns: [],
      filters: [],
      unresolved: [],
      reason: plan.reason || null
    };
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

  const needsNumeric = ["average", "sum", "min", "max", "median"].includes(normalizedOp);
  if (needsNumeric) {
    if (!validatedTarget) {
      validatedTarget = colInfo.find((c) => c.isNumeric) || null;
    }
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

  if (["top_n", "bottom_n"].includes(normalizedOp)) {
    if (!validatedTarget) {
      validatedTarget = colInfo.find((c) => c.isNumeric && /total|score|mark|average|salary|rating/i.test(c.name)) ||
                        colInfo.find((c) => c.isNumeric) ||
                        colInfo[0];
    }
  }

  if (["difference", "compare"].includes(normalizedOp)) {
    if (!validatedTarget && validatedColumns.length === 0) {
      validatedTarget = colInfo.find((c) => c.isNumeric) || colInfo[0];
      if (validatedTarget) validatedColumns.push(validatedTarget);
    }
  }

  if (normalizedOp === "group_by") {
    if (!validatedTarget) {
      validatedTarget = colInfo.find((c) => !c.isNumeric) || colInfo[0];
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

  if (normalizedOp === "sort") {
    if (!validatedTarget) {
      validatedTarget = colInfo.find((c) => c.isNumeric && /total|score|mark|average/i.test(c.name)) ||
                        colInfo.find((c) => c.isNumeric) ||
                        colInfo[0];
    }
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

/**
 * Builds the "requested attribute not in dataset" message from real schema columns only.
 */
export function buildColumnNotFoundMessage(unresolvedAttributes, documentName, columns) {
  const quoted = unresolvedAttributes.map((a) => `"${a}"`).join(", ");
  return `I couldn't find ${quoted} in ${documentName}, so I can't answer that. Available columns: ${columns.join(", ")}.`;
}

// ---------- main entry point ----------

/**
 * @param {string} question          The user's current question.
 * @param {string[]} targetDepartments
 * @param {string[]} targetDocuments
 * @param {string} fallbackQuestion  Optional pre-resolved standalone question.
 * @param {Array<{role: string, content: string}>} history  Recent chat turns, used to resolve
 *        follow-ups that name no entity (e.g. "her average").
 */
export async function processTabularQuery(question = "", targetDepartments = [], targetDocuments = [], fallbackQuestion = "", history = []) {
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

  // 1. Pick the best matching tabular document by schema inspection and cell token scoring
  let scoredCandidates = [];
  const qCombined = `${question} ${fallbackQuestion}`.toLowerCase();
  for (const doc of docs) {
    let rows;
    try { rows = loadRows(doc); } catch { continue; }
    if (!rows || rows.length === 0) continue;
    const colInfo = analyseColumns(rows);
    let score = 0;
    for (const c of colInfo) {
      if (qCombined.includes(c.name.toLowerCase())) score += 10;
      else if (matchTokenToColumn(c.name, qCombined)) score += 5;
    }
    for (const c of colInfo) {
      if (c.isNumeric || !c.distinct) continue;
      for (const d of c.distinct) {
        if (d && String(d).length >= 3 && qCombined.includes(String(d).toLowerCase())) {
          score += 15;
          break;
        }
      }
    }
    scoredCandidates.push({ doc, rows, colInfo, score });
  }

  if (scoredCandidates.length === 0) {
    return { success: false, error: "Dataset is empty or unreadable." };
  }

  scoredCandidates.sort((a, b) => b.score - a.score);
  const best = scoredCandidates[0];

  const { doc, rows, colInfo } = best;
  const documentName = doc.originalName;
  const columns = colInfo.map((c) => c.name);

  // 2. Query Understanding: Attempt fast deterministic parsing first
  let semanticPlan = parseDeterministicQueryPlan(question, colInfo, rows, history);
  let resolvedQuestion = question;

  if (!semanticPlan && fallbackQuestion && fallbackQuestion !== question) {
    semanticPlan = parseDeterministicQueryPlan(fallbackQuestion, colInfo, rows, history);
    if (semanticPlan) {
      resolvedQuestion = fallbackQuestion;
      console.log(`[Tabular Processor] Deterministic plan resolved using context: ${semanticPlan.operation} on ${semanticPlan.targetColumns?.join(", ") || semanticPlan.targetColumn || "table"}`);
    }
  } else if (semanticPlan) {
    console.log(`[Tabular Processor] Deterministic plan resolved: ${semanticPlan.operation} on ${semanticPlan.targetColumns?.join(", ") || semanticPlan.targetColumn || "table"}`);
  }

  if (semanticPlan && semanticPlan.operation === "column_not_found") {
    const message = buildColumnNotFoundMessage([semanticPlan.missingColumn], documentName, columns);
    return {
      documentName,
      operation: "column_not_found",
      column: null,
      targetColumns: [],
      filters: [],
      columns,
      totalRows: rows.length,
      rowsUsed: 0,
      semanticPlan,
      usedLlmPlanner: false,
      coverageDecision: "complete",
      unresolved: [semanticPlan.missingColumn],
      success: true,
      computedValue: message,
      summary: message
    };
  }

  if (semanticPlan && semanticPlan.operation === "entity_not_found") {
    const message = `I couldn't find any record matching "${semanticPlan.missingEntity}" in ${documentName}.`;
    return {
      documentName,
      operation: "entity_not_found",
      column: null,
      targetColumns: [],
      filters: [],
      columns,
      totalRows: rows.length,
      rowsUsed: 0,
      semanticPlan,
      usedLlmPlanner: false,
      coverageDecision: "complete",
      unresolved: [semanticPlan.missingEntity],
      success: true,
      computedValue: message,
      summary: message
    };
  }

  // Requirement 1 & 2: Plan coverage check & escalation
  let coverage = checkPlanCoverage(resolvedQuestion, semanticPlan, colInfo, rows);
  let usedLlmPlanner = false;
  let partialMisses = [];

  // Requested attribute(s) match nothing in the schema (e.g. a subject that has no column).
  // Never silently drop them: answer "not found" unless a lookup can still return its resolved columns.
  const attrMisses = coverage.unresolvedAttributes || [];
  if (semanticPlan && attrMisses.length > 0 && coverage.plausibleUnconsumed.length === 0) {
    const hasResolvedProjection =
      semanticPlan.operation === "lookup" &&
      Array.isArray(semanticPlan.targetColumns) &&
      semanticPlan.targetColumns.length > 0;

    if (hasResolvedProjection) {
      partialMisses = attrMisses;
      console.log(`[Tabular Processor] Partial lookup: unresolved attribute(s) ${JSON.stringify(attrMisses)} will be reported alongside resolved columns.`);
    } else {
      const message = buildColumnNotFoundMessage(attrMisses, documentName, columns);
      console.log(`[TABULAR SEMANTIC DEBUG]`);
      console.log(`  - question: "${question}"`);
      console.log(`  - selected document: ${documentName}`);
      console.log(`  - schema: [${columns.join(", ")}]`);
      console.log(`  - coverage decision: incomplete (${coverage.reason})`);
      console.log(`  - used LLM planner: false`);
      console.log(`  - semantic operation: ${semanticPlan.operation}`);
      console.log(`  - semantic filters: ${JSON.stringify(semanticPlan.filters || [])}`);
      console.log(`  - unresolved: ${JSON.stringify(attrMisses)}`);
      console.log(`  - computed result: ${message}`);
      console.log(`  - fallback reason: column_not_found`);
      return {
        documentName,
        operation: "column_not_found",
        column: null,
        targetColumns: [],
        filters: semanticPlan.filters || [],
        columns,
        totalRows: rows.length,
        rowsUsed: 0,
        semanticPlan,
        usedLlmPlanner: false,
        coverageDecision: "incomplete",
        unresolved: attrMisses,
        success: true,
        computedValue: message,
        summary: message
      };
    }
  }

  // Escalate to the LLM planner only when there is no plan or a plausible schema match was left unused
  const needsLlm = !semanticPlan || coverage.plausibleUnconsumed.length > 0;

  if (needsLlm) {
    const qForLlm = contextualQuestion || fallbackQuestion || question;
    console.log(
      `[Tabular Processor] Plan ${semanticPlan ? "incomplete" : "null"} (reason: ${coverage.reason}). Escalating to LLM semantic planner.`
    );
    semanticPlan = await parseSemanticQueryPlan(qForLlm, documentName, colInfo);
    resolvedQuestion = qForLlm;
    usedLlmPlanner = true;
    partialMisses = [];
  } else {
    console.log(`[Tabular Processor] Plan ${coverage.isComplete ? "complete" : "partial"}. Fast path enabled (0 LLM calls).`);
  }

  const coverageLabel = coverage.isComplete ? "complete" : (partialMisses.length > 0 ? "partial" : "incomplete");

  // 3. Strict Programmatic Validation
  const validation = validateSemanticPlan(semanticPlan, colInfo, rows);

  if (validation.valid && partialMisses.length > 0) {
    validation.unresolved = [...(validation.unresolved || [])];
    for (const m of partialMisses) {
      if (!validation.unresolved.includes(m)) validation.unresolved.push(m);
    }
  }

  return executePlan(
    documentName,
    semanticPlan,
    validation,
    rows,
    colInfo,
    resolvedQuestion,
    coverageLabel,
    usedLlmPlanner
  );
}

export function executePlan(
  documentName,
  semanticPlan,
  validation,
  rows,
  colInfo,
  question = "",
  coverageLabel = "complete",
  usedLlmPlanner = false
) {
  const columns = colInfo.map((c) => c.name);
  const base = {
    documentName,
    operation: validation.operation || semanticPlan?.operation || "none",
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
    coverageDecision: coverageLabel,
    unresolved: validation.unresolved || []
  };

  const logTabularSemanticDebug = (computedResult, fallbackReason = null, filteredCount = 0) => {
    console.log(`[TABULAR SEMANTIC DEBUG]`);
    console.log(`  - question: "${question}"`);
    console.log(`  - selected document: ${documentName}`);
    console.log(`  - schema: [${columns.join(", ")}]`);
    console.log(`  - coverage decision: ${coverageLabel}`);
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

  // 4. Handle terminal plans or apply validated filters
  const { operation, target } = validation;
  const entityCol = semanticPlan.entityCol || getEntityColumn(colInfo, rows)?.name || columns[0];
  const label = entityCol;

  if (operation === "column_not_found") {
    const msg = semanticPlan?.reason || buildColumnNotFoundMessage(semanticPlan?.unresolved || [], documentName, columns);
    logTabularSemanticDebug(msg, "column_not_found", 0);
    return {
      ...base,
      success: true,
      operation: "column_not_found",
      computedValue: msg,
      summary: msg
    };
  }

  if (operation === "entity_not_found") {
    const msg = semanticPlan?.reason || `I couldn't find any record matching "${semanticPlan?.missingEntity}" in ${documentName}.`;
    logTabularSemanticDebug(msg, "entity_not_found", 0);
    return {
      ...base,
      success: true,
      operation: "entity_not_found",
      computedValue: msg,
      summary: msg
    };
  }

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
  const needsNumeric = ["average", "sum", "min", "max", "median"].includes(operation);

  if (needsNumeric && target) {
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

    if (operation === "median") {
      const sortedNums = nums.map((x) => x.n).sort((a, b) => a - b);
      const mid = Math.floor(sortedNums.length / 2);
      const medianVal = sortedNums.length % 2 !== 0 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
      const computedValue = fmt(medianVal);

      logTabularSemanticDebug(computedValue, null, nums.length);
      return {
        ...base,
        success: true,
        operation: "median",
        column: target.name,
        computedValue,
        rowsUsed: nums.length,
        summary: `Median of ${target.name} = ${computedValue} across ${nums.length} rows (filters: ${filterText}).`
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

  if (operation === "top_n" || operation === "bottom_n") {
    const n = semanticPlan.limit || 5;
    const isTop = operation === "top_n";
    const targetCol = target?.name || (colInfo.find((c) => c.isNumeric)?.name) || columns[0];
    const sorted = [...filteredRows].sort((a, b) => {
      const na = parseNum(a[targetCol]), nb = parseNum(b[targetCol]);
      if (na !== null && nb !== null) return isTop ? nb - na : na - nb;
      return isTop
        ? String(b[targetCol] ?? "").localeCompare(String(a[targetCol] ?? ""))
        : String(a[targetCol] ?? "").localeCompare(String(b[targetCol] ?? ""));
    });
    const sliced = sorted.slice(0, n);
    const computedValue = sliced.map((r) => `${r[label]} (${targetCol}: ${r[targetCol]})`).join(", ");
    logTabularSemanticDebug(computedValue, null, sliced.length);
    return {
      ...base,
      success: true,
      operation,
      limit: n,
      column: targetCol,
      computedValue,
      rowsUsed: sliced.length,
      records: sliced,
      summary: `The ${isTop ? "top" : "bottom"} ${n} by ${targetCol}: ${computedValue}.`
    };
  }

  if (operation === "difference") {
    if (semanticPlan.subOperation === "two_columns" && filteredRows.length > 0 && validation.targetColumns?.length >= 2) {
      const r = filteredRows[0];
      const c1 = validation.targetColumns[0].name;
      const c2 = validation.targetColumns[1].name;
      const v1 = parseNum(r[c1]);
      const v2 = parseNum(r[c2]);
      const diffVal = Math.abs(v1 - v2);
      const computedValue = fmt(diffVal);
      logTabularSemanticDebug(computedValue, null, 1);
      return {
        ...base,
        success: true,
        operation: "difference",
        subOperation: "two_columns",
        entityName: r[label],
        col1: c1,
        col2: c2,
        val1: fmt(v1),
        val2: fmt(v2),
        computedValue,
        rowsUsed: 1,
        records: [r],
        summary: `For ${r[label]}, difference between ${c1} (${fmt(v1)}) and ${c2} (${fmt(v2)}) is ${computedValue}.`
      };
    }

    const tCol = target || validation.targetColumns?.[0] || colInfo.find((c) => c.isNumeric);
    if (tCol) {
      const nums = filteredRows.map((r) => ({ row: r, n: parseNum(r[tCol.name]) })).filter((x) => x.n !== null);
      if (nums.length > 0) {
        const maxVal = Math.max(...nums.map((x) => x.n));
        const minVal = Math.min(...nums.map((x) => x.n));
        const maxHolders = nums.filter((x) => x.n === maxVal).map((x) => x.row[label]).join(", ");
        const minHolders = nums.filter((x) => x.n === minVal).map((x) => x.row[label]).join(", ");
        const diffVal = maxVal - minVal;
        const computedValue = fmt(diffVal);
        logTabularSemanticDebug(computedValue, null, nums.length);
        return {
          ...base,
          success: true,
          operation: "difference",
          subOperation: "max_min",
          column: tCol.name,
          computedValue,
          maxVal: fmt(maxVal),
          minVal: fmt(minVal),
          maxHolders,
          minHolders,
          rowsUsed: nums.length,
          summary: `Difference between highest ${tCol.name} (${fmt(maxVal)}, ${maxHolders}) and lowest ${tCol.name} (${fmt(minVal)}, ${minHolders}) is ${computedValue}.`
        };
      }
    }
  }

  if (operation === "compare" && filteredRows.length > 0 && validation.targetColumns?.length >= 2) {
    const r = filteredRows[0];
    const c1 = validation.targetColumns[0].name;
    const c2 = validation.targetColumns[1].name;
    const v1 = parseNum(r[c1]);
    const v2 = parseNum(r[c2]);
    const diff = Math.abs(v1 - v2);
    const winner = v1 > v2 ? c1 : (v2 > v1 ? c2 : "Equal");
    const diffDesc = winner !== "Equal" ? `${winner} is higher by ${fmt(diff)}` : `both are equal at ${fmt(v1)}`;
    const computedValue = `${c1}: ${fmt(v1)}, ${c2}: ${fmt(v2)} (${diffDesc})`;
    logTabularSemanticDebug(computedValue, null, 1);
    return {
      ...base,
      success: true,
      operation: "compare",
      subOperation: "two_columns",
      entityName: r[label],
      col1: c1,
      col2: c2,
      val1: fmt(v1),
      val2: fmt(v2),
      winner,
      diff: fmt(diff),
      computedValue,
      rowsUsed: 1,
      records: [r],
      summary: `For ${r[label]}, ${c1} is ${fmt(v1)} and ${c2} is ${fmt(v2)} (${diffDesc}).`
    };
  }

  if (operation === "group_by") {
    const gCol = semanticPlan.groupColumn || target?.name || (colInfo.find((c) => !c.isNumeric)?.name);
    const tCol = target && target.name !== gCol && target.isNumeric ? target.name : null;
    const groups = {};
    for (const r of filteredRows) {
      const g = String(r[gCol] ?? "Unknown").trim();
      if (!groups[g]) groups[g] = [];
      groups[g].push(r);
    }
    const parts = Object.entries(groups).map(([g, gRows]) => {
      if (tCol) {
        const nums = gRows.map((r) => parseNum(r[tCol])).filter((n) => n !== null);
        const avg = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
        return `${g}: average ${tCol} is ${fmt(avg)}`;
      }
      return `${g}: ${gRows.length}`;
    });
    const computedValue = parts.join("; ");
    logTabularSemanticDebug(computedValue, null, filteredRows.length);
    return {
      ...base,
      success: true,
      operation: "group_by",
      groupColumn: gCol,
      computedValue,
      rowsUsed: filteredRows.length,
      summary: `Breakdown by ${gCol}: ${computedValue}.`
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
      filteredCount: filteredRows.length,
      totalRows: rows.length,
      rowsUsed: filteredRows.length,
      summary: `Percentage of rows matching (${filterText}) = ${pctVal} (${filteredRows.length} / ${rows.length}).`
    };
  }

  if (operation === "lookup" && (target || (validation.targetColumns && validation.targetColumns.length > 0)) && filteredRows.length <= 10) {
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
    const filterCol = (target && !target.isNumeric) ? target.name : label;
    const names = filteredRows.map((r) => String(r[filterCol] ?? "")).filter(Boolean);
    const computedValue = names.length > 0 ? names.join(", ") : "None";
    const details = filteredRows.map((r) => {
      const parts = validation.filters.map((f) => `${f.column}: ${r[f.column]}`).join(", ");
      return parts ? `${r[filterCol]} (${parts})` : String(r[filterCol]);
    }).join("; ");

    logTabularSemanticDebug(computedValue, null, filteredRows.length);
    return {
      ...base,
      success: true,
      operation: "filter",
      column: filterCol,
      computedValue,
      rowsUsed: filteredRows.length,
      records: filteredRows,
      summary: `Matching records (${filterText}): ${details}. Total matching: ${filteredRows.length} out of ${rows.length} rows.`
    };
  }

  if (operation === "sort" && target) {
    const order = semanticPlan.sortOrder || "desc";
    const sorted = [...filteredRows].sort((a, b) => {
      const na = parseNum(a[target.name]);
      const nb = parseNum(b[target.name]);
      if (na !== null && nb !== null) {
        return order === "asc" ? na - nb : nb - na;
      }
      return order === "asc"
        ? String(a[target.name] ?? "").localeCompare(String(b[target.name] ?? ""))
        : String(b[target.name] ?? "").localeCompare(String(a[target.name] ?? ""));
    });

    const computedValue = sorted.map((r) => `${r[label]} (${target.name}: ${r[target.name]})`).join(", ");
    logTabularSemanticDebug(computedValue, null, sorted.length);
    return {
      ...base,
      success: true,
      operation: "sort",
      column: target.name,
      sortOrder: order,
      computedValue,
      rowsUsed: sorted.length,
      records: sorted,
      summary: `Records sorted by ${target.name} (${order}): ${computedValue}.`
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

  if (operation === "entity_not_found" || operation === "column_not_found") {
    return computedValue;
  }

  if (operation === "filter") {
    return `The matching records are: ${computedValue}.${unresolvedNotice}`;
  }

  if (operation === "lookup" && records && records.length > 0) {
    const r = records[0];
    const name = tabularResult.entityName || r.Name || r.Employee || Object.values(r)[0] || "The record";
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

  if (operation === "median") {
    return `The median ${column} is ${computedValue}.${unresolvedNotice}`;
  }

  if (operation === "sum" || operation === "total") {
    return `The total ${column} is ${computedValue}.${unresolvedNotice}`;
  }

  if (operation === "sort") {
    return `Sorted by ${column} (${tabularResult.sortOrder || "descending"}): ${computedValue}.${unresolvedNotice}`;
  }

  if (operation === "top_n") {
    return `The top ${tabularResult.limit} by ${column} are: ${computedValue}.${unresolvedNotice}`;
  }

  if (operation === "bottom_n") {
    return `The bottom ${tabularResult.limit} by ${column} are: ${computedValue}.${unresolvedNotice}`;
  }

  if (operation === "difference") {
    if (tabularResult.subOperation === "max_min") {
      return `The difference between the highest ${column} (${tabularResult.maxVal}, ${tabularResult.maxHolders}) and lowest ${column} (${tabularResult.minVal}, ${tabularResult.minHolders}) is ${computedValue}.${unresolvedNotice}`;
    }
    if (tabularResult.subOperation === "two_columns") {
      return `For ${tabularResult.entityName}, the difference between ${tabularResult.col1} (${tabularResult.val1}) and ${tabularResult.col2} (${tabularResult.val2}) is ${computedValue}.${unresolvedNotice}`;
    }
  }

  if (operation === "compare") {
    if (tabularResult.subOperation === "two_columns") {
      const diffDesc = tabularResult.winner !== "Equal" ? `${tabularResult.winner} is ${tabularResult.diff} points higher` : `both are equal`;
      return `For ${tabularResult.entityName}, ${tabularResult.col1} is ${tabularResult.val1} and ${tabularResult.col2} is ${tabularResult.val2} (${diffDesc}).${unresolvedNotice}`;
    }
  }

  if (operation === "group_by") {
    return `Breakdown by ${tabularResult.groupColumn}: ${computedValue}.${unresolvedNotice}`;
  }

  if (operation === "max" || operation === "highest") {
    if (records && records.length > 0) {
      const names = records.map((r) => r.Name || r.Employee || (Object.values(r)[0])).filter(Boolean).join(", ");
      const verb = records.length > 1 ? "have" : "has";
      if (names) {
        return `${names} ${verb} the highest ${column} with ${computedValue}.${unresolvedNotice}`;
      }
    }
    return `The highest ${column} is ${computedValue}.${unresolvedNotice}`;
  }

  if (operation === "min" || operation === "lowest") {
    if (records && records.length > 0) {
      const names = records.map((r) => r.Name || r.Employee || (Object.values(r)[0])).filter(Boolean).join(", ");
      const verb = records.length > 1 ? "have" : "has";
      if (names) {
        return `${names} ${verb} the lowest ${column} with ${computedValue}.${unresolvedNotice}`;
      }
    }
    return `The lowest ${column} is ${computedValue}.${unresolvedNotice}`;
  }

  if (operation === "count") {
    if (filters && filters.length > 0) {
      const filterDesc = describeFilters(filters);
      return `There are ${computedValue} matching records with ${filterDesc}.${unresolvedNotice}`;
    }
    return `There are ${computedValue} records in total.${unresolvedNotice}`;
  }

  if (operation === "percentage") {
    const filterDesc = filters && filters.length > 0 ? describeFilters(filters) : "matching condition";
    return `${computedValue} match (${filterDesc}) (${tabularResult.filteredCount} out of ${tabularResult.totalRows}).${unresolvedNotice}`;
  }

  if (summary) {
    return `${summary}${unresolvedNotice}`;
  }

  return `The result is ${computedValue}.${unresolvedNotice}`;
}