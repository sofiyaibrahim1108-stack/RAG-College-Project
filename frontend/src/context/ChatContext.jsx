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
  }

  async function sendMessage(questionText) {
    const text = (questionText || "").trim();
    if (!text || isStreaming) return;

    // Add user message to UI immediately
    const tempUserMsg = {
      _id: `temp_user_${Date.now()}`,
      role: "user",
      content: text,
      createdAt: new Date().toISOString()
    };

    // Add placeholder assistant message
    const tempAssistantId = `temp_asst_${Date.now()}`;
    const tempAssistantMsg = {
      _id: tempAssistantId,
      role: "assistant",
      content: "",
      routedDepartments: [],
      sources: [],
      images: [],
      timings: {},
      createdAt: new Date().toISOString()
    };

    setMessages((prev) => [...prev, tempUserMsg, tempAssistantMsg]);
    setIsStreaming(true);
    setStreamStatusText("Initializing knowledge retrieval...");

    const controller = new AbortController();
    abortControllerRef.current = controller;

    let streamedContent = "";

    await chatApi.streamQuestion(
      text,
      currentConversationId,
      {
        onConversationId: (convId) => {
          if (!currentConversationId) {
            setCurrentConversationId(convId);
            loadConversations();
          }
        },
        onStatus: (statusMsg) => {
          setStreamStatusText(statusMsg);
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
              m._id === tempAssistantId ? { ...m, content: streamedContent } : m
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
                      timings: data.timings || {}
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
                    content: `Error: ${errMsg}. Please ensure Ollama and the Python SigLIP service are running.`
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

    sendMessage(lastUserMsg.content);
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
