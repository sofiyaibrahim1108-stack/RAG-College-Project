export const RAG_CONFIG = {
  chunkSize: 700,
  chunkOverlap: 100,
  minChunkLength: 40,
  topKText: 3,
  topKImages: 3,
  textSimilarityThreshold: 0.48,
  imageSimilarityThreshold: 0.065,
  historyWindow: 3, // number of previous messages to consider in context
  llm: {
    temperature: 0.2,
    num_predict: 700,
    top_p: 0.92
  }
};
