import mongoose from "mongoose";
import { ENV } from "../config/env.js";

async function main() {
  await mongoose.connect(ENV.MONGO_URI);
  console.log("Connected to:", ENV.MONGO_URI);
  const db = mongoose.connection.db;
  const buildInfo = await db.admin().command({ buildInfo: 1 });
  console.log("MongoDB Version:", buildInfo.version);
  console.log("Modules:", buildInfo.modules);
  
  const coll = db.collection("documentchunks");
  const chunkCount = await coll.countDocuments();
  console.log("documentchunks count:", chunkCount);

  // Check sample chunk embedding
  const sample = await coll.findOne({ embedding: { $exists: true, $ne: [] } });
  if (sample) {
    console.log("Sample chunk found:");
    console.log("- Document ID:", sample.documentId);
    console.log("- Department:", sample.department);
    console.log("- Embedding field exists:", Array.isArray(sample.embedding));
    console.log("- Embedding dimensions:", sample.embedding?.length);
  }

  // Attempt search index creation
  try {
    const listIndexes = await coll.listSearchIndexes().toArray();
    console.log("Existing Search Indexes:", listIndexes);
  } catch (e) {
    console.log("listSearchIndexes result:", e.code, e.message);
  }

  // Attempt $vectorSearch
  try {
    const res = await coll.aggregate([
      {
        $vectorSearch: {
          index: "vector_index",
          path: "embedding",
          queryVector: new Array(1024).fill(0.01),
          numCandidates: 10,
          limit: 5
        }
      }
    ]).toArray();
    console.log("$vectorSearch executed successfully, count:", res.length);
  } catch (e) {
    console.log("$vectorSearch execution result:", e.code, e.message);
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Audit error:", err);
  process.exit(1);
});
