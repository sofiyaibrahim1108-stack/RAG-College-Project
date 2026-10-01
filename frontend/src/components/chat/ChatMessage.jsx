import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  User,
  Bot,
  Copy,
  Check,
  RotateCw,
  ThumbsUp,
  ThumbsDown,
  Edit2,
  Clock,
  Layers,
  Sparkles,
  BookOpen,
  Image as ImageIcon
} from "lucide-react";
import { SourceCitationCard } from "../sources/SourceCitationCard";
import { ImageCitationCard } from "../sources/ImageCitationCard";
import { useChat } from "../../context/ChatContext";

export function ChatMessage({ message, index }) {
  const { handleFeedback, regenerateLastMessage, resendEditedMessage, isStreaming } = useChat();
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);

  const isUser = message.role === "user";

  function handleCopy() {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleSaveEdit() {
    if (!editText.trim()) return;
    setIsEditing(false);
    resendEditedMessage(index, editText.trim());
  }

  return (
    <div
      className={`group w-full py-5 px-4 md:px-6 transition-colors ${
        isUser
          ? "bg-transparent"
          : "bg-neutral-100/60 dark:bg-neutral-900/40 border-y border-neutral-200/40 dark:border-neutral-800/40"
      }`}
    >
      <div className="max-w-4xl mx-auto flex space-x-4">
        {/* Avatar */}
        <div className="flex-shrink-0 pt-0.5">
          {isUser ? (
            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-neutral-700 to-neutral-500 dark:from-neutral-600 dark:to-neutral-400 flex items-center justify-center text-white shadow-sm">
              <User className="w-4 h-4" />
            </div>
          ) : (
            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-sm ring-2 ring-blue-500/20">
              <Sparkles className="w-4 h-4" />
            </div>
          )}
        </div>

        {/* Content Area */}
        <div className="flex-1 min-w-0">
          {/* Header line: Role name + Department badge */}
          <div className="flex items-center space-x-2 mb-1.5">
            <span className="text-xs font-semibold text-neutral-900 dark:text-neutral-200">
              {isUser ? "You" : "Knowledge Assistant"}
            </span>

            {!isUser && message.routedDepartments && message.routedDepartments.length > 0 && (
              <div className="flex items-center space-x-1">
                {message.routedDepartments.map((dept) => (
                  <span
                    key={dept}
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 text-blue-800 dark:bg-blue-950/70 dark:text-blue-300 border border-blue-200 dark:border-blue-900"
                  >
                    <Layers className="w-2.5 h-2.5 mr-1" />
                    {dept}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* User Message Edit Mode */}
          {isUser && isEditing ? (
            <div className="mt-2 space-y-2">
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                className="w-full p-3 text-sm rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                rows={3}
              />
              <div className="flex items-center space-x-2">
                <button
                  onClick={handleSaveEdit}
                  disabled={isStreaming}
                  className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition"
                >
                  Save & Resend
                </button>
                <button
                  onClick={() => setIsEditing(false)}
                  className="px-3 py-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-800 rounded-lg transition"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            /* Main Content Rendering */
            <div className="text-neutral-800 dark:text-neutral-200 text-sm markdown-body">
              {isUser ? (
                <p className="whitespace-pre-wrap">{message.content}</p>
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code({ node, inline, className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className || "");
                      const codeString = String(children).replace(/\n$/, "");
                      if (!inline && match) {
                        return (
                          <div className="relative my-4 rounded-xl overflow-hidden border border-neutral-300 dark:border-neutral-800 bg-neutral-900 dark:bg-neutral-950">
                            <div className="flex items-center justify-between px-4 py-1.5 bg-neutral-800/80 dark:bg-neutral-900/80 text-xs text-neutral-400 border-b border-neutral-700/50">
                              <span>{match[1]}</span>
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(codeString);
                                }}
                                className="flex items-center space-x-1 hover:text-white transition"
                              >
                                <Copy className="w-3.5 h-3.5" />
                                <span>Copy</span>
                              </button>
                            </div>
                            <pre className="p-4 text-xs font-mono text-neutral-100 overflow-x-auto">
                              <code>{children}</code>
                            </pre>
                          </div>
                        );
                      }
                      return (
                        <code className={className} {...props}>
                          {children}
                        </code>
                      );
                    }
                  }}
                >
                  {message.content || ""}
                </ReactMarkdown>
              )}
            </div>
          )}

          {/* Assistant Sources & Citations */}
          {!isUser && message.sources && message.sources.length > 0 && (
            <div className="mt-4 pt-3 border-t border-neutral-200/60 dark:border-neutral-800/60">
              <div className="flex items-center space-x-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-2">
                <BookOpen className="w-3.5 h-3.5 text-blue-500" />
                <span>Cited Sources</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {message.sources.map((src, i) => (
                  <SourceCitationCard key={i} source={src} />
                ))}
              </div>
            </div>
          )}

          {/* Assistant Visual Diagrams / Figures */}
          {!isUser && message.images && message.images.length > 0 && (
            <div className="mt-4 pt-3 border-t border-neutral-200/60 dark:border-neutral-800/60">
              <div className="flex items-center space-x-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-2">
                <ImageIcon className="w-3.5 h-3.5 text-purple-500" />
                <span>Relevant Document Diagrams</span>
              </div>
              <div className="flex flex-wrap gap-3">
                {message.images.map((img, i) => (
                  <ImageCitationCard key={i} image={img} />
                ))}
              </div>
            </div>
          )}

          {/* Action Footer Bar */}
          <div className="mt-3 flex items-center justify-between text-xs text-neutral-400 pt-1">
            <div className="flex items-center space-x-2">
              {isUser ? (
                <button
                  onClick={() => setIsEditing(true)}
                  className="opacity-0 group-hover:opacity-100 p-1 hover:text-neutral-700 dark:hover:text-neutral-200 rounded transition"
                  title="Edit question"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
              ) : (
                <>
                  <button
                    onClick={handleCopy}
                    className="p-1 hover:text-neutral-700 dark:hover:text-neutral-200 rounded transition flex items-center space-x-1"
                    title="Copy answer"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>

                  <button
                    onClick={regenerateLastMessage}
                    disabled={isStreaming}
                    className="p-1 hover:text-neutral-700 dark:hover:text-neutral-200 rounded transition"
                    title="Regenerate response"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                  </button>

                  <div className="h-3 w-px bg-neutral-300 dark:bg-neutral-800 my-auto" />

                  <button
                    onClick={() => handleFeedback(message._id, "like")}
                    className={`p-1 rounded transition ${
                      message.feedback === "like"
                        ? "text-emerald-500"
                        : "hover:text-neutral-700 dark:hover:text-neutral-200"
                    }`}
                    title="Helpful"
                  >
                    <ThumbsUp className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={() => handleFeedback(message._id, "dislike")}
                    className={`p-1 rounded transition ${
                      message.feedback === "dislike"
                        ? "text-red-500"
                        : "hover:text-neutral-700 dark:hover:text-neutral-200"
                    }`}
                    title="Not helpful"
                  >
                    <ThumbsDown className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>

            {/* Timings info pill */}
            {!isUser && message.timings?.total && (
              <span
                className="flex items-center space-x-1 text-[10px] text-neutral-400 font-mono"
                title={`Router: ${message.timings.router || 0}ms | TextRet: ${
                  message.timings.textRetrieval || 0
                }ms | SigLIP: ${message.timings.siglipEmbedding || 0}ms | LLM: ${message.timings.llm || 0}ms`}
              >
                <Clock className="w-3 h-3" />
                <span>{(message.timings.total / 1000).toFixed(1)}s</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
