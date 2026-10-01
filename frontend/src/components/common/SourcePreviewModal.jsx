import React from "react";
import { X, BookOpen, FileCheck, Layers } from "lucide-react";
import { useChat } from "../../context/ChatContext";

export function SourcePreviewModal() {
  const { previewSource, setPreviewSource } = useChat();

  if (!previewSource) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={() => setPreviewSource(null)}
    >
      <div
        className="relative max-w-2xl w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/90">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-lg">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-neutral-900 dark:text-neutral-100 text-sm">
                {previewSource.documentName}
              </h3>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 flex items-center gap-2 mt-0.5">
                <span>Page {previewSource.pageNumber || 1}</span>
                {previewSource.chunkIndex !== undefined && (
                  <span>• Chunk #{previewSource.chunkIndex}</span>
                )}
              </p>
            </div>
          </div>
          <button
            onClick={() => setPreviewSource(null)}
            className="p-2 text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-200 dark:hover:bg-neutral-800 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Excerpt */}
        <div className="p-6 max-h-[60vh] overflow-y-auto bg-neutral-50/50 dark:bg-neutral-950/40">
          <div className="flex items-center justify-between mb-3 text-xs text-neutral-500 dark:text-neutral-400">
            <span className="flex items-center gap-1.5 font-medium">
              <FileCheck className="w-4 h-4 text-emerald-500" />
              Retrieved Grounding Excerpt
            </span>
            {previewSource.similarity && (
              <span className="px-2 py-0.5 bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 rounded font-mono">
                Similarity: {(previewSource.similarity * 100).toFixed(1)}%
              </span>
            )}
          </div>
          <div className="p-4 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl text-neutral-800 dark:text-neutral-200 text-sm leading-relaxed whitespace-pre-wrap font-sans">
            {previewSource.snippet || previewSource.content}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-3 border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/90">
          <button
            onClick={() => setPreviewSource(null)}
            className="px-4 py-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-800 rounded-lg transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
