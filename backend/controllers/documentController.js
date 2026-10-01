import path from "path";
import fs from "fs";
import { Document } from "../models/Document.js";
import { DocumentChunk } from "../models/DocumentChunk.js";
import { ImageModel } from "../models/Image.js";
import { processDocument } from "../services/documentProcessor.js";
import { ENV } from "../config/env.js";

import { Department } from "../models/Department.js";

/**
 * Upload single or multiple documents
 */
export async function uploadDocument(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { departmentId, department: deptNameParam, isTestData, title } = req.body;

    // Requirement: Department selection is mandatory - no silent default
    if (!departmentId && (!deptNameParam || !deptNameParam.trim())) {
      return res.status(400).json({
        error: "Department selection is mandatory. Please select or create a department before uploading."
      });
    }

    // Verify department against database
    let departmentDoc = null;
    if (departmentId) {
      departmentDoc = await Department.findById(departmentId);
    } else if (deptNameParam) {
      departmentDoc = await Department.findOne({
        name: { $regex: new RegExp(`^${deptNameParam.trim()}$`, "i") }
      });
    }

    if (!departmentDoc) {
      return res.status(400).json({
        error: `Selected department is invalid or does not exist in the database. Please select a valid department.`
      });
    }

    const file = req.file;
    const departmentName = departmentDoc.name;
    const ext = path.extname(file.originalname).toLowerCase().replace(".", "");

    let fileType = "other";
    if (ext === "pdf") fileType = "pdf";
    else if (ext === "docx") fileType = "docx";
    else if (ext === "doc") fileType = "doc";
    else if (ext === "txt") fileType = "txt";
    else if (ext === "csv") fileType = "csv";
    else if (ext === "xlsx") fileType = "xlsx";
    else if (ext === "xls") fileType = "xls";
    else if (ext === "pptx") fileType = "pptx";
    else if (ext === "ppt") fileType = "ppt";
    else if (ext === "md" || ext === "markdown") fileType = "markdown";
    else if (ext === "json") fileType = "json";
    else if (ext === "html" || ext === "htm") fileType = "html";
    else if (ext === "xml") fileType = "xml";

    const document = await Document.create({
      title: title || file.originalname,
      originalName: file.originalname,
      filename: file.filename,
      path: file.path,
      fileType: fileType,
      mimeType: file.mimetype,
      size: file.size,
      departmentId: departmentDoc._id,
      department: departmentName,
      isTestData: isTestData === "true" || isTestData === true || departmentDoc.isTestData === true,
      status: "processing",
      source: "upload"
    });

    // Run processing asynchronously so response returns fast with processing status
    processDocument(document._id).catch((err) => {
      console.error(`[Upload] Document processing error: ${err.message}`);
    });

    res.status(201).json({
      success: true,
      message: "Document uploaded and processing started",
      document
    });
  } catch (error) {
    console.error(`[Upload Error] ${error.message}`);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Get all documents with optional filtering
 */
export async function getDocuments(req, res) {
  try {
    const { department, status, search } = req.query;
    const query = {};

    if (department && department !== "All") {
      query.department = department;
    }
    if (status) {
      query.status = status;
    }
    if (search) {
      query.$or = [
        { originalName: { $regex: search, $options: "i" } },
        { title: { $regex: search, $options: "i" } }
      ];
    }

    const documents = await Document.find(query).sort({ createdAt: -1 });
    res.json({ success: true, count: documents.length, documents });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

/**
 * Get document by ID
 */
export async function getDocumentById(req, res) {
  try {
    const document = await Document.findById(req.params.id);
    if (!document) {
      return res.status(404).json({ error: "Document not found" });
    }

    const chunks = await DocumentChunk.find({ documentId: document._id })
      .select("-embedding")
      .sort({ chunkIndex: 1 });

    const images = await ImageModel.find({ documentId: document._id })
      .select("-embedding")
      .sort({ pageNumber: 1 });

    res.json({
      success: true,
      document,
      chunks,
      images
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

/**
 * Re-process an existing document
 */
export async function reprocessDocument(req, res) {
  try {
    const document = await Document.findById(req.params.id);
    if (!document) {
      return res.status(404).json({ error: "Document not found" });
    }

    if (!fs.existsSync(document.path)) {
      return res.status(400).json({ error: "Source file no longer exists on disk" });
    }

    document.status = "processing";
    document.errorMessage = null;
    await document.save();

    // Trigger re-processing
    processDocument(document._id).catch((err) => {
      console.error(`[Reprocess Error] ${err.message}`);
    });

    res.json({
      success: true,
      message: "Document reprocessing started",
      document
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

/**
 * Delete document and associated chunks and images
 */
export async function deleteDocument(req, res) {
  try {
    const document = await Document.findById(req.params.id);
    if (!document) {
      return res.status(404).json({ error: "Document not found" });
    }

    // Delete chunks
    await DocumentChunk.deleteMany({ documentId: document._id });

    // Delete images and files
    const images = await ImageModel.find({ documentId: document._id });
    for (const img of images) {
      if (img.imagePath && fs.existsSync(img.imagePath)) {
        try {
          fs.unlinkSync(img.imagePath);
        } catch (e) {}
      }
    }
    await ImageModel.deleteMany({ documentId: document._id });

    // Delete uploaded source file
    if (document.path && fs.existsSync(document.path)) {
      try {
        fs.unlinkSync(document.path);
      } catch (e) {}
    }

    // Delete image dir if exists
    const docImgDir = path.join(ENV.UPLOAD_DIR, "images", document._id.toString());
    if (fs.existsSync(docImgDir)) {
      try {
        fs.rmSync(docImgDir, { recursive: true, force: true });
      } catch (e) {}
    }

    await Document.findByIdAndDelete(document._id);

    res.json({ success: true, message: "Document and related artifacts removed" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

/**
 * Bulk delete documents with confirmation
 */
export async function bulkDeleteDocuments(req, res) {
  try {
    const { documentIds } = req.body;
    if (!documentIds || !Array.isArray(documentIds) || documentIds.length === 0) {
      return res.status(400).json({ error: "documentIds array is required" });
    }

    const documents = await Document.find({ _id: { $in: documentIds } });
    if (documents.length === 0) {
      return res.status(404).json({ error: "No matching documents found" });
    }

    const ids = documents.map((d) => d._id);

    // 1. Delete associated chunks
    await DocumentChunk.deleteMany({ documentId: { $in: ids } });

    // 2. Delete associated images and their image files
    const images = await ImageModel.find({ documentId: { $in: ids } });
    for (const img of images) {
      if (img.imagePath && fs.existsSync(img.imagePath)) {
        try {
          fs.unlinkSync(img.imagePath);
        } catch (e) {}
      }
    }
    await ImageModel.deleteMany({ documentId: { $in: ids } });

    // 3. Delete uploaded source files and doc image folders
    for (const doc of documents) {
      if (doc.path && fs.existsSync(doc.path)) {
        try {
          fs.unlinkSync(doc.path);
        } catch (e) {}
      }
      const docImgDir = path.join(ENV.UPLOAD_DIR, "images", doc._id.toString());
      if (fs.existsSync(docImgDir)) {
        try {
          fs.rmSync(docImgDir, { recursive: true, force: true });
        } catch (e) {}
      }
    }

    // 4. Delete document records
    const deleteResult = await Document.deleteMany({ _id: { $in: ids } });

    res.json({
      success: true,
      message: `Successfully deleted ${deleteResult.deletedCount} document(s) and their associated chunks, images, and embeddings.`,
      deletedCount: deleteResult.deletedCount
    });
  } catch (error) {
    console.error(`[bulkDeleteDocuments Error] ${error.message}`);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Serves extracted image files
 */
export function serveDocumentImage(req, res) {
  const { docId, filename } = req.params;
  const safeFilename = path.basename(filename);
  const filePath = path.join(ENV.UPLOAD_DIR, "images", docId, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Image file not found" });
  }

  res.sendFile(filePath);
}
