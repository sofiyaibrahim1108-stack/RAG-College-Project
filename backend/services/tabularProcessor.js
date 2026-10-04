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
        }
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

export async function processTabularQuery(question = "", targetDepartments = [], targetDocuments = []) {
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

  // 2. Semantic Query Understanding against real schema
  const semanticPlan = await parseSemanticQueryPlan(question, documentName, colInfo);

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
  const filteredRows = applyFilters(rows, validation.filters);
  const filterText = describeFilters(validation.filters);

  if (filteredRows.length === 0) {
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
  const { operation, target } = validation;
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
    const lookupVal = filteredRows.length === 1 ? String(filteredRows[0][target.name]) : null;
    logTabularSemanticDebug(lookupVal, null, filteredRows.length);
    return {
      ...base,
      success: true,
      operation: "lookup",
      column: target.name,
      computedValue: lookupVal,
      rowsUsed: filteredRows.length,
      summary: `Lookup (filters: ${filterText}): ${vals.join("; ")}.`
    };
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
