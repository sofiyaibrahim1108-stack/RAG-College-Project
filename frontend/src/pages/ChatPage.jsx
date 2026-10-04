import React, { useRef, useEffect, useState } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import { useChat } from "../context/ChatContext";
import { ChatMessage } from "../components/chat/ChatMessage";
import { ChatInput } from "../components/chat/ChatInput";

function getTimeGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning!";
  if (hour < 18) return "Good afternoon!";
  return "Good evening!";
}

export function ChatPage() {
  const { messages, isStreaming, isLoadingMessages } = useChat();
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
        className="flex-1 overflow-y-auto flex flex-col"
      >
        {isLoadingMessages && messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center space-y-3 animate-in fade-in duration-200">
            <Loader2 className="w-6 h-6 animate-spin text-neutral-400" />
            <span className="text-xs text-neutral-400">Loading conversation...</span>
          </div>
        ) : messages.length === 0 ? (
          /* Empty State / Welcome (Clean, minimal, generous whitespace) */
          <div className="flex-1 flex flex-col items-center justify-center px-4 py-16 text-center max-w-2xl mx-auto select-none animate-in fade-in duration-200">
            <p className="text-base sm:text-lg font-medium text-blue-600 dark:text-blue-400 mb-2">
              {getTimeGreeting()}
            </p>
            <h2 className="text-2xl sm:text-3xl md:text-4xl font-semibold text-neutral-900 dark:text-white tracking-tight leading-snug mb-3">
              How can I help you with your documents today?
            </h2>
            <p className="text-sm sm:text-base text-neutral-500 dark:text-neutral-400 max-w-lg leading-relaxed">
              Ask questions about your uploaded documents, search for information, or explore diagrams and images.
            </p>
          </div>
        ) : (
          /* Messages Stream */
          <div className="py-6 px-2 sm:px-4 max-w-4xl mx-auto w-full space-y-6">
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

