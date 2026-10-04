import React, { useState, useEffect } from "react";
import {
  X,
  FileText,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  Download,
  Plus
} from "lucide-react";
import { GoogleDriveIcon } from "../common/GoogleDriveIcon";
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
        } catch (e) {
          console.error("Failed to parse drive tokens", e);
        }
      }
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (authStatus === "error") {
      console.error("[Google OAuth Error]:", params.get("message"));
      setErrorMessage("Something went wrong during Google authorization. Please try again.");
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
      // Do NOT preselect any department - user must actively choose
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
      console.error("[Drive OAuth AuthUrl Error]:", err);
      setErrorMessage("Could not connect to Google Drive. Please verify configuration and try again.");
    }
  }

  async function loadDriveFiles() {
    setLoadingFiles(true);
    setErrorMessage(null);
    try {
      const res = await driveApi.listFiles(tokens);
      setFiles(res.files || []);
    } catch (err) {
      console.error("[Drive listFiles Error]:", err);
      setErrorMessage("Could not load your Google Drive files. Please try again.");
    } finally {
      setLoadingFiles(false);
    }
  }

  async function handleImport() {
    if (!selectedDeptId) {
      setErrorMessage("Please select a department before importing the document.");
      return;
    }

    if (!selectedFileId) {
      setErrorMessage("Please select a document to import.");
      return;
    }

    const deptObj = departments.find((d) => d._id === selectedDeptId);
    if (!deptObj) {
      setErrorMessage("Please select a department before importing the document.");
      return;
    }

    setIsImporting(true);
    setStatusMessage("Downloading document and importing to knowledge base...");
    setErrorMessage(null);

    try {
      const res = await driveApi.importFile(tokens, selectedFileId, {
        departmentId: deptObj._id,
        department: deptObj.name,
        isTestData: deptObj.isTestData === true
      });
      setStatusMessage(
        res.alreadyImported
          ? "File is already available in your knowledge base."
          : "Document imported successfully! Processing in background."
      );

      setTimeout(() => {
        setIsImporting(false);
        setStatusMessage(null);
        setSelectedFileId(null);
        setShowDriveModal(false);
      }, 1500);
    } catch (err) {
      console.error("[Drive importFile Error]:", err);
      setIsImporting(false);
      setErrorMessage("Something went wrong while importing the document. Please try again.");
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in"
      onClick={() => !isImporting && setShowDriveModal(false)}
    >
      <div
        className="relative max-w-xl w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl overflow-hidden shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5 pb-3 border-b border-neutral-100 dark:border-neutral-800">
          <div className="flex items-center gap-2.5">
            <GoogleDriveIcon className="w-5 h-5 shrink-0" />
            <h3 className="text-lg font-bold text-neutral-900 dark:text-neutral-100">
              Google Drive Import
            </h3>
          </div>
          <button
            onClick={() => !isImporting && setShowDriveModal(false)}
            disabled={isImporting}
            className="p-1.5 text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 rounded-lg cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {!tokens ? (
          /* Step 1: Connect Account */
          <div className="text-center py-8 px-4 space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 flex items-center justify-center mx-auto shadow-xs">
              <GoogleDriveIcon className="w-9 h-9" />
            </div>
            <div>
              <h4 className="text-base font-bold text-neutral-900 dark:text-neutral-100">
                Connect your Google Drive
              </h4>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 max-w-sm mx-auto mt-1 leading-relaxed">
                Connect your Google Drive account to import PDF, DOCX, TXT, and spreadsheet documents directly.
              </p>
            </div>

            {errorMessage && (
              <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl text-sm text-red-600 dark:text-red-400 text-left">
                {errorMessage}
              </div>
            )}

            <button
              onClick={handleConnectOAuth}
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold shadow-xs transition inline-flex items-center space-x-2 cursor-pointer"
            >
              <span>Connect with Google</span>
              <ExternalLink className="w-4 h-4" />
            </button>
          </div>
        ) : (
          /* Step 2: Browse & Select Files */
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs pb-1">
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                Google Drive Connected
              </span>
              <button
                onClick={handleDisconnect}
                className="text-neutral-400 hover:text-red-500 text-xs font-medium cursor-pointer"
              >
                Disconnect
              </button>
            </div>

            {/* Department Selection */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                  Select Department *
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setShowDriveModal(false);
                    setActiveView("departments");
                  }}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 font-medium cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create Department</span>
                </button>
              </div>

              {loadingDepts ? (
                <div className="p-2.5 rounded-xl border border-neutral-200 dark:border-neutral-800 text-sm text-neutral-400 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                  <span>Loading departments...</span>
                </div>
              ) : departments.length === 0 ? (
                <div className="p-3.5 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl text-sm space-y-1.5">
                  <p className="text-amber-800 dark:text-amber-300 font-semibold">
                    No departments available.
                  </p>
                  <p className="text-amber-700/80 dark:text-amber-400 text-xs">
                    Please create at least one department before importing documents.
                  </p>
                </div>
              ) : (
                <select
                  value={selectedDeptId}
                  onChange={(e) => {
                    setSelectedDeptId(e.target.value);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  disabled={isImporting}
                  className="w-full text-sm p-2.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500 font-medium"
                >
                  <option value="">Select Department</option>
                  {departments.map((dept) => (
                    <option key={dept._id} value={dept._id}>
                      {dept.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* File List */}
            <div>
              <label className="block text-sm font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
                Choose Document to Import *
              </label>
              <div className="border border-neutral-200 dark:border-neutral-800 rounded-xl max-h-56 overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800/60 bg-neutral-50/40 dark:bg-neutral-950/40 p-1">
                {loadingFiles ? (
                  <div className="py-8 text-center text-sm text-neutral-400 flex items-center justify-center space-x-2">
                    <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                    <span>Loading documents from Google Drive...</span>
                  </div>
                ) : files.length === 0 ? (
                  <div className="py-8 text-center text-sm text-neutral-400">
                    No supported documents found in Google Drive root folder.
                  </div>
                ) : (
                  files.map((file) => {
                    const isSelected = selectedFileId === file.id;
                    return (
                      <div
                        key={file.id}
                        onClick={() => {
                          setSelectedFileId(file.id);
                          if (errorMessage) setErrorMessage(null);
                        }}
                        className={`p-3 rounded-lg flex items-center justify-between text-sm cursor-pointer transition ${
                          isSelected
                            ? "bg-blue-50 dark:bg-blue-950/60 border border-blue-400 dark:border-blue-700 text-blue-950 dark:text-blue-100 shadow-xs"
                            : "hover:bg-neutral-100/80 dark:hover:bg-neutral-800/60 text-neutral-800 dark:text-neutral-200 border border-transparent"
                        }`}
                      >
                        <div className="flex items-center space-x-2.5 truncate">
                          <FileText
                            className={`w-4.5 h-4.5 flex-shrink-0 ${
                              isSelected ? "text-blue-600" : "text-neutral-400"
                            }`}
                          />
                          <span className={`truncate ${isSelected ? "font-semibold" : "font-normal"}`}>
                            {file.name}
                          </span>
                        </div>
                        {file.size && (
                          <span className="text-xs text-neutral-400 ml-2 shrink-0">
                            {(file.size / 1024 / 1024).toFixed(1)} MB
                          </span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Status & Error messages */}
            {statusMessage && (
              <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded-xl flex items-center space-x-2 text-sm text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-600" />
                <span>{statusMessage}</span>
              </div>
            )}

            {errorMessage && (
              <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl flex items-center justify-between text-sm text-red-600 dark:text-red-400">
                <div className="flex items-center space-x-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{errorMessage}</span>
                </div>
                {selectedFileId && selectedDeptId && (
                  <button
                    onClick={handleImport}
                    disabled={isImporting}
                    className="text-xs font-semibold underline hover:text-red-700 ml-2 cursor-pointer"
                  >
                    Try again
                  </button>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between pt-2">
              <div className="text-xs text-neutral-400">
                {!selectedDeptId
                  ? "Select a department above to continue"
                  : !selectedFileId
                  ? "Select a document to import"
                  : ""}
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setShowDriveModal(false)}
                  disabled={isImporting}
                  className="px-4 py-2 text-sm font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-xl transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleImport}
                  disabled={!selectedFileId || !selectedDeptId || departments.length === 0 || isImporting}
                  className={`px-5 py-2.5 text-sm font-semibold rounded-xl shadow-xs transition flex items-center space-x-2 ${
                    selectedFileId && selectedDeptId && !isImporting
                      ? "bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
                      : "bg-neutral-200 dark:bg-neutral-800 text-neutral-400 cursor-not-allowed opacity-80"
                  }`}
                >
                  {isImporting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                  <span>Import to Knowledge Base</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
