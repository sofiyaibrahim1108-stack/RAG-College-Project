import mongoose from "mongoose";

const DocumentSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    originalName: { type: String, required: true },
    filename: { type: String, required: true },
    path: { type: String, required: true },
    fileType: {
      type: String,
      enum: ["pdf", "doc", "docx", "txt", "csv", "xls", "xlsx", "ppt", "pptx", "md", "markdown", "json", "html", "xml", "other"],
      required: true
    },
    size: { type: Number, default: 0 },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      default: null,
      index: true
    },
    department: { type: String, required: true, trim: true, index: true },
    isTestData: { type: Boolean, default: false, index: true },
    createdBy: { type: String, default: "user" },
    status: {
      type: String,
      enum: ["uploading", "processing", "completed", "failed"],
      default: "processing",
      index: true
    },
    errorMessage: { type: String, default: null },
    chunkCount: { type: Number, default: 0 },
    imageCount: { type: Number, default: 0 },
    source: { type: String, enum: ["upload", "google-drive"], default: "upload" },
    driveFileId: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

DocumentSchema.index({ department: 1, status: 1 });
DocumentSchema.index({ createdAt: -1 });

export const Document = mongoose.model("Document", DocumentSchema);
