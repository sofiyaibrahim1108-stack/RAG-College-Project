import React from "react";
import { X, ExternalLink, FileText } from "lucide-react";
import { useChat } from "../../context/ChatContext";

export function Lightbox() {
  const { lightboxImage, setLightboxImage } = useChat();

  if (!lightboxImage) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={() => setLightboxImage(null)}
    >
      <div
        className="relative max-w-4xl w-full bg-neutral-900 border border-neutral-800 rounded-2xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-900/90">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-blue-500/10 text-blue-400 rounded-lg">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-neutral-100 text-sm">
                {lightboxImage.filename || "Document Diagram"}
              </h3>
              <p className="text-xs text-neutral-400">
                Source: {lightboxImage.documentName} {lightboxImage.pageNumber ? `• Page ${lightboxImage.pageNumber}` : ""}
              </p>
            </div>
          </div>
          <button
            onClick={() => setLightboxImage(null)}
            className="p-2 text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Image Display */}
        <div className="p-6 flex items-center justify-center bg-neutral-950/60 max-h-[70vh] overflow-auto">
          <img
            src={lightboxImage.imagePath}
            alt={lightboxImage.filename}
            className="max-h-[60vh] max-w-full object-contain rounded-lg shadow-md"
          />
        </div>

        {/* Footer info */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-neutral-800 bg-neutral-900/90 text-xs text-neutral-400">
          <span>
            {lightboxImage.similarity ? `SigLIP2 Multimodal Match: ${(lightboxImage.similarity * 100).toFixed(1)}%` : ""}
          </span>
          <a
            href={lightboxImage.imagePath}
            target="_blank"
            rel="noreferrer"
            className="flex items-center space-x-1 text-blue-400 hover:underline"
          >
            <span>Open Original</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}
