import React, { useState } from "react";
import {
  MessageSquare,
  Plus,
  Search,
  Pin,
  PinOff,
  Trash2,
  Edit2,
  FolderArchive,
  Building2,
  Settings,
  MoreVertical,
  Check,
  X,
  Database,
  Cpu,
  Eye,
  Bot
} from "lucide-react";
import { useChat } from "../../context/ChatContext";

export function Sidebar({ isOpen, onClose }) {
  const {
    conversations,
    currentConversationId,
    selectConversation,
    createNewChat,
    renameConversation,
    togglePinConversation,
    deleteConversation,
    activeView,
    setActiveView,
    searchQuery,
    setSearchQuery,
    systemHealth
  } = useChat();

  const [editingId, setEditingId] = useState(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [activeMenuId, setActiveMenuId] = useState(null);

  const filteredConversations = conversations.filter((c) =>
    (c.title || "").toLowerCase().includes(searchQuery.toLowerCase())
  );

  const pinnedConversations = filteredConversations.filter((c) => c.pinned);
  const recentConversations = filteredConversations.filter((c) => !c.pinned);

  function startRename(e, conv) {
    e.stopPropagation();
    setEditingId(conv._id);
    setEditingTitle(conv.title);
    setActiveMenuId(null);
  }

  function handleSaveRename(id) {
    if (editingTitle.trim()) {
      renameConversation(id, editingTitle.trim());
    }
    setEditingId(null);
  }

  function renderConversationItem(conv) {
    const isActive = currentConversationId === conv._id && activeView === "chat";
    const isEditing = editingId === conv._id;

    return (
      <div
        key={conv._id}
        onClick={() => {
          selectConversation(conv._id);
          if (onClose) onClose();
        }}
        className={`group relative flex items-center justify-between px-3 py-2 rounded-xl text-sm transition cursor-pointer ${
          isActive
            ? "bg-neutral-200/80 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-medium"
            : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800/50 hover:text-neutral-900 dark:hover:text-neutral-200"
        }`}
      >
        <div className="flex items-center space-x-2.5 min-w-0 flex-1">
          <MessageSquare className="w-4 h-4 flex-shrink-0 text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-300" />
          {isEditing ? (
            <div className="flex items-center space-x-1 flex-1" onClick={(e) => e.stopPropagation()}>
              <input
                type="text"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSaveRename(conv._id)}
                autoFocus
                className="w-full text-xs bg-white dark:bg-neutral-900 px-1.5 py-0.5 rounded border border-blue-500 focus:outline-none"
              />
              <button
                onClick={() => handleSaveRename(conv._id)}
                className="p-1 text-emerald-600 hover:text-emerald-700"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <span className="truncate text-xs">{conv.title || "Untitled Chat"}</span>
          )}
        </div>

        {/* Dropdown Menu Trigger */}
        {!isEditing && (
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setActiveMenuId(activeMenuId === conv._id ? null : conv._id)}
              className="p-1 rounded-md opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition"
            >
              <MoreVertical className="w-3.5 h-3.5" />
            </button>

            {activeMenuId === conv._id && (
              <div className="absolute right-0 mt-1 w-32 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl shadow-xl z-20 py-1 text-xs">
                <button
                  onClick={(e) => {
                    togglePinConversation(conv._id, conv.pinned);
                    setActiveMenuId(null);
                  }}
                  className="flex items-center space-x-2 w-full px-3 py-1.5 text-left text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  {conv.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
                  <span>{conv.pinned ? "Unpin" : "Pin"}</span>
                </button>
                <button
                  onClick={(e) => startRename(e, conv)}
                  className="flex items-center space-x-2 w-full px-3 py-1.5 text-left text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                  <span>Rename</span>
                </button>
                <button
                  onClick={() => {
                    deleteConversation(conv._id);
                    setActiveMenuId(null);
                  }}
                  className="flex items-center space-x-2 w-full px-3 py-1.5 text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden backdrop-blur-xs"
          onClick={onClose}
        />
      )}

      {/* Sidebar container */}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-40 w-72 bg-neutral-50/95 dark:bg-neutral-900/95 border-r border-neutral-200/80 dark:border-neutral-800/80 flex flex-col justify-between transition-transform duration-200 ease-in-out ${
          isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        {/* Top Header & New Chat */}
        <div className="p-3.5 border-b border-neutral-200/60 dark:border-neutral-800/60 space-y-3">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center space-x-2.5">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-md">
                <Bot className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-neutral-900 dark:text-white leading-tight">
                  Knowledge AI
                </h2>
                <span className="text-[10px] text-neutral-500 dark:text-neutral-400 font-mono">
                  RAG + LangGraph
                </span>
              </div>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 md:hidden"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* New Chat Button */}
          <button
            onClick={() => {
              createNewChat();
              if (onClose) onClose();
            }}
            className="w-full flex items-center justify-center space-x-2 px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm transition"
          >
            <Plus className="w-4 h-4" />
            <span>New Chat</span>
          </button>

          {/* Search Box */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-neutral-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search conversations..."
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Scrollable Conversation List */}
        <div className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
          {/* Pinned section */}
          {pinnedConversations.length > 0 && (
            <div>
              <div className="flex items-center space-x-1.5 px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                <Pin className="w-3 h-3 text-amber-500" />
                <span>Pinned</span>
              </div>
              <div className="space-y-0.5">
                {pinnedConversations.map(renderConversationItem)}
              </div>
            </div>
          )}

          {/* Recent section */}
          <div>
            <div className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
              Recent Chats
            </div>
            {recentConversations.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-neutral-400">
                No conversations yet
              </div>
            ) : (
              <div className="space-y-0.5">
                {recentConversations.map(renderConversationItem)}
              </div>
            )}
          </div>
        </div>

        {/* Bottom Section: Navigation Tabs & Health Indicators */}
        <div className="p-3 border-t border-neutral-200/60 dark:border-neutral-800/60 space-y-2 bg-neutral-100/50 dark:bg-neutral-950/40">
          <nav className="space-y-1">
            <button
              onClick={() => {
                setActiveView("departments");
                if (onClose) onClose();
              }}
              className={`flex items-center space-x-2.5 w-full px-3 py-2 rounded-xl text-xs font-medium transition ${
                activeView === "departments"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800"
              }`}
            >
              <Building2 className="w-4 h-4" />
              <span>Departments</span>
            </button>

            <button
              onClick={() => {
                setActiveView("documents");
                if (onClose) onClose();
              }}
              className={`flex items-center space-x-2.5 w-full px-3 py-2 rounded-xl text-xs font-medium transition ${
                activeView === "documents"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800"
              }`}
            >
              <FolderArchive className="w-4 h-4" />
              <span>Knowledge Documents</span>
            </button>

            <button
              onClick={() => {
                setActiveView("settings");
                if (onClose) onClose();
              }}
              className={`flex items-center space-x-2.5 w-full px-3 py-2 rounded-xl text-xs font-medium transition ${
                activeView === "settings"
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800"
              }`}
            >
              <Settings className="w-4 h-4" />
              <span>System & RAG Settings</span>
            </button>
          </nav>

          {/* Status Badges */}
          <div className="pt-2 border-t border-neutral-200/50 dark:border-neutral-800/50 flex items-center justify-between px-1 text-[11px] text-neutral-500">
            <span className="flex items-center gap-1.5" title="MongoDB Compass Connected">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>Mongo</span>
            </span>

            <span className="flex items-center gap-1.5" title="Local Ollama Qwen Active">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              <span>Ollama</span>
            </span>

            <span className="flex items-center gap-1.5" title="Python SigLIP2 Active">
              <span
                className={`w-2 h-2 rounded-full ${
                  systemHealth?.siglip?.status === "ok" ? "bg-emerald-500" : "bg-amber-500"
                }`}
              />
              <span>SigLIP2</span>
            </span>
          </div>
        </div>
      </aside>
    </>
  );
}
