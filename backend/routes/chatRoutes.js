import express from "express";
import {
  askQuestion,
  askQuestionStream,
  submitFeedback
} from "../controllers/chatController.js";

const router = express.Router();

router.post("/ask", askQuestion);
router.post("/stream", askQuestionStream);
router.post("/messages/:messageId/feedback", submitFeedback);

export default router;
