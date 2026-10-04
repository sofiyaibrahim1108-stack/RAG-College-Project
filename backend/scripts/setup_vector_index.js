import mongoose from "mongoose";
import { ENV } from "../config/env.js";

/**
 * Creates MongoDB Atlas Vector Search index on the `documentchunks` collection.
 * 
 * Index specification:
 * - Name: "vector_index"
 * - Collection: "documentchunks"
 * - Field: "embedding"
 * - Dimensions: 1024 (mxbai-embed-large)
 * - Similarity: cosine
 * - Filter fields: "department"
 */
async function setupVectorIndex() {
  console.log(`[VectorIndexSetup] Connecting to MongoDB: ${ENV.MONGO_URI}...`);
  await mongoose.connect(ENV.MONGO_URI);
  const db = mongoose.connection.db;
  const collection = db.collection("documentchunks");

  const indexDefinition = {
    name: "vector_index",
    type: "vectorSearch",
    definition: {
      fields: [
        {
          type: "vector",
          path: "embedding",
          numDimensions: 1024,
          similarity: "cosine"
        },
        {
          type: "filter",
          path: "department"
        }
      ]
    }
  };

  try {
    console.log("[VectorIndexSetup] Attempting to create search index 'vector_index'...");
    const result = await collection.createSearchIndex(indexDefinition);
    console.log(`[VectorIndexSetup] Success! Search index created: ${result}`);
  } catch (err) {
    if (err.code === 31082 || /requires additional configuration/i.test(err.message)) {
      console.warn(
        `[VectorIndexSetup] Environment limitation detected (code 31082): ` +
        `This MongoDB instance is running MongoDB Community Edition without Atlas Search (mongot). ` +
        `MongoDB Atlas Vector Search is only available on MongoDB Atlas or via an Atlas CLI local deployment.`
      );
      console.log("[VectorIndexSetup] The application will automatically use indexed candidate retrieval.");
    } else if (/already exists/i.test(err.message)) {
      console.log("[VectorIndexSetup] Index 'vector_index' already exists.");
    } else {
      console.error(`[VectorIndexSetup] Error creating search index: ${err.message}`);
    }
  }

  await mongoose.disconnect();
  console.log("[VectorIndexSetup] Done.");
}

setupVectorIndex().catch((err) => {
  console.error("[VectorIndexSetup Fatal]", err);
  process.exit(1);
});
