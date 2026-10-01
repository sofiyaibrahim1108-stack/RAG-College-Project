import React, { useState, useEffect } from "react";
import {
  Database,
  Cpu,
  Layers,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Cloud,
  Sliders,
  RefreshCw
} from "lucide-react";
import { useChat } from "../context/ChatContext";
import { driveApi } from "../services/driveApi";

export function SettingsPage() {
  const { systemHealth, theme, toggleTheme, driveConnected } = useChat();
  const [driveConfig, setDriveConfig] = useState({ configured: false });

  useEffect(() => {
    driveApi.getDriveStatus().then((status) => {
      setDriveConfig(status || { configured: false });
    });
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-6 max-w-5xl mx-auto">
      <div>
        <h2 className="text-xl font-bold text-neutral-900 dark:text-white">
          System & RAG Configuration
        </h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
          Diagnostics and settings for MongoDB, Ollama LLM, Python SigLIP2, and Google Drive.
        </p>
      </div>

      {/* Diagnostics Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* MongoDB Status */}
        <div className="p-5 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-xs space-y-3">
          <div className="flex items-center justify-between">
            <div className="p-2.5 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 rounded-xl">
              <Database className="w-5 h-5" />
            </div>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Connected
            </span>
          </div>
          <div>
            <h3 className="font-semibold text-sm text-neutral-900 dark:text-neutral-100">
              Local MongoDB
            </h3>
            <p className="text-xs text-neutral-400 mt-0.5 font-mono">
              localhost:27017
            </p>
          </div>
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400 border-t border-neutral-100 dark:border-neutral-800 pt-2">
            Compatible with MongoDB Compass. Stores all vectors, chunks, and sessions.
          </p>
        </div>

        {/* Ollama LLM Status */}
        <div className="p-5 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-xs space-y-3">
          <div className="flex items-center justify-between">
            <div className="p-2.5 bg-blue-50 dark:bg-blue-950/40 text-blue-600 rounded-xl">
              <Cpu className="w-5 h-5" />
            </div>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Active
            </span>
          </div>
          <div>
            <h3 className="font-semibold text-sm text-neutral-900 dark:text-neutral-100">
              Ollama Local Models
            </h3>
            <p className="text-xs text-neutral-400 mt-0.5 font-mono truncate">
              qwen2.5-coder:3b
            </p>
          </div>
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400 border-t border-neutral-100 dark:border-neutral-800 pt-2">
            LLM: Qwen 2.5 Coder 3B • Embed: mxbai-embed-large (1024-dim).
          </p>
        </div>

        {/* SigLIP2 Microservice Status */}
        <div className="p-5 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-xs space-y-3">
          <div className="flex items-center justify-between">
            <div className="p-2.5 bg-purple-50 dark:bg-purple-950/40 text-purple-600 rounded-xl">
              <Sparkles className="w-5 h-5" />
            </div>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                systemHealth?.siglip?.status === "ok"
                  ? "bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300"
                  : "bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300"
              }`}
            >
              <CheckCircle2 className="w-3 h-3 mr-1" />
              {systemHealth?.siglip?.status === "ok" ? "Active" : "Standby"}
            </span>
          </div>
          <div>
            <h3 className="font-semibold text-sm text-neutral-900 dark:text-neutral-100">
              Python SigLIP2
            </h3>
            <p className="text-xs text-neutral-400 mt-0.5 font-mono">
              768-dim Multimodal
            </p>
          </div>
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400 border-t border-neutral-100 dark:border-neutral-800 pt-2">
            Cross-modal embeddings comparing questions to document diagrams.
          </p>
        </div>

        {/* Google Drive Status */}
        <div className="p-5 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-xs space-y-3">
          <div className="flex items-center justify-between">
            <div className="p-2.5 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 rounded-xl">
              <Cloud className="w-5 h-5" />
            </div>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                driveConnected
                  ? "bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300"
                  : driveConfig.configured
                  ? "bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
                  : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400"
              }`}
            >
              {driveConnected ? (
                <>
                  <CheckCircle2 className="w-3 h-3 mr-1" />
                  Connected
                </>
              ) : driveConfig.configured ? (
                "Ready to Connect"
              ) : (
                "Not Configured"
              )}
            </span>
          </div>
          <div>
            <h3 className="font-semibold text-sm text-neutral-900 dark:text-neutral-100">
              Google Drive
            </h3>
            <p className="text-xs text-neutral-400 mt-0.5 font-mono">
              OAuth 2.0 API
            </p>
          </div>
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400 border-t border-neutral-100 dark:border-neutral-800 pt-2">
            {driveConnected
              ? "Account connected and ready for cloud document imports."
              : driveConfig.configured
              ? "OAuth credentials detected in backend/.env."
              : "Requires GOOGLE_CLIENT_ID & SECRET in backend/.env."}
          </p>
        </div>
      </div>

      {/* RAG Pipeline Settings Table */}
      <div className="p-6 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Sliders className="w-5 h-5 text-blue-500" />
            <h3 className="font-semibold text-sm text-neutral-900 dark:text-neutral-100">
              RAG Pipeline Hyperparameters
            </h3>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-2">
          <div className="p-3 bg-neutral-50 dark:bg-neutral-950/60 rounded-xl border border-neutral-200 dark:border-neutral-800">
            <span className="text-[11px] text-neutral-400 block">Chunk Size</span>
            <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">700 characters</span>
          </div>

          <div className="p-3 bg-neutral-50 dark:bg-neutral-950/60 rounded-xl border border-neutral-200 dark:border-neutral-800">
            <span className="text-[11px] text-neutral-400 block">Chunk Overlap</span>
            <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">100 characters</span>
          </div>

          <div className="p-3 bg-neutral-50 dark:bg-neutral-950/60 rounded-xl border border-neutral-200 dark:border-neutral-800">
            <span className="text-[11px] text-neutral-400 block">Top-K Text Excerpts</span>
            <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">3 chunks</span>
          </div>

          <div className="p-3 bg-neutral-50 dark:bg-neutral-950/60 rounded-xl border border-neutral-200 dark:border-neutral-800">
            <span className="text-[11px] text-neutral-400 block">Top-K SigLIP Images</span>
            <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">2 diagrams</span>
          </div>
        </div>
      </div>

      {/* Google Drive Configuration Guide */}
      <div className="p-6 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-xs space-y-3">
        <div className="flex items-center space-x-2 text-emerald-600 dark:text-emerald-400 font-semibold text-sm">
          <Cloud className="w-5 h-5" />
          <span>Google Drive Integration</span>
        </div>
        <p className="text-xs text-neutral-600 dark:text-neutral-300 leading-relaxed">
          To enable Google Drive imports, create an OAuth 2.0 Client ID in the{" "}
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noreferrer"
            className="text-blue-500 hover:underline"
          >
            Google Cloud Console
          </a>{" "}
          and configure in your root <code className="px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 font-mono text-[11px]">.env</code>:
        </p>
        <pre className="p-3 rounded-xl bg-neutral-100 dark:bg-neutral-950 text-xs font-mono text-neutral-800 dark:text-neutral-200 overflow-x-auto">
{`GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://localhost:5000/api/drive/callback`}
        </pre>
      </div>
    </div>
  );
}
