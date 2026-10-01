import mongoose from "mongoose";

const DocumentChunkSchema = new mongoose.Schema(
  {
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
      required: true,
      index: true
    },
    documentName: { type: String, required: true },
    pageNumber: { type: Number, default: 1 },
    chunkIndex: { type: Number, required: true },
    content: { type: String, required: true },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      default: null,
      index: true
    },
    department: { type: String, required: true, trim: true, index: true },
    isTestData: { type: Boolean, default: false, index: true },
    sourceType: { type: String, default: "upload" },
    sourcePath: { type: String, default: "" },
    embedding: {
      type: [Number],
      required: true
    }
  },
  { timestamps: true }
);

DocumentChunkSchema.index({ department: 1, documentId: 1 });
DocumentChunkSchema.index({ documentName: 1, pageNumber: 1 });

export const DocumentChunk = mongoose.model("DocumentChunk", DocumentChunkSchema);
