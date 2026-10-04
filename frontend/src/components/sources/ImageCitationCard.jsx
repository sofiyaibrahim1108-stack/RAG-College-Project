import React from "react";
import { Image as ImageIcon, ZoomIn } from "lucide-react";
import { useChat } from "../../context/ChatContext";

export function ImageCitationCard({ image }) {
  const { setLightboxImage } = useChat();

  return (
    <div
      onClick={() => setLightboxImage(image)}
      className="relative group cursor-pointer overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 shadow-sm hover:shadow-md transition w-48"
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
      <div className="p-2.5 bg-white dark:bg-neutral-900 border-t border-neutral-200/60 dark:border-neutral-800">
        <p className="text-xs font-semibold text-neutral-800 dark:text-neutral-100 truncate" title={image.caption || image.filename}>
          {image.documentName || "Document"}
        </p>
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400 truncate mt-0.5" title={image.caption || image.filename}>
          {image.caption || image.filename || "Diagram"}
        </p>
        <div className="flex items-center justify-between text-[11px] text-neutral-500 dark:text-neutral-400 mt-1.5 pt-1 border-t border-neutral-100 dark:border-neutral-800/50">
          <span className="font-medium text-neutral-600 dark:text-neutral-300">Page {image.pageNumber || 1}</span>
          <span className="text-[10px] text-neutral-400">Click to expand</span>
        </div>
      </div>
    </div>
  );
}
