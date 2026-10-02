import fs from "fs";
import * as XLSX from "xlsx";
import { Document } from "../models/Document.js";

/**
 * Deterministic tabular processor for CSV and spreadsheet datasets.
 * Computes exact statistical operations (highest, lowest, average, sum, count, distribution)
 * without LLM hallucination or vector chunk truncation.
 */
export async function processTabularQuery(question = "", targetDepartments = [], targetDocuments = []) {
  // 1. Locate relevant tabular document from MongoDB
  const query = {
    fileType: { $in: ["csv", "xlsx", "xls"] },
    status: "completed"
  };

  if (targetDepartments && targetDepartments.length > 0) {
    query.department = { $in: targetDepartments };
  }

  let doc = await Document.findOne(query).sort({ createdAt: -1 });

  // If no document found in filtered department, look across all tabular documents
  if (!doc) {
    doc = await Document.findOne({
      fileType: { $in: ["csv", "xlsx", "xls"] },
      status: "completed"
    }).sort({ createdAt: -1 });
  }

  if (!doc || !doc.path || !fs.existsSync(doc.path)) {
    return {
      success: false,
      error: "No tabular document found in uploaded files."
    };
  }

  // 2. Read dataset via SheetJS
  const fileBuffer = fs.readFileSync(doc.path);
  const workbook = XLSX.read(fileBuffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

  if (!rawRows || rawRows.length === 0) {
    return {
      success: false,
      documentName: doc.originalName,
      error: "Dataset is empty."
    };
  }

  const columns = Object.keys(rawRows[0]);
  const qLower = question.toLowerCase();

  // Helper to find best column match
  function findMatchingColumn(candidates) {
    for (const c of candidates) {
      const match = columns.find(
        (col) => col.toLowerCase() === c.toLowerCase() || col.toLowerCase().replace(/[^a-z0-9]/g, "") === c.toLowerCase().replace(/[^a-z0-9]/g, "")
      );
      if (match) return match;
    }
    // Partial substring match
    for (const col of columns) {
      if (qLower.includes(col.toLowerCase().replace(/_/g, " ")) || qLower.includes(col.toLowerCase())) {
        return col;
      }
    }
    return null;
  }

  // Helper to parse numbers safely
  function parseNum(val) {
    if (typeof val === "number") return val;
    if (typeof val === "string") {
      const cleaned = val.replace(/[^0-9.-]/g, "");
      const n = parseFloat(cleaned);
      return isNaN(n) ? null : n;
    }
    return null;
  }

  // 3. Detect requested operation
  const isHighest = /\b(highest|max|maximum|top|most|best)\b/i.test(qLower);
  const isLowest = /\b(lowest|min|minimum|bottom|least|worst)\b/i.test(qLower);
  const isAverage = /\b(average|mean|avg)\b/i.test(qLower);
  const isSum = /\b(sum|total marks|total score|aggregate)\b/i.test(qLower) && !isHighest && !isLowest;
  const isDistribution = /\b(how many|count|distribution|number of students|grade a|grade b|grade c)\b/i.test(qLower);

  // Check for Count / Distribution (e.g. "How many students got Grade A, B, C?")
  if (isDistribution || /\b(grade|status)\b/i.test(qLower)) {
    const gradeCol = findMatchingColumn(["Grade", "Status"]) || "Grade";
    if (columns.includes(gradeCol)) {
      const counts = {};
      let totalValid = 0;

      for (const row of rawRows) {
        const val = String(row[gradeCol] || "").trim();
        if (val) {
          counts[val] = (counts[val] || 0) + 1;
          totalValid++;
        }
      }

      // Format clean summary
      const breakdown = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${gradeCol} ${k}: ${v}`)
        .join(", ");

      return {
        success: true,
        documentName: doc.originalName,
        operation: "distribution",
        column: gradeCol,
        counts,
        totalRecords: totalValid,
        summary: `According to ${doc.originalName}, the ${gradeCol} distribution across ${totalValid} records is: ${breakdown}.`
      };
    }
  }

  // Check for Highest / Maximum (e.g. "Highest total marks?")
  if (isHighest) {
    // Identify target numeric column
    let targetCol = findMatchingColumn(["Total_Marks", "Total", "Marks", "Score", "Average"]);
    if (!targetCol) {
      // Find any numeric column mentioned in question or default to highest variance numeric column
      targetCol = columns.find((c) => {
        const firstVal = parseNum(rawRows[0][c]);
        return firstVal !== null && qLower.includes(c.toLowerCase());
      });
    }
    if (!targetCol) {
      // Default to Total_Marks if present, or first numeric column
      targetCol = columns.find((c) => /total.*mark|total|score/i.test(c)) ||
                  columns.find((c) => parseNum(rawRows[0][c]) !== null);
    }

    if (targetCol) {
      let maxVal = -Infinity;
      let topRows = [];

      for (const row of rawRows) {
        const num = parseNum(row[targetCol]);
        if (num !== null) {
          if (num > maxVal) {
            maxVal = num;
            topRows = [row];
          } else if (num === maxVal) {
            topRows.push(row);
          }
        }
      }

      const topPerson = topRows[0];
      const nameCol = columns.find((c) => /^name$/i.test(c)) || columns.find((c) => /name/i.test(c)) || columns[0];
      const personName = topPerson ? topPerson[nameCol] : "Unknown";

      return {
        success: true,
        documentName: doc.originalName,
        operation: "highest",
        column: targetCol,
        highestValue: maxVal,
        topRecords: topRows,
        summary: `The highest ${targetCol} in ${doc.originalName} is ${maxVal}, obtained by ${personName}. Full record: ${JSON.stringify(topPerson)}`
      };
    }
  }

  // Check for Lowest / Minimum
  if (isLowest) {
    let targetCol = findMatchingColumn(["Total_Marks", "Total", "Marks", "Score", "Average"]) ||
                    columns.find((c) => parseNum(rawRows[0][c]) !== null);

    if (targetCol) {
      let minVal = Infinity;
      let bottomRows = [];

      for (const row of rawRows) {
        const num = parseNum(row[targetCol]);
        if (num !== null) {
          if (num < minVal) {
            minVal = num;
            bottomRows = [row];
          } else if (num === minVal) {
            bottomRows.push(row);
          }
        }
      }

      const bottomPerson = bottomRows[0];
      const nameCol = columns.find((c) => /^name$/i.test(c)) || columns.find((c) => /name/i.test(c)) || columns[0];
      const personName = bottomPerson ? bottomPerson[nameCol] : "Unknown";

      return {
        success: true,
        documentName: doc.originalName,
        operation: "lowest",
        column: targetCol,
        lowestValue: minVal,
        bottomRecords: bottomRows,
        summary: `The lowest ${targetCol} in ${doc.originalName} is ${minVal}, obtained by ${personName}. Full record: ${JSON.stringify(bottomPerson)}`
      };
    }
  }

  // Check for Average
  if (isAverage) {
    let targetCol = findMatchingColumn(["Average", "Total_Marks", "Marks", "Score"]) ||
                    columns.find((c) => parseNum(rawRows[0][c]) !== null);

    if (targetCol) {
      let sum = 0;
      let count = 0;

      for (const row of rawRows) {
        const num = parseNum(row[targetCol]);
        if (num !== null) {
          sum += num;
          count++;
        }
      }

      const avg = count > 0 ? (sum / count).toFixed(2) : 0;
      return {
        success: true,
        documentName: doc.originalName,
        operation: "average",
        column: targetCol,
        averageValue: parseFloat(avg),
        totalRecords: count,
        summary: `The average ${targetCol} in ${doc.originalName} across ${count} records is ${avg}.`
      };
    }
  }

  // Default: Return complete dataset summary and matching rows
  return {
    success: true,
    documentName: doc.originalName,
    operation: "preview",
    totalRows: rawRows.length,
    columns: columns,
    sampleRows: rawRows.slice(0, 10),
    summary: `Dataset ${doc.originalName} contains ${rawRows.length} rows with columns: ${columns.join(", ")}.`
  };
}
