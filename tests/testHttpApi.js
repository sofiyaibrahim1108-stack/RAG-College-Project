import axios from "../backend/node_modules/axios/index.js";

async function main() {
  console.log("Testing POST http://127.0.0.1:5000/api/chat/ask ...");
  const res = await axios.post("http://127.0.0.1:5000/api/chat/ask", {
    question: "What is the accuracy of EfficientNetB0?"
  }, { timeout: 120000 });

  console.log("HTTP Response Status:", res.status);
  console.log("Data:", {
    success: res.data.success,
    queryType: res.data.queryType,
    routedDepartments: res.data.routedDepartments,
    answer: res.data.answer,
    sourcesCount: res.data.sources?.length
  });
  process.exit(0);
}

main().catch(err => {
  console.error("HTTP API Test Error:", err.response?.data || err.message);
  process.exit(1);
});
