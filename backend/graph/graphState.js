import { Annotation } from "@langchain/langgraph";

/**
 * State annotation schema for LangGraph RAG Workflow
 */
export const RAGStateAnnotation = Annotation.Root({
  question: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => ""
  }),
  conversationId: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => null
  }),
  conversationHistory: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => []
  }),
  queryType: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => "document_qa"
  }),
  routedDepartments: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => []
  }),
  routerCandidates: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => []
  }),
  routerConfidence: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => 0
  }),
  queryEmbedding: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => []
  }),
  retrievedChunks: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => []
  }),
  siglipQueryEmbedding: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => []
  }),
  retrievedImages: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => []
  }),
  tabularResult: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => null
  }),
  contextPrompt: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => ""
  }),
  finalAnswer: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => ""
  }),
  sources: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => []
  }),
  imageCitations: Annotation({
    reducer: (curr, update) => update ?? curr,
    default: () => []
  }),
  timings: Annotation({
    reducer: (curr, update) => ({ ...(curr || {}), ...(update || {}) }),
    default: () => ({})
  })
});
