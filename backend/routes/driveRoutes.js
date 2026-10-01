import express from "express";
import {
  getAuthUrl,
  handleOAuthCallback,
  listDriveFiles,
  importDriveFile,
  getDriveStatus
} from "../controllers/driveController.js";

const router = express.Router();

router.get("/status", getDriveStatus);
router.get("/auth-url", getAuthUrl);
router.get("/callback", handleOAuthCallback);
router.get("/files", listDriveFiles);
router.post("/import", importDriveFile);

export default router;
