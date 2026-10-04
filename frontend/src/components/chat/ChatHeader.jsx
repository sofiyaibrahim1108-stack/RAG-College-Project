import React, { useState } from "react";
import {
  Menu,
  Sun,
  Moon,
  Edit2,
  Check
} from "lucide-react";
import { BrandIcon } from "../common/BrandIcon";
import { useChat } from "../../context/ChatContext";

function formatConversationTitle(rawTitle = "") {
  if (!rawTitle) return "";
  let clean = rawTitle.replace(/^["']+|["']+$/g, "").trim();
  clean = clean.replace(/\.{2,}$/, "").trim();
  return clean;
}

export function ChatHeader({ onToggleSidebar }) {
  const {
    conversations,
    currentConversationId,
    messages,
    theme,
    toggleTheme,
    renameConversation,
    setActiveView
  } = useChat();

  const currentConv = conversations.find((c) => c._id === currentConversationId);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleText, setTitleText] = useState("");

  const firstUserQuestion = messages.find((m) => m.role === "user")?.content;
  const rawTitle = firstUserQuestion || currentConv?.title || "";
  const displayTitle = formatConversationTitle(rawTitle);

  function handleSaveTitle() {
    if (currentConversationId && titleText.trim()) {
      renameConversation(currentConversationId, titleText.trim());
    }
    setIsEditingTitle(false);
  }

  return (
    <header className="h-14 border-b border-neutral-200/80 dark:border-neutral-800/80 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-md px-4 flex items-center justify-between z-10 sticky top-0">
      {/* Left section: mobile hamburger + Brand Icon + RAG Chatbot + / + Title */}
      <div className="flex items-center space-x-3 min-w-0">
        <button
          onClick={onToggleSidebar}
          className="p-2 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg md:hidden"
          aria-label="Toggle sidebar"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="flex items-center space-x-2.5 min-w-0">
          <div
            className="flex items-center space-x-2 cursor-pointer"
            onClick={() => setActiveView("chat")}
            title="Return to chat"
          >
            <BrandIcon
              className="w-4 h-4"
              containerClassName="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-xs shrink-0"
            />
            <span className="text-sm sm:text-base font-semibold text-neutral-900 dark:text-neutral-100 shrink-0">
              RAG Chatbot
            </span>
          </div>

          {displayTitle && (
            <div className="flex items-center space-x-2 text-xs text-neutral-400 min-w-0">
              <span className="text-neutral-300 dark:text-neutral-700">/</span>
              {isEditingTitle ? (
                <div className="flex items-center space-x-1">
                  <input
                    type="text"
                    value={titleText}
                    onChange={(e) => setTitleText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveTitle()}
                    autoFocus
                    className="text-xs font-medium bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded border border-blue-500 focus:outline-none text-neutral-800 dark:text-neutral-200"
                  />
                  <button
                    onClick={handleSaveTitle}
                    className="p-0.5 text-emerald-600 hover:bg-emerald-50 rounded"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div
                  className="flex items-center space-x-1 group cursor-pointer truncate max-w-[200px] sm:max-w-sm md:max-w-lg"
                  onClick={() => {
                    setTitleText(displayTitle);
                    setIsEditingTitle(true);
                  }}
                  title="Click to rename"
                >
                  <span className="truncate text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 transition">
                    {displayTitle}
                  </span>
                  <Edit2 className="w-2.5 h-2.5 text-neutral-400 opacity-0 group-hover:opacity-100 transition shrink-0" />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right section: Only theme toggle */}
      <div className="flex items-center space-x-2">
        <button
          onClick={toggleTheme}
          className="p-2 text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition"
          aria-label="Toggle theme"
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </div>
    </header>
  );
}
