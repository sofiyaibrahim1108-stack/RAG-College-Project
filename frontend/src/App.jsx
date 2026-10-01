import React, { useState } from "react";
import { ChatProvider, useChat } from "./context/ChatContext";
import { Sidebar } from "./components/sidebar/Sidebar";
import { ChatHeader } from "./components/chat/ChatHeader";
import { ChatPage } from "./pages/ChatPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { DepartmentsPage } from "./pages/DepartmentsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { Lightbox } from "./components/common/Lightbox";
import { SourcePreviewModal } from "./components/common/SourcePreviewModal";
import { UploadModal } from "./components/documents/UploadModal";
import { GoogleDriveModal } from "./components/documents/GoogleDriveModal";

function MainContent() {
  const { activeView } = useChat();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white dark:bg-neutral-950">
      {/* Sidebar */}
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
        <ChatHeader onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />

        <main className="flex-1 overflow-hidden flex flex-col">
          {activeView === "chat" && <ChatPage />}
          {activeView === "departments" && <DepartmentsPage />}
          {activeView === "documents" && <DocumentsPage />}
          {activeView === "settings" && <SettingsPage />}
        </main>
      </div>

      {/* Global Modals & Overlays */}
      <Lightbox />
      <SourcePreviewModal />
      <UploadModal />
      <GoogleDriveModal />
    </div>
  );
}

export default function App() {
  return (
    <ChatProvider>
      <MainContent />
    </ChatProvider>
  );
}
