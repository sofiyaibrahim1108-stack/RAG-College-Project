import fs from "fs";
import path from "path";
import { google } from "googleapis";
import { ENV } from "../config/env.js";
import { Document } from "../models/Document.js";
import { processDocument } from "./documentProcessor.js";

// Scopes required for Google Drive browsing and downloading
const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly"
];

export class DriveService {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      ENV.GOOGLE_CLIENT_ID,
      ENV.GOOGLE_CLIENT_SECRET,
      ENV.GOOGLE_REDIRECT_URI
    );
  }

  /**
   * Generates authorization URL for Google OAuth
   */
  getAuthUrl() {
    if (!ENV.GOOGLE_CLIENT_ID || !ENV.GOOGLE_CLIENT_SECRET) {
      throw new Error(
        "Google OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) are not configured."
      );
    }

    return this.oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent"
    });
  }

  /**
   * Exchanges authorization code for OAuth tokens
   */
  async getTokens(code) {
    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    return tokens;
  }

  /**
   * Creates an authenticated client from tokens
   */
  getClientWithTokens(tokens) {
    const client = new google.auth.OAuth2(
      ENV.GOOGLE_CLIENT_ID,
      ENV.GOOGLE_CLIENT_SECRET,
      ENV.GOOGLE_REDIRECT_URI
    );
    client.setCredentials(tokens);
    return client;
  }

  /**
   * Lists supported documents (PDF, DOCX, TXT) from Google Drive
   */
  async listFiles(tokens, pageToken = null) {
    const auth = this.getClientWithTokens(tokens);
    const drive = google.drive({ version: "v3", auth });

    // Filter for all supported document formats
    const supportedMimes = [
      "mimeType = 'application/pdf'",
      "mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'",
      "mimeType = 'application/msword'",
      "mimeType = 'text/plain'",
      "mimeType = 'text/csv'",
      "mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'",
      "mimeType = 'application/vnd.ms-excel'",
      "mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'",
      "mimeType = 'application/vnd.ms-powerpoint'",
      "mimeType = 'text/markdown'",
      "mimeType = 'application/json'",
      "mimeType = 'text/html'",
      "mimeType = 'text/xml'",
      "mimeType = 'application/xml'",
      "mimeType = 'application/vnd.google-apps.document'",
      "mimeType = 'application/vnd.google-apps.spreadsheet'",
      "mimeType = 'application/vnd.google-apps.presentation'"
    ];
    const q = `trashed = false and (${supportedMimes.join(" or ")})`;

    const response = await drive.files.list({
      q: q,
      fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime, iconLink, thumbnailLink)",
      pageSize: 30,
      pageToken: pageToken
    });

    return {
      files: response.data.files || [],
      nextPageToken: response.data.nextPageToken || null
    };
  }

  /**
   * Imports a document from Google Drive into the local document library & RAG pipeline
   */
  async importFile(tokens, fileId, department, departmentId = null, isTestData = false) {
    if (!department) {
      throw new Error("Department is required for Google Drive document import");
    }

    // 1. Check for duplicate imports
    const existing = await Document.findOne({ driveFileId: fileId, status: "completed" });
    if (existing) {
      console.log(`[DriveService] File ${fileId} already imported as Document ${existing._id}`);
      return { document: existing, alreadyImported: true };
    }

    const auth = this.getClientWithTokens(tokens);
    const drive = google.drive({ version: "v3", auth });

    // Get file metadata
    const fileMeta = await drive.files.get({
      fileId,
      fields: "id, name, mimeType, size"
    });

    const originalName = fileMeta.data.name || "drive_document";
    const mimeType = fileMeta.data.mimeType;
    const ext = path.extname(originalName).toLowerCase().replace(".", "");

    let fileType = "other";
    const isGoogleWorkspace = mimeType.startsWith("application/vnd.google-apps.");

    if (mimeType === "application/pdf" || ext === "pdf") fileType = "pdf";
    else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext === "docx") fileType = "docx";
    else if (mimeType === "application/msword" || ext === "doc") fileType = "doc";
    else if (mimeType === "text/plain" || ext === "txt") fileType = "txt";
    else if (mimeType === "text/csv" || ext === "csv") fileType = "csv";
    else if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || ext === "xlsx") fileType = "xlsx";
    else if (mimeType === "application/vnd.ms-excel" || ext === "xls") fileType = "xls";
    else if (mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || ext === "pptx") fileType = "pptx";
    else if (mimeType === "application/vnd.ms-powerpoint" || ext === "ppt") fileType = "ppt";
    else if (mimeType === "text/markdown" || ext === "md" || ext === "markdown") fileType = "markdown";
    else if (mimeType === "application/json" || ext === "json") fileType = "json";
    else if (mimeType === "text/html" || ext === "html" || ext === "htm") fileType = "html";
    else if (mimeType === "text/xml" || mimeType === "application/xml" || ext === "xml") fileType = "xml";
    else if (isGoogleWorkspace) {
      // Export Google Docs/Sheets/Slides as standard PDF
      fileType = "pdf";
    }

    const timestamp = Date.now();
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${timestamp}_${safeName}${isGoogleWorkspace && !safeName.endsWith(".pdf") ? ".pdf" : ""}`;
    const destDir = path.join(ENV.UPLOAD_DIR, "documents");
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, filename);

    // Download file content stream
    const destStream = fs.createWriteStream(destPath);

    if (isGoogleWorkspace) {
      // Export as PDF
      const exportRes = await drive.files.export(
        { fileId, mimeType: "application/pdf" },
        { responseType: "stream" }
      );
      await new Promise((resolve, reject) => {
        exportRes.data.pipe(destStream).on("finish", resolve).on("error", reject);
      });
    } else {
      const getRes = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
      await new Promise((resolve, reject) => {
        getRes.data.pipe(destStream).on("finish", resolve).on("error", reject);
      });
    }

    const stats = fs.statSync(destPath);

    // Create Document record
    const document = await Document.create({
      title: originalName,
      originalName: originalName,
      filename: filename,
      path: destPath,
      fileType: fileType,
      mimeType: mimeType,
      size: stats.size,
      departmentId: departmentId,
      department: department,
      isTestData: isTestData,
      status: "processing",
      source: "google-drive",
      driveFileId: fileId
    });

    // Run RAG processing pipeline asynchronously
    processDocument(document._id).catch((err) => {
      console.error(`[DriveService] Background processing error: ${err.message}`);
    });

    return { document, alreadyImported: false };
  }
}

export const driveService = new DriveService();
