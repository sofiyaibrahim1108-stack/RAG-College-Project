import express from "express";
import { getTestDataSummary, cleanTestData } from "../controllers/testDataController.js";

const router = express.Router();

router.get("/summary", getTestDataSummary);
router.post("/cleanup", cleanTestData);

export default router;
