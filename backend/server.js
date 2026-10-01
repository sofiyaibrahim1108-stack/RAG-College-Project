import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { ENV } from "./config/env.js";
import { connectDB } from "./config/db.js";
import documentRoutes from "./routes/documentRoutes.js";
import driveRoutes from "./routes/driveRoutes.js";
import conversationRoutes from "./routes/conversationRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import departmentRoutes from "./routes/departmentRoutes.js";
import testDataRoutes from "./routes/testDataRoutes.js";
import { siglipClient } from "./services/siglipClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure essential upload directories exist
fs.mkdirSync(path.join(ENV.UPLOAD_DIR, "documents"), { recursive: true });
fs.mkdirSync(path.join(ENV.UPLOAD_DIR, "images"), { recursive: true });

const app = express();

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Static uploads serving
app.use("/uploads", express.static(ENV.UPLOAD_DIR));

// API Routes
app.use("/api/departments", departmentRoutes);
app.use("/api/test-data", testDataRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/drive", driveRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/chat", chatRoutes);

// System Health Check
app.get("/api/health", async (req, res) => {
  const siglipStatus = await siglipClient.checkHealth();
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    services: {
      backend: "running",
      mongodb: "connected",
      ollama: {
        model: ENV.OLLAMA_LLM_MODEL,
        embedModel: ENV.OLLAMA_EMBED_MODEL,
        url: ENV.OLLAMA_BASE_URL
      },
      siglip: siglipStatus
    }
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.url}` });
});

// Global Error Handler - Prevents any uncaught error from crashing the server
app.use((err, req, res, next) => {
  console.error(`[Global Error] ${err.stack || err.message}`);
  res.status(err.status || 500).json({
    error: err.message || "An unexpected internal server error occurred",
    details: process.env.NODE_ENV === "development" ? err.stack : undefined
  });
});

// Start Server
async function startServer() {
  try {
    await connectDB();
    app.listen(ENV.PORT, () => {
      console.log(`===============================================`);
      console.log(`🚀 RAG Knowledge Assistant Backend is LIVE!`);
      console.log(`📡 URL: http://localhost:${ENV.PORT}`);
      console.log(`💾 Database: ${ENV.MONGO_URI}`);
      console.log(`🧠 Ollama LLM: ${ENV.OLLAMA_LLM_MODEL}`);
      console.log(`🔍 Ollama Embeddings: ${ENV.OLLAMA_EMBED_MODEL}`);
      console.log(`🖼️ SigLIP2 Microservice: ${ENV.SIGLIP_SERVICE_URL}`);
      console.log(`===============================================`);
    });
  } catch (error) {
    console.error(`Fatal: Failed to connect to MongoDB: ${error.message}`);
    process.exit(1);
  }
}

startServer();
