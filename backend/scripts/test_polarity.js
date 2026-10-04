const POLARITY_WORDS = new Set(["no", "not", "without", "never", "none", "nor"]);

function isTermNegatedInText(term, textLower) {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const negPattern = new RegExp(`\\b(?:no|not|without|never|none|nor)[\\s_\\-]+${esc}\\b`, "i");
  return negPattern.test(textLower);
}

function testLexical(query, content) {
  const qLower = query.toLowerCase();
  const cLower = content.toLowerCase();
  const terms = qLower.replace(/[^a-z0-9_\-\s]/g, " ").split(/\s+/).filter(w => w.length >= 2);
  let matches = 0;
  for (const t of terms) {
    if (POLARITY_WORDS.has(t)) continue;
    if (cLower.includes(t)) {
      const qNeg = isTermNegatedInText(t, qLower);
      const cNeg = isTermNegatedInText(t, cLower);
      if (qNeg !== cNeg) {
        matches += 0.2;
      } else {
        matches += 1.0;
      }
    }
  }
  return matches / terms.length;
}

const qDR = "In the prediction probability bar chart for the DR case, which bar is higher, and what are the two categories?";
const p60 = "OUTPUT PREDICTION PROBABILITY OF DISEASE. Bar chart No_DR and DR.";
const p62 = "OUTPUT PREDICTION PROBABILITY OF NO DISEASE. Bar chart No_DR and DR.";

console.log("Q (DR case):");
console.log("P60 score:", testLexical(qDR, p60).toFixed(4));
console.log("P62 score:", testLexical(qDR, p62).toFixed(4));

const qNormal = "In the sample output where no disease is detected, what is the confidence percentage and what risk message is shown?";
console.log("\nQ (No disease case):");
console.log("P60 score:", testLexical(qNormal, p60).toFixed(4));
console.log("P62 score:", testLexical(qNormal, p62).toFixed(4));
