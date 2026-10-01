import React, { useRef, useEffect, useState } from "react";
import { Sparkles, ArrowDown, HelpCircle, FileSearch, Lightbulb, Compass } from "lucide-react";
import { useChat } from "../context/ChatContext";
import { ChatMessage } from "../components/chat/ChatMessage";
import { ChatInput } from "../components/chat/ChatInput";

const SUGGESTIONS = [
  {
    title: "Document Summary",
    desc: "Can you provide a summary of the uploaded documents and their key topics?",
    icon: FileSearch
  },
  {
    title: "Cross-Domain Questions",
    desc: "What are the core concepts and findings documented in the knowledge base?",
    icon: Lightbulb
  },
  {
    title: "Diagrams & Illustrations",
    desc: "Explain any architectural diagrams, flowcharts, or figures found in the files.",
    icon: Compass
  },
  {
    title: "Knowledge Exploration",
    desc: "What departments and subjects are currently covered in this workspace?",
    icon: HelpCircle
  }
];

export function ChatPage() {
  const { messages, sendMessage, isStreaming } = useChat();
  const messagesEndRef = useRef(null);
  const containerRef = useRef(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (!showScrollBottom) {
      messagesEndRef.current?.scrollIntoView({
        behavior: isStreaming ? "auto" : "smooth"
      });
    }
  }, [messages, showScrollBottom, isStreaming]);

  function handleScroll() {
    if (containerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      const atBottom = scrollHeight - scrollTop - clientHeight < 150;
      setShowScrollBottom(!atBottom);
    }
  }

  function scrollToBottom() {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowScrollBottom(false);
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden relative">
      {/* Scrollable chat messages area */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {messages.length === 0 ? (
          /* Empty State / Welcome Hero */
          <div className="max-w-2xl mx-auto px-4 py-16 text-center space-y-8 animate-in fade-in duration-300">
            <div className="space-y-3">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white mx-auto shadow-xl ring-4 ring-blue-500/10">
                <Sparkles className="w-7 h-7" />
              </div>
              <h2 className="text-2xl font-bold text-neutral-900 dark:text-white">
                How can I assist you with your knowledge today?
              </h2>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 max-w-md mx-auto">
                Ask questions grounded in your uploaded documents and diagrams. The system routes by department and queries text chunks and SigLIP2 images.
              </p>
            </div>

            {/* Quick Prompt Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-left">
              {SUGGESTIONS.map((item, idx) => {
                const Icon = item.icon;
                return (
                  <button
                    key={idx}
                    onClick={() => sendMessage(item.desc)}
                    disabled={isStreaming}
                    className="p-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white/70 dark:bg-neutral-900/60 hover:border-blue-500/50 hover:bg-neutral-50 dark:hover:bg-neutral-800/60 transition shadow-xs group"
                  >
                    <div className="flex items-center space-x-2 text-xs font-semibold text-neutral-900 dark:text-neutral-100 mb-1">
                      <Icon className="w-4 h-4 text-blue-500 group-hover:scale-110 transition" />
                      <span>{item.title}</span>
                    </div>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 line-clamp-2">
                      {item.desc}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          /* Messages Stream */
          <div className="pb-6 divide-y divide-transparent">
            {messages.map((msg, index) => (
              <ChatMessage key={msg._id || index} message={msg} index={index} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Floating scroll to bottom button */}
      {showScrollBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-24 right-6 p-2 rounded-full bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 shadow-lg text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white transition z-20"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}

      {/* Bottom Chat Input */}
      <ChatInput />
    </div>
  );
}
