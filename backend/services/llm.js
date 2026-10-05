
import axios from "axios";
import { ENV } from "../config/env.js";
import { RAG_CONFIG } from "../config/rag.js";
import { extractQueryTerms } from "./textRetrieval.js";

export const FALLBACK_MESSAGE =
  "I couldn't find this information in the uploaded documents.";

/**
 * Checks whether an answer string is the fallback or an admission of missing evidence.
 */
export function isFallbackAnswer(answer) {
  if (!answer || !answer.trim()) return true;

  const trimmed = answer.trim();

  if (trimmed === FALLBACK_MESSAGE) return true;

  if (
    /^I couldn'?t find this (information )?in the uploaded documents\.?/i.test(
      trimmed
    ) &&
    trimmed.length < 120
  ) {
    return true;
  }

  if (
    /^I couldn'?t find (this|enough information) in the uploaded documents\.?/i.test(
      trimmed
    ) &&
    trimmed.length < 120
  ) {
    return true;
  }

  if (
    /^I don'?t have enough information/i.test(trimmed) &&
    trimmed.length < 120
  ) {
    return true;
  }

  if (
    /^(?:The requested information |This )?(?:cannot be determined|is not (?:specified|found|available)) (?:from|in) the (?:provided|retrieved|uploaded)/i.test(
      trimmed
    ) &&
    trimmed.length < 150
  ) {
    return true;
  }

  return false;
}

/**
 * Generic recognition and parsing of English number words.
 * Prevents spelled-out numbers (e.g. "Ninety-six") from being treated as named entities.
 */
const NUMBER_WORDS = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty",
  "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "million", "billion"
]);

export function isNumberWordToken(token = "") {
  if (!token) return false;
  const parts = token.toLowerCase().split(/[-_\s]+/);
  return parts.length > 0 && parts.every((p) => NUMBER_WORDS.has(p));
}

export function parseWordNumber(token = "") {
  if (!token) return null;
  const parts = token.toLowerCase().split(/[-_\s]+/);
  if (parts.length === 0 || !parts.every((p) => NUMBER_WORDS.has(p))) return null;

  const small = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19
  };
  const tens = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
  };

  let total = 0;
  let current = 0;

  for (const p of parts) {
    if (small[p] !== undefined) {
      current += small[p];
    } else if (tens[p] !== undefined) {
      current += tens[p];
    } else if (p === "hundred") {
      current = (current || 1) * 100;
    } else if (p === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
    } else if (p === "million") {
      total += (current || 1) * 1000000;
      current = 0;
    } else if (p === "billion") {
      total += (current || 1) * 1000000000;
      current = 0;
    }
  }

  return total + current;
}

/**
 * Strips context prompt metadata headers ([Source X], Page Y, guideline labels)
 * so that source indices, timestamps, and page numbers do not leak as factual numeric evidence.
 */
export function stripContextMetadata(contextPrompt = "") {
  if (!contextPrompt) return "";
  return contextPrompt
    .replace(/^\[(?:Source|Visual Evidence)\s+\d+\]\s+Document:[^\n]*/gim, "")
    .replace(/^===[^=\n]+===/gm, "")
    .replace(/^CRITICAL DIRECTIVE:[\s\S]*?(?=\n\n|$)/gm, "")
    .replace(/^=== STRICT VISUAL QA GUIDELINES ===[\s\S]*?(?=\n\n|$)/gm, "")
    .replace(/^=== MULTI-TOPIC QUERY GUIDELINES ===[\s\S]*?(?=\n\n|$)/gm, "");
}

/**
 * Extracts document/collection scope tokens dynamically from the context text.
 */
export function extractScopeTokensFromContext(contextPrompt = "") {
  const scopeTokens = new Set([
    "document",
    "page",
    "source",
    "section",
  ]);

  const docMatches =
    contextPrompt.match(/Document:\s*([A-Za-z0-9_\-\.]+)/gi) || [];

  for (const m of docMatches) {
    const rawName = m
      .replace(/Document:\s*/i, "")
      .replace(/\.[a-z0-9]+$/i, "");

    const parts = rawName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, " ")
      .split(/\s+/)
      .filter((p) => p.length >= 2);

    for (const p of parts) {
      scopeTokens.add(p);
    }
  }

  return scopeTokens;
}

/**
 * Checks whether a word or its root stem appears in the context text.
 */
function isStemInContext(word, contextLower) {
  if (!word || !contextLower) return false;

  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (new RegExp(`\\b${escaped}\\b`, "i").test(contextLower)) {
    return true;
  }

  const suffixes = [
    "ed",
    "ing",
    "s",
    "es",
    "ly",
    "tion",
    "tions",
    "ive",
    "able",
    "ment",
  ];

  for (const suf of suffixes) {
    if (word.endsWith(suf) && word.length - suf.length >= 3) {
      const stem = word.slice(0, -suf.length);
      const escStem = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      if (new RegExp(`\\b${escStem}`, "i").test(contextLower)) {
        return true;
      }
    }
  }

  if (word.length >= 3) {
    if (
      new RegExp(
        `\\b${escaped}(?:s|es|ed|ing|ion|ions|ment)?\\b`,
        "i"
      ).test(contextLower)
    ) {
      return true;
    }
  }

  if (word.endsWith("ed") && word.length >= 5) {
    const root = word.slice(0, -2);
    const escRoot = root
      .slice(0, -1)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    if (
      root.length >= 4 &&
      new RegExp(`\\b${escRoot}`, "i").test(contextLower)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts strict named tokens:
 * - acronyms
 * - identifiers
 * - dotted abbreviations
 * - CamelCase
 * - mixed alpha-numeric identifiers
 */
export function extractStrictNamedTokens(text = "") {
  if (!text) return [];

  const out = new Set();

  const code =
    text.match(
      /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(\s*\)/g
    ) || [];

  code.forEach((c) => out.add(c.replace(/\s+/g, "")));

  const dotted =
    text.match(
      /\b(?:[A-Z]\.\s?|[A-Z][A-Za-z]{1,3}\.)[A-Za-z]{1,6}(?:\.[A-Za-z]{1,6})*\b\.?/g
    ) || [];

  dotted.forEach((d) =>
    out.add(d.replace(/\s/g, "").replace(/\.$/, ""))
  );

  const caps = text.match(/\b[A-Z][A-Z0-9]{1,}\b/g) || [];
  caps.forEach((c) => out.add(c));

  const camel =
    text.match(
      /\b[a-z]*[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g
    ) || [];

  camel.forEach((c) => out.add(c));

  const hyphenated =
    text.match(
      /\b[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g
    ) || [];
  hyphenated.forEach((h) => {
    // Exclude spelled-out number words (e.g. Ninety-six, Twenty-four)
    if (!isNumberWordToken(h)) {
      out.add(h);
    }
  });

  const alnum =
    text.match(
      /\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{2,}\b/g
    ) || [];

  alnum.forEach((a) => {
    if (!/^\d+(?:st|nd|rd|th|[a-z]{1,3})$/i.test(a)) {
      out.add(a);
    }
  });

  return [...out];
}

/**
 * Generic extraction of requested subject.
 */
export function extractGenericTarget(
  question = "",
  scopeTokens = new Set()
) {
  if (!question || typeof question !== "string") {
    return {
      entity: null,
      entities: [],
      rawEntity: null,
    };
  }

  const entities = extractStrictNamedTokens(question.trim());

  const distinguishing = entities.filter(
    (e) =>
      !scopeTokens.has(
        e.toLowerCase().replace(/[^a-z0-9]/g, "")
      )
  );

  const primary = distinguishing[0] || null;

  return {
    entity: primary,
    entities,
    rawEntity: primary,
  };
}

/**
 * Parses questions like:
 *
 * What is the tuition fee of B.E?
 * What is the duration of B.Tech?
 * Which is the intake capacity for MBA?
 */
function parseAttributeQuestion(question = "") {
  const q = question.trim().replace(/\?+$/, "");

  const m = q.match(
    /^(?:what|which)\s+(?:is|are|was|were)\s+(?:the\s+|a\s+|an\s+)?(.+?)\s+(?:of|for|at|in|on)\s+(?:the\s+|a\s+|an\s+)?(.+)$/i
  );

  if (!m) return null;

  const attrWords = extractQueryTerms(m[1]);

  if (attrWords.length === 0) return null;

  return {
    head: attrWords[attrWords.length - 1],
    modifiers: attrWords.slice(0, -1),
    subject: m[2],
  };
}

function answerTypeWords(question = "") {
  const words = new Set();

  const re =
    /\bhow\s+(?:many|much|long|often|far|old)\s+([a-z]+)/gi;

  let m;

  while ((m = re.exec(question)) !== null) {
    words.add(m[1].toLowerCase());
  }

  return words;
}

/**
 * Checks whether an acronym can be formed from initials.
 */
function acronymExpandsInText(acr, text) {
  const letters = acr
    .toLowerCase()
    .replace(/[^a-z]/g, "");

  if (letters.length < 2 || letters.length > 8) {
    return false;
  }

  const words = text
    .split(/[^A-Za-z0-9]+/)
    .filter(
      (w) =>
        w &&
        !/^(?:of|and|the|for|in|on|to|&)$/.test(w)
    );

  for (
    let i = 0;
    i + letters.length <= words.length;
    i++
  ) {
    let ok = true;

    for (let j = 0; j < letters.length; j++) {
      const w = words[i + j];

      if (
        !/^[A-Z]/.test(w) ||
        w[0].toLowerCase() !== letters[j]
      ) {
        ok = false;
        break;
      }
    }

    if (ok) return true;
  }

  return false;
}

/**
 * Checks whether an entity is present in context.
 */
export function isEntityInContext(
  entity,
  contextPrompt = ""
) {
  if (!entity || !contextPrompt) return false;

  const ctx = contextPrompt.toLowerCase();

  const cleanEntity = entity
    .replace(/\s*\(\s*\)$/, "")
    .trim()
    .toLowerCase();

  if (cleanEntity.length < 2) return false;

  const esc = (s) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Whole-token match.
  if (
    new RegExp(
      `(?:^|[^a-z0-9])${esc(cleanEntity)}(?![a-z0-9])`,
      "i"
    ).test(ctx)
  ) {
    return true;
  }

  // Number words match if their numeric value exists in context
  if (isNumberWordToken(cleanEntity)) {
    const numVal = parseWordNumber(cleanEntity);
    if (numVal !== null) {
      return numberInText(numVal, contextPrompt) || numberInText(String(numVal), contextPrompt);
    }
  }

  const isIdentifier =
    /[.\d_\-]/.test(cleanEntity) ||
    /^[A-Z0-9]{2,}$/.test(entity.trim()) ||
    /[a-z][A-Z]/.test(entity);

  const parts = cleanEntity
    .split(/[.\s/_-]+/)
    .filter(Boolean);

  // Punctuation/spacing tolerant.
  if (parts.length > 1) {
    const flexible = parts
      .map(esc)
      .join("[.\\s/_-]*");

    if (
      new RegExp(
        `(?:^|[^a-z0-9])${flexible}(?![a-z0-9])`,
        "i"
      ).test(ctx)
    ) {
      return true;
    }
  }

  if (isIdentifier) {
    if (
      /^[A-Z]{2,}$/.test(entity.trim()) &&
      acronymExpandsInText(entity.trim(), contextPrompt)
    ) {
      return true;
    }

    return false;
  }

  const words = parts.filter((p) => p.length >= 3);

  return (
    words.length > 0 &&
    words.every((w) => isStemInContext(w, ctx))
  );
}

/**
 * Evidence Sufficiency Check.
 */
export function checkEvidenceSupportGate(
  question = "",
  contextPrompt = "",
  queryType = "document_qa",
  evidenceMeta = {}
) {
  if (queryType === "out_of_scope") {
    return {
      supported: false,
      reason: "out_of_scope",
    };
  }

  if (
    !contextPrompt ||
    contextPrompt === "NO_DOCUMENTS_FOUND" ||
    contextPrompt.trim().length === 0
  ) {
    return {
      supported: false,
      reason: "insufficient_evidence",
    };
  }

  // Trusted tabular result.
  if (/TABULAR TOOL RESULT/i.test(contextPrompt)) {
    return {
      supported: true,
      reason: "tabular_tool_result_present",
    };
  }

  const topSim =
    typeof evidenceMeta.topSimilarity === "number"
      ? evidenceMeta.topSimilarity
      : 0;

  const STRONG_SEMANTIC = 0.65;

  // Explicit page constraint.
  const pageMatch = question
    ? question.match(/\b(?:page|p\.?)\s*(\d+)\b/i)
    : null;

  if (pageMatch) {
    const targetPage = parseInt(pageMatch[1], 10);

    if (
      !new RegExp(
        `\\bPage\\s*${targetPage}\\b`,
        "i"
      ).test(contextPrompt)
    ) {
      console.log(
        `[Evidence Gate] Target Page ${targetPage} not retrieved -> missing_entity`
      );

      return {
        supported: false,
        reason: "missing_entity",
        entity: `page ${targetPage}`,
      };
    }
  }

  const contextLower = contextPrompt.toLowerCase();

  const scopeTokens =
    extractScopeTokensFromContext(contextPrompt);

  // Strict entities.
  const { entities } = extractGenericTarget(
    question,
    scopeTokens
  );

  for (const ent of entities) {
    if (!isEntityInContext(ent, contextPrompt)) {
      console.log(
        `[Evidence Gate] Named token "${ent}" absent from evidence -> missing_entity`
      );

      return {
        supported: false,
        reason: "missing_entity",
        entity: ent,
      };
    }
  }

  // Attribute modifiers.
  const parsed = parseAttributeQuestion(question);

  if (parsed) {
    const missingMods = parsed.modifiers.filter(
      (w) =>
        !scopeTokens.has(w) &&
        !isStemInContext(w, contextLower)
    );

    const STRONG_ATTRIBUTE_EVIDENCE = 0.65;

    if (
      missingMods.length > 0 &&
      topSim < STRONG_ATTRIBUTE_EVIDENCE
    ) {
      console.log(
        `[Evidence Gate] Attribute modifier(s) [${missingMods.join(
          ", "
        )}] unsupported -> missing_attribute`
      );

      return {
        supported: false,
        reason: "missing_attribute",
        missingTerms: missingMods,
      };
    }

    if (
      missingMods.length > 0 &&
      topSim >= STRONG_ATTRIBUTE_EVIDENCE
    ) {
      console.log(
        `[Evidence Gate] Ignoring attribute modifier warning because retrieval evidence is strong. topSimilarity=${topSim.toFixed(
          3
        )}`
      );
    }
  }

  // Overall lexical/semantic relevance.
  const exempt = answerTypeWords(question);

  if (parsed) {
    exempt.add(parsed.head);
  }

  const terms = extractQueryTerms(question).filter(
    (t) => !exempt.has(t)
  );

  if (terms.length > 0) {
    const matched = terms.filter((t) =>
      isStemInContext(t, contextLower)
    );

    const coverage = matched.length / terms.length;

    if (
      matched.length === 0 &&
      topSim < STRONG_SEMANTIC
    ) {
      console.log(
        `[Evidence Gate] No lexical overlap and weak semantic similarity (${topSim.toFixed(
          3
        )}) -> insufficient_evidence`
      );

      return {
        supported: false,
        reason: "insufficient_evidence",
      };
    }

    if (
      terms.length >= 3 &&
      coverage < 0.25 &&
      topSim < STRONG_SEMANTIC
    ) {
      console.log(
        `[Evidence Gate] Coverage ${(
          coverage * 100
        ).toFixed(
          0
        )}% and similarity ${topSim.toFixed(
          3
        )} too low -> insufficient_evidence`
      );

      return {
        supported: false,
        reason: "insufficient_evidence",
      };
    }
  }

  return {
    supported: true,
    reason: "evidence_present",
  };
}

/**
 * Strict document-grounded system prompt.
 */
function buildSystemPrompt(contextPrompt) {
  return `You are a document-grounded assistant.

Use only information supported by the provided evidence in CONTEXT.
Do not use outside knowledge.
Do not guess or infer missing facts.

If the evidence does not contain enough information to answer the question, reply exactly:
'I couldn't find this information in the uploaded documents.'

Never invent or assume:
- numbers
- names
- dates
- percentages
- currency or fee amounts
- examples
- code
- statistics
- technical specifications
- conclusions

If the context contains the answer, answer clearly and naturally based only on the evidence.

If the context contains only part of the answer, or if the question contains multiple parts/topics, answer each supported part and clearly state what specific information is not found in the documents.

Match the response length to the question:
- simple factual question: 1–2 sentences
- explain/how/why/difference/compare/steps/multi-topic: structured detailed answer

Preserve numbers, names, dates and technical values exactly as provided in the context.

NO ATTRIBUTE TRANSFER RULE:
You must never transfer attributes, fees, numbers, marks, dates, or specifications from one entity to another.

For example:
- Never use a fee from one program for a different program.
- Never use a duration from one course for a different course.
- Never use a metric from one model/component for another model.
- If the requested entity or specific attribute is not supported by the context, use the fallback response.

NUMERIC / CURRENCY GROUNDING RULE:
- Never invent a number.
- Never convert an unrelated percentage/count into a currency value.
- Every currency value must exist in the evidence.
- Use the currency value that is explicitly associated with the requested entity/attribute in the evidence.
- If several different values exist for different entities, do not transfer one entity's value to another.

TABULAR CALCULATION DIRECTIVE:
When an AUTHORITATIVE TABULAR TOOL RESULT is provided in CONTEXT:
- The tool's computed value is the verified mathematical calculation over all matching rows.
- Report the exact computed value.
- Never replace a computed aggregate with a value from an individual row.

For visual description questions, list each distinct visual element or UI component at most once without repeating duplicate elements.

VISUAL EVIDENCE RULE:
Image-derived context items are visual evidence and the image is displayed to the user automatically; if the user asks to see/show/display an image or page, briefly describe what the visual evidence shows and state its page, instead of refusing. If no visual evidence is in the context, use the normal fallback.

If retrieved sources contain conflicting or different values, explicitly report the conflict, state which page/source contains each value, and do not silently choose one.

Use only the document relevant to the user's question.

Chat history may help understand the user's question, but chat history is NEVER a source of factual information.

Do not use previous assistant answers as evidence.

For examples and code, use only examples/code explicitly present in the retrieved context.

Do not create new examples from general knowledge.

At the end, provide the supporting source file name and page number(s) when available.

CONTEXT:
${contextPrompt}
`;
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Boundary-aware number presence with Indian and Western grouping normalization.
 */
function numberInText(num, text) {
  if (num === null || num === undefined || !text) return false;
  const raw = String(num).replace(/,/g, "");
  const forms = new Set([String(num), raw]);

  // Check original text
  if ([...forms].some((f) => new RegExp(`(?<![\\d.,])${escRe(f)}(?![\\d]|[.,]\\d)`).test(text))) {
    return true;
  }

  // Check comma-normalized text (commas between digits removed)
  const normalizedText = text.replace(/(?<=\d),(?=\d)/g, "");
  return new RegExp(`(?<![\\d.])${escRe(raw)}(?![\\d.])`).test(normalizedText);
}

/**
 * Value computed by trusted tool.
 */
function getToolComputedValue(contextPrompt = "") {
  const m = contextPrompt.match(
    /^Computed Value: (.+)$/m
  );

  return m ? m[1].trim() : null;
}

function getToolSummary(contextPrompt = "") {
  const doc = contextPrompt.match(
    /===\s*(?:AUTHORITATIVE\s+)?TABULAR TOOL RESULT\s*===\s*\nDocument:\s*([^\n]+)/i
  );

  const sum = contextPrompt.match(
    /Calculation Result:\s*\n([\s\S]*?)(?:\n\n|\nCRITICAL|\n\(This value|$)/i
  );

  if (!sum) return null;

  return doc
    ? `According to ${doc[1].trim()}: ${sum[1].trim()}`
    : sum[1].trim();
}

/**
 * Checks tool calculation preservation.
 */
function checkToolValuePreserved(
  answer,
  computedValue
) {
  const expected =
    computedValue
      .match(/-?\d+(?:\.\d+)?/g)
      ?.map(Number) || [];

  if (expected.length === 0) return true;

  const got =
    answer
      .replace(/,(?=\d{3})/g, "")
      .match(/-?\d+(?:\.\d+)?/g)
      ?.map(Number) || [];

  return expected.every((e) =>
    got.some(
      (g) =>
        Math.abs(g - e) < 1e-9 ||
        (!Number.isInteger(e) &&
          Math.abs(g - e) <= 0.05)
    )
  );
}

/**
 * Generic named-entity grounding.
 *
 * IMPORTANT:
 * Do not scan every capitalized English word.
 * That caused false positives such as:
 * The, College, Students, Principal, etc.
 */
function findUnsupportedEntities(
  answer,
  contextPrompt,
  question
) {
  let text = answer
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(
      /\b[\w.-]+\.(?:pdf|csv|xlsx?|docx?|txt|pptx?|png|jpe?g)\b/gi,
      " "
    );

  const evidence = `${contextPrompt}\n${question}`;

  const unsupported = new Set();

  for (const tok of extractStrictNamedTokens(text)) {
    if (!tok || /^\d/.test(tok)) {
      continue;
    }

    if (isNumberWordToken(tok)) {
      continue;
    }

    // Anything explicitly present in the question is allowed.
    if (isEntityInContext(tok, question)) {
      continue;
    }

    if (!isEntityInContext(tok, evidence)) {
      unsupported.add(tok);
    }
  }

  return [...unsupported];
}

/**
 * Normalize evidence for association checks.
 *
 * Keeps line boundaries because they are useful for tables and
 * structured document extraction.
 */
function normalizeEvidenceText(text = "") {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    // Closing punctuation, bracket, colon, percent, or letter directly followed by a digit
    .replace(/([a-zA-Z)\]}>:%])([0-9])/g, "$1 $2")
    // Digit or percent directly followed by letter, opening punctuation, or bracket
    .replace(/([0-9%])([a-zA-Z({\[<])/g, "$1 $2")
    // Colon directly followed by letter or number (e.g. "Grade:A" -> "Grade: A")
    .replace(/(:)([a-zA-Z0-9])/g, "$1 $2")
    // Abbreviation period followed by digit (e.g. "M.E.60,000" -> "M.E. 60,000")
    .replace(/(\b[A-Za-z]\.)([0-9])/g, "$1 $2")
    // Formatted thousands group followed by next digit in squished table rows (e.g. "50,00065,000" -> "50,000 65,000")
    .replace(/(,\d{3})(?=\d)/g, "$1 ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function parseNumericValue(str) {
  if (typeof str === "number") return str;
  if (!str) return null;
  const cleaned = String(str).replace(/[,\s]/g, "");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

/**
 * Extracts currency values with their exact positions and normalized numeric values.
 * Handles Indian grouping (1,00,000), Western grouping (100,000), symbols (Rs., ₹, INR, $, USD, EUR),
 * suffixes ("1,00,000 per year", "50,000/-"), and numbers on monetary lines.
 */
function extractCurrencyOccurrences(text = "") {
  if (!text) return [];
  const normalized = normalizeEvidenceText(text);
  const results = [];
  const seen = new Set();

  // Pattern A: Prefix symbol + number (word boundary before alphabetic codes; symbol-safe for non-word)
const prefixRegex =
  /(?:\b(?:Rs\.?|INR|USD|EUR)\s*|[₹$]\s*)([0-9][0-9,]*(?:\.\d+)?)/gi;  let m;
  while ((m = prefixRegex.exec(normalized)) !== null) {
    const rawVal = m[1].replace(/,$/, "");
    const numericValue = parseNumericValue(rawVal);
    if (numericValue !== null) {
      const key = `${m.index}:${rawVal}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          text: m[0],
          rawNumber: rawVal,
          numericValue,
          index: m.index,
          length: m[0].length
        });
      }
    }
  }

  // Pattern B: Number + suffix or context (with word boundaries)
  const suffixRegex = /\b([0-9][0-9,]*(?:\.\d+)?)\s*(?:(?:\/-)|(?:\b(?:Rs\.?|INR|USD|EUR)\b|[₹$])|(?:per\s+(?:year|annum|semester|sem|month|day|hr|hour))|(?:\b(?:lpa|lakhs?)\b))/gi;
  while ((m = suffixRegex.exec(normalized)) !== null) {
    const rawVal = m[1].replace(/,$/, "");
    const numericValue = parseNumericValue(rawVal);
    if (numericValue !== null) {
      const key = `${m.index}:${rawVal}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          text: m[0],
          rawNumber: rawVal,
          numericValue,
          index: m.index,
          length: m[0].length
        });
      }
    }
  }

  // Pattern C: Numbers appearing on a line with monetary indicators
  const lines = normalized.split("\n");
  let lineOffset = 0;
  for (const line of lines) {
    const isMonetaryLine = /(?:\b(?:rs\.?|inr|usd|eur|fee|fees|tuition|cost|costs|price|salary|stipend|package|lpa|lakhs?)\b|[₹$]|\bper\s+(?:year|annum|month|semester)\b)/i.test(line);
    if (isMonetaryLine) {
      const lineNums = /\b([0-9][0-9,]*(?:\.\d+)?)\b/g;
      let lm;
      while ((lm = lineNums.exec(line)) !== null) {
        const rawVal = lm[1];
        const numVal = parseNumericValue(rawVal);
        if (numVal !== null && numVal >= 100) {
          const idx = lineOffset + lm.index;
          const key = `${idx}:${rawVal}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({
              text: lm[0],
              rawNumber: rawVal,
              numericValue: numVal,
              index: idx,
              length: lm[0].length
            });
          }
        }
      }
    }
    lineOffset += line.length + 1;
  }

  return results;
}

/**
 * Checks whether an occurrence of a monetary value in the evidence
 * is legitimately associated with the requested entity.
 */
function isCurrencyAssociatedWithEntity(occ, entity, normalizedContext) {
  if (!entity || !normalizedContext) return false;

  // 1. Same line check (highest precision for tables and lists)
  let lineStart = normalizedContext.lastIndexOf("\n", occ.index - 1) + 1;
  let lineEnd = normalizedContext.indexOf("\n", occ.index);
  if (lineEnd === -1) lineEnd = normalizedContext.length;
  const lineText = normalizedContext.slice(lineStart, lineEnd);

  if (isEntityInContext(entity, lineText)) {
    return true;
  }

  // If this line explicitly names another distinct capitalized entity,
  // this value belongs to that other entity, NOT the requested entity.
  const otherCaps = lineText.match(/\b[A-Z][A-Za-z0-9._-]{1,}\b/g) || [];
  const hasOtherEntity = otherCaps.some(
    (c) => !isEntityInContext(entity, c) && !/^(?:rs|inr|usd|eur|tuition|fee|fees|hostel|total|per|year|page|source|document)$/i.test(c)
  );
  if (hasOtherEntity) {
    return false;
  }

  // 2. Structural proximity check (within 250 characters when no competing entity intervenes)
  const wStart = Math.max(0, occ.index - 250);
  const wEnd = Math.min(normalizedContext.length, occ.index + occ.length + 250);
  const windowText = normalizedContext.slice(wStart, wEnd);

  if (isEntityInContext(entity, windowText)) {
    return true;
  }

  return false;
}

/**
 * Post-generation factual grounding.
 */
export function verifyAnswerGrounding(
  answer,
  contextPrompt = "",
  question = ""
) {
  if (isFallbackAnswer(answer)) {
    return {
      valid: true,
      reason: null,
      unsupported: [],
    };
  }

  // ---------------------------------------------------------
  // 0. Trusted calculation result
  // ---------------------------------------------------------
  const toolValue = getToolComputedValue(contextPrompt);
  if (toolValue && !checkToolValuePreserved(answer, toolValue)) {
    return {
      valid: false,
      reason: "tool_value_mismatch",
      unsupported: [`Expected tool value: ${toolValue}`],
    };
  }

  // Strip metadata headers (Source X, Page Y, Document: ...) so they don't leak into evidence
  const cleanContext = stripContextMetadata(contextPrompt);
  const normalizedContext = normalizeEvidenceText(cleanContext);
  const contextLower = normalizedContext.toLowerCase();
  const questionLower = (question || "").toLowerCase();
  const combinedEvidence = `${contextLower} ${questionLower}`;
  const unsupported = [];

  // Extract distinguishing entity from question if any
  const scopeTokens = extractScopeTokensFromContext(contextPrompt);
  const { entity } = extractGenericTarget(question, scopeTokens);

  // ---------------------------------------------------------
  // 1. Currency grounding
  // ---------------------------------------------------------
  const answerCurrencies = extractCurrencyOccurrences(answer);
  if (answerCurrencies.length > 0) {
    const evidenceCurrencies = extractCurrencyOccurrences(cleanContext);
    const qCurrencies = extractCurrencyOccurrences(question);
    const allEvidence = [...evidenceCurrencies, ...qCurrencies];

    for (const curr of answerCurrencies) {
      let matchingOccurrences = allEvidence.filter(
        (e) => Math.abs(e.numericValue - curr.numericValue) < 1e-5
      );

      // If not identified as currency directly in evidence/question, check if the numeric value
      // appears in normalized context under an established monetary context (e.g. table headers or question context)
      if (matchingOccurrences.length === 0) {
        const hasMonetaryContext =
          /(?:\b(?:rs\.?|inr|usd|eur|fee|fees|tuition|cost|costs|price|salary|stipend|package|budget|expense|charge|rate|amount|lpa|lakh|crore)\b|[₹$])/i.test(cleanContext) ||
          /(?:fee|cost|price|salary|tuition|rate|charge|how much|inr|rs|\$)/i.test(question);

        if (hasMonetaryContext) {
          const numRegex = new RegExp(`(?<![\\d.,])${escRe(curr.rawNumber)}(?![\\d]|[.,]\\d)`, "g");
          let nm;
          while ((nm = numRegex.exec(normalizedContext)) !== null) {
            matchingOccurrences.push({
              text: nm[0],
              rawNumber: curr.rawNumber,
              numericValue: curr.numericValue,
              index: nm.index,
              length: nm[0].length,
            });
          }
          if (matchingOccurrences.length === 0) {
            const rawNumberStr = String(curr.numericValue);
            const rawRegex = new RegExp(`(?<![\\d.])${escRe(rawNumberStr)}(?![\\d.])`, "g");
            let rm;
            while ((rm = rawRegex.exec(normalizedContext)) !== null) {
              matchingOccurrences.push({
                text: rm[0],
                rawNumber: rawNumberStr,
                numericValue: curr.numericValue,
                index: rm.index,
                length: rm[0].length,
              });
            }
          }
        }
      }

      let association = false;
      if (matchingOccurrences.length > 0) {
        if (!entity) {
          association = true;
        } else {
          association = matchingOccurrences.some((occ) =>
            isCurrencyAssociatedWithEntity(occ, entity, normalizedContext)
          );
        }
      }

      console.log(`[Currency Debug]`);
      console.log(`  Answer value: ${curr.text}`);
      console.log(`  Normalized answer value: ${curr.numericValue}`);
      console.log(`  Evidence values found: [${allEvidence.map((e) => e.numericValue).join(", ")}]`);
      console.log(`  Matched evidence occurrences: ${matchingOccurrences.length}`);
      console.log(`  Entity association: ${association ? "PASS" : "FAIL"}`);

      if (matchingOccurrences.length === 0) {
        unsupported.push(`Currency: ${curr.text}`);
        continue;
      }

      if (!association && entity) {
        return {
          valid: false,
          reason: "unsupported_value",
          unsupported: [`Transferred value: ${curr.text} for ${entity}`],
        };
      }
    }
  }

  if (unsupported.length > 0) {
    return {
      valid: false,
      reason: "unsupported_value",
      unsupported,
    };
  }

  // ---------------------------------------------------------
  // 2. Percentages and multi-digit numbers
  // ---------------------------------------------------------
  const percentages = answer.match(/\b\d+(?:,\d+)*(?:\.\d+)?\s*%/g) || [];
  for (const pct of percentages) {
    const cleanPct = pct.replace(/\s+/g, "").toLowerCase();
    const rawNum = cleanPct.replace(/%/g, "");
    const v = parseFloat(rawNum);
    const ok =
      combinedEvidence.includes(cleanPct) ||
      (rawNum && numberInText(rawNum, combinedEvidence)) ||
      (!isNaN(v) && (numberInText((v / 100).toFixed(2), combinedEvidence) || numberInText(String(v / 100), combinedEvidence)));

    if (!ok) {
      unsupported.push(`Percentage: ${pct.trim()}`);
    }
  }

  const proseOnly = answer
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ");

  // Remove currency expressions so their digits aren't treated as bare numbers
  const proseWithoutCurrency = proseOnly
    .replace(/(?:Rs\.?|INR|₹|\$|USD|EUR)\s*[0-9][0-9,]*(?:\.\d+)?/gi, " ")
    .replace(/\b[0-9][0-9,]*(?:\.\d+)?\s*(?:(?:\/-)|(?:Rs\.?|INR|₹|\$|USD|EUR)|(?:per\s+(?:year|annum|semester|sem|month|day|hr|hour))|(?:lpa|lakhs?))\b/gi, " ");

  // Remove percentage expressions so their digits are not checked as bare numbers
  const proseWithoutPercentages = proseWithoutCurrency
    .replace(/\b\d+(?:,\d+)*(?:\.\d+)?\s*%/g, " ");

  // Remove source citation lines and page indicators (e.g. "Supporting source ... | Page 17", "Page 17", "p. 17")
  const proseWithoutCitations = proseWithoutPercentages
    .replace(/Supporting\s+source[\s\S]*$/i, " ")
    .replace(/\b(?:page|pages|p\.)\s*\d+\b/gi, " ");

  const withoutListNums = proseWithoutCitations.replace(/^\s*\d+[.)]\s+/gm, " ");
  // Match bare numbers with optional Indian or Western grouping commas
  const numbers =
  withoutListNums.match(
    /\b\d+(?:,\d+)*(?:\.\d+)?\b/g
  ) || [];

  // Numbers present in the user question are premise numbers and allowed in answer
  const questionNumbers = new Set((question.match(/\b\d+(?:,\d+)*(?:\.\d+)?\b/g) || []).map((n) => n.replace(/,/g, "")));

  // Also extract spelled-out hyphenated number words (e.g. "Ninety-six" -> 96) and check their numeric value
  const hyphenatedWords = proseOnly.match(/\b[A-Za-z]+(?:-[A-Za-z]+)+\b/g) || [];
  for (const hw of hyphenatedWords) {
    if (isNumberWordToken(hw)) {
      const numVal = parseWordNumber(hw);
      if (numVal !== null && numVal >= 10) {
        numbers.push(String(numVal));
      }
    }
  }

  const evidenceNormalized = combinedEvidence.replace(/(?<=\d),(?=\d)/g, "");

  for (const num of numbers) {
    const rawVal = num.replace(/,/g, "");
    if (rawVal.length < 2) continue; // Single digits 0-9 are allowed
    if (questionNumbers.has(rawVal)) continue; // Allow numbers from question premise

    // Skip numbers already validated as currencies
    if (answerCurrencies.some((c) => Math.abs(c.numericValue - parseFloat(rawVal)) < 1e-5)) {
      continue;
    }

    const inEvidence =
      numberInText(num, combinedEvidence) ||
      numberInText(rawVal, evidenceNormalized);

    if (!inEvidence) {
      unsupported.push(`Number: ${num}`);
    }
  }

  if (unsupported.length > 0) {
    return {
      valid: false,
      reason: "unsupported_value",
      unsupported,
    };
  }

  // ---------------------------------------------------------
  // 3. Named entity grounding
  // ---------------------------------------------------------
  const badEntities = findUnsupportedEntities(
    answer,
    cleanContext,
    question
  );

  if (badEntities.length > 0) {
    return {
      valid: false,
      reason: "unsupported_entity",
      unsupported: badEntities.map((e) => `Entity: ${e}`),
    };
  }

  return {
    valid: true,
    reason: null,
    unsupported: [],
  };
}

/**
 * Backward compatibility alias.
 */
export function checkFactualTokens(
  answer,
  contextPrompt,
  question = ""
) {
  const result =
    verifyAnswerGrounding(
      answer,
      contextPrompt,
      question
    );

  return {
    valid: result.valid,
    unsupported: result.unsupported,
  };
}

/**
 * Applies post-generation grounding.
 */
export function finalizeGeneratedAnswer(
  rawAnswer,
  contextPrompt,
  question,
  queryType = "document_qa"
) {
  const answer = (rawAnswer || "").trim();

  if (isFallbackAnswer(answer)) {
    return {
      answer: FALLBACK_MESSAGE,
      reason: "insufficient_evidence",
      replaced:
        answer !== FALLBACK_MESSAGE,
    };
  }

  const verification =
    verifyAnswerGrounding(
      answer,
      contextPrompt,
      question
    );

  if (!verification.valid) {
    console.warn(
      `[Grounding] Answer rejected (${verification.reason}): [${verification.unsupported.join(
        ", "
      )}]`
    );

    if (
      verification.reason ===
      "tool_value_mismatch"
    ) {
      const toolText =
        getToolSummary(contextPrompt);

      if (toolText) {
        return {
          answer: toolText,
          reason: null,
          replaced: true,
        };
      }
    }

    return {
      answer: FALLBACK_MESSAGE,
      reason: verification.reason,
      replaced: true,
    };
  }

  return {
    answer:
      queryType === "visual_qa"
        ? deduplicateVisualElements(answer)
        : answer,
    reason: null,
    replaced: false,
  };
}

/**
 * Generates an answer using one LLM call.
 */
export async function generateAnswerDetailed(
  question,
  contextPrompt,
  conversationHistory = [],
  queryType = "document_qa",
  evidenceMeta = {}
) {
  const startTime = Date.now();

  // 1. Pre-generation evidence gate.
  const gate =
    checkEvidenceSupportGate(
      question,
      contextPrompt,
      queryType,
      evidenceMeta
    );

  if (!gate.supported) {
    console.log(
      `[Evidence Gate] Question "${question}" failed evidence gate (${gate.reason}). Returning fallback.`
    );

    return {
      answer: FALLBACK_MESSAGE,
      reason: gate.reason,
    };
  }

  // 2. Generate grounded answer.
  const systemPrompt =
    buildSystemPrompt(
      contextPrompt
    );

  const historyMessages =
    (conversationHistory || [])
      .slice(-RAG_CONFIG.historyWindow)
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));

  let userContent = question;


  if (
    contextPrompt.includes(
      "=== MULTI-TOPIC QUERY GUIDELINES ==="
    )
  ) {
    userContent +=
      "\n\n(Important: Address each topic separately. If information for any specific item is not present in the documents, explicitly state that it was not found in the uploaded documents.)";
  }

  const messages = [
    {
      role: "system",
      content: systemPrompt,
    },
    ...historyMessages,
    {
      role: "user",
      content: userContent,
    },
  ];

  try {
    const response = await axios.post(
      `${ENV.OLLAMA_BASE_URL}/api/chat`,
      {
        model: ENV.OLLAMA_LLM_MODEL,
        keep_alive: "30m",
        messages,
        stream: false,
        options: {
          temperature: 0.1,
          num_ctx: 3072,
          num_predict: 350,
        },
      },
      {
        timeout: 120000,
      }
    );

    const d = response.data || {};
    const promptEvalCount = d.prompt_eval_count || 0;
    const promptEvalMs = d.prompt_eval_duration ? (d.prompt_eval_duration / 1e6).toFixed(0) : "N/A";
    const evalCount = d.eval_count || 0;
    const evalMs = d.eval_duration ? (d.eval_duration / 1e6).toFixed(0) : "N/A";
    const totalMs = d.total_duration ? (d.total_duration / 1e6).toFixed(0) : (Date.now() - startTime);
    const speed = d.eval_duration && d.eval_count ? (d.eval_count / (d.eval_duration / 1e9)).toFixed(1) : "N/A";

    console.log(`[LLM Diagnostics] Model: ${ENV.OLLAMA_LLM_MODEL} | Device: CPU (size_vram: 0) | num_ctx: 3072 | num_predict: 350 | keep_alive: 30m`);
    console.log(`[LLM Diagnostics] Prompt Tokens: ${promptEvalCount} (${promptEvalMs}ms eval) | Generated Tokens: ${evalCount} (${evalMs}ms, ${speed} tok/s) | Total: ${totalMs}ms`);

    const raw =
      (
        response.data?.message?.content ||
        ""
      ).trim();

    console.log("\n========== LLM DEBUG ==========");
    console.log("QUESTION:", question);
    console.log("RAW LLM ANSWER:", raw);

console.log("CONTEXT HAS 100:", contextPrompt.includes("100"));
console.log(
  "CONTEXT AROUND 100:",
  contextPrompt.match(/.{0,100}100.{0,100}/gi)
);
    
    console.log("================================\n");

    console.log(
      `[LLM Generation] Answer generated in ${
        Date.now() - startTime
      }ms`
    );

    // 3. Post-generation grounding.
    const {
      answer,
      reason,
    } =
      finalizeGeneratedAnswer(
        raw,
        contextPrompt,
        question,
        queryType
      );

    return {
      answer,
      reason,
    };
  } catch (error) {
    console.error(
      `[LLM Error] Generation failed: ${error.message}`
    );

    throw new Error(
      `Ollama generation failed: ${error.message}`
    );
  }
}

/**
 * Backward-compatible wrapper.
 */
export async function generateAnswer(
  question,
  contextPrompt,
  conversationHistory = [],
  queryType = "document_qa",
  evidenceMeta = {}
) {
  const { answer } =
    await generateAnswerDetailed(
      question,
      contextPrompt,
      conversationHistory,
      queryType,
      evidenceMeta
    );

  return answer;
}

/**
 * Streams grounded answer from Ollama.
 */
export async function streamAnswer(
  question,
  contextPrompt,
  conversationHistory = [],
  onToken,
  queryType = "document_qa",
  evidenceMeta = {},
  meta = {}
) {
  // 1. Pre-generation evidence gate.
  const gate =
    checkEvidenceSupportGate(
      question,
      contextPrompt,
      queryType,
      evidenceMeta
    );

  if (!gate.supported) {
    console.log(
      `[LLM Stream] Question "${question}" failed evidence gate (${gate.reason}). Returning fallback.`
    );

    meta.reason = gate.reason;

    if (onToken) {
      onToken(FALLBACK_MESSAGE);
    }

    return FALLBACK_MESSAGE;
  }

  // 2. Stream grounded answer.
  const systemPrompt =
    buildSystemPrompt(
      contextPrompt
    );

  const historyMessages =
    (conversationHistory || [])
      .slice(-RAG_CONFIG.historyWindow)
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));

  let userStreamContent = question;


  if (
    contextPrompt.includes(
      "=== MULTI-TOPIC QUERY GUIDELINES ==="
    )
  ) {
    userStreamContent +=
      "\n\n(Important: Address each topic separately. If information for any specific item is not present in the documents, explicitly state that it was not found in the uploaded documents.)";
  }

  const messages = [
    {
      role: "system",
      content: systemPrompt,
    },
    ...historyMessages,
    {
      role: "user",
      content: userStreamContent,
    },
  ];

  const response = await axios.post(
    `${ENV.OLLAMA_BASE_URL}/api/chat`,
    {
      model: ENV.OLLAMA_LLM_MODEL,
      messages,
      stream: true,
      options: {
        temperature: 0.1,
        num_ctx: 3072,
        num_predict: 500,
      },
    },
    {
      responseType: "stream",
      timeout: 180000,
    }
  );

  let fullAnswer = "";

  return new Promise(
    (resolve, reject) => {
      response.data.on(
        "data",
        (chunk) => {
          const lines = chunk
            .toString()
            .split("\n")
            .filter(
              (l) => l.trim() !== ""
            );

          for (const line of lines) {
            try {
              const parsed =
                JSON.parse(line);

              const token =
                parsed.message?.content ||
                "";

              if (token) {
                fullAnswer += token;

                if (onToken) {
                  onToken(token);
                }
              }
            } catch (e) {
              // Ignore partial JSON chunks.
            }
          }
        }
      );

      response.data.on(
        "end",
        async () => {
          const {
            answer,
            reason,
          } =
            finalizeGeneratedAnswer(
              fullAnswer,
              contextPrompt,
              question,
              queryType
            );

          meta.reason = reason;

          resolve(answer);
        }
      );

      response.data.on(
        "error",
        (err) => {
          reject(err);
        }
      );
    }
  );
}

/**
 * Backward compatibility wrappers.
 */
export function extractProgramEntity(
  question = ""
) {
  const target =
    extractGenericTarget(question);

  return target.entity;
}

export function isProgramInContext(
  programEntity,
  contextPrompt = ""
) {
  return isEntityInContext(
    programEntity,
    contextPrompt
  );
}

export function checkProgramEntityGrounding(
  question = "",
  contextPrompt = ""
) {
  const gate =
    checkEvidenceSupportGate(
      question,
      contextPrompt
    );

  if (
    !gate.supported &&
    gate.reason === "missing_entity"
  ) {
    return {
      isUngroundedProgram: true,
      program: gate.entity || "",
      unavailableAnswer:
        FALLBACK_MESSAGE,
    };
  }

  return {
    isUngroundedProgram: false,
  };
}

/**
 * Deduplicates repeated visual elements.
 */
export function deduplicateVisualElements(
  answer
) {
  if (
    !answer ||
    typeof answer !== "string"
  ) {
    return answer;
  }

  const lines = answer.split("\n");

  const seenItems = new Set();

  const dedupedLines = [];

  let itemCounter = 1;

  for (const line of lines) {
    const listMatch =
      line.match(
        /^(\s*(?:\d+[\.\)]|[-*•])\s*)(.*)$/
      );

    if (listMatch) {
      const prefix = listMatch[1];

      const content =
        listMatch[2].trim();

      const normContent =
        content
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");

      if (normContent.length > 5) {
        if (
          seenItems.has(normContent)
        ) {
          continue;
        }

        seenItems.add(
          normContent
        );
      }

      if (
        /^\s*\d+[\.\)]/.test(
          prefix
        )
      ) {
        dedupedLines.push(
          `${itemCounter}. ${content}`
        );

        itemCounter++;
      } else {
        dedupedLines.push(line);
      }
    } else {
      dedupedLines.push(line);
    }
  }

  return dedupedLines.join("\n");
}

/**
 * Generic citation filter.
 */
export function filterSupportingSources(
  sources,
  answer,
  retrievedChunks,
  question = ""
) {
  if (
    !sources ||
    sources.length === 0 ||
    isFallbackAnswer(answer)
  ) {
    return [];
  }

  const pageMatch = question.match(/\b(?:page|p\.?)\s*(\d+)\b/i);
  const targetPage = pageMatch ? parseInt(pageMatch[1], 10) : null;

  const rawAnswerTerms = extractQueryTerms(answer);
  const specificAnswerTerms = rawAnswerTerms.filter((t) => t.length >= 3);

  const rawQTerms = extractQueryTerms(question);
  const requiredQTerms = rawQTerms.filter((t) => t.length >= 3);

  const answerNumbers = (
    answer.match(/\b\d+(?:,\d+)*(?:\.\d+)?%?\b/g) || []
  ).map((n) =>
    n.replace(/,/g, "").toLowerCase()
  );

  const significantNums =
    answerNumbers.filter(
      (n) =>
        n.length >= 2 ||
        n.includes("%")
    );

  const supported = sources.filter((source) => {
    if (targetPage !== null && source.pageNumber !== targetPage) {
      return false;
    }

    const chunk =
      retrievedChunks?.find(
        (c) =>
          c.documentName === source.documentName &&
          c.pageNumber === source.pageNumber &&
          (source.chunkIndex === undefined || c.chunkIndex === source.chunkIndex)
      ) ||
      retrievedChunks?.find(
        (c) =>
          c.documentName === source.documentName &&
          c.pageNumber === source.pageNumber
      );

    const rawText = (chunk?.content || source.snippet || "").toLowerCase();
    const text = rawText.replace(/(?<=\d),(?=\d)/g, "");

    const hasNum =
      significantNums.length > 0 &&
      significantNums.some((n) => text.includes(n));

    const matchedSpecific = specificAnswerTerms.filter((t) => text.includes(t));
    const ratio =
      specificAnswerTerms.length > 0
        ? matchedSpecific.length / specificAnswerTerms.length
        : 0;

    const matchesQ =
      requiredQTerms.length === 0 ||
      requiredQTerms.some((qt) => text.includes(qt));

    if (significantNums.length > 0) {
      return hasNum && matchesQ;
    }

    return matchesQ && (ratio >= 0.25 || (matchedSpecific.length >= 3 && ratio >= 0.15));
  });

  const candidateList = supported.length > 0
    ? supported
    : (targetPage ? sources.filter((s) => s.pageNumber === targetPage) : sources.slice(0, 1));

  // Task 3: Deduplicate the Sources list by (document, page) and show only pages whose chunks supported the final answer
  const seenPages = new Set();
  const deduplicated = [];
  for (const s of candidateList) {
    const key = `${s.documentName}_p${s.pageNumber}`;
    if (!seenPages.has(key)) {
      seenPages.add(key);
      deduplicated.push(s);
    }
  }

  return deduplicated;
}

/**
 * Task 1d: Warm Ollama models once at server start with keep_alive: "30m"
 */
export async function warmOllamaModels() {
  try {
    console.log(`[Ollama Warmup] Pre-warming LLM (${ENV.OLLAMA_LLM_MODEL}) and Embeddings (${ENV.OLLAMA_EMBED_MODEL})...`);
    await Promise.allSettled([
      axios.post(
        `${ENV.OLLAMA_BASE_URL}/api/chat`,
        {
          model: ENV.OLLAMA_LLM_MODEL,
          messages: [{ role: "user", content: "warmup" }],
          stream: false,
          options: { num_predict: 1 },
          keep_alive: "30m"
        },
        { timeout: 15000 }
      ),
      axios.post(
        `${ENV.OLLAMA_BASE_URL}/api/embeddings`,
        {
          model: ENV.OLLAMA_EMBED_MODEL,
          prompt: "warmup",
          keep_alive: "30m"
        },
        { timeout: 15000 }
      )
    ]);
    console.log(`[Ollama Warmup] Complete. Models pre-warmed in memory with keep_alive: 30m.`);
  } catch (err) {
    console.warn(`[Ollama Warmup] Notice: ${err.message}`);
  }
}


