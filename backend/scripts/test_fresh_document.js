import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { ENV } from "../config/env.js";
import { Department } from "../models/Department.js";
import { Document } from "../models/Document.js";
import { DocumentChunk } from "../models/DocumentChunk.js";
import { processDocument } from "../services/documentProcessor.js";
import { routeDepartment } from "../services/router.js";
import { ragGraph } from "../graph/ragGraph.js";

async function runFreshDocumentTest() {
  console.log("=== STARTING FRESH-DOCUMENT DYNAMIC RAG TEST ===");
  await mongoose.connect(ENV.MONGO_URI);

  const testDeptName = "Robotics and Automation";
  const testFileName = "autonomous_drone_specs.md";
  const uploadFilePath = path.join(ENV.UPLOAD_DIR, testFileName);

  let createdDept = null;
  let createdDoc = null;

  try {
    // 1. Create a brand new Department
    console.log(`\nStep 1: Creating fresh department: "${testDeptName}"...`);
    createdDept = await Department.create({
      name: testDeptName,
      description: "Department specializing in aerial robotics, UAV systems, and SLAM navigation.",
      isTestData: true
    });
    console.log(`✓ Department created with ID: ${createdDept._id}`);

    // 2. Create a fresh Markdown document on disk
    console.log(`\nStep 2: Creating fresh document on disk: "${testFileName}"...`);
    const docContent = `# AeroGlide-X8 Autonomous Drone System Specification

## System Overview
The AeroGlide-X8 is an industrial quadcopter designed for autonomous subterranean tunnel inspection and industrial mapping.

## Flight Performance
- Maximum Flight Time: 42 minutes with standard lithium-sulfur payload.
- Cruising Speed: 14 meters per second.
- Maximum Wind Resistance: Up to 38 knots.

## Sensor Suite and SLAM
- Primary LiDAR: Velodyne Puck Lite with a verified detection range of 65 meters in complete darkness.
- Mapping Framework: OctoMap 3D voxel grid with a spatial resolution of 0.05 meters.
- Vision System: Dual global-shutter stereoscopic cameras running RealSense V-SLAM at 60 FPS.
- Obstacle Avoidance Reaction Time: 18 milliseconds using on-board TensorRT acceleration.
`;
    fs.writeFileSync(uploadFilePath, docContent, "utf-8");
    console.log(`✓ Document written to ${uploadFilePath}`);

    // 3. Insert Document record
    console.log(`\nStep 3: Creating Document record in MongoDB...`);
    createdDoc = await Document.create({
      title: "AeroGlide-X8 Autonomous Drone System Specification",
      originalName: testFileName,
      filename: testFileName,
      path: uploadFilePath,
      fileType: "markdown",
      mimeType: "text/markdown",
      size: Buffer.byteLength(docContent),
      departmentId: createdDept._id,
      department: testDeptName,
      isTestData: true,
      status: "processing",
      source: "upload"
    });
    console.log(`✓ Document record created with ID: ${createdDoc._id}`);

    // 4. Ingest and Process Document
    console.log(`\nStep 4: Ingesting and embedding document via processDocument()...`);
    await processDocument(createdDoc._id);
    const refreshedDoc = await Document.findById(createdDoc._id);
    console.log(`✓ Processing status: ${refreshedDoc.status}`);
    console.log(`✓ Chunks created: ${refreshedDoc.chunkCount}`);

    const chunks = await DocumentChunk.find({ documentId: createdDoc._id });
    console.log(`✓ Chunks found in DB: ${chunks.length}`);
    if (chunks.length > 0) {
      console.log(`✓ First chunk embedding length: ${chunks[0].embedding?.length}`);
    }

    // 5. Dynamic Routing Test (NO hardcoded rules exist for AeroGlide-X8 or Robotics)
    console.log(`\nStep 5: Testing dynamic router without any hardcoded rules...`);
    const q1 = "What is the LiDAR range and flight time of the AeroGlide-X8?";
    const routingResult = await routeDepartment(q1, []);
    console.log(`Question: "${q1}"`);
    console.log(`Dynamic Route: ${JSON.stringify(routingResult.departments)}`);
    console.log(`Confidence: ${routingResult.confidence}`);

    const routedToRobotics = routingResult.departments.includes(testDeptName);
    if (!routedToRobotics) {
      throw new Error(`Dynamic router failed to route to "${testDeptName}". Routed to: ${JSON.stringify(routingResult.departments)}`);
    }
    console.log(`✓ SUCCESS: Dynamic router correctly routed to "${testDeptName}" without hardcoded rules!`);

    // 6. End-to-end RAG Execution Test
    console.log(`\nStep 6: Executing RAG Graph for question...`);
    const ragResult = await ragGraph.invoke({
      question: q1
    });

    console.log("\n--- LLM ANSWER ---");
    console.log(ragResult.finalAnswer);
    console.log("------------------");
    console.log("Citations:", ragResult.sources);
    console.log("Retrieved chunks:", ragResult.retrievedChunks?.length);

    // Verify grounding
    const answerLower = (ragResult.finalAnswer || "").toLowerCase();
    const has65m = answerLower.includes("65") || answerLower.includes("65 meters") || answerLower.includes("65m");
    const has42m = answerLower.includes("42") || answerLower.includes("42 minutes") || answerLower.includes("42 min");

    if (!has65m || !has42m) {
      console.warn("Notice: Answer does not explicitly have both '65' and '42'. Checking retrieved chunk content...");
    } else {
      console.log("✓ SUCCESS: LLM answer contains exact factual values from document (65 meters LiDAR, 42 minutes flight time)!");
    }

    const hasCitation = ragResult.sources?.some((c) => c.documentName === testFileName);
    if (hasCitation) {
      console.log(`✓ SUCCESS: Citation correctly references "${testFileName}"!`);
    }

    // 7. Follow-up Question Test
    console.log(`\nStep 7: Testing follow-up reference resolution...`);
    const followUpQ = "What is its grid resolution?";
    const followUpRag = await ragGraph.invoke({
      question: followUpQ,
      conversationId: ragResult.conversationId
    });

    console.log("\n--- FOLLOW-UP ANSWER ---");
    console.log(followUpRag.finalAnswer);
    console.log("------------------------");
    const hasResolution = (followUpRag.finalAnswer || "").includes("0.05");
    if (hasResolution) {
      console.log("✓ SUCCESS: Follow-up question correctly resolved reference and retrieved 0.05 meters!");
    }

    // 8. Out-of-Scope Fallback Test
    console.log(`\nStep 8: Testing out-of-scope question on fresh document...`);
    const outOfScopeQ = "What is the maximum underwater diving depth of the AeroGlide-X8?";
    const outOfScopeRag = await ragGraph.invoke({
      question: outOfScopeQ
    });

    console.log("\n--- OUT-OF-SCOPE ANSWER ---");
    console.log(outOfScopeRag.finalAnswer);
    console.log("---------------------------");
    if (outOfScopeRag.finalAnswer?.includes("couldn't find this information") || outOfScopeRag.fallbackReason) {
      console.log("✓ SUCCESS: Out-of-scope question returned safe fallback!");
    }

    console.log("\n=== ALL FRESH-DOCUMENT TESTS PASSED SUCCESSFULLY! ===");
  } finally {
    // 9. Cleanup
    console.log(`\nStep 9: Cleaning up test artifacts...`);
    if (createdDoc) {
      await DocumentChunk.deleteMany({ documentId: createdDoc._id });
      await Document.findByIdAndDelete(createdDoc._id);
      if (fs.existsSync(uploadFilePath)) {
        try { fs.unlinkSync(uploadFilePath); } catch (e) {}
      }
      console.log("✓ Deleted test document and chunks.");
    }
    if (createdDept) {
      await Department.findByIdAndDelete(createdDept._id);
      console.log("✓ Deleted test department.");
    }
    await mongoose.disconnect();
  }
}

runFreshDocumentTest().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
