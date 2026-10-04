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

async function testFreshTabular() {
  console.log("=== STARTING UNSEEN TABULAR DYNAMIC RAG TEST ===");
  await mongoose.connect(ENV.MONGO_URI);

  const testDeptName = "Retail Operations";
  const testFileName = "retail_store_sales.csv";
  const uploadFilePath = path.join(ENV.UPLOAD_DIR, testFileName);

  let createdDept = null;
  let createdDoc = null;

  try {
    // 1. Create fresh Department
    console.log(`Step 1: Creating fresh department "${testDeptName}"...`);
    createdDept = await Department.create({
      name: testDeptName,
      description: "Department managing retail store performance, financial reports, and regional sales."
    });

    // 2. Create fresh CSV on disk
    console.log(`Step 2: Creating fresh CSV on disk...`);
    const csvContent = `Store_ID,Store_Name,Region,Revenue,Cost,Profit,Status
STR_101,Apex Supercenter,North,450000,320000,130000,Active
STR_102,Metro Mart,South,620000,410000,210000,Active
STR_103,Cascade Retail,East,280000,210000,70000,Underperforming
STR_104,Highland Plaza,West,530000,360000,170000,Active
STR_105,Beacon Outlet,North,390000,290000,100000,Active`;

    fs.writeFileSync(uploadFilePath, csvContent, "utf8");

    // 3. Create Document record
    createdDoc = await Document.create({
      title: "retail_store_sales.csv",
      originalName: testFileName,
      filename: testFileName,
      path: uploadFilePath,
      fileType: "csv",
      mimeType: "text/csv",
      size: Buffer.byteLength(csvContent),
      departmentId: createdDept._id,
      department: testDeptName,
      isTestData: true,
      status: "processing",
      source: "upload"
    });

    // 4. Ingest
    console.log(`Step 3: Processing and embedding CSV...`);
    await processDocument(createdDoc._id);

    // 5. Test dynamic tabular routing and execution
    console.log(`\nStep 4: Testing dynamic query: "Which store had the highest profit?"`);
    const res1 = await ragGraph.invoke({ question: "Which store had the highest profit?" });
    console.log(`Route: ${JSON.stringify(res1.routedDepartments)}, QueryType: ${res1.queryType}`);
    console.log(`Answer: ${res1.finalAnswer}`);
    const passed1 = (res1.finalAnswer || "").includes("Metro Mart") || (res1.finalAnswer || "").includes("210000");
    if (!passed1) throw new Error("Failed to find Metro Mart / 210000 as highest profit store");
    console.log("✓ SUCCESS: Correctly computed highest profit store (Metro Mart) dynamically!");

    // 6. Test dynamic lookup query
    console.log(`\nStep 5: Testing dynamic lookup: "what was the revenue of cascade retail"`);
    const res2 = await ragGraph.invoke({ question: "what was the revenue of cascade retail" });
    console.log(`Route: ${JSON.stringify(res2.routedDepartments)}, QueryType: ${res2.queryType}`);
    console.log(`Answer: ${res2.finalAnswer}`);
    const cleanAns2 = (res2.finalAnswer || "").replace(/,/g, "");
    const passed2 = cleanAns2.includes("280000");
    if (!passed2) throw new Error("Failed to retrieve revenue for Cascade Retail (280000)");
    console.log("✓ SUCCESS: Correctly retrieved cell lookup (280000) dynamically!");

    // 7. Test generic stemming / plural matching: "revenues" matching "Revenue" column
    console.log(`\nStep 6: Testing generic plural stemming: "average revenues across all stores"`);
    const res3 = await ragGraph.invoke({ question: "average revenues across all stores" });
    console.log(`Route: ${JSON.stringify(res3.routedDepartments)}, QueryType: ${res3.queryType}`);
    console.log(`Answer: ${res3.finalAnswer}`);
    const cleanAns3 = (res3.finalAnswer || "").replace(/,/g, "");
    const passed3 = cleanAns3.includes("454000"); // (450+620+280+530+390)/5 = 454000
    if (!passed3) throw new Error("Failed to compute average revenues via generic stemming");
    console.log("✓ SUCCESS: Correctly computed average revenues (454000) through generic stemming!");

    console.log("\n=== ALL UNSEEN TABULAR TESTS PASSED SUCCESSFULLY! ===");
  } finally {
    if (createdDoc) {
      await DocumentChunk.deleteMany({ documentId: createdDoc._id });
      await Document.findByIdAndDelete(createdDoc._id);
      if (fs.existsSync(uploadFilePath)) {
        try { fs.unlinkSync(uploadFilePath); } catch (e) {}
      }
    }
    if (createdDept) {
      await Department.findByIdAndDelete(createdDept._id);
    }
    await mongoose.disconnect();
  }
}

testFreshTabular().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
