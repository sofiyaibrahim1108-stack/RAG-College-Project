import multer from "multer";
import path from "path";
import fs from "fs";
import { ENV } from "../config/env.js";

// Ensure upload directory exists
const documentUploadDir = path.join(ENV.UPLOAD_DIR, "documents");
fs.mkdirSync(documentUploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, documentUploadDir);
  },
  filename: function (req, file, cb) {
    const timestamp = Date.now();
    // Sanitize filename: replace spaces and special characters
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${timestamp}_${sanitized}`);
  }
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExts = [
    ".pdf",
    ".doc",
    ".docx",
    ".txt",
    ".csv",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".md",
    ".markdown",
    ".json",
    ".html",
    ".htm",
    ".xml"
  ];

  if (allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Unsupported file type: ${ext}. Supported formats: PDF, DOC, DOCX, TXT, CSV, XLS, XLSX, PPT, PPTX, Markdown, JSON, HTML, XML`
      ),
      false
    );
  }
};

export const uploadMiddleware = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB
  }
});
