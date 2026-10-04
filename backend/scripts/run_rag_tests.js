import { connectDB } from "../config/db.js";
import { ragGraph } from "../graph/ragGraph.js";

async function runTests() {
  await connectDB();

  const testCases = [
    {
      id: "1_math_below_60",
      question: "Which students have Math below 60?",
      expected: "8 students (Ananya Iyer, Sneha Reddy, Kavya Joshi, Rhea Sen, Siddharth Das, Gaurav Bhatia, Priyanka Saxena, Akash Nambiar), no image",
      history: []
    },
    {
      id: "2_attendance",
      question: "What is the minimum attendance required to write examinations?",
      expected: "75%, no image",
      history: []
    },
    {
      id: "3_no_disease_sample",
      question: "In the sample output where no disease is detected, what is the confidence percentage and what risk message is shown?",
      expected: "97.52%, Normal (Low Risk), page 61 image",
      history: []
    },
    {
      id: "4_dr_bar_chart",
      question: "In the prediction probability bar chart for the DR case, which bar is higher, and what are the two categories?",
      expected: "DR higher (99.74%), categories: No_DR and DR, page 60 image",
      history: []
    },
    {
      id: "5_algo_accuracy",
      question: "In the Algorithm Accuracy Comparison, which algorithm has the highest accuracy, and what are the accuracies of all three?",
      expected: "EfficientNetB0 94%, MobileNet 92%, CNN 90%, page 64 image",
      history: []
    },
    {
      id: "6_show_page_61",
      question: "Show me the image/screenshot on page 61 of the Eye disease document",
      expected: "page 61 image",
      history: []
    },
    {
      id: "7_aws_fee",
      question: "What is the AWS hosting fee?",
      expected: "fallback, no image",
      history: []
    },
    {
      id: "8_microtasks",
      question: "Difference between Microtasks vs Macrotasks?",
      expected: "explanation of microtasks vs macrotasks; event-loop diagram allowed",
      history: []
    },
    {
      id: "9_rhea_sen_followup",
      isMultiTurn: true,
      turns: [
        {
          question: "i want to know rhea sen maths and science mark?",
          expected: "Math 50, Science 85, no image"
        },
        {
          question: "and his average?",
          expected: "Average 61, no image"
        }
      ]
    }
  ];

  console.log(`\n=================== EXECUTING FINAL VERIFICATION SUITE ===================\n`);

  for (const tc of testCases) {
    if (tc.isMultiTurn) {
      console.log(`\n------------------------------------------------------------`);
      console.log(`MULTI-TURN TEST [${tc.id.toUpperCase()}]`);
      console.log(`------------------------------------------------------------`);
      let convHistory = [];
      for (let t = 0; t < tc.turns.length; t++) {
        const turn = tc.turns[t];
        console.log(`\n>>> Turn ${t + 1}: "${turn.question}"`);
        console.log(`Expected: ${turn.expected}`);
        const t0 = Date.now();
        const res = await ragGraph.invoke({
          question: turn.question,
          conversationHistory: convHistory
        });
        const duration = Date.now() - t0;
        console.log(`[Result Answer]: ${res.finalAnswer.replace(/\n/g, " ")}`);
        console.log(`[Result Images]: ${JSON.stringify(res.imageCitations.map(img => ({ page: img.pageNumber, file: img.filename, survivingChunk: img.survivingChunk || 'image_chunk' })))}`);
        console.log(`[Result Sources]: ${JSON.stringify(res.sources.map(s => ({ doc: s.documentName, page: s.pageNumber })))}`);
        console.log(`[Total Time]: ${duration}ms (Timings: ${JSON.stringify(res.timings)})`);

        convHistory.push({ role: "user", content: turn.question });
        convHistory.push({ role: "assistant", content: res.finalAnswer });
      }
    } else {
      console.log(`\n------------------------------------------------------------`);
      console.log(`TEST [${tc.id.toUpperCase()}]: "${tc.question}"`);
      console.log(`Expected: ${tc.expected}`);
      console.log(`------------------------------------------------------------`);
      const t0 = Date.now();
      const res = await ragGraph.invoke({
        question: tc.question,
        conversationHistory: tc.history || []
      });
      const duration = Date.now() - t0;
      console.log(`[Result Answer]: ${res.finalAnswer.replace(/\n/g, " ")}`);
      console.log(`[Result Images]: ${JSON.stringify(res.imageCitations.map(img => ({ page: img.pageNumber, file: img.filename, survivingChunk: img.survivingChunk || 'image_chunk' })))}`);
      console.log(`[Result Sources]: ${JSON.stringify(res.sources.map(s => ({ doc: s.documentName, page: s.pageNumber })))}`);
      console.log(`[Total Time]: ${duration}ms (Timings: ${JSON.stringify(res.timings)})`);
    }
  }

  console.log(`\n=================== COMPLETED FINAL VERIFICATION SUITE ===================\n`);
  process.exit(0);
}

runTests().catch(err => {
  console.error("Test runner error:", err);
  process.exit(1);
});
