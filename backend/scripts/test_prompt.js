import axios from "axios";

async function testPrompt() {
  const prompt = `You are a document-grounded assistant.
Use only information supported by the provided evidence in CONTEXT.
If the evidence does not contain enough information to answer the question, reply exactly:
'I couldn't find this information in the uploaded documents.'

VISUAL EVIDENCE RULE:
Context items labeled with Visual Evidence or containing OCR/Screenshot content represent visual elements, screenshots, and figures from the document, and the corresponding image is displayed to the user automatically in the interface. If the user asks to see, show, or display an image, screenshot, or page, describe what this visual evidence shows and state its page, instead of refusing. If no visual evidence is in the context, use the normal fallback.

CONTEXT:
=== DOCUMENT EXCERPTS ===
[Source 1 (Visual Evidence / Screenshot)] Document: Eye disease.pdf | Page 61
IMAGE ANALYSIS AND PREDICTION OUTPUT ( NO DISEASE - NORMAL)
OCR: Diabetic Retinopathy Detection using Deep learning
Model used : EfficientNetB0 + TFLite (No_DR vs DR)
Predicted Output: No DR (Normal)
Confidence: 97.52%
Risk Message: Normal (Low Risk)
No clear signs of Diabetic Retinopathy
`;

  const res = await axios.post("http://127.0.0.1:11434/api/chat", {
    model: "qwen2.5-coder:3b",
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: "Show me the image/screenshot on page 61 of the Eye disease document" }
    ],
    stream: false,
    options: { temperature: 0.1 }
  });

  console.log("RESPONSE:\n", res.data.message.content);
}

testPrompt().catch(console.error);
