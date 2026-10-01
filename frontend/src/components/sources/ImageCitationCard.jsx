import React from "react";
import { Image as ImageIcon, ZoomIn } from "lucide-react";
import { useChat } from "../../context/ChatContext";

export function ImageCitationCard({ image }) {
  const { setLightboxImage } = useChat();

  return (
    <div
      onClick={() => setLightboxImage(image)}
      className="relative group cursor-pointer overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 shadow-sm hover:shadow-md transition w-44"
    >
      <div className="h-28 w-full bg-neutral-200 dark:bg-neutral-950 flex items-center justify-center overflow-hidden">
        <img
          src={image.imagePath}
          alt={image.filename}
          className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
          onError={(e) => {
            e.target.style.display = "none";
          }}
        />
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-white">
          <ZoomIn className="w-5 h-5 drop-shadow" />
        </div>
      </div>
      <div className="p-2 bg-white dark:bg-neutral-900">
        <p className="text-[11px] font-medium text-neutral-800 dark:text-neutral-200 truncate">
          {image.filename || "Diagram"}
        </p>
        <div className="flex items-center justify-between text-[10px] text-neutral-500 dark:text-neutral-400 mt-0.5">
          <span>Page {image.pageNumber || 1}</span>
          {image.similarity ? (
            <span className="font-mono text-purple-600 dark:text-purple-400">
              {(image.similarity * 100).toFixed(0)}% SigLIP
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
