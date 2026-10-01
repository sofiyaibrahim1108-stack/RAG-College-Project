import React, { useState, useEffect } from "react";
import {
  X,
  Cloud,
  FileText,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  Download,
  Plus
} from "lucide-react";
import { useChat } from "../../context/ChatContext";
import { driveApi } from "../../services/driveApi";
import { departmentApi } from "../../services/departmentApi";

export function GoogleDriveModal() {
  const { showDriveModal, setShowDriveModal, setActiveView } = useChat();
  const [tokens, setTokens] = useState(() => {
    const saved = localStorage.getItem("google_drive_tokens");
    return saved ? JSON.parse(saved) : null;
  });

  const [files, setFiles] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [departments, setDepartments] = useState([]);
  const [loadingDepts, setLoadingDepts] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState(null);
  const [selectedDeptId, setSelectedDeptId] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);

  // Check URL query parameters for OAuth callback results
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authStatus = params.get("google_auth");
    if (authStatus === "success") {
      const tokensParam = params.get("tokens");
      if (tokensParam) {
        try {
          const parsed = JSON.parse(decodeURIComponent(tokensParam));
          localStorage.setItem("google_drive_tokens", JSON.stringify(parsed));
          setTokens(parsed);
          setShowDriveModal(true);
        } catch (e) {}
      }
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (authStatus === "error") {
      setErrorMessage(params.get("message") || "Google authentication failed");
      setShowDriveModal(true);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // Fetch Drive files and departments when modal opens and tokens exist
  useEffect(() => {
    if (showDriveModal) {
      loadDepartments();
      if (tokens) {
        loadDriveFiles();
      }
    }
  }, [showDriveModal, tokens]);

  async function loadDepartments() {
    setLoadingDepts(true);
    try {
      const res = await departmentApi.getDepartments();
      const depts = res.departments || [];
      setDepartments(depts);
      if (depts.length > 0 && !selectedDeptId) {
        setSelectedDeptId(depts[0]._id);
      }
    } catch (e) {
      console.error("Failed to load departments", e);
    } finally {
      setLoadingDepts(false);
    }
  }

  async function handleConnectOAuth() {
    try {
      setErrorMessage(null);
      const authUrl = await driveApi.getAuthUrl();
      window.location.href = authUrl;
    } catch (err) {
      setErrorMessage(
        err.response?.data?.error ||
          err.message ||
          "Google OAuth is not configured in backend environment variables (.env)."
      );
    }
  }

  async function loadDriveFiles() {
    setLoadingFiles(true);
    setErrorMessage(null);
    try {
      const res = await driveApi.listFiles(tokens);
      setFiles(res.files || []);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || err.message || "Failed to load Google Drive files");
    } finally {
      setLoadingFiles(false);
    }
  }

  async function handleImport() {
    if (!selectedFileId) {
      setErrorMessage("Please select a document to import");
      return;
    }

    if (!selectedDeptId) {
      setErrorMessage("Please select a department before importing");
      return;
    }

    const deptObj = departments.find((d) => d._id === selectedDeptId);
    if (!deptObj) {
      setErrorMessage("Selected department is invalid");
      return;
    }

    setIsImporting(true);
    setStatusMessage("Downloading document and passing to RAG pipeline...");
    setErrorMessage(null);

    try {
      const res = await driveApi.importFile(tokens, selectedFileId, {
        departmentId: deptObj._id,
        department: deptObj.name,
        isTestData: deptObj.isTestData === true
      });
      setStatusMessage(
        res.alreadyImported
          ? "File was previously imported! Ready in knowledge base."
          : "Document imported successfully! Processing in background."
      );

      setTimeout(() => {
        setIsImporting(false);
        setStatusMessage(null);
        setSelectedFileId(null);
        setShowDriveModal(false);
      }, 1500);
    } catch (err) {
      setIsImporting(false);
      setErrorMessage(err.response?.data?.error || err.message || "Failed to import file");
    }
  }

  function handleDisconnect() {
    localStorage.removeItem("google_drive_tokens");
    setTokens(null);
    setFiles([]);
    setSelectedFileId(null);
  }

  if (!showDriveModal) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in"
      onClick={() => !isImporting && setShowDriveModal(false)}
    >
      <div
        className="relative max-w-xl w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl overflow-hidden shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
            <Cloud className="w-5 h-5 text-emerald-500" />
            <span>Google Drive Import</span>
          </h3>
          <button
            onClick={() => !isImporting && setShowDriveModal(false)}
            disabled={isImporting}
            className="p-1.5 text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {!tokens ? (
          /* Step 1: Connect Account */
          <div className="text-center py-8 px-4 space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto shadow-inner">
              <Cloud className="w-8 h-8" />
            </div>
            <div>
              <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                Connect your Google Drive
              </h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 max-w-sm mx-auto mt-1">
                Authorize Google Drive to select PDF, DOCX, and TXT documents directly from your cloud storage.
              </p>
            </div>

            {errorMessage && (
              <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl text-xs text-red-600 dark:text-red-400 text-left">
                {errorMessage}
              </div>
            )}

            <button
              onClick={handleConnectOAuth}
              className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold shadow-sm transition inline-flex items-center space-x-2"
            >
              <span>Authenticate with Google</span>
              <ExternalLink className="w-4 h-4" />
            </button>
          </div>
        ) : (
          /* Step 2: Browse & Select Files */
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs">
              <span className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                Google Drive Connected
              </span>
              <button
                onClick={handleDisconnect}
                className="text-neutral-400 hover:text-red-500 text-[11px]"
              >
                Disconnect
              </button>
            </div>

            {/* Department Selection */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                  Assign Knowledge Department *
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setShowDriveModal(false);
                    setActiveView("departments");
                  }}
                  className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5"
                >
                  <Plus className="w-3 h-3" />
                  <span>Create Department</span>
                </button>
              </div>

              {loadingDepts ? (
                <div className="p-2 rounded-xl border border-neutral-200 dark:border-neutral-800 text-xs text-neutral-400 flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Loading departments...</span>
                </div>
              ) : departments.length === 0 ? (
                <div className="p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl text-xs space-y-1.5">
                  <p className="text-amber-800 dark:text-amber-300 font-medium">
                    No departments available.
                  </p>
                  <p className="text-amber-700/80 dark:text-amber-400 text-[11px]">
                    You must create at least one department before importing documents.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setShowDriveModal(false);
                      setActiveView("departments");
                    }}
                    className="mt-1 px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-[11px] font-semibold transition flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" />
                    <span>+ Create Department</span>
                  </button>
                </div>
              ) : (
                <select
                  value={selectedDeptId}
                  onChange={(e) => setSelectedDeptId(e.target.value)}
                  disabled={isImporting}
                  className="w-full text-xs p-2 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:outline-none"
                >
                  <option value="" disabled>
                    Select Department ▼
                  </option>
                  {departments.map((dept) => (
                    <option key={dept._id} value={dept._id}>
                      {dept.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* File List */}
            <div className="border border-neutral-200 dark:border-neutral-800 rounded-xl max-h-56 overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800/60 bg-neutral-50/40 dark:bg-neutral-950/40">
              {loadingFiles ? (
                <div className="py-8 text-center text-xs text-neutral-400 flex items-center justify-center space-x-2">
                  <Loader2 className="w-4 h-4 animate-spin text-emerald-500" />
                  <span>Loading documents from Google Drive...</span>
                </div>
              ) : files.length === 0 ? (
                <div className="py-8 text-center text-xs text-neutral-400">
                  No supported documents (PDF, DOCX, TXT, etc.) found in Drive root
                </div>
              ) : (
                files.map((file) => (
                  <div
                    key={file.id}
                    onClick={() => setSelectedFileId(file.id)}
                    className={`p-3 flex items-center justify-between text-xs cursor-pointer transition ${
                      selectedFileId === file.id
                        ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200"
                        : "hover:bg-neutral-100 dark:hover:bg-neutral-800/60 text-neutral-800 dark:text-neutral-200"
                    }`}
                  >
                    <div className="flex items-center space-x-2.5 truncate">
                      <FileText className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                      <span className="truncate font-medium">{file.name}</span>
                    </div>
                    {file.size && (
                      <span className="text-[10px] text-neutral-400 ml-2">
                        {(file.size / 1024 / 1024).toFixed(1)} MB
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Status messages */}
            {statusMessage && (
              <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded-xl flex items-center space-x-2 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                <span>{statusMessage}</span>
              </div>
            )}

            {errorMessage && (
              <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl flex items-center space-x-2 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-end space-x-2 pt-2">
              <button
                onClick={() => setShowDriveModal(false)}
                disabled={isImporting}
                className="px-4 py-2 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-xl transition"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={!selectedFileId || !selectedDeptId || departments.length === 0 || isImporting}
                className={`px-4 py-2 text-xs font-semibold rounded-xl shadow-sm transition flex items-center space-x-1.5 ${
                  selectedFileId && selectedDeptId && !isImporting
                    ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                    : "bg-neutral-200 dark:bg-neutral-800 text-neutral-400 cursor-not-allowed"
                }`}
              >
                {isImporting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                <span>Import to Knowledge Base</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
