import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as XLSX from "../backend/node_modules/xlsx/xlsx.mjs";
import AdmZip from "../backend/node_modules/adm-zip/adm-zip.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testDataDir = path.resolve(__dirname, "../test_data");

// 1. Create CSV file
const csvContent = `id,name,role,department,technology
1,Alice Johnson,Backend Lead,Engineering,Node.js & MongoDB
2,Bob Smith,Frontend Architect,UI/UX,React & Tailwind
3,Charlie Brown,Cloud Specialist,DevOps,Docker & Kubernetes
4,Dana White,Database Administrator,Engineering,PostgreSQL & Redis`;
fs.writeFileSync(path.join(testDataDir, "sample_data.csv"), csvContent);

// 2. Create XLSX file with multiple sheets
const wb = XLSX.utils.book_new();
const ws1Data = [
  ["Quarter", "Revenue", "Department", "Growth"],
  ["Q1", "$1.2M", "Cloud Computing", "15%"],
  ["Q2", "$1.5M", "Cloud Computing", "25%"],
  ["Q3", "$1.8M", "Cloud Computing", "20%"]
];
const ws1 = XLSX.utils.aoa_to_sheet(ws1Data);
XLSX.utils.book_append_sheet(wb, ws1, "Financials");

const ws2Data = [
  ["Server", "CPU", "Memory", "Status"],
  ["Node-Cluster-01", "32 Cores", "128GB", "Healthy"],
  ["Mongo-Repl-01", "16 Cores", "64GB", "Active"],
  ["SigLIP-Inference-01", "GPU Tesla", "32GB", "Online"]
];
const ws2 = XLSX.utils.aoa_to_sheet(ws2Data);
XLSX.utils.book_append_sheet(wb, ws2, "Infrastructure");
const xlsxBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
fs.writeFileSync(path.join(testDataDir, "sample_spreadsheet.xlsx"), xlsxBuffer);

// 3. Create PPTX presentation with slide XML and embedded image in ppt/media/
const pptxZip = new AdmZip();
const slide1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:p><a:r><a:t>Enterprise AI Knowledge Assistant Architecture</a:t></a:r></a:p>
          <a:p><a:r><a:t>LangGraph orchestrates routing, retrieval, SigLIP2 multimodal embeddings, and Qwen generation.</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;

const slide2Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:p><a:r><a:t>SigLIP2 Multimodal Vision Pipeline</a:t></a:r></a:p>
          <a:p><a:r><a:t>Visual diagrams from PDF, DOCX, and PPTX are embedded into 768-dimensional space for cross-modal search.</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;

pptxZip.addFile("ppt/slides/slide1.xml", Buffer.from(slide1Xml, "utf-8"));
pptxZip.addFile("ppt/slides/slide2.xml", Buffer.from(slide2Xml, "utf-8"));

// Embed image from test_data/react_components.png if present
const sampleImgPath = path.join(testDataDir, "react_components.png");
if (fs.existsSync(sampleImgPath)) {
  const imgBuffer = fs.readFileSync(sampleImgPath);
  pptxZip.addFile("ppt/media/image1.png", imgBuffer);
}
pptxZip.writeZip(path.join(testDataDir, "sample_presentation.pptx"));

// 4. Create Markdown file
const mdContent = `# Cloud Computing Guide

## Overview
Cloud computing delivers computing services over the internet including servers, storage, databases, networking, and software.

## Key Benefits
1. **Cost Efficiency**: No upfront capital expense for hardware.
2. **Scalability**: Instant scale up or scale down based on demands.
3. **High Availability**: Redundant distributed regions guarantee uptime.

## Architecture Patterns
Microservices architecture combined with Kubernetes and Docker provides containerized resilience.`;
fs.writeFileSync(path.join(testDataDir, "sample_guide.md"), mdContent);

// 5. Create JSON file
const jsonContent = JSON.stringify({
  system: "RAG-College Platform",
  version: "2.0.0",
  modules: [
    { name: "Router", technology: "Ollama Qwen2.5-Coder:3b", type: "LLM" },
    { name: "Text Embedder", technology: "mxbai-embed-large", type: "Embedding" },
    { name: "Image Embedder", technology: "SigLIP2", type: "Vision-Language" }
  ],
  database: {
    type: "MongoDB",
    collections: ["documents", "documentchunks", "images", "conversations", "messages"]
  }
}, null, 2);
fs.writeFileSync(path.join(testDataDir, "sample_config.json"), jsonContent);

// 6. Create HTML file
const htmlContent = `<!DOCTYPE html>
<html>
<head><title>System Architecture Overview</title></head>
<body>
  <h1>Microservices Architecture</h1>
  <p>Our distributed system separates backend services into independent microservices communicating via REST and asynchronous message queues.</p>
  <h2>Key Design Principles</h2>
  <p>Stateless API servers allow horizontal auto-scaling behind load balancers.</p>
</body>
</html>`;
fs.writeFileSync(path.join(testDataDir, "sample_page.html"), htmlContent);

// 7. Create XML file
const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<catalog>
  <course id="CS101">
    <title>Introduction to Database Systems</title>
    <department>Database Systems</department>
    <description>Relational vs NoSQL databases, indexing, B-Trees, and ACID properties.</description>
  </course>
  <course id="CS102">
    <title>Modern Web Development</title>
    <department>Web Development</department>
    <description>React virtual DOM, component lifecycles, and state management.</description>
  </course>
</catalog>`;
fs.writeFileSync(path.join(testDataDir, "sample_feed.xml"), xmlContent);

console.log("✅ All test data documents successfully generated in test_data directory!");
