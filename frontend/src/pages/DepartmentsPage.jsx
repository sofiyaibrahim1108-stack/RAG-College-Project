import React, { useState, useEffect } from "react";
import {
  Building2,
  Plus,
  Search,
  Edit2,
  Trash2,
  FileText,
  AlertTriangle,
  X,
  Loader2,
  CheckCircle2,
  FolderOpen
} from "lucide-react";
import { departmentApi } from "../services/departmentApi";

export function DepartmentsPage() {
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Create / Edit modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDept, setEditingDept] = useState(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [modalError, setModalError] = useState(null);

  // Delete confirmation modal state
  const [deleteDept, setDeleteDept] = useState(null);
  const [deleteWarning, setDeleteWarning] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    loadDepartments();
  }, []);

  async function loadDepartments() {
    setLoading(true);
    try {
      const res = await departmentApi.getDepartments();
      setDepartments(res.departments || []);
    } catch (e) {
      console.error("Failed to load departments", e);
    } finally {
      setLoading(false);
    }
  }

  function openCreateModal() {
    setEditingDept(null);
    setName("");
    setDescription("");
    setModalError(null);
    setIsModalOpen(true);
  }

  function openEditModal(dept) {
    setEditingDept(dept);
    setName(dept.name);
    setDescription(dept.description || "");
    setModalError(null);
    setIsModalOpen(true);
  }

  async function handleSaveDepartment(e) {
    e.preventDefault();
    if (!name.trim()) {
      setModalError("Department name is required");
      return;
    }

    setIsSubmitting(true);
    setModalError(null);

    try {
      if (editingDept) {
        await departmentApi.updateDepartment(editingDept._id, {
          name: name.trim(),
          description: description.trim()
        });
      } else {
        await departmentApi.createDepartment({
          name: name.trim(),
          description: description.trim()
        });
      }
      setIsModalOpen(false);
      loadDepartments();
    } catch (err) {
      setModalError(err.response?.data?.error || err.message || "Failed to save department");
    } finally {
      setIsSubmitting(false);
    }
  }

  function startDeleteCheck(dept) {
    setDeleteDept(dept);
    setDeleteWarning(null);
    // If it has documents, prepare safety prompt
    if (dept.documentCount > 0) {
      setDeleteWarning({
        count: dept.documentCount,
        message: `This department contains ${dept.documentCount} document(s). Please move or delete associated documents first.`
      });
    }
  }

  async function confirmDelete(force = false) {
    if (!deleteDept) return;
    setIsDeleting(true);
    try {
      await departmentApi.deleteDepartment(deleteDept._id, { force });
      setDeleteDept(null);
      setDeleteWarning(null);
      loadDepartments();
    } catch (err) {
      const errData = err.response?.data;
      if (errData?.documentCount) {
        setDeleteWarning({
          count: errData.documentCount,
          message: errData.error || `This department contains ${errData.documentCount} document(s).`
        });
      } else {
        alert("Failed to delete department: " + (errData?.error || err.message));
      }
    } finally {
      setIsDeleting(false);
    }
  }

  const filteredDepts = departments.filter((d) =>
    d.name.toLowerCase().includes(search.toLowerCase()) ||
    (d.description || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-white flex items-center gap-2">
            <Building2 className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            <span>Departments</span>
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            {departments.length} departments available for organizing knowledge documents.
          </p>
        </div>

        <button
          onClick={openCreateModal}
          className="px-4.5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold shadow-xs transition flex items-center space-x-2 self-start sm:self-auto cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Create Department</span>
        </button>
      </div>

      {/* Search Bar */}
      <div className="relative w-full max-w-sm">
        <Search className="w-4 h-4 absolute left-3 top-2.5 text-neutral-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search departments..."
          className="w-full pl-9 pr-3 py-2 text-sm rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {/* Table or Empty State */}
      {loading ? (
        <div className="py-16 text-center text-sm text-neutral-400 flex items-center justify-center space-x-2">
          <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
          <span>Loading departments...</span>
        </div>
      ) : departments.length === 0 ? (
        /* Empty State */
        <div className="py-16 text-center border-2 border-dashed border-neutral-200 dark:border-neutral-800 rounded-2xl p-8 space-y-3">
          <FolderOpen className="w-10 h-10 text-neutral-400 mx-auto" />
          <p className="text-base font-semibold text-neutral-800 dark:text-neutral-200">
            No departments available
          </p>
          <p className="text-sm text-neutral-400 max-w-sm mx-auto">
            Create your first department to start organizing documents and routing knowledge searches.
          </p>
          <button
            onClick={openCreateModal}
            className="mt-2 px-4.5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold cursor-pointer"
          >
            + Create Department
          </button>
        </div>
      ) : (
        /* Department Table */
        <div className="border border-neutral-200 dark:border-neutral-800 rounded-2xl bg-white dark:bg-neutral-900 overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-50 dark:bg-neutral-950/60 border-b border-neutral-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400 font-semibold uppercase tracking-wider text-xs">
                <tr>
                  <th className="py-3.5 px-4">Department Name</th>
                  <th className="py-3.5 px-4">Description</th>
                  <th className="py-3.5 px-4 text-center">Documents</th>
                  <th className="py-3.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/60 text-neutral-700 dark:text-neutral-300">
                {filteredDepts.map((dept) => (
                  <tr key={dept._id} className="hover:bg-neutral-50/70 dark:hover:bg-neutral-800/40 transition">
                    <td className="py-4 px-4 font-semibold text-neutral-900 dark:text-neutral-100">
                      <div className="flex items-center gap-2.5">
                        <Building2 className="w-4 h-4 text-blue-500 flex-shrink-0" />
                        <span>{dept.name}</span>
                      </div>
                    </td>
                    <td className="py-4 px-4 text-neutral-500 dark:text-neutral-400 max-w-xs truncate text-xs">
                      {dept.description || "—"}
                    </td>
                    <td className="py-4 px-4 text-center font-mono">
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                        <FileText className="w-3.5 h-3.5 mr-1 text-blue-500" />
                        {dept.documentCount || 0}
                      </span>
                    </td>
                    <td className="py-4 px-4 text-right">
                      <div className="flex items-center justify-end space-x-1.5">
                        <button
                          onClick={() => openEditModal(dept)}
                          className="p-1.5 text-neutral-500 hover:text-blue-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition cursor-pointer"
                          title="Edit department"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => startDeleteCheck(dept)}
                          className="p-1.5 text-neutral-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition cursor-pointer"
                          title="Delete department"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create / Edit Department Modal */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in"
          onClick={() => !isSubmitting && setIsModalOpen(false)}
        >
          <div
            className="relative max-w-md w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl overflow-hidden shadow-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5 pb-3 border-b border-neutral-100 dark:border-neutral-800">
              <h3 className="text-lg font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-2.5">
                <Building2 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                <span>{editingDept ? "Edit Department" : "Create Department"}</span>
              </h3>
              <button
                onClick={() => !isSubmitting && setIsModalOpen(false)}
                disabled={isSubmitting}
                className="p-1.5 text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveDepartment} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
                  Department Name *
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Ophthalmology, Academic Affairs, Computer Science"
                  autoFocus
                  required
                  disabled={isSubmitting}
                  className="w-full text-sm p-2.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
                  Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description of documents and topics under this department..."
                  rows={3}
                  disabled={isSubmitting}
                  className="w-full text-sm p-2.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {modalError && (
                <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl text-sm text-red-600 dark:text-red-400">
                  {modalError}
                </div>
              )}

              <div className="flex items-center justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  disabled={isSubmitting}
                  className="px-4 py-2 text-sm font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-xl transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!name.trim() || isSubmitting}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl text-sm font-semibold shadow-xs transition flex items-center space-x-2 cursor-pointer"
                >
                  {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>{editingDept ? "Save Changes" : "Create Department"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteDept && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in"
          onClick={() => !isDeleting && setDeleteDept(null)}
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
                  Delete Department?
                </h3>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  Are you sure you want to delete <span className="font-semibold text-neutral-800 dark:text-neutral-200">"{deleteDept.name}"</span>?
                </p>

                {deleteWarning ? (
                  <div className="mt-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-300">
                    <p className="font-semibold">⚠️ Safety Warning</p>
                    <p className="mt-0.5">
                      This department currently contains {deleteWarning.count} document(s). To protect your knowledge base, you must remove or move those documents before deleting this department.
                    </p>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-5 flex items-center justify-end space-x-2">
              <button
                onClick={() => setDeleteDept(null)}
                disabled={isDeleting}
                className="px-4 py-2 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-xl transition"
              >
                Cancel
              </button>
              {!deleteWarning && (
                <button
                  onClick={() => confirmDelete(false)}
                  disabled={isDeleting}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-semibold shadow-sm transition flex items-center space-x-1.5"
                >
                  {isDeleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>Delete Department</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
