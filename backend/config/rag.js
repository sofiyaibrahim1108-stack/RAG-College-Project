export const RAG_CONFIG = {
  chunkSize: 700,
  chunkOverlap: 100,
  minChunkLength: 40,
  topKText: 3,
  topKImages: 2,
  textSimilarityThreshold: 0.30,
  imageSimilarityThreshold: 0.10,
  historyWindow: 4, // number of previous messages to consider in context
  llm: {
    temperature: 0.1,
    num_predict: 450,
    top_p: 0.9
  }
};
