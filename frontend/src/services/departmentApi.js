import { api } from "./api";

export const departmentApi = {
  async getDepartments() {
    const res = await api.get("/departments");
    return res.data;
  },

  async getDepartment(id) {
    const res = await api.get(`/departments/${id}`);
    return res.data;
  },

  async createDepartment(data) {
    const res = await api.post("/departments", data);
    return res.data;
  },

  async updateDepartment(id, data) {
    const res = await api.put(`/departments/${id}`, data);
    return res.data;
  },

  async deleteDepartment(id, options = {}) {
    const params = {};
    if (options.force) params.force = "true";
    if (options.deleteTestDocumentsOnly) params.deleteTestDocumentsOnly = "true";
    const res = await api.delete(`/departments/${id}`, { params });
    return res.data;
  }
};

export const testDataApi = {
  async getSummary() {
    const res = await api.get("/test-data/summary");
    return res.data;
  },

  async cleanup(confirm = true) {
    const res = await api.post("/test-data/cleanup", { confirm });
    return res.data;
  }
};
