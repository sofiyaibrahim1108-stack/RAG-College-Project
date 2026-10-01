import { api } from "./api";

export const conversationApi = {
  async getConversations(search = "") {
    const res = await api.get("/conversations", { params: { search } });
    return res.data.conversations || [];
  },

  async createConversation(title = "New Chat") {
    const res = await api.post("/conversations", { title });
    return res.data.conversation;
  },

  async getConversation(id) {
    const res = await api.get(`/conversations/${id}`);
    return res.data;
  },

  async updateConversation(id, updates) {
    const res = await api.patch(`/conversations/${id}`, updates);
    return res.data.conversation;
  },

  async deleteConversation(id) {
    const res = await api.delete(`/conversations/${id}`);
    return res.data;
  }
};
