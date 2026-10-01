import React, { useState, useEffect } from "react";
import {
  Upload,
  Cloud,
  Search,
  Filter,
  Trash2,
  RotateCw,
  FileText,
  CheckCircle2,
  Clock,
  AlertCircle,
  Eye,
  Layers,
  Image as ImageIcon,
  Building2,
  CheckSquare,
  Square,
  AlertTriangle,
  X,
  Loader2
} from "lucide-react";
import { useChat } from "../context/ChatContext";
import { documentApi } from "../services/documentApi";
import { departmentApi } from "../services/departmentApi";

export function DocumentsPage() {
  const { setShowUploadModal, setShowDriveModal, setLightboxImage, setActiveView } = useChat();
  const [documents, setDocuments] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDept, setSelectedDept] = useState("All");
  const [search, setSearch] = useState("");
  const [selectedDocDetails, setSelectedDocDetails] = useState(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Bulk Selection & Deletion state
  const [selectedDocIds, setSelectedDocIds] = useState(new Set());
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  useEffect(() => {
    loadDepartments();
  }, []);

  useEffect(() => {
    loadDocs();
    const interval = setInterval(loadDocs, 10000); // Polling for processing status changes
    return () => clearInterval(interval);
  }, [selectedDept, search]);

  async function loadDepartments() {
    try {
      const res = await departmentApi.getDepartments();
      setDepartments(res.departments || []);
    } catch (e) {
      console.error("Failed to load departments", e);
    }
  }

  async function loadDocs() {
    try {
      const res = await documentApi.getDocuments({
        department: selectedDept !== "All" ? selectedDept : undefined,
        search: search.trim() || undefined
      });
      setDocuments(res.documents || []);
    } catch (e) {
      console.error("Failed to load documents", e);
    } finally {
      setLoading(false);
    }
  }

  // Toggle selection for a single doc
  function toggleSelectDoc(id, e) {
    if (e) e.stopPropagation();
    setSelectedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  // Select all or deselect all visible docs
  function toggleSelectAll() {
    if (selectedDocIds.size === documents.length && documents.length > 0) {
      setSelectedDocIds(new Set());
    } else {
      setSelectedDocIds(new Set(documents.map((d) => d._id)));
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Are you sure you want to delete this document and all its chunks?")) {
      return;
    }
    try {
      await documentApi.deleteDocument(id);
      setDocuments((prev) => prev.filter((d) => d._id !== id));
      setSelectedDocIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (selectedDocDetails?.document?._id === id) {
        setSelectedDocDetails(null);
      }
    } catch (err) {
      alert("Failed to delete document: " + err.message);
    }
  }

  async function handleBulkDelete() {
    if (selectedDocIds.size === 0) return;
    setIsBulkDeleting(true);
    try {
      await documentApi.bulkDeleteDocuments(Array.from(selectedDocIds));
      setSelectedDocIds(new Set());
      setShowBulkDeleteModal(false);
      loadDocs();
      loadDepartments();
    } catch (err) {
      alert("Failed to delete selected documents: " + (err.response?.data?.error || err.message));
    } finally {
      setIsBulkDeleting(false);
    }
  }

  async function handleReprocess(id) {
    try {
      await documentApi.reprocessDocument(id);
      loadDocs();
    } catch (err) {
      alert("Failed to trigger reprocessing: " + err.message);
    }
  }

  async function handleViewDetails(id) {
    setLoadingDetails(true);
    try {
      const data = await documentApi.getDocument(id);
      setSelectedDocDetails(data);
    } catch (e) {
      alert("Failed to fetch document details");
    } finally {
      setLoadingDetails(false);
    }
  }

  function renderStatusBadge(status) {
    switch (status) {
      case "completed":
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
            <CheckCircle2 className="w-3 h-3 mr-1" />
            Completed
          </span>
        );
      case "processing":
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-800 animate-pulse">
            <Clock className="w-3 h-3 mr-1 animate-spin" />
            Processing
          </span>
        );
      case "failed":
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300 border border-red-200 dark:border-red-800">
            <AlertCircle className="w-3 h-3 mr-1" />
            Failed
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
            {status}
          </span>
        );
    }
  }

  const isAllSelected = documents.length > 0 && selectedDocIds.size === documents.length;

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-neutral-900 dark:text-white flex items-center gap-2">
            <span>Knowledge Documents</span>
            <span className="text-xs font-normal px-2.5 py-0.5 rounded-full bg-neutral-200 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400">
              {documents.length} Total
            </span>
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            Manage files, inspect extracted SigLIP2 diagrams, or import from Google Drive.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center space-x-2.5 flex-wrap gap-y-2">
          {selectedDocIds.size > 0 && (
            <button
              onClick={() => setShowBulkDeleteModal(true)}
              className="px-3.5 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-semibold shadow-sm transition flex items-center space-x-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete Selected ({selectedDocIds.size})</span>
            </button>
          )}

          <button
            onClick={() => setShowUploadModal(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-semibold shadow-sm transition flex items-center space-x-1.5"
          >
            <Upload className="w-4 h-4" />
            <span>Upload Document</span>
          </button>

          <button
            onClick={() => setShowDriveModal(true)}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold shadow-sm transition flex items-center space-x-1.5"
          >
            <Cloud className="w-4 h-4" />
            <span>Google Drive Import</span>
          </button>
        </div>
      </div>

      {/* Supported Formats Banner */}
      <div className="flex flex-wrap items-center gap-1.5 p-3 rounded-2xl bg-neutral-100/70 dark:bg-neutral-900/50 border border-neutral-200/80 dark:border-neutral-800/80 text-xs">
        <span className="font-semibold text-neutral-700 dark:text-neutral-300 mr-1 flex items-center gap-1">
          <FileText className="w-3.5 h-3.5 text-blue-500" />
          Supported Formats:
        </span>
        {["PDF", "DOC", "DOCX", "TXT", "CSV", "XLS", "XLSX", "PPT", "PPTX", "Markdown", "JSON", "HTML", "XML"].map((fmt) => (
          <span
            key={fmt}
            className="px-2 py-0.5 rounded-lg bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-[10px] font-mono text-neutral-600 dark:text-neutral-300 font-medium"
          >
            {fmt}
          </span>
        ))}
      </div>

      {/* Filters: Dynamic MongoDB Department Tabs, Search, and Bulk Selection */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
        {/* Dynamic Department Pills from MongoDB */}
        <div className="flex items-center space-x-1 overflow-x-auto w-full md:w-auto pb-1">
          <button
            onClick={() => setSelectedDept("All")}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition whitespace-nowrap ${
              selectedDept === "All"
                ? "bg-blue-600 text-white shadow-xs"
                : "bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            }`}
          >
            All
          </button>

          {departments.map((dept) => (
            <button
              key={dept._id}
              onClick={() => setSelectedDept(dept.name)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition whitespace-nowrap ${
                selectedDept === dept.name
                  ? "bg-blue-600 text-white shadow-xs"
                  : "bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              }`}
            >
              {dept.name}
            </button>
          ))}
        </div>

        {/* Search & Bulk Select Controls */}
        <div className="flex items-center space-x-2 w-full md:w-auto">
          {documents.length > 0 && (
            <button
              onClick={toggleSelectAll}
              className="px-3 py-2 text-xs font-medium rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition flex items-center space-x-1.5 whitespace-nowrap"
            >
              {isAllSelected ? (
                <CheckSquare className="w-3.5 h-3.5 text-blue-600" />
              ) : (
                <Square className="w-3.5 h-3.5 text-neutral-400" />
              )}
              <span>{isAllSelected ? "Deselect All" : "Select All"}</span>
            </button>
          )}

          <div className="relative flex-1 md:w-64">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-neutral-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search documents..."
              className="w-full pl-9 pr-3 py-2 text-xs rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Document Grid */}
      {loading ? (
        <div className="py-16 text-center text-xs text-neutral-400 flex items-center justify-center space-x-2">
          <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
          <span>Loading documents...</span>
        </div>
      ) : documents.length === 0 ? (
        /* Empty State */
        <div className="py-16 text-center border-2 border-dashed border-neutral-200 dark:border-neutral-800 rounded-2xl p-8 space-y-3">
          <FileText className="w-10 h-10 text-neutral-400 mx-auto" />
          <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
            No documents uploaded yet
          </p>
          <p className="text-xs text-neutral-400 max-w-sm mx-auto">
            Upload PDF, DOC/DOCX, TXT, CSV, XLS/XLSX, PPT/PPTX, Markdown, JSON, HTML, or XML documents or import directly from Google Drive.
          </p>
          <button
            onClick={() => setShowUploadModal(true)}
            className="mt-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-semibold"
          >
            Upload Document
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {documents.map((doc) => {
            const isSelected = selectedDocIds.has(doc._id);
            return (
              <div
                key={doc._id}
                className={`p-5 rounded-2xl border bg-white dark:bg-neutral-900 shadow-xs transition flex flex-col justify-between ${
                  isSelected
                    ? "border-blue-500 dark:border-blue-500 ring-1 ring-blue-500/20"
                    : "border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700"
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={(e) => toggleSelectDoc(doc._id, e)}
                        className="text-neutral-400 hover:text-blue-600 transition"
                      >
                        {isSelected ? (
                          <CheckSquare className="w-4 h-4 text-blue-600" />
                        ) : (
                          <Square className="w-4 h-4" />
                        )}
                      </button>
                      <span className="px-2 py-0.5 rounded-md text-[10px] uppercase font-bold tracking-wider bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400">
                        {doc.fileType}
                      </span>
                      {doc.isTestData && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300">
                          test
                        </span>
                      )}
                    </div>
                    {renderStatusBadge(doc.status)}
                  </div>

                  <h3
                    className="font-semibold text-sm text-neutral-900 dark:text-neutral-100 truncate"
                    title={doc.title}
                  >
                    {doc.title}
                  </h3>
                  <p className="text-xs text-neutral-400 truncate mt-0.5">
                    {doc.originalName}
                  </p>

                  <div className="mt-4 pt-3 border-t border-neutral-100 dark:border-neutral-800/80 flex items-center justify-between text-xs text-neutral-500">
                    <span className="flex items-center gap-1">
                      <Layers className="w-3.5 h-3.5 text-blue-500" />
                      <span>{doc.chunkCount || 0} Chunks</span>
                    </span>

                    <span className="flex items-center gap-1">
                      <ImageIcon className="w-3.5 h-3.5 text-purple-500" />
                      <span>{doc.imageCount || 0} Images</span>
                    </span>

                    <span className="px-2 py-0.5 rounded-full text-[10px] bg-neutral-100 dark:bg-neutral-800 font-medium">
                      {doc.department}
                    </span>
                  </div>
                </div>

                {/* Actions Footer */}
                <div className="mt-4 pt-3 border-t border-neutral-100 dark:border-neutral-800/80 flex items-center justify-between">
                  <button
                    onClick={() => handleViewDetails(doc._id)}
                    className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>Inspect</span>
                  </button>

                  <div className="flex items-center space-x-1">
                    <button
                      onClick={() => handleReprocess(doc._id)}
                      className="p-1.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
                      title="Reprocess document"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                    </button>

                    <button
                      onClick={() => handleDelete(doc._id)}
                      className="p-1.5 text-neutral-400 hover:text-red-600 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 transition"
                      title="Delete document"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Bulk Delete Confirmation Modal */}
      {showBulkDeleteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in"
          onClick={() => !isBulkDeleting && setShowBulkDeleteModal(false)}
        >
          <div
            className="relative max-w-md w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl overflow-hidden shadow-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 flex-shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  Delete {selectedDocIds.size} selected documents?
                </h3>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  This will permanently remove:
                </p>
                <ul className="text-xs text-neutral-600 dark:text-neutral-300 list-disc list-inside mt-2 space-y-0.5">
                  <li>Document files and database records</li>
                  <li>All generated document text chunks</li>
                  <li>Extracted diagrams and SigLIP2 vision embeddings</li>
                  <li>Related vector embeddings</li>
                </ul>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-end space-x-2">
              <button
                onClick={() => setShowBulkDeleteModal(false)}
                disabled={isBulkDeleting}
                className="px-4 py-2 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-xl transition"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={isBulkDeleting}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-semibold shadow-sm transition flex items-center space-x-1.5"
              >
                {isBulkDeleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Delete {selectedDocIds.size} Documents</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Document Detail Inspection Modal */}
      {selectedDocDetails && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in"
          onClick={() => setSelectedDocDetails(null)}
        >
          <div
            className="relative max-w-3xl w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl overflow-hidden shadow-2xl p-6 max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-neutral-200 dark:border-neutral-800">
              <div>
                <h3 className="font-semibold text-base text-neutral-900 dark:text-neutral-100">
                  {selectedDocDetails.document.title}
                </h3>
                <p className="text-xs text-neutral-400">
                  {selectedDocDetails.document.originalName} • {selectedDocDetails.chunks?.length || 0} Chunks •{" "}
                  {selectedDocDetails.images?.length || 0} Extracted Images • Department:{" "}
                  <span className="font-medium text-neutral-700 dark:text-neutral-300">
                    {selectedDocDetails.document.department}
                  </span>
                </p>
              </div>
              <button
                onClick={() => setSelectedDocDetails(null)}
                className="p-1.5 text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-4 space-y-5">
              {/* Extracted Images */}
              {selectedDocDetails.images && selectedDocDetails.images.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-neutral-700 dark:text-neutral-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <ImageIcon className="w-3.5 h-3.5 text-purple-500" />
                    <span>Extracted Images & SigLIP2 Embeddings</span>
                  </h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {selectedDocDetails.images.map((img) => (
                      <div
                        key={img._id}
                        onClick={() =>
                          setLightboxImage({
                            ...img,
                            imagePath: `/api/documents/images/${selectedDocDetails.document._id}/${img.filename}`
                          })
                        }
                        className="cursor-pointer border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden group shadow-xs"
                      >
                        <div className="h-24 bg-neutral-100 dark:bg-neutral-950 flex items-center justify-center">
                          <img
                            src={`/api/documents/images/${selectedDocDetails.document._id}/${img.filename}`}
                            alt={img.filename}
                            className="h-full w-full object-cover group-hover:scale-105 transition"
                          />
                        </div>
                        <div className="p-2 text-[10px] text-neutral-500 dark:text-neutral-400 truncate">
                          {img.filename} (Page {img.pageNumber})
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Text Chunks */}
              <div>
                <h4 className="text-xs font-semibold text-neutral-700 dark:text-neutral-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-blue-500" />
                  <span>Text Chunks</span>
                </h4>
                <div className="space-y-2">
                  {selectedDocDetails.chunks?.map((chunk, i) => (
                    <div
                      key={chunk._id || i}
                      className="p-3 bg-neutral-50 dark:bg-neutral-950/60 border border-neutral-200 dark:border-neutral-800 rounded-xl text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between text-[11px] text-neutral-400 font-mono">
                        <span>Chunk #{chunk.chunkIndex}</span>
                        <span>Page {chunk.pageNumber || 1}</span>
                      </div>
                      <p className="text-neutral-800 dark:text-neutral-200 leading-relaxed font-sans">
                        {chunk.content}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
