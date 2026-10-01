import React from "react";
import { FileText, ChevronRight } from "lucide-react";
import { useChat } from "../../context/ChatContext";

export function SourceCitationCard({ source }) {
  const { setPreviewSource } = useChat();

  return (
    <button
      onClick={() => setPreviewSource(source)}
      className="flex items-center space-x-2 px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-neutral-900/80 hover:bg-neutral-100 dark:hover:bg-neutral-800/80 transition group text-left max-w-xs shadow-sm"
      title="Click to view grounding excerpt"
    >
      <div className="p-1 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 group-hover:bg-blue-500/20 transition">
        <FileText className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-neutral-800 dark:text-neutral-200 truncate">
          {source.documentName}
        </p>
        <p className="text-[10px] text-neutral-500 dark:text-neutral-400">
          Page {source.pageNumber || 1}
          {source.similarity ? ` • ${(source.similarity * 100).toFixed(0)}% match` : ""}
        </p>
      </div>
      <ChevronRight className="w-3 h-3 text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-200 transition" />
    </button>
  );
}
