import React, { useState, useEffect, useRef } from "react";
import { X, UploadCloud, FileText, CheckCircle2, AlertCircle, Loader2, Plus, Building2 } from "lucide-react";
import { useChat } from "../../context/ChatContext";
import { documentApi } from "../../services/documentApi";
import { departmentApi } from "../../services/departmentApi";

export function UploadModal() {
  const { showUploadModal, setShowUploadModal, setActiveView } = useChat();
  const [selectedFile, setSelectedFile] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [loadingDepts, setLoadingDepts] = useState(false);
  const [selectedDeptId, setSelectedDeptId] = useState("");
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
      if (depts.length > 0 && !selectedDeptId) {
        setSelectedDeptId(depts[0]._id);
      }
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
    if (!selectedFile) {
      setErrorMessage("Please select a file to upload");
      return;
    }

    if (!selectedDeptId) {
      setErrorMessage("Please select a department before uploading");
      return;
    }

    const deptObj = departments.find((d) => d._id === selectedDeptId);
    if (!deptObj) {
      setErrorMessage("Selected department is invalid");
      return;
    }

    setIsUploading(true);
    setStatusMessage("Uploading document to server...");
    setErrorMessage(null);

    try {
      await documentApi.uploadDocument(
        selectedFile,
        {
          departmentId: deptObj._id,
          department: deptObj.name,
          isTestData: deptObj.isTestData === true
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
        setUploadProgress(0);
        setStatusMessage(null);
        setShowUploadModal(false);
      }, 1500);
    } catch (err) {
      setIsUploading(false);
      setErrorMessage(err.response?.data?.error || err.message || "Failed to upload document");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in"
      onClick={() => !isUploading && setShowUploadModal(false)}
    >
      <div
        className="relative max-w-md w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl overflow-hidden shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
            <UploadCloud className="w-5 h-5 text-blue-500" />
            <span>Upload Document</span>
          </h3>
          <button
            onClick={() => !isUploading && setShowUploadModal(false)}
            disabled={isUploading}
            className="p-1.5 text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Dynamic Department Selector */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Department *
            </label>
            <button
              type="button"
              onClick={() => {
                setShowUploadModal(false);
                setActiveView("departments");
              }}
              className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5"
            >
              <Plus className="w-3 h-3" />
              <span>Create Department</span>
            </button>
          </div>

          {loadingDepts ? (
            <div className="p-2.5 rounded-xl border border-neutral-200 dark:border-neutral-800 text-xs text-neutral-400 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Loading departments...</span>
            </div>
          ) : departments.length === 0 ? (
            <div className="p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-xl text-xs space-y-1.5">
              <p className="text-amber-800 dark:text-amber-300 font-medium">
                No departments available.
              </p>
              <p className="text-amber-700/80 dark:text-amber-400 text-[11px]">
                You must create at least one department before uploading documents.
              </p>
              <button
                type="button"
                onClick={() => {
                  setShowUploadModal(false);
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
              disabled={isUploading}
              className="w-full text-xs p-2.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
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

          <p className="text-[11px] text-neutral-400 mt-1">
            Department is required for domain-aware retrieval.
          </p>
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

          <FileText className="w-8 h-8 text-neutral-400 mx-auto mb-2" />
          {selectedFile ? (
            <div>
              <p className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">
                {selectedFile.name}
              </p>
              <p className="text-[11px] text-neutral-400 mt-0.5">
                {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
              </p>
            </div>
          ) : (
            <div>
              <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                Click to browse or drag file here
              </p>
              <p className="text-[11px] text-neutral-400 mt-1">
                Supports PDF, DOC, DOCX, TXT, CSV, XLS, XLSX, PPT, PPTX, MD, JSON, HTML, XML (up to 50MB)
              </p>
            </div>
          )}
        </div>

        {/* Progress or error */}
        {isUploading && (
          <div className="mt-4 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-neutral-600 dark:text-neutral-400">
              <span className="flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />
                {statusMessage}
              </span>
              <span>{uploadProgress}%</span>
            </div>
            <div className="w-full bg-neutral-200 dark:bg-neutral-800 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-blue-600 h-full rounded-full transition-all duration-200"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

        {errorMessage && (
          <div className="mt-3 p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl flex items-center space-x-2 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {statusMessage && !isUploading && (
          <div className="mt-3 p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded-xl flex items-center space-x-2 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>{statusMessage}</span>
          </div>
        )}

        {/* Footer Actions */}
        <div className="mt-5 flex items-center justify-end space-x-2">
          <button
            onClick={() => setShowUploadModal(false)}
            disabled={isUploading}
            className="px-4 py-2 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-xl transition"
          >
            Cancel
          </button>
          <button
            onClick={handleUpload}
            disabled={!selectedFile || !selectedDeptId || departments.length === 0 || isUploading}
            className={`px-4 py-2 text-xs font-semibold rounded-xl shadow-sm transition flex items-center space-x-1.5 ${
              selectedFile && selectedDeptId && !isUploading
                ? "bg-blue-600 hover:bg-blue-700 text-white"
                : "bg-neutral-200 dark:bg-neutral-800 text-neutral-400 cursor-not-allowed"
            }`}
          >
            {isUploading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>Upload & Process</span>
          </button>
        </div>
      </div>
    </div>
  );
}
