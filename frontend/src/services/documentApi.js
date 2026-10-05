import { api } from "./api";

export const documentApi = {
  async getDocuments(params = {}) {
    const res = await api.get("/documents", { params });
    return res.data;
  },

  async getDocument(id) {
    const res = await api.get(`/documents/${id}`);
    return res.data;
  },

  async uploadDocument(file, departmentData, onUploadProgress) {
    const formData = new FormData();
    formData.append("file", file);

    if (typeof departmentData === "object" && departmentData !== null) {
      if (departmentData.departmentIds && Array.isArray(departmentData.departmentIds)) {
        formData.append("departmentIds", JSON.stringify(departmentData.departmentIds));
      }
      if (departmentData.departmentId) formData.append("departmentId", departmentData.departmentId);
      if (departmentData.department) formData.append("department", departmentData.department);
      if (departmentData.isTestData !== undefined) formData.append("isTestData", departmentData.isTestData);
      if (departmentData.title) formData.append("title", departmentData.title);
    } else if (typeof departmentData === "string") {
      formData.append("department", departmentData);
    }

    const res = await api.post("/documents/upload", formData, {
      headers: { "Content-Type": "multipart/form-data" },
      onUploadProgress
    });
    return res.data;
  },

  async bulkDeleteDocuments(documentIds) {
    const res = await api.post("/documents/bulk-delete", { documentIds });
    return res.data;
  },

  async reprocessDocument(id) {
    const res = await api.post(`/documents/${id}/reprocess`);
    return res.data;
  },

  async deleteDocument(id) {
    const res = await api.delete(`/documents/${id}`);
    return res.data;
  }
};
