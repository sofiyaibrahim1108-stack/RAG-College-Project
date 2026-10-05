export const RAG_CONFIG = {
  chunkSize: 700,
  chunkOverlap: 100,
  minChunkLength: 40,
  topKText: 5,
  topKImages: 3,
  topKTextChunks: 5,
  topKImageChunks: 2,
  bigramLexicalWeight: 0.20,
  textSimilarityThreshold: 0.48,
  imageSimilarityThreshold: 0.065,
  minImageNoveltyRatio: 0.15,
  maxContextChunks: 3,
  maxContextTextChunks: 2,
  maxContextImageChunks: 1,
  strongEvidenceThreshold: 0.62,
  entityColumnMinDistinct: 8,
  fuzzyMinTokenLength: 4,
  fuzzyMaxEditDistance: 1,
  fuzzyMaxSuggestions: 3,
  tabularPlannerTimeout: 25000,
  tabularFuzzyMaxEdit: 2,
  tabularFuzzyMinLength: 3,
  historyWindow: 3, // number of previous messages to consider in context
  llm: {
    temperature: 0.2,
    num_predict: 700,
    top_p: 0.92
  }
};
