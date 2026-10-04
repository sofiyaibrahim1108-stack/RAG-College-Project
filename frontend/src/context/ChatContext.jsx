import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { conversationApi } from "../services/conversationApi";
import { chatApi } from "../services/chatApi";
import { api } from "../services/api";
import { toFriendlyErrorMessage } from "../utils/userMessage";

const ChatContext = createContext(null);

function isValidConvId(id) {
  return typeof id === "string" && id.trim().length > 0 && id !== "null" && id !== "undefined";
}

function getInitialConvId() {
  if (typeof window === "undefined") return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("c");
    if (isValidConvId(fromUrl)) return fromUrl.trim();
    const fromStorage = localStorage.getItem("rag_current_conv_id");
    if (isValidConvId(fromStorage)) return fromStorage.trim();
  } catch (err) {
    console.error("Failed to read initial conversation ID:", err);
  }
  return null;
}

function getInitialView() {
  if (typeof window === "undefined") return "chat";
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("view");
    if (fromUrl && ["chat", "departments", "documents", "settings"].includes(fromUrl)) {
      return fromUrl;
    }
    const fromStorage = localStorage.getItem("rag_active_view");
    if (fromStorage && ["chat", "departments", "documents", "settings"].includes(fromStorage)) {
      return fromStorage;
    }
  } catch (err) {
    console.error("Failed to read initial view:", err);
  }
  return "chat";
}

function getPersistedMessages(convId) {
  if (typeof window === "undefined" || !isValidConvId(convId)) return [];
  try {
    const raw = localStorage.getItem(`rag_messages_${convId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.error("Failed to load persisted messages:", err);
  }
  return [];
}

function persistMessages(convId, msgs) {
  if (typeof window === "undefined" || !isValidConvId(convId)) return;
  try {
    localStorage.setItem(`rag_messages_${convId}`, JSON.stringify(msgs));
  } catch (err) {
    console.error("Failed to persist messages:", err);
  }
}

/**
 * Reconciles server-persisted messages with local optimistic/in-flight messages.
 * Prevents duplicates by counting matched occurrences of user questions.
 */
function reconcileMessages(serverMessages, localMessages) {
  if (!Array.isArray(serverMessages)) return localMessages || [];
  if (!Array.isArray(localMessages) || localMessages.length === 0) return serverMessages;

  const serverUserCounts = new Map();
  serverMessages.forEach((m) => {
    if (m.role === "user") {
      const key = (m.content || "").trim();
      serverUserCounts.set(key, (serverUserCounts.get(key) || 0) + 1);
    }
  });

  const localUserCounts = new Map();
  const uncommittedLocal = [];

  for (let i = 0; i < localMessages.length; i++) {
    const msg = localMessages[i];
    if (msg.role === "user") {
      const key = (msg.content || "").trim();
      const currentLocalCount = (localUserCounts.get(key) || 0) + 1;
      localUserCounts.set(key, currentLocalCount);

      const serverCount = serverUserCounts.get(key) || 0;
      if (currentLocalCount > serverCount) {
        // This local user message is not yet saved on the server
        uncommittedLocal.push(msg);

        // Include any corresponding assistant message immediately following it
        const nextMsg = localMessages[i + 1];
        if (nextMsg && nextMsg.role === "assistant") {
          uncommittedLocal.push(nextMsg);
          i++; // skip nextMsg since we included it
        }
      }
    }
  }

  return [...serverMessages, ...uncommittedLocal];
}

function updateUrlAndStorage(convId, view, options = {}) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);

    if (isValidConvId(convId)) {
      url.searchParams.set("c", convId);
      localStorage.setItem("rag_current_conv_id", convId);
    } else {
      url.searchParams.delete("c");
      localStorage.removeItem("rag_current_conv_id");
    }

    if (view && view !== "chat") {
      url.searchParams.set("view", view);
      localStorage.setItem("rag_active_view", view);
    } else {
      url.searchParams.delete("view");
      localStorage.setItem("rag_active_view", "chat");
    }

    if (url.toString() !== window.location.href) {
      if (options.replace) {
        window.history.replaceState({}, "", url.toString());
      } else {
        window.history.pushState({}, "", url.toString());
      }
    }
  } catch (err) {
    console.error("Failed to update URL and storage:", err);
  }
}

export function ChatProvider({ children }) {
  const initialConvId = getInitialConvId();
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(initialConvId);
  const [messages, setMessages] = useState(() => getPersistedMessages(initialConvId));
  const [isLoadingMessages, setIsLoadingMessages] = useState(() => {
    if (!initialConvId) return false;
    const cached = getPersistedMessages(initialConvId);
    return cached.length === 0;
  });
  const [activeStreamsCount, setActiveStreamsCount] = useState(0);
  const [streamStatusText, setStreamStatusText] = useState("");
  const [activeDepartments, setActiveDepartments] = useState([]);
  const [activeView, setActiveView] = useState(getInitialView);
  const [theme, setTheme] = useState(() => localStorage.getItem("rag_theme") || "light");
  const [searchQuery, setSearchQuery] = useState("");
  const [systemHealth, setSystemHealth] = useState(null);

  // Modals / Overlays
  const [lightboxImage, setLightboxImage] = useState(null);
  const [previewSource, setPreviewSource] = useState(null);
  const [showDriveModal, setShowDriveModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);

  // Controllers and active conversation refs
  const abortControllersRef = useRef(new Map()); // tempAssistantId -> AbortController
  const activeConversationIdRef = useRef(currentConversationId);
  const pollingRef = useRef(null);

  const isStreaming = activeStreamsCount > 0;

  // Keep activeConversationIdRef in sync with current state and URL
  useEffect(() => {
    activeConversationIdRef.current = currentConversationId;
    updateUrlAndStorage(currentConversationId, activeView, { replace: true });
  }, [currentConversationId, activeView]);

  // Continuously sync messages to localStorage whenever they change
  useEffect(() => {
    if (isValidConvId(currentConversationId) && messages.length > 0) {
      persistMessages(currentConversationId, messages);
    }
  }, [currentConversationId, messages]);

  // Synchronize browser back/forward (popstate)
  useEffect(() => {
    function handlePopState() {
      const convId = getInitialConvId();
      const view = getInitialView();
      if (convId !== activeConversationIdRef.current) {
        setCurrentConversationId(convId);
        activeConversationIdRef.current = convId;
        const cached = getPersistedMessages(convId);
        setMessages(cached);
      }
      setActiveView(view);
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

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

  /**
   * Starts recovery polling to recover generating/interrupted assistant responses from MongoDB.
   */
  const startRecoveryPolling = useCallback((convId) => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    let attempts = 0;
    const maxAttempts = 15; // 15 attempts * 2s = 30 seconds

    pollingRef.current = setInterval(async () => {
      attempts++;
      if (activeConversationIdRef.current !== convId || attempts > maxAttempts) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;

        // If timed out and still in-flight, mark any uncompleted recovering assistant message as interrupted
        if (attempts > maxAttempts) {
          setMessages((prev) => {
            const updated = prev.map((m) =>
              m.isStreaming
                ? {
                    ...m,
                    isStreaming: false,
                    statusText: "",
                    content:
                      m.content ||
                      "Response generation was interrupted. You can retry your question.",
                    isError: !m.content
                  }
                : m
            );
            persistMessages(convId, updated);
            return updated;
          });
        }
        return;
      }

      try {
        const res = await conversationApi.getConversation(convId);
        if (res && res.messages) {
          const serverMsgs = res.messages;
          const currentLocal = getPersistedMessages(convId);
          const reconciled = reconcileMessages(serverMsgs, currentLocal);

          setMessages(reconciled);
          persistMessages(convId, reconciled);

          const stillStreaming = reconciled.some(
            (m) => m.role === "assistant" && m.isStreaming
          );
          if (!stillStreaming) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
        }
      } catch (e) {
        console.warn("Recovery poll error:", e);
      }
    }, 2000);
  }, []);

  const loadMessages = useCallback(
    async (convId) => {
      if (!isValidConvId(convId)) {
        setMessages([]);
        setActiveDepartments([]);
        setIsLoadingMessages(false);
        return;
      }

      const cached = getPersistedMessages(convId);
      if (cached.length === 0) {
        setIsLoadingMessages(true);
      }

      try {
        const res = await conversationApi.getConversation(convId);
        if (!res || !res.conversation) {
          throw new Error("Conversation not found");
        }

        const serverMsgs = res.messages || [];
        const localMsgs = getPersistedMessages(convId);
        const reconciled = reconcileMessages(serverMsgs, localMsgs);

        setMessages(reconciled);
        persistMessages(convId, reconciled);

        // If last assistant message has routed departments, show them only if not fallback
        const lastAssistantMsg = [...reconciled].reverse().find((m) => m.role === "assistant");
        const FALLBACK = "I couldn't find this information in the uploaded documents.";
        if (
          lastAssistantMsg &&
          lastAssistantMsg.routedDepartments &&
          lastAssistantMsg.routedDepartments.length > 0 &&
          lastAssistantMsg.content !== FALLBACK
        ) {
          setActiveDepartments(lastAssistantMsg.routedDepartments);
        } else {
          setActiveDepartments([]);
        }

        // If there are still any assistant messages in streaming/recovering state, start recovery poll
        const hasRecovering = reconciled.some(
          (m) => m.role === "assistant" && m.isStreaming
        );
        if (hasRecovering) {
          startRecoveryPolling(convId);
        }
      } catch (err) {
        console.warn("Could not load conversation messages:", err);
        // ONLY clear state if conversation was actually deleted or not found (HTTP 404)
        if (err?.response?.status === 404) {
          setCurrentConversationId(null);
          activeConversationIdRef.current = null;
          setMessages([]);
          setActiveDepartments([]);
          updateUrlAndStorage(null, activeView, { replace: true });
          if (typeof window !== "undefined") {
            localStorage.removeItem(`rag_messages_${convId}`);
          }
        }
      } finally {
        setIsLoadingMessages(false);
      }
    },
    [activeView, startRecoveryPolling]
  );

  // When current conversation changes, load its messages
  useEffect(() => {
    if (currentConversationId) {
      loadMessages(currentConversationId);
    } else {
      setMessages([]);
      setActiveDepartments([]);
      setIsLoadingMessages(false);
    }
  }, [currentConversationId, loadMessages]);

  async function checkHealth() {
    try {
      const res = await api.get("/health");
      setSystemHealth(res.data?.services || null);
    } catch {
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

  function toggleTheme() {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }

  function changeActiveView(newView) {
    setActiveView(newView);
    updateUrlAndStorage(activeConversationIdRef.current, newView);
    // When returning to chat, ensure the active conversation's messages are loaded if missing
    if (newView === "chat" && activeConversationIdRef.current && messages.length === 0) {
      loadMessages(activeConversationIdRef.current);
    }
  }

  async function createNewChat() {
    stopGeneration();
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setCurrentConversationId(null);
    activeConversationIdRef.current = null;
    setMessages([]);
    setActiveDepartments([]);
    setIsLoadingMessages(false);
    changeActiveView("chat");
    updateUrlAndStorage(null, "chat");
  }

  async function selectConversation(id) {
    stopGeneration();
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    const idChanged = activeConversationIdRef.current !== id;
    setCurrentConversationId(id);
    activeConversationIdRef.current = id;
    changeActiveView("chat");
    updateUrlAndStorage(id, "chat");

    const cached = getPersistedMessages(id);
    if (cached.length > 0) {
      setMessages(cached);
    }

    if (idChanged || cached.length === 0) {
      loadMessages(id);
    }
  }

  async function renameConversation(id, newTitle) {
    if (!newTitle.trim()) return;
    try {
      const updated = await conversationApi.updateConversation(id, { title: newTitle.trim() });
      setConversations((prev) =>
        prev.map((c) => (c._id === id ? { ...c, title: updated.title } : c))
      );
    } catch (err) {
      console.error("Failed to rename conversation:", err);
    }
  }

  async function togglePinConversation(id, currentPinned) {
    try {
      const updated = await conversationApi.updateConversation(id, { pinned: !currentPinned });
      setConversations((prev) => {
        const next = prev.map((c) => (c._id === id ? { ...c, pinned: updated.pinned } : c));
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
      if (typeof window !== "undefined") {
        localStorage.removeItem(`rag_messages_${id}`);
      }
      if (activeConversationIdRef.current === id) {
        createNewChat();
      }
    } catch (err) {
      console.error("Failed to delete conversation:", err);
    }
  }

  function stopGeneration() {
    abortControllersRef.current.forEach((controller) => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    });
    abortControllersRef.current.clear();
    setActiveStreamsCount(0);
    setStreamStatusText("");
    setMessages((prev) => {
      const updated = prev.map((m) =>
        m.isStreaming ? { ...m, isStreaming: false, statusText: "" } : m
      );
      if (activeConversationIdRef.current) {
        persistMessages(activeConversationIdRef.current, updated);
      }
      return updated;
    });
  }

  /**
   * Public sendMessage method.
   * Immediately persists the user question locally so refresh/navigation preserves it,
   * establishes/reuses conversation ID without duplicates, and streams assistant answer.
   */
  async function sendMessage(questionText, options = {}) {
    const text = (questionText || "").trim();
    if (!text) return;

    const { isRegenerate = false } = options;

    let convId = activeConversationIdRef.current;

    // If starting a fresh chat, create the conversation upfront to anchor the ID in MongoDB and URL
    if (!isValidConvId(convId)) {
      try {
        const newConv = await conversationApi.createConversation(text.slice(0, 40));
        if (newConv && newConv._id) {
          convId = newConv._id;
          setCurrentConversationId(convId);
          activeConversationIdRef.current = convId;
          updateUrlAndStorage(convId, "chat", { replace: true });
          loadConversations();
        }
      } catch (err) {
        console.warn("Could not create conversation upfront, falling back to stream creation:", err);
      }
    }

    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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

    let nextMessages;
    if (isRegenerate) {
      nextMessages = [...messages, tempAssistantMsg];
    } else {
      const tempUserMsg = {
        _id: `temp_user_${uniqueSuffix}`,
        role: "user",
        content: text,
        createdAt: new Date().toISOString()
      };
      nextMessages = [...messages, tempUserMsg, tempAssistantMsg];
    }

    // 1. Immediately render in UI
    setMessages(nextMessages);

    // 2. Immediately persist user message and assistant placeholder into client storage
    if (isValidConvId(convId)) {
      persistMessages(convId, nextMessages);
    }

    // 3. Track active stream count & AbortController
    const controller = new AbortController();
    abortControllersRef.current.set(tempAssistantId, controller);
    setActiveStreamsCount((c) => c + 1);

    let streamedContent = "";

    // 4. Start streaming response
    chatApi.streamQuestion(
      text,
      convId,
      {
        onConversationId: (backendConvId) => {
          if (!activeConversationIdRef.current || activeConversationIdRef.current !== backendConvId) {
            setCurrentConversationId(backendConvId);
            activeConversationIdRef.current = backendConvId;
            updateUrlAndStorage(backendConvId, "chat", { replace: true });
            persistMessages(backendConvId, nextMessages);
            loadConversations();
          }
        },
        onStatus: (statusMsg) => {
          setStreamStatusText(statusMsg);
          setMessages((prev) => {
            const updated = prev.map((m) =>
              m._id === tempAssistantId ? { ...m, statusText: statusMsg } : m
            );
            if (activeConversationIdRef.current) {
              persistMessages(activeConversationIdRef.current, updated);
            }
            return updated;
          });
        },
        onRouted: ({ departments }) => {
          setActiveDepartments(departments);
          setMessages((prev) => {
            const updated = prev.map((m) =>
              m._id === tempAssistantId ? { ...m, routedDepartments: departments } : m
            );
            if (activeConversationIdRef.current) {
              persistMessages(activeConversationIdRef.current, updated);
            }
            return updated;
          });
        },
        onToken: (token) => {
          streamedContent += token;
          setMessages((prev) => {
            const updated = prev.map((m) =>
              m._id === tempAssistantId
                ? { ...m, content: streamedContent, isStreaming: true, statusText: "" }
                : m
            );
            if (activeConversationIdRef.current) {
              persistMessages(activeConversationIdRef.current, updated);
            }
            return updated;
          });
        },
        onComplete: (data) => {
          abortControllersRef.current.delete(tempAssistantId);
          setActiveStreamsCount((c) => Math.max(0, c - 1));

          const FALLBACK = "I couldn't find this information in the uploaded documents.";
          const finalDepts =
            data?.routedDepartments && data?.answer !== FALLBACK
              ? data.routedDepartments
              : [];

          setActiveDepartments(finalDepts);

          setMessages((prev) => {
            const updated = prev.map((m) =>
              m._id === tempAssistantId
                ? {
                    ...m,
                    _id: data?.messageId || m._id,
                    content: data?.answer || streamedContent,
                    sources: data?.sources || [],
                    images: data?.images || [],
                    routedDepartments: finalDepts,
                    timings: data?.timings || {},
                    isStreaming: false,
                    statusText: ""
                  }
                : m
            );
            if (activeConversationIdRef.current) {
              persistMessages(activeConversationIdRef.current, updated);
            }
            return updated;
          });

          loadConversations();
        },
        onError: (errMsg) => {
          abortControllersRef.current.delete(tempAssistantId);
          setActiveStreamsCount((c) => Math.max(0, c - 1));

          console.error("[Stream Error Detail]:", errMsg);
          const friendlyMessage = toFriendlyErrorMessage(
            errMsg,
            "Something went wrong while processing your request. Please try again."
          );

          setMessages((prev) => {
            const updated = prev.map((m) =>
              m._id === tempAssistantId
                ? {
                    ...m,
                    content: friendlyMessage,
                    isStreaming: false,
                    statusText: "",
                    isError: true
                  }
                : m
            );
            if (activeConversationIdRef.current) {
              persistMessages(activeConversationIdRef.current, updated);
            }
            return updated;
          });
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
    const trimmed = (newContent || "").trim();
    if (!trimmed) return;
    setMessages((prev) => {
      const updated = prev.slice(0, msgIndex);
      if (activeConversationIdRef.current) {
        persistMessages(activeConversationIdRef.current, updated);
      }
      return updated;
    });
    sendMessage(trimmed);
  }

  return (
    <ChatContext.Provider
      value={{
        conversations,
        currentConversationId,
        isLoadingMessages,
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
        setActiveView: changeActiveView,
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
