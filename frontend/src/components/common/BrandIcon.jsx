import React from "react";
import { FileText } from "lucide-react";

/**
 * Consistent RAG Chatbot Brand Icon across Sidebar and Chat Header.
 */
export function BrandIcon({
  className = "w-4 h-4",
  containerClassName = "w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-xs shrink-0"
}) {
  return (
    <div className={containerClassName}>
      <FileText className={className} />
    </div>
  );
}
