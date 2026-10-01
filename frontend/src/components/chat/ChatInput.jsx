import React, { useState, useRef, useEffect } from "react";
import {
  ArrowUp,
  Square,
  Paperclip,
  Cloud,
  Sparkles,
  Loader2
} from "lucide-react";
import { useChat } from "../../context/ChatContext";

export function ChatInput() {
  const {
    sendMessage,
    isStreaming,
    stopGeneration,
    streamStatusText,
    setShowUploadModal,
    setShowDriveModal
  } = useChat();

  const [input, setInput] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(
        textareaRef.current.scrollHeight,
        200
      )}px`;
    }
  }, [input]);

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleSubmit() {
    if (!input.trim() || isStreaming) return;
    sendMessage(input.trim());
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(e) {
    e.preventDefault();
    setIsDragging(false);
    setShowUploadModal(true);
  }

  return (
    <div
      className="w-full max-w-4xl mx-auto px-4 pb-4 pt-1"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay notice */}
      {isDragging && (
        <div className="mb-2 p-3 bg-blue-500/10 border-2 border-dashed border-blue-500 rounded-2xl text-center text-xs text-blue-600 dark:text-blue-400 font-medium animate-pulse">
          Drop PDF, DOC, DOCX, TXT, CSV, XLS, XLSX, PPT, PPTX, MD, JSON, HTML, or XML file here
        </div>
      )}

      {/* Dynamic retrieval status indicator */}
      {isStreaming && streamStatusText && (
        <div className="mb-2 flex items-center justify-center space-x-2 text-xs text-blue-600 dark:text-blue-400 animate-pulse">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>{streamStatusText}</span>
        </div>
      )}

      {/* Main input card */}
      <div className="relative rounded-2xl border border-neutral-300 dark:border-neutral-700/80 bg-white dark:bg-neutral-900 shadow-sm focus-within:ring-2 focus-within:ring-blue-500/30 focus-within:border-blue-500 transition-all">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything about your documents, architecture, or code..."
          rows={1}
          className="w-full resize-none bg-transparent px-4 pt-3.5 pb-12 text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none min-h-[52px] max-h-48"
        />

        {/* Bottom toolbar */}
        <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between pointer-events-auto">
          {/* Left tools: Attach document & Google Drive */}
          <div className="flex items-center space-x-1">
            <button
              type="button"
              onClick={() => setShowUploadModal(true)}
              className="p-1.5 text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition flex items-center space-x-1 text-xs"
              title="Attach document (PDF, DOC, DOCX, TXT, CSV, XLS, XLSX, PPT, PPTX, MD, JSON...)"
            >
              <Paperclip className="w-4 h-4" />
              <span className="hidden sm:inline">Attach File</span>
            </button>

            <button
              type="button"
              onClick={() => setShowDriveModal(true)}
              className="p-1.5 text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition flex items-center space-x-1 text-xs"
              title="Import from Google Drive"
            >
              <Cloud className="w-4 h-4 text-emerald-500" />
              <span className="hidden sm:inline">Google Drive</span>
            </button>
          </div>

          {/* Right action: Send or Stop */}
          <div>
            {isStreaming ? (
              <button
                type="button"
                onClick={stopGeneration}
                className="p-2 rounded-xl bg-red-600 hover:bg-red-700 text-white shadow transition flex items-center justify-center"
                title="Stop generation"
              >
                <Square className="w-4 h-4 fill-white" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!input.trim()}
                className={`p-2 rounded-xl transition flex items-center justify-center shadow-sm ${
                  input.trim()
                    ? "bg-blue-600 hover:bg-blue-700 text-white"
                    : "bg-neutral-200 dark:bg-neutral-800 text-neutral-400 cursor-not-allowed"
                }`}
                title="Send question"
              >
                <ArrowUp className="w-4 h-4 stroke-[2.5]" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mt-2 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
        AI Knowledge Assistant grounded in your local documents via LangGraph & SigLIP2.
      </div>
    </div>
  );
}
