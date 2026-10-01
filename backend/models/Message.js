import mongoose from "mongoose";

const SourceCitationSchema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document" },
    documentName: { type: String, required: true },
    pageNumber: { type: Number, default: 1 },
    chunkIndex: { type: Number },
    snippet: { type: String },
    similarity: { type: Number }
  },
  { _id: false }
);

const ImageCitationSchema = new mongoose.Schema(
  {
    imageId: { type: String, required: true },
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document" },
    documentName: { type: String, required: true },
    pageNumber: { type: Number, default: 1 },
    filename: { type: String },
    imagePath: { type: String, required: true },
    similarity: { type: Number }
  },
  { _id: false }
);

const MessageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true
    },
    role: {
      type: String,
      enum: ["user", "assistant", "system"],
      required: true
    },
    content: {
      type: String,
      required: true
    },
    routedDepartments: {
      type: [String],
      default: []
    },
    sources: [SourceCitationSchema],
    images: [ImageCitationSchema],
    timings: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    feedback: {
      type: String,
      enum: ["like", "dislike", null],
      default: null
    }
  },
  { timestamps: true }
);

MessageSchema.index({ conversationId: 1, createdAt: 1 });

export const Message = mongoose.model("Message", MessageSchema);
