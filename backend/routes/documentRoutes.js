import express from "express";
import {
  uploadDocument,
  getDocuments,
  getDocumentById,
  deleteDocument,
  bulkDeleteDocuments,
  reprocessDocument,
  serveDocumentImage
} from "../controllers/documentController.js";
import { uploadMiddleware } from "../middleware/uploadMiddleware.js";

const router = express.Router();

router.post("/upload", uploadMiddleware.single("file"), uploadDocument);
router.post("/bulk-delete", bulkDeleteDocuments);
router.get("/", getDocuments);
router.get("/:id", getDocumentById);
router.post("/:id/reprocess", reprocessDocument);
router.delete("/:id", deleteDocument);
router.get("/images/:docId/:filename", serveDocumentImage);

export default router;
