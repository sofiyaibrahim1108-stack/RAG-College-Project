import { Conversation } from "../models/Conversation.js";
import { Message } from "../models/Message.js";

/**
 * Get all conversations with optional title search
 */
export async function getConversations(req, res) {
  try {
    const { search } = req.query;
    const query = {};

    if (search) {
      query.title = { $regex: search, $options: "i" };
    }

    const conversations = await Conversation.find(query)
      .sort({ pinned: -1, updatedAt: -1 })
      .lean();

    res.json({ success: true, count: conversations.length, conversations });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

/**
 * Create a new conversation
 */
export async function createConversation(req, res) {
  try {
    const title = req.body.title || "New Chat";
    const conversation = await Conversation.create({ title });
    res.status(201).json({ success: true, conversation });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

/**
 * Get single conversation with all its messages
 */
export async function getConversationById(req, res) {
  try {
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const messages = await Message.find({ conversationId: conversation._id }).sort({
      createdAt: 1
    });

    res.json({ success: true, conversation, messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

/**
 * Update conversation (rename or pin/unpin)
 */
export async function updateConversation(req, res) {
  try {
    const { title, pinned } = req.body;
    const updates = {};

    if (typeof title === "string") updates.title = title.trim();
    if (typeof pinned === "boolean") updates.pinned = pinned;

    const conversation = await Conversation.findByIdAndUpdate(req.params.id, updates, {
      new: true
    });

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    res.json({ success: true, conversation });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

/**
 * Delete a conversation and its messages
 */
export async function deleteConversation(req, res) {
  try {
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    await Message.deleteMany({ conversationId: conversation._id });
    await Conversation.findByIdAndDelete(conversation._id);

    res.json({ success: true, message: "Conversation and messages deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
