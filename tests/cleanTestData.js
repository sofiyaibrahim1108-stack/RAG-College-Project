import readline from "readline";
import { connectDB } from "../backend/config/db.js";
import { Document } from "../backend/models/Document.js";
import { DocumentChunk } from "../backend/models/DocumentChunk.js";
import { ImageModel } from "../backend/models/Image.js";
import { Department } from "../backend/models/Department.js";
import fs from "fs";
import path from "path";
import { ENV } from "../backend/config/env.js";

async function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    })
  );
}

export async function runCleanTestData(autoConfirm = false) {
  console.log("==================================================");
  console.log("🧹 RAG-COLLEGE SAFE TEST DATA CLEANUP UTILITY");
  console.log("==================================================");

  await connectDB();

  // 1. Identify test data
  const testDocs = await Document.find({ isTestData: true });
  const testDocIds = testDocs.map((d) => d._id);

  const testChunkCount = await DocumentChunk.countDocuments({
    $or: [{ isTestData: true }, { documentId: { $in: testDocIds } }]
  });

  const testImages = await ImageModel.find({
    $or: [{ isTestData: true }, { documentId: { $in: testDocIds } }]
  });

  const testDepartments = await Department.find({ isTestData: true });

  console.log("\nTest Data Found:");
  console.log(`- Documents:        ${testDocs.length}`);
  console.log(`- Chunks:           ${testChunkCount}`);
  console.log(`- Images:           ${testImages.length}`);
  console.log(`- Test Departments: ${testDepartments.length}`);

  if (testDocs.length === 0 && testDepartments.length === 0 && testImages.length === 0) {
    console.log("\n✅ No test data found in the database. Genuine documents remain untouched.");
    return { cleaned: 0 };
  }

  console.log("\nItems to be removed:");
  if (testDepartments.length > 0) {
    console.log("  Test Departments:");
    testDepartments.forEach((dept) => console.log(`   • ${dept.name}`));
  }
  if (testDocs.length > 0) {
    console.log("  Test Documents:");
    testDocs.forEach((doc) => console.log(`   • ${doc.title || doc.originalName} (${doc.department})`));
  }

  // 2. Ask confirmation
  if (!autoConfirm) {
    const confirmation = await askQuestion(
      "\n⚠️ Do you want to permanently delete all marked test data? Genuine documents will NOT be affected. (yes/no): "
    );

    if (confirmation !== "yes" && confirmation !== "y") {
      console.log("\n🚫 Cleanup cancelled by user. Nothing was deleted.");
      return { cancelled: true };
    }
  }

  // 3. Delete files on disk for test documents and images
  let removedImageFiles = 0;
  for (const img of testImages) {
    if (img.imagePath && fs.existsSync(img.imagePath)) {
      try {
        fs.unlinkSync(img.imagePath);
        removedImageFiles++;
      } catch (e) {}
    }
  }

  let removedDocFiles = 0;
  for (const doc of testDocs) {
    if (doc.path && fs.existsSync(doc.path)) {
      try {
        fs.unlinkSync(doc.path);
        removedDocFiles++;
      } catch (e) {}
    }
    const docImgDir = path.join(ENV.UPLOAD_DIR, "images", doc._id.toString());
    if (fs.existsSync(docImgDir)) {
      try {
        fs.rmSync(docImgDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }

  // 4. Delete DB records
  const deletedChunks = await DocumentChunk.deleteMany({
    $or: [{ isTestData: true }, { documentId: { $in: testDocIds } }]
  });

  const deletedImages = await ImageModel.deleteMany({
    $or: [{ isTestData: true }, { documentId: { $in: testDocIds } }]
  });

  const deletedDocs = await Document.deleteMany({ isTestData: true });
  const deletedDepts = await Department.deleteMany({ isTestData: true });

  console.log("\n✅ Cleanup completed successfully!");
  console.log(`- Documents removed:        ${deletedDocs.deletedCount}`);
  console.log(`- Chunks removed:           ${deletedChunks.deletedCount}`);
  console.log(`- Images removed:           ${deletedImages.deletedCount}`);
  console.log(`- Test Departments removed: ${deletedDepts.deletedCount}`);
  console.log(`- Files deleted from disk:  ${removedDocFiles + removedImageFiles}`);
  console.log("🔒 Genuine user documents and departments remain 100% intact.");

  return {
    documents: deletedDocs.deletedCount,
    chunks: deletedChunks.deletedCount,
    images: deletedImages.deletedCount,
    departments: deletedDepts.deletedCount
  };
}

// Allow direct execution
if (process.argv[1] && process.argv[1].endsWith("cleanTestData.js")) {
  const autoConfirm = process.argv.includes("--yes") || process.argv.includes("-y");
  runCleanTestData(autoConfirm)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Cleanup error:", err);
      process.exit(1);
    });
}
