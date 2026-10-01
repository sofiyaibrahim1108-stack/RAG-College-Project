import { api } from "./api";

export const driveApi = {
  async getDriveStatus() {
    try {
      const res = await api.get("/drive/status");
      return res.data;
    } catch (e) {
      return { configured: false, clientIdConfigured: false };
    }
  },

  async getAuthUrl() {
    const res = await api.get("/drive/auth-url");
    return res.data.authUrl;
  },

  async listFiles(tokens, pageToken = null) {
    const res = await api.get("/drive/files", {
      headers: {
        Authorization: `Bearer ${encodeURIComponent(JSON.stringify(tokens))}`
      },
      params: { pageToken }
    });
    return res.data;
  },

  async importFile(tokens, fileId, departmentData) {
    const payload = { fileId };
    if (typeof departmentData === "object" && departmentData !== null) {
      if (departmentData.departmentId) payload.departmentId = departmentData.departmentId;
      if (departmentData.department) payload.department = departmentData.department;
      if (departmentData.isTestData !== undefined) payload.isTestData = departmentData.isTestData;
    } else if (typeof departmentData === "string") {
      payload.department = departmentData;
    }

    const res = await api.post(
      "/drive/import",
      payload,
      {
        headers: {
          Authorization: `Bearer ${encodeURIComponent(JSON.stringify(tokens))}`
        }
      }
    );
    return res.data;
  }
};
