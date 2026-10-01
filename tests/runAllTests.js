import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { connectDB } from "../backend/config/db.js";
import { Department } from "../backend/models/Department.js";
import { Document } from "../backend/models/Document.js";
import { DocumentChunk } from "../backend/models/DocumentChunk.js";
import { ImageModel } from "../backend/models/Image.js";
import { processDocument } from "../backend/services/documentProcessor.js";
import { routeDepartment } from "../backend/services/router.js";
import { retrieveRelevantTextChunks } from "../backend/services/textRetrieval.js";
import { retrieveRelevantImages } from "../backend/services/imageRetrieval.js";
import { generateTextEmbedding } from "../backend/services/embeddingService.js";
import { siglipClient } from "../backend/services/siglipClient.js";
import { ragGraph } from "../backend/graph/ragGraph.js";
import { runCleanTestData } from "./cleanTestData.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const testDataDir = path.join(rootDir, "test_data");

async function runTests() {
  console.log("==================================================");
  console.log("🧪 STARTING COMPREHENSIVE RAG PIPELINE TESTS");
  console.log("==================================================");

  // 1. Database Connection
  console.log("\n[Test 1] Connecting to MongoDB...");
  await connectDB();
  console.log("✅ MongoDB connected successfully!");

  // Clean any previous test data safely
  console.log("\n[Setup] Cleaning previous test data...");
  await runCleanTestData(true);

  // 2. Test Dynamic Department Creation in MongoDB
  console.log("\n[Test 2] Creating dynamic test departments in MongoDB...");
  const deptAI = await Department.create({
    name: "Artificial Intelligence",
    description: "Deep learning, neural networks, computer vision, and NLP",
    isTestData: true
  });
  const deptWeb = await Department.create({
    name: "Web Engineering",
    description: "Frontend frameworks, microservices, and web protocols",
    isTestData: true
  });
  const deptDB = await Department.create({
    name: "Database Systems",
    description: "Relational, document, and vector databases",
    isTestData: true
  });
  console.log(`✅ Created test departments: ${deptAI.name}, ${deptWeb.name}, ${deptDB.name}`);

  // 3. Ingest Test PDF tagged with Department and isTestData: true
  console.log("\n[Test 3] Processing PDF Document (mongodb_guide.pdf)...");
  const pdfDoc = await Document.create({
    title: "MongoDB Guide",
    originalName: "mongodb_guide.pdf",
    filename: "test_mongodb_guide.pdf",
    path: path.join(testDataDir, "mongodb_guide.pdf"),
    fileType: "pdf",
    departmentId: deptDB._id,
    department: deptDB.name,
    isTestData: true,
    status: "processing"
  });
  await processDocument(pdfDoc._id);
  const pdfChunks = await DocumentChunk.find({ documentId: pdfDoc._id });
  const pdfImages = await ImageModel.find({ documentId: pdfDoc._id });
  console.log(`✅ PDF Ingestion Complete: ${pdfChunks.length} chunks, ${pdfImages.length} images.`);

  // 4. Ingest Test DOCX
  console.log("\n[Test 4] Processing DOCX Document (react_architecture.docx)...");
  const docxDoc = await Document.create({
    title: "React Architecture",
    originalName: "react_architecture.docx",
    filename: "test_react_architecture.docx",
    path: path.join(testDataDir, "react_architecture.docx"),
    fileType: "docx",
    departmentId: deptWeb._id,
    department: deptWeb.name,
    isTestData: true,
    status: "processing"
  });
  await processDocument(docxDoc._id);
  const docxChunks = await DocumentChunk.find({ documentId: docxDoc._id });
  const docxImages = await ImageModel.find({ documentId: docxDoc._id });
  console.log(`✅ DOCX Ingestion Complete: ${docxChunks.length} chunks, ${docxImages.length} images.`);

  // 5. Ingest Test TXT
  console.log("\n[Test 5] Processing TXT Document (sql_vs_nosql.txt)...");
  const txtDoc = await Document.create({
    title: "SQL vs NoSQL",
    originalName: "sql_vs_nosql.txt",
    filename: "test_sql_vs_nosql.txt",
    path: path.join(testDataDir, "sql_vs_nosql.txt"),
    fileType: "txt",
    departmentId: deptDB._id,
    department: deptDB.name,
    isTestData: true,
    status: "processing"
  });
  await processDocument(txtDoc._id);
  const txtChunks = await DocumentChunk.find({ documentId: txtDoc._id });
  console.log(`✅ TXT Ingestion Complete: ${txtChunks.length} chunks.`);

  // 6. Test SigLIP2 Microservice Health & Multimodal Embeddings
  console.log("\n[Test 6] Testing SigLIP2 Microservice...");
  const siglipHealth = await siglipClient.checkHealth();
  console.log(`✅ SigLIP2 Health Status:`, siglipHealth);
  const textQueryEmb = await siglipClient.embedText("system architecture component diagram");
  console.log(`✅ SigLIP2 Text Embedding: ${textQueryEmb.length} dimensions generated.`);

  // 7. Test Dynamic Department Router (Reads from MongoDB)
  console.log("\n[Test 7] Testing Dynamic Department Router against MongoDB departments...");
  const routerTests = [
    { q: "What is MongoDB indexing and why is it useful?" },
    { q: "How do React components handle state?" },
    { q: "What is the difference between SQL and NoSQL databases?" }
  ];

  for (const item of routerTests) {
    const route = await routeDepartment(item.q);
    console.log(`❓ Query: "${item.q}"`);
    console.log(`🧭 Routed To: [${route.departments.join(", ")}] (Confidence: ${route.confidence})`);
  }

  // 8. Test Department-aware Text Retrieval
  console.log("\n[Test 8] Testing Text Retrieval with mxbai-embed-large...");
  const query = "What is MongoDB indexing?";
  const qEmb = await generateTextEmbedding(query);
  const retrievedChunks = await retrieveRelevantTextChunks(qEmb, [deptDB.name]);
  console.log(`✅ Retrieved ${retrievedChunks.length} chunks for "${query}":`);
  retrievedChunks.forEach((c, idx) => {
    console.log(`   #${idx + 1} [${c.documentName}] (Score: ${c.similarity}): ${c.content.slice(0, 80).replace(/\n/g, " ")}...`);
  });

  // 9. Test SigLIP2 Image Retrieval
  console.log("\n[Test 9] Testing SigLIP2 Image Retrieval...");
  const imgQueryEmb = await siglipClient.embedText("React components diagram");
  const retrievedImages = await retrieveRelevantImages(imgQueryEmb, [deptWeb.name]);
  console.log(`✅ Retrieved ${retrievedImages.length} relevant diagrams/figures:`);
  retrievedImages.forEach((img, idx) => {
    console.log(`   #${idx + 1} Image: ${img.filename} in ${img.documentName} (Score: ${img.similarity})`);
  });

  // 10. Test LangGraph End-to-End Chat Pipeline
  console.log("\n[Test 10] Testing LangGraph End-to-End Execution...");
  const ragResult = await ragGraph.invoke({
    question: "What is MongoDB indexing and how does it help query performance?",
    conversationId: null
  });

  console.log("\n=================== RAG RESULT ===================");
  console.log("Answer:\n", ragResult.finalAnswer);
  console.log("\nSources Cited:", ragResult.sources);
  console.log("\nImages Retrieved:", ragResult.imageCitations);
  console.log("\nPipeline Timings (ms):", ragResult.timings);
  console.log("==================================================");

  // 11. Test Safe Test Data Cleanup Functionality
  console.log("\n[Test 11] Testing Safe Test Data Cleanup...");
  const cleanResult = await runCleanTestData(true);
  console.log(`✅ Cleaned ${cleanResult.documents} test documents and ${cleanResult.departments} test departments.`);

  // Verify DB state
  const remainingTestDocs = await Document.countDocuments({ isTestData: true });
  const remainingTestDepts = await Department.countDocuments({ isTestData: true });
  console.log(`✅ Verified remaining test documents in DB: ${remainingTestDocs}`);
  console.log(`✅ Verified remaining test departments in DB: ${remainingTestDepts}`);

  console.log("\n🎉 ALL TESTS PASSED WITH CLEAN TEST DATA TEARDOWN!");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("❌ Test suite failed:", err);
  process.exit(1);
});
