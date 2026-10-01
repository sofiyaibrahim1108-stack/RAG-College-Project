import express from "express";
import {
  getConversations,
  createConversation,
  getConversationById,
  updateConversation,
  deleteConversation
} from "../controllers/conversationController.js";

const router = express.Router();

router.get("/", getConversations);
router.post("/", createConversation);
router.get("/:id", getConversationById);
router.patch("/:id", updateConversation);
router.delete("/:id", deleteConversation);

export default router;
