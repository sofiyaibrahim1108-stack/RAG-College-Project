import mongoose from "mongoose";

const ImageSchema = new mongoose.Schema(
  {
    imageId: { type: String, required: true, unique: true, index: true },
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
      required: true,
      index: true
    },
    documentName: { type: String, required: true },
    pageNumber: { type: Number, default: 1 },
    filename: { type: String, required: true },
    imagePath: { type: String, required: true },
    mimeType: { type: String, default: "image/png" },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      default: null,
      index: true
    },
    department: { type: String, required: true, trim: true, index: true },
    isTestData: { type: Boolean, default: false, index: true },
    embedding: {
      type: [Number],
      required: true
    },
    caption: { type: String, default: "" },
    description: { type: String, default: "" }
  },
  { timestamps: true }
);

ImageSchema.index({ documentId: 1, pageNumber: 1 });

export const ImageModel = mongoose.model("Image", ImageSchema);
