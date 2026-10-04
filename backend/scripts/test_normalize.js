import axios from "axios";

async function testRewrite(question, history = []) {
  const systemPrompt = `You are a query normalization assistant.
Your task is to rewrite the user's latest input into a clear, direct, standalone question suitable for document retrieval and question-answering.
Rules:
1. Turn imperative requests or commands like "show me X" or "display X" into questions like "What does X show?" or "What is in X?".
2. Resolve pronouns (such as "he", "she", "it", "they", "his", "her", "its") and elliptical follow-ups (such as "and his average?", "what about them?") using the previous conversation turns.
3. If the input is already a complete, standalone question, DO NOT rephrase, simplify, or shorten it; output it verbatim.
4. Output ONLY the rewritten question. Do not include explanations, quotes, or markdown.`;

  const messages = [{ role: "system", content: systemPrompt }];
  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: "user", content: question });

  const res = await axios.post("http://127.0.0.1:11434/api/chat", {
    model: "qwen2.5-coder:3b",
    messages,
    stream: false,
    options: {
      temperature: 0.1,
      num_predict: 80,
      num_ctx: 1024
    }
  });

  console.log(`Original: "${question}"`);
  console.log(`Rewritten: "${res.data.message.content.trim()}"\n`);
}

async function run() {
  await testRewrite("Show me the image/screenshot on page 61 of the Eye disease document");
  await testRewrite("and his average?", [
    { role: "user", content: "What are the marks of Rhea Sen?" },
    { role: "assistant", content: "Rhea Sen scored 55 in Math, 62 in Science, and 58 in English." }
  ]);
  await testRewrite("In the prediction probability bar chart for the DR case, which bar is higher, and what are the two categories?");
}

run().catch(console.error);
