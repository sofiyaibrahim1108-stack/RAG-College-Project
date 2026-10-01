import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config(); // fallback to current dir

export const ENV = {
  PORT: process.env.PORT || 5000,
  MONGO_URI: process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/rag_college_db",
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  OLLAMA_LLM_MODEL: process.env.OLLAMA_CHAT_MODEL || process.env.OLLAMA_LLM_MODEL || "qwen2.5-coder:3b",
  OLLAMA_EMBED_MODEL: process.env.OLLAMA_EMBED_MODEL || "mxbai-embed-large:latest",
  SIGLIP_SERVICE_URL: process.env.SIGLIP_SERVICE_URL || "http://127.0.0.1:8000",
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || "",
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || "http://localhost:5000/api/drive/callback",
  JWT_SECRET: process.env.JWT_SECRET || "rag-college-secret-key-2026",
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.resolve(__dirname, "../uploads")
};
