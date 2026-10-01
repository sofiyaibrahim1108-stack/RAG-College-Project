export const RAG_CONFIG = {
  chunkSize: 700,
  chunkOverlap: 100,
  minChunkLength: 40,
  topKText: 3,
  topKImages: 2,
  textSimilarityThreshold: 0.48,
  imageSimilarityThreshold: 0.15,
  historyWindow: 3, // number of previous messages to consider in context
  llm: {
    temperature: 0.05,
    num_predict: 260,
    top_p: 0.9
  }
};
