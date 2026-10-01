import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  User,
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
  Image as ImageIcon,
  AlertCircle
} from "lucide-react";
import { SourceCitationCard } from "../sources/SourceCitationCard";
import { ImageCitationCard } from "../sources/ImageCitationCard";
import { useChat } from "../../context/ChatContext";

/**
 * Sanitizes markdown string to strip out malformed copy artifacts (e.g. "javascriptCopy")
 */
function sanitizeMarkdown(text = "") {
  if (!text) return "";
  return text
    // Replace broken "```languageCopy" patterns
    .replace(/```(\w+)\s*Copy\b/gi, "```$1")
    // Replace duplicate "Copy" words at start of code blocks
    .replace(/^Copy\s*$/gm, "");
}

export function ChatMessage({ message, index }) {
  const { handleFeedback, regenerateLastMessage, resendEditedMessage, isStreaming } = useChat();
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);

  const isUser = message.role === "user";
  const isAssistantLoading = Boolean(message.isStreaming && !message.content && !message.isError);
  const isAssistantStreaming = Boolean(message.isStreaming && message.content && !message.isError);
  const isAssistantComplete = Boolean(!message.isStreaming && message.content && !message.isError);

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

  /* ==========================================================
     USER MESSAGE (Right-Aligned Bubble)
     ========================================================== */
  if (isUser) {
    return (
      <div className="group w-full py-2.5 px-4 md:px-6">
        <div className="max-w-4xl mx-auto flex flex-col items-end">
          {/* "You" Label & Edit Action */}
          <div className="flex items-center space-x-2 mb-1 pr-1 text-xs text-neutral-400 dark:text-neutral-500 select-none">
            <button
              onClick={() => setIsEditing(true)}
              className="opacity-0 group-hover:opacity-100 hover:text-neutral-700 dark:hover:text-neutral-200 transition p-0.5 rounded cursor-pointer"
              title="Edit question"
            >
              <Edit2 className="w-3 h-3" />
            </button>
            <span className="font-semibold">You</span>
          </div>

          {/* User Bubble or Edit Textarea */}
          {isEditing ? (
            <div className="w-full max-w-2xl space-y-2">
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                className="w-full p-3 text-sm rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                rows={3}
              />
              <div className="flex items-center justify-end space-x-2">
                <button
                  onClick={() => setIsEditing(false)}
                  className="px-3 py-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-800 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveEdit}
                  disabled={isStreaming}
                  className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition cursor-pointer"
                >
                  Save & Resend
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-blue-600 dark:bg-blue-600 text-white rounded-2xl rounded-tr-xs px-4 py-3 shadow-xs max-w-2xl text-sm leading-relaxed whitespace-pre-wrap break-words">
              {message.content}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ==========================================================
     AI ASSISTANT MESSAGE (Left-Aligned Container)
     ========================================================== */
  return (
    <div className="group w-full py-3 px-4 md:px-6">
      <div className="max-w-4xl mx-auto flex flex-col items-start space-y-2">
        {/* Assistant Header: Avatar + "Knowledge Assistant" + Department badges */}
        <div className="flex items-center space-x-2 select-none pl-1">
          <div className="w-6 h-6 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-xs ring-2 ring-blue-500/20">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <span className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">
            Knowledge Assistant
          </span>
          {message.routedDepartments && message.routedDepartments.length > 0 && (
            <div className="flex items-center space-x-1 ml-1.5">
              {message.routedDepartments.map((dept) => (
                <span
                  key={dept}
                  className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-700 dark:bg-blue-950/70 dark:text-blue-300 border border-blue-200 dark:border-blue-900"
                >
                  <Layers className="w-2.5 h-2.5 mr-1" />
                  {dept}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Separate Answer Container */}
        <div className="w-full bg-white dark:bg-neutral-900 border border-neutral-200/90 dark:border-neutral-800 rounded-2xl rounded-tl-xs p-4 sm:p-5 shadow-xs transition-all">
          {/* Loading / Searching State inside the message container */}
          {isAssistantLoading && (
            <div className="flex items-center space-x-2.5 py-1 text-neutral-500 dark:text-neutral-400 select-none">
              <div className="flex space-x-1 items-center">
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-bounce [animation-delay:-0.3s]"></span>
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-bounce [animation-delay:-0.15s]"></span>
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-bounce"></span>
              </div>
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                {message.statusText || "Searching your documents..."}
              </span>
            </div>
          )}

          {/* Error Alert State */}
          {message.isError && (
            <div className="flex items-start space-x-2.5 py-1 text-sm text-red-600 dark:text-red-400">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <div className="flex-1 leading-relaxed">{message.content}</div>
            </div>
          )}

          {/* Markdown Content Area */}
          {message.content && !message.isError && (
            <div className="text-neutral-800 dark:text-neutral-200 text-sm markdown-body leading-relaxed">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ node, inline, className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || "");
                    const isMultiLine = String(children).includes("\n") || Boolean(match);

                    if (!inline && isMultiLine) {
                      const lang = match ? match[1] : "code";
                      const codeString = String(children).replace(/\n$/, "");

                      return (
                        <div className="relative my-4 rounded-xl overflow-hidden border border-neutral-200 dark:border-neutral-800 bg-neutral-900 dark:bg-neutral-950">
                          {/* Header bar: language indicator + Copy button */}
                          <div className="flex items-center justify-between px-4 py-1.5 bg-neutral-800/90 dark:bg-neutral-900/90 text-xs text-neutral-400 border-b border-neutral-700/50 select-none">
                            <span className="font-mono text-[11px] uppercase tracking-wider text-neutral-300">
                              {lang}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(codeString);
                              }}
                              className="flex items-center space-x-1 hover:text-white transition select-none cursor-pointer"
                              title="Copy code"
                            >
                              <Copy className="w-3.5 h-3.5" />
                              <span className="text-[11px]">Copy</span>
                            </button>
                          </div>
                          <pre className="p-4 text-xs font-mono text-neutral-100 overflow-x-auto leading-normal">
                            <code>{children}</code>
                          </pre>
                        </div>
                      );
                    }

                    return (
                      <code
                        className="bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded text-xs font-mono text-blue-600 dark:text-blue-400"
                        {...props}
                      >
                        {children}
                      </code>
                    );
                  },
                  table({ children }) {
                    return (
                      <div className="my-4 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
                        <table className="w-full text-left text-xs border-collapse">
                          {children}
                        </table>
                      </div>
                    );
                  },
                  th({ children }) {
                    return (
                      <th className="bg-neutral-100 dark:bg-neutral-800/80 px-3.5 py-2 font-semibold text-neutral-700 dark:text-neutral-200 border-b border-neutral-200 dark:border-neutral-700">
                        {children}
                      </th>
                    );
                  },
                  td({ children }) {
                    return (
                      <td className="px-3.5 py-2 border-b border-neutral-100 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300">
                        {children}
                      </td>
                    );
                  }
                }}
              >
                {sanitizeMarkdown(message.content || "")}
              </ReactMarkdown>

              {/* Streaming Cursor */}
              {isAssistantStreaming && (
                <span className="inline-block w-1.5 h-4 ml-1 bg-blue-500 rounded-xs animate-pulse align-middle" />
              )}
            </div>
          )}

          {/* Assistant Sources & Citations */}
          {isAssistantComplete && message.sources && message.sources.length > 0 && (
            <div className="mt-5 pt-3.5 border-t border-neutral-100 dark:border-neutral-800 animate-in fade-in duration-200">
              <div className="flex items-center space-x-1.5 text-xs font-semibold text-neutral-600 dark:text-neutral-400 mb-2.5">
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
          {isAssistantComplete && message.images && message.images.length > 0 && (
            <div className="mt-4 pt-3.5 border-t border-neutral-100 dark:border-neutral-800 animate-in fade-in duration-200">
              <div className="flex items-center space-x-1.5 text-xs font-semibold text-neutral-600 dark:text-neutral-400 mb-2">
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
          {isAssistantComplete && (
            <div className="mt-4 flex items-center justify-between text-xs text-neutral-400 pt-2.5 border-t border-neutral-100 dark:border-neutral-800/60 select-none animate-in fade-in duration-200">
              <div className="flex items-center space-x-2">
                <button
                  onClick={handleCopy}
                  className="p-1 hover:text-neutral-700 dark:hover:text-neutral-200 rounded transition flex items-center space-x-1 cursor-pointer"
                  title="Copy answer"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                </button>

                <button
                  onClick={regenerateLastMessage}
                  disabled={isStreaming}
                  className="p-1 hover:text-neutral-700 dark:hover:text-neutral-200 rounded transition cursor-pointer"
                  title="Regenerate response"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                </button>

                <div className="h-3 w-px bg-neutral-200 dark:bg-neutral-800 my-auto" />

                <button
                  onClick={() => handleFeedback(message._id, "like")}
                  className={`p-1 rounded transition cursor-pointer ${
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
                  className={`p-1 rounded transition cursor-pointer ${
                    message.feedback === "dislike"
                      ? "text-red-500"
                      : "hover:text-neutral-700 dark:hover:text-neutral-200"
                  }`}
                  title="Not helpful"
                >
                  <ThumbsDown className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Timings info pill */}
              {message.timings?.total && (
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
          )}
        </div>
      </div>
    </div>
  );
}
