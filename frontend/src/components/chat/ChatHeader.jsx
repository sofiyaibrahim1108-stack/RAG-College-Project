import React, { useState } from "react";
import {
  Menu,
  Sun,
  Moon,
  Sparkles,
  Layers,
  Edit2,
  Check,
  Plus,
  Cpu
} from "lucide-react";
import { useChat } from "../../context/ChatContext";

export function ChatHeader({ onToggleSidebar }) {
  const {
    conversations,
    currentConversationId,
    activeDepartments,
    theme,
    toggleTheme,
    createNewChat,
    renameConversation
  } = useChat();

  const currentConv = conversations.find((c) => c._id === currentConversationId);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleText, setTitleText] = useState(currentConv?.title || "New Chat");

  function handleSaveTitle() {
    if (currentConversationId && titleText.trim()) {
      renameConversation(currentConversationId, titleText.trim());
    }
    setIsEditingTitle(false);
  }

  return (
    <header className="h-14 border-b border-neutral-200/80 dark:border-neutral-800/80 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-md px-4 flex items-center justify-between z-10 sticky top-0">
      {/* Left section: mobile hamburger + conversation title */}
      <div className="flex items-center space-x-3 min-w-0">
        <button
          onClick={onToggleSidebar}
          className="p-2 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg md:hidden"
          aria-label="Toggle sidebar"
        >
          <Menu className="w-5 h-5" />
        </button>

        {isEditingTitle ? (
          <div className="flex items-center space-x-1">
            <input
              type="text"
              value={titleText}
              onChange={(e) => setTitleText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSaveTitle()}
              autoFocus
              className="text-sm font-semibold bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 rounded border border-blue-500 focus:outline-none"
            />
            <button
              onClick={handleSaveTitle}
              className="p-1 text-emerald-600 hover:bg-emerald-50 rounded"
            >
              <Check className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center space-x-2 group cursor-pointer" onClick={() => setIsEditingTitle(true)}>
            <h1 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate max-w-[200px] sm:max-w-xs md:max-w-md">
              {currentConv?.title || "New Conversation"}
            </h1>
            <Edit2 className="w-3 h-3 text-neutral-400 opacity-0 group-hover:opacity-100 transition" />
          </div>
        )}
      </div>

      {/* Right section: Model pill + Department pills + Theme toggle */}
      <div className="flex items-center space-x-2 sm:space-x-3">
        {/* Routed Department pill */}
        {activeDepartments && activeDepartments.length > 0 && (
          <div className="hidden lg:flex items-center space-x-1 px-2.5 py-1 rounded-full bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 text-blue-700 dark:text-blue-300 text-xs font-medium">
            <Layers className="w-3.5 h-3.5" />
            <span>Routed: {activeDepartments.join(", ")}</span>
          </div>
        )}

        {/* Model badge */}
        <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 text-xs font-medium">
          <Cpu className="w-3.5 h-3.5 text-blue-500" />
          <span className="hidden sm:inline">Qwen 2.5 Coder 3B</span>
          <span className="sm:hidden">Qwen</span>
        </div>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="p-2 text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition"
          aria-label="Toggle theme"
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        {/* New chat icon button */}
        <button
          onClick={createNewChat}
          className="p-2 text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition"
          title="New Chat"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
