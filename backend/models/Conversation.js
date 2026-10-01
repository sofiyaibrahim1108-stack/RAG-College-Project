import mongoose from "mongoose";

const ConversationSchema = new mongoose.Schema(
  {
    title: { type: String, default: "New Conversation", trim: true },
    pinned: { type: Boolean, default: false, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

ConversationSchema.index({ updatedAt: -1 });

export const Conversation = mongoose.model("Conversation", ConversationSchema);
