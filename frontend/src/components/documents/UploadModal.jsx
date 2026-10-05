import React, { useState, useEffect, useRef } from "react";
import { X, UploadCloud, FileText, CheckCircle2, AlertCircle, Loader2, Plus } from "lucide-react";
import { useChat } from "../../context/ChatContext";
import { documentApi } from "../../services/documentApi";
import { departmentApi } from "../../services/departmentApi";

export function UploadModal() {
  const { showUploadModal, setShowUploadModal, setActiveView } = useChat();
  const [selectedFile, setSelectedFile] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [loadingDepts, setLoadingDepts] = useState(false);
  const [selectedDeptIds, setSelectedDeptIds] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const fileInputRef = useRef(null);

  // Load dynamic departments when modal opens
  useEffect(() => {
    if (showUploadModal) {
      loadDepartments();
    }
  }, [showUploadModal]);

  async function loadDepartments() {
    setLoadingDepts(true);
    try {
      const res = await departmentApi.getDepartments();
      const depts = res.departments || [];
      setDepartments(depts);
      // Do NOT silently select a department by default
    } catch (e) {
      console.error("Failed to load departments", e);
    } finally {
      setLoadingDepts(false);
    }
  }

  if (!showUploadModal) return null;

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setErrorMessage(null);
    }
  }

  async function handleUpload() {
    if (selectedDeptIds.length === 0) {
      setErrorMessage("Please select at least one department before uploading.");
      return;
    }

    if (!selectedFile) {
      setErrorMessage("Please select a file to upload.");
      return;
    }

    const selectedDepts = departments.filter((d) => selectedDeptIds.includes(d._id));
    if (selectedDepts.length === 0) {
      setErrorMessage("Please select at least one valid department before uploading.");
      return;
    }

    setIsUploading(true);
    setStatusMessage("Uploading document to server...");
    setErrorMessage(null);

    try {
      await documentApi.uploadDocument(
        selectedFile,
        {
          departmentIds: selectedDeptIds,
          departmentId: selectedDepts[0]._id,
          department: selectedDepts[0].name,
          isTestData: selectedDepts.some((d) => d.isTestData === true)
        },
        (progressEvent) => {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          setUploadProgress(percent);
        }
      );

      setStatusMessage("Upload successful! Document processing has started in the background.");
      setTimeout(() => {
        setIsUploading(false);
        setSelectedFile(null);
        setSelectedDeptIds([]);
        setUploadProgress(0);
        setStatusMessage(null);
        setShowUploadModal(false);
      }, 1500);
    } catch (err) {
      console.error("[Upload Error]:", err);
      setIsUploading(false);
      setErrorMessage("Something went wrong while uploading the document. Please try again.");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in"
      onClick={() => !isUploading && setShowUploadModal(false)}
    >
      <div
        className="relative max-w-md w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl overflow-hidden shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5 pb-3 border-b border-neutral-100 dark:border-neutral-800">
          <div className="flex items-center gap-2.5">
            <UploadCloud className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0" />
            <h3 className="text-lg font-bold text-neutral-900 dark:text-neutral-100">
              Upload Document
            </h3>
          </div>
          <button
            onClick={() => !isUploading && setShowUploadModal(false)}
            disabled={isUploading}
            className="p-1.5 text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 rounded-lg cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Dynamic Multi-Department Selector */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
              Departments *
            </label>
            <button
              type="button"
              onClick={() => {
                setShowUploadModal(false);
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
                Please create at least one department before uploading documents.
              </p>
            </div>
          ) : (
            <div className="border border-neutral-300 dark:border-neutral-700 rounded-xl p-2.5 max-h-40 overflow-y-auto space-y-1.5 bg-neutral-50 dark:bg-neutral-950">
              {departments.map((dept) => {
                const isChecked = selectedDeptIds.includes(dept._id);
                return (
                  <label
                    key={dept._id}
                    className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-sm cursor-pointer transition select-none ${
                      isChecked
                        ? "bg-blue-50 dark:bg-blue-950/50 text-blue-900 dark:text-blue-200 font-medium"
                        : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
                    }`}
                  >
                    <input
                      type="checkbox"
                      value={dept._id}
                      checked={isChecked}
                      disabled={isUploading}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        if (checked) {
                          setSelectedDeptIds((prev) => [...new Set([...prev, dept._id])]);
                        } else {
                          setSelectedDeptIds((prev) => prev.filter((id) => id !== dept._id));
                        }
                        if (errorMessage) setErrorMessage(null);
                      }}
                      className="w-4 h-4 text-blue-600 rounded border-neutral-300 dark:border-neutral-700 focus:ring-blue-500 cursor-pointer"
                    />
                    <span className="truncate">{dept.name}</span>
                  </label>
                );
              })}
            </div>
          )}
          {selectedDeptIds.length > 0 && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1.5">
              {selectedDeptIds.length} department{selectedDeptIds.length > 1 ? "s" : ""} selected
            </p>
          )}
        </div>

        {/* Dropzone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-neutral-300 dark:border-neutral-700 hover:border-blue-500 dark:hover:border-blue-400 rounded-2xl p-6 text-center cursor-pointer transition bg-neutral-50/50 dark:bg-neutral-950/40"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.doc,.docx,.txt,.csv,.xls,.xlsx,.ppt,.pptx,.md,.markdown,.json,.html,.htm,.xml"
            onChange={handleFileSelect}
            className="hidden"
          />

          <FileText className="w-9 h-9 text-neutral-400 mx-auto mb-2" />
          {selectedFile ? (
            <div>
              <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                {selectedFile.name}
              </p>
              <p className="text-xs text-neutral-400 mt-0.5">
                {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
              </p>
            </div>
          ) : (
            <div>
              <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Click to browse or drag file here
              </p>
              <p className="text-xs text-neutral-400 mt-1">
                Supports PDF, DOC, DOCX, TXT, CSV, XLS, PPT, Markdown (up to 50MB)
              </p>
            </div>
          )}
        </div>

        {/* Progress bar */}
        {isUploading && (
          <div className="mt-4 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-neutral-600 dark:text-neutral-400">
              <span className="flex items-center gap-1.5 font-medium">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />
                {statusMessage}
              </span>
              <span className="font-semibold">{uploadProgress}%</span>
            </div>
            <div className="w-full bg-neutral-200 dark:bg-neutral-800 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-blue-600 h-full rounded-full transition-all duration-200"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Error message */}
        {errorMessage && (
          <div className="mt-3 p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl flex items-center space-x-2 text-sm text-red-600 dark:text-red-400">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Status message */}
        {statusMessage && !isUploading && (
          <div className="mt-3 p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded-xl flex items-center space-x-2 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>{statusMessage}</span>
          </div>
        )}

        {/* Footer Actions */}
        <div className="mt-5 flex items-center justify-between">
          <div className="text-xs text-neutral-400">
            {selectedDeptIds.length === 0
              ? "Select department(s) to continue"
              : !selectedFile
              ? "Choose file to upload"
              : ""}
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={() => setShowUploadModal(false)}
              disabled={isUploading}
              className="px-4 py-2 text-sm font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-xl transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleUpload}
              disabled={!selectedFile || selectedDeptIds.length === 0 || departments.length === 0 || isUploading}
              className={`px-5 py-2.5 text-sm font-semibold rounded-xl shadow-xs transition flex items-center space-x-1.5 ${
                selectedFile && selectedDeptIds.length > 0 && !isUploading
                  ? "bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
                  : "bg-neutral-200 dark:bg-neutral-800 text-neutral-400 cursor-not-allowed opacity-80"
              }`}
            >
              {isUploading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>Upload Document</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
