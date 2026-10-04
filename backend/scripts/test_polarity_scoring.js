const POLARITY_WORDS = new Set(["no", "not", "without", "never", "none", "nor"]);

function computeLexical(rawQuestion, content) {
  const contentLower = content.toLowerCase();
  const rawQ = rawQuestion.toLowerCase();
  const queryTerms = rawQ.replace(/[^a-z0-9_\-\s]/g, " ").split(/\s+/).filter(w => w.length >= 2);
  const activeTerms = queryTerms.filter(t => !["eye", "disease"].includes(t));

  let termMatches = 0;
  for (const term of activeTerms) {
    if (contentLower.includes(term)) termMatches++;
  }
  let tokenCoverage = termMatches / activeTerms.length;

  let polarityPenalty = 0;
  let polarityBonus = 0;
  const qHasNegation = queryTerms.some((t) => POLARITY_WORDS.has(t));

  for (const polWord of POLARITY_WORDS) {
    const negRegex = new RegExp(`\\b${polWord}[\\s_\\-]+([a-z0-9]+)`, "gi");
    let m;
    while ((m = negRegex.exec(contentLower)) !== null) {
      const negatedSubject = m[1];
      if (negatedSubject && negatedSubject.length >= 2) {
        const isQueryTarget = activeTerms.includes(negatedSubject) || queryTerms.includes(negatedSubject);
        if (isQueryTarget) {
          const qHasNegatedTarget = new RegExp(`\\b${polWord}[\\s_\\-]+${negatedSubject}\\b`, "i").test(rawQ);
          if (qHasNegatedTarget) {
            polarityBonus = Math.max(polarityBonus, 0.20);
          } else if (!qHasNegation && !/\b(?:normal|low)\b/i.test(negatedSubject)) {
            polarityPenalty = Math.max(polarityPenalty, 0.25);
          }
        }
      }
    }
  }

  return Math.min(1.0, Math.max(0, tokenCoverage + polarityBonus - polarityPenalty));
}

const qDR = "In the prediction probability bar chart for the DR case, which bar is higher, and what are the two categories?";
const p60 = "OUTPUT PREDICTION PROBABILITY OF DISEASE\nOCR: Prediction Probability (%) 100 90 80 70 60 50 40 30 20 10 No_DR DR";
const p62 = "OUTPUT PREDICTION PROBABILITY OF NO DISEASE\nOCR: Prediction Probability (%) 100 90 80 70 60 50 40 30 20 10 No_DR DR";

console.log("Q (DR case):");
console.log("P60 lexical:", computeLexical(qDR, p60).toFixed(4));
console.log("P62 lexical:", computeLexical(qDR, p62).toFixed(4));

const qNormal = "In the sample output where no disease is detected, what is the confidence percentage and what risk message is shown?";
const p59 = "SAMPLE OUTPUT FORM - IMAGE ANALYSIS AND PREDICTION OUTPUT ( DR PRESENT )\nPredicted Output: DR Detected Confidence 99.74%";
const p61 = "IMAGE ANALYSIS AND PREDICTION OUTPUT ( NO DISEASE - NORMAL )\nConfidence 97.52% Normal (Low Risk)";

console.log("\nQ (No disease case):");
console.log("P59 lexical:", computeLexical(qNormal, p59).toFixed(4));
console.log("P61 lexical:", computeLexical(qNormal, p61).toFixed(4));
