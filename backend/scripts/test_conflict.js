import axios from "axios";

async function main() {
  const sys = `You are a document-grounded assistant.

Answer using ONLY the retrieved evidence supplied in CONTEXT.

Never use outside knowledge to fill missing information.

If retrieved sources contain conflicting values, report the conflict and identify which source/page contains each value. Do not silently choose one.

CONFLICT HANDLING:
If different pages or sources report different accuracy values for the model / EfficientNetB0 (such as approximately 96% validation accuracy in the report text versus 94% in the code/UI table), state both values clearly, citing each page, and note that the documents contain conflicting values.

CONTEXT:
[Source 1] Document: Eye disease.pdf | Page 7
Stage 1: Feature Extraction Training: The pre-trained EfficientNetB0 layers are frozen... Stage 2: Fine-Tuning: In this stage, the last few layers of EfficientNetB0 are unfrozen... By applying this two-stage training strategy, the model achieves improved accuracy and better generalization, resulting in an overall accuracy of approximately 96% in detecting Diabetic Retinopathy.

[Source 2] Document: Eye disease.pdf | Page 33
The training process uses Binary Cross-Entropy loss and Adam optimizer... In your implementation, the final model achieved 96% validation accuracy, confirming strong screening capability.

[Source 3] Document: Eye disease.pdf | Page 44
algorithm_accuracy: {"EfficientNetB0": "94%", "MobileNet": "92%", "CNN": "90%"}`;

  const res = await axios.post("http://127.0.0.1:11434/api/chat", {
    model: "qwen2.5-coder:3b",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: "What is the accuracy of EfficientNetB0?" }
    ],
    stream: false,
    options: { temperature: 0.1, num_ctx: 8192, num_predict: 800 }
  });
  console.log("Result:\n", res.data.message.content);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
