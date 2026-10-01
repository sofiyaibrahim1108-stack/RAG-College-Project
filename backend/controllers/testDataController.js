import fs from "fs";
import path from "path";
import { Document } from "../models/Document.js";
import { DocumentChunk } from "../models/DocumentChunk.js";
import { ImageModel } from "../models/Image.js";
import { Department } from "../models/Department.js";
import { ENV } from "../config/env.js";

/**
 * Get summary of test data currently in the database
 */
export async function getTestDataSummary(req, res) {
  try {
    const testDocs = await Document.find({ isTestData: true }).select("_id originalName title department departmentId createdAt").lean();
    const testDocIds = testDocs.map((d) => d._id);

    const testChunkCount = await DocumentChunk.countDocuments({
      $or: [{ isTestData: true }, { documentId: { $in: testDocIds } }]
    });

    const testImages = await ImageModel.find({
      $or: [{ isTestData: true }, { documentId: { $in: testDocIds } }]
    }).lean();

    const testDepartments = await Department.find({ isTestData: true }).lean();

    res.json({
      success: true,
      summary: {
        documents: testDocs.length,
        chunks: testChunkCount,
        images: testImages.length,
        testDepartments: testDepartments.length,
        documentDetails: testDocs.map((d) => ({
          id: d._id,
          title: d.title || d.originalName,
          department: d.department,
          createdAt: d.createdAt
        })),
        departmentDetails: testDepartments.map((dept) => ({
          id: dept._id,
          name: dept.name
        }))
      }
    });
  } catch (error) {
    console.error(`[getTestDataSummary Error] ${error.message}`);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Safely clean all test data with confirmation
 */
export async function cleanTestData(req, res) {
  try {
    const { confirm } = req.body;
    if (confirm !== true) {
      return res.status(400).json({
        error: "Confirmation required. Send { confirm: true } to proceed with test data cleanup."
      });
    }

    // 1. Identify test documents
    const testDocs = await Document.find({ isTestData: true });
    const testDocIds = testDocs.map((d) => d._id);

    // 2. Identify and remove image files for test documents
    const testImages = await ImageModel.find({
      $or: [{ isTestData: true }, { documentId: { $in: testDocIds } }]
    });

    let removedImageFiles = 0;
    for (const img of testImages) {
      if (img.imagePath && fs.existsSync(img.imagePath)) {
        try {
          fs.unlinkSync(img.imagePath);
          removedImageFiles++;
        } catch (e) {}
      }
    }

    // 3. Remove uploaded document files for test documents
    let removedDocFiles = 0;
    for (const doc of testDocs) {
      if (doc.path && fs.existsSync(doc.path)) {
        try {
          fs.unlinkSync(doc.path);
          removedDocFiles++;
        } catch (e) {}
      }

      // Remove extracted images folder for doc if exists
      const docImgDir = path.join(ENV.UPLOAD_DIR, "images", doc._id.toString());
      if (fs.existsSync(docImgDir)) {
        try {
          fs.rmSync(docImgDir, { recursive: true, force: true });
        } catch (e) {}
      }
    }

    // 4. Remove database records for test data only
    const deletedChunks = await DocumentChunk.deleteMany({
      $or: [{ isTestData: true }, { documentId: { $in: testDocIds } }]
    });

    const deletedImages = await ImageModel.deleteMany({
      $or: [{ isTestData: true }, { documentId: { $in: testDocIds } }]
    });

    const deletedDocs = await Document.deleteMany({ isTestData: true });

    // 5. Remove test-only departments (departments created specifically for testing)
    const deletedDepts = await Department.deleteMany({ isTestData: true });

    res.json({
      success: true,
      message: "Test data cleanup completed successfully. Genuine data was untouched.",
      deleted: {
        documents: deletedDocs.deletedCount,
        chunks: deletedChunks.deletedCount,
        images: deletedImages.deletedCount,
        departments: deletedDepts.deletedCount,
        filesRemoved: removedDocFiles + removedImageFiles
      }
    });
  } catch (error) {
    console.error(`[cleanTestData Error] ${error.message}`);
    res.status(500).json({ error: error.message });
  }
}
