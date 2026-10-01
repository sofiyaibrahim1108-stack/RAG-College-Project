import React, { createContext, useContext, useState, useEffect, useRef } from "react";
import { conversationApi } from "../services/conversationApi";
import { chatApi } from "../services/chatApi";
import { api } from "../services/api";

const ChatContext = createContext(null);

export function ChatProvider({ children }) {
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamStatusText, setStreamStatusText] = useState("");
  const [activeDepartments, setActiveDepartments] = useState([]);
  const [activeView, setActiveView] = useState("chat"); // 'chat' | 'documents' | 'settings'
  const [theme, setTheme] = useState(() => localStorage.getItem("rag_theme") || "dark");
  const [searchQuery, setSearchQuery] = useState("");
  const [systemHealth, setSystemHealth] = useState(null);

  // Modals / Overlays
  const [lightboxImage, setLightboxImage] = useState(null);
  const [previewSource, setPreviewSource] = useState(null);
  const [showDriveModal, setShowDriveModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);

  const abortControllerRef = useRef(null);
  const skipNextMessageLoadRef = useRef(false);

  // Apply theme to html root
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem("rag_theme", theme);
  }, [theme]);

  // Load conversations and system health on startup
  useEffect(() => {
    loadConversations();
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  // When current conversation changes, load its messages
  useEffect(() => {
    if (skipNextMessageLoadRef.current) {
      skipNextMessageLoadRef.current = false;
      return;
    }
    if (currentConversationId) {
      loadMessages(currentConversationId);
    } else {
      setMessages([]);
      setActiveDepartments([]);
    }
  }, [currentConversationId]);

  async function checkHealth() {
    try {
      const res = await api.get("/health");
      setSystemHealth(res.data?.services || null);
    } catch (e) {
      setSystemHealth(null);
    }
  }

  async function loadConversations(search = "") {
    try {
      const list = await conversationApi.getConversations(search);
      setConversations(list);
    } catch (err) {
      console.error("Failed to load conversations:", err);
    }
  }

  async function loadMessages(convId) {
    try {
      const res = await conversationApi.getConversation(convId);
      setMessages(res.messages || []);
      // If last assistant message has routed departments, show them
      const lastAssistantMsg = [...(res.messages || [])].reverse().find((m) => m.role === "assistant");
      if (lastAssistantMsg && lastAssistantMsg.routedDepartments) {
        setActiveDepartments(lastAssistantMsg.routedDepartments);
      } else {
        setActiveDepartments([]);
      }
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }

  function toggleTheme() {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }

  async function createNewChat() {
    if (isStreaming) {
      stopGeneration();
    }
    setCurrentConversationId(null);
    setMessages([]);
    setActiveDepartments([]);
    setActiveView("chat");
  }

  async function selectConversation(id) {
    if (isStreaming) {
      stopGeneration();
    }
    setCurrentConversationId(id);
    setActiveView("chat");
  }

  async function renameConversation(id, newTitle) {
    if (!newTitle.trim()) return;
    try {
      const updated = await conversationApi.updateConversation(id, { title: newTitle.trim() });
      setConversations((prev) => prev.map((c) => (c._id === id ? { ...c, title: updated.title } : c)));
    } catch (err) {
      console.error("Failed to rename conversation:", err);
    }
  }

  async function togglePinConversation(id, currentPinned) {
    try {
      const updated = await conversationApi.updateConversation(id, { pinned: !currentPinned });
      setConversations((prev) => {
        const next = prev.map((c) => (c._id === id ? { ...c, pinned: updated.pinned } : c));
        // Keep pinned at the top
        return next.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
      });
    } catch (err) {
      console.error("Failed to toggle pin:", err);
    }
  }

  async function deleteConversation(id) {
    try {
      await conversationApi.deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c._id !== id));
      if (currentConversationId === id) {
        createNewChat();
      }
    } catch (err) {
      console.error("Failed to delete conversation:", err);
    }
  }

  function stopGeneration() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
    setStreamStatusText("");
    setMessages((prev) =>
      prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false, statusText: "" } : m))
    );
  }

  async function sendMessage(questionText, options = {}) {
    const text = (questionText || "").trim();
    if (!text || isStreaming) return;

    const { isRegenerate = false } = options;

    // Unique IDs for user and assistant messages
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const tempUserMsg = {
      _id: `temp_user_${uniqueSuffix}`,
      role: "user",
      content: text,
      createdAt: new Date().toISOString()
    };

    const tempAssistantId = `temp_asst_${uniqueSuffix}`;
    const tempAssistantMsg = {
      _id: tempAssistantId,
      role: "assistant",
      content: "",
      statusText: "Searching your documents...",
      isStreaming: true,
      routedDepartments: [],
      sources: [],
      images: [],
      timings: {},
      createdAt: new Date().toISOString()
    };

    if (isRegenerate) {
      setMessages((prev) => [...prev, tempAssistantMsg]);
    } else {
      setMessages((prev) => [...prev, tempUserMsg, tempAssistantMsg]);
    }

    setIsStreaming(true);
    setStreamStatusText("Searching your documents...");

    const controller = new AbortController();
    abortControllerRef.current = controller;

    let streamedContent = "";

    await chatApi.streamQuestion(
      text,
      currentConversationId,
      {
        onConversationId: (convId) => {
          if (!currentConversationId) {
            skipNextMessageLoadRef.current = true;
            setCurrentConversationId(convId);
            loadConversations();
          }
        },
        onStatus: (statusMsg) => {
          setStreamStatusText(statusMsg);
          setMessages((prev) =>
            prev.map((m) =>
              m._id === tempAssistantId ? { ...m, statusText: statusMsg } : m
            )
          );
        },
        onRouted: ({ departments }) => {
          setActiveDepartments(departments);
          setMessages((prev) =>
            prev.map((m) =>
              m._id === tempAssistantId ? { ...m, routedDepartments: departments } : m
            )
          );
        },
        onToken: (token) => {
          streamedContent += token;
          setMessages((prev) =>
            prev.map((m) =>
              m._id === tempAssistantId
                ? { ...m, content: streamedContent, isStreaming: true, statusText: "" }
                : m
            )
          );
        },
        onComplete: (data) => {
          setIsStreaming(false);
          setStreamStatusText("");
          abortControllerRef.current = null;

          if (data && !data.stopped) {
            setMessages((prev) =>
              prev.map((m) =>
                m._id === tempAssistantId
                  ? {
                      ...m,
                      _id: data.messageId || m._id,
                      content: data.answer || streamedContent,
                      sources: data.sources || [],
                      images: data.images || [],
                      timings: data.timings || {},
                      isStreaming: false,
                      statusText: ""
                    }
                  : m
              )
            );
          }
          loadConversations();
        },
        onError: (errMsg) => {
          setIsStreaming(false);
          setStreamStatusText("");
          abortControllerRef.current = null;
          setMessages((prev) =>
            prev.map((m) =>
              m._id === tempAssistantId
                ? {
                    ...m,
                    content: `Error: ${errMsg}. Please ensure Ollama and the Python SigLIP service are running.`,
                    isStreaming: false,
                    statusText: "",
                    isError: true
                  }
                : m
            )
          );
        }
      },
      controller.signal
    );
  }

  async function handleFeedback(messageId, feedback) {
    try {
      await chatApi.submitFeedback(messageId, feedback);
      setMessages((prev) =>
        prev.map((m) => (m._id === messageId ? { ...m, feedback } : m))
      );
    } catch (e) {
      console.error("Feedback failed:", e);
    }
  }

  async function regenerateLastMessage() {
    if (messages.length < 2 || isStreaming) return;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return;

    // Remove last assistant message
    setMessages((prev) => {
      const idx = prev.map((m) => m.role).lastIndexOf("assistant");
      if (idx !== -1) {
        return prev.slice(0, idx);
      }
      return prev;
    });

    sendMessage(lastUserMsg.content, { isRegenerate: true });
  }

  async function resendEditedMessage(msgIndex, newContent) {
    if (isStreaming) return;
    // Trim conversation history up to this message
    setMessages((prev) => prev.slice(0, msgIndex));
    sendMessage(newContent);
  }

  return (
    <ChatContext.Provider
      value={{
        conversations,
        currentConversationId,
        messages,
        isStreaming,
        streamStatusText,
        activeDepartments,
        activeView,
        theme,
        searchQuery,
        systemHealth,
        lightboxImage,
        previewSource,
        showDriveModal,
        showUploadModal,
        setSearchQuery,
        setActiveView,
        setLightboxImage,
        setPreviewSource,
        setShowDriveModal,
        setShowUploadModal,
        toggleTheme,
        createNewChat,
        selectConversation,
        renameConversation,
        togglePinConversation,
        deleteConversation,
        sendMessage,
        stopGeneration,
        regenerateLastMessage,
        resendEditedMessage,
        handleFeedback,
        loadConversations
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChat must be used within a ChatProvider");
  }
  return context;
}
