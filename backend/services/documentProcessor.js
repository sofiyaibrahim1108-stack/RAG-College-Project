import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import { v4 as uuidv4 } from "uuid";
import { Document } from "../models/Document.js";
import { DocumentChunk } from "../models/DocumentChunk.js";
import { ImageModel } from "../models/Image.js";
import { chunkDocumentPages } from "./chunkingService.js";
import { generateBatchTextEmbeddings } from "./embeddingService.js";
import { siglipClient } from "./siglipClient.js";
import { extractOcrText } from "./ocrService.js";
import { invalidateDepartmentProfilesCache } from "./router.js";
import { ENV } from "../config/env.js";

/**
 * Extracts embedded JPEG/PNG images from PDF binary stream buffers
 */
function extractImagesFromPdfBuffer(buffer, outputDir, docName) {
  const images = [];
  try {
    let startIdx = 0;
    let imgCounter = 1;

    // Scan for JPEG headers: FF D8 FF and trailer FF D9
    while ((startIdx = buffer.indexOf(Buffer.from([0xff, 0xd8, 0xff]), startIdx)) !== -1) {
      const endIdx = buffer.indexOf(Buffer.from([0xff, 0xd9]), startIdx + 3);
      if (endIdx !== -1 && endIdx - startIdx > 1024 && endIdx - startIdx < 20 * 1024 * 1024) {
        // Minimum 1KB to avoid false positive byte sequences
        const imgBuffer = buffer.slice(startIdx, endIdx + 2);
        const filename = `pdf_img_${imgCounter}.jpg`;
        const filePath = path.join(outputDir, filename);
        fs.writeFileSync(filePath, imgBuffer);

        images.push({
          imageId: uuidv4(),
          filename,
          filePath,
          pageNumber: Math.max(1, Math.ceil(imgCounter / 2)),
          mimeType: "image/jpeg"
        });
        imgCounter++;
        startIdx = endIdx + 2;
      } else {
        startIdx += 3;
      }

      if (imgCounter > 20) break; // Reasonable upper cap per document
    }
  } catch (err) {
    console.warn(`[DocumentProcessor] Warning during PDF image scan: ${err.message}`);
  }
  return images;
}

/**
 * Extracts text and images from a PDF file
 */
async function processPdf(filePath, outputDir, docName) {
  const dataBuffer = fs.readFileSync(filePath);
  const pages = [];

  let currentPage = 1;
  const renderOptions = {
    pagerender: function (pageData) {
      return pageData.getTextContent().then(function (textContent) {
        let lastY, text = "";
        for (const item of textContent.items) {
          if (lastY === item.transform[5] || !lastY) {
            const needSpace = text.length > 0 && !text.endsWith(" ") && !text.endsWith("\n") && !item.str.startsWith(" ");
            text += (needSpace ? " " : "") + item.str;
          } else {
            text += "\n" + item.str;
          }
          lastY = item.transform[5];
        }

        pages.push({
          pageNumber: currentPage++,
          text: text.trim()
        });
        return text;
      });
    }
  };

  const parsed = await pdfParse(dataBuffer, renderOptions);

  // If pagerender didn't populate individual pages, fallback to overall text
  if (pages.length === 0 && parsed.text) {
    pages.push({
      pageNumber: 1,
      text: parsed.text.trim()
    });
  }

  // Extract embedded images and vector diagrams via multimodal microservice
  let images = [];
  try {
    images = await siglipClient.extractPdfVisuals(filePath, outputDir);
  } catch (err) {
    console.warn(`[DocumentProcessor] Notice during microservice PDF visual extraction: ${err.message}`);
  }

  // Fallback to binary buffer scan if microservice returned no images
  if (!images || images.length === 0) {
    images = extractImagesFromPdfBuffer(dataBuffer, outputDir, docName);
  }

  return { pages, images, numPages: parsed.numpages || pages.length };
}

/**
 * Extracts text and embedded images from a DOCX file
 */
async function processDocx(filePath, outputDir, docName) {
  // 1. Extract text using mammoth
  const textResult = await mammoth.extractRawText({ path: filePath });
  const rawText = textResult.value || "";

  // Split DOCX into synthetic pages if long (e.g. approx 2500 chars per page)
  const pageSize = 2500;
  const pages = [];
  if (rawText.length <= pageSize) {
    pages.push({ pageNumber: 1, text: rawText.trim() });
  } else {
    let pNum = 1;
    for (let i = 0; i < rawText.length; i += pageSize) {
      pages.push({
        pageNumber: pNum++,
        text: rawText.slice(i, i + pageSize).trim()
      });
    }
  }

  // 2. Extract embedded images from DOCX archive (word/media/)
  const images = [];
  try {
    const zip = new AdmZip(filePath);
    const zipEntries = zip.getEntries();
    let imgCounter = 1;

    for (const entry of zipEntries) {
      if (entry.entryName.startsWith("word/media/") && !entry.isDirectory) {
        const ext = path.extname(entry.name).toLowerCase() || ".png";
        const filename = `docx_img_${imgCounter}${ext}`;
        const destPath = path.join(outputDir, filename);

        const imgBuffer = entry.getData();
        if (imgBuffer.length > 512) {
          fs.writeFileSync(destPath, imgBuffer);
          const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

          images.push({
            imageId: uuidv4(),
            filename,
            filePath: destPath,
            pageNumber: 1,
            mimeType
          });
          imgCounter++;
        }
      }
    }
  } catch (err) {
    console.warn(`[DocumentProcessor] Notice during DOCX media extraction: ${err.message}`);
  }

  return { pages, images, numPages: pages.length };
}

/**
 * Processes a plain TXT file
 */
async function processTxt(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const pageSize = 2500;
  const pages = [];

  if (content.length <= pageSize) {
    pages.push({ pageNumber: 1, text: content.trim() });
  } else {
    let pNum = 1;
    for (let i = 0; i < content.length; i += pageSize) {
      pages.push({
        pageNumber: pNum++,
        text: content.slice(i, i + pageSize).trim()
      });
    }
  }

  return { pages, images: [], numPages: pages.length };
}

/**
 * Processes XLSX, XLS, and CSV spreadsheets using SheetJS
 * Preserves sheet names and extracts embedded images if XLSX
 */
async function processSpreadsheet(filePath, outputDir, docName) {
  const buffer = fs.readFileSync(filePath);
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const pages = [];
  let sheetNum = 1;

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    const csvContent = XLSX.utils.sheet_to_csv(worksheet);
    if (csvContent && csvContent.trim()) {
      pages.push({
        pageNumber: sheetNum,
        sheetName: sheetName,
        text: `[Sheet: ${sheetName}]\n${csvContent.trim()}`
      });
      sheetNum++;
    }
  }

  // Extract embedded images if file is an XLSX archive (xl/media/)
  const images = [];
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".xlsx") {
    try {
      const zip = new AdmZip(filePath);
      const zipEntries = zip.getEntries();
      let imgCounter = 1;

      for (const entry of zipEntries) {
        if (entry.entryName.startsWith("xl/media/") && !entry.isDirectory) {
          const imgExt = path.extname(entry.name).toLowerCase() || ".png";
          const filename = `xlsx_img_${imgCounter}${imgExt}`;
          const destPath = path.join(outputDir, filename);

          const imgBuffer = entry.getData();
          if (imgBuffer.length > 512) {
            fs.writeFileSync(destPath, imgBuffer);
            images.push({
              imageId: uuidv4(),
              filename,
              filePath: destPath,
              pageNumber: 1,
              mimeType: imgExt === ".jpg" || imgExt === ".jpeg" ? "image/jpeg" : "image/png"
            });
            imgCounter++;
          }
        }
      }
    } catch (err) {
      console.warn(`[DocumentProcessor] Notice during XLSX image extraction: ${err.message}`);
    }
  }

  if (pages.length === 0) {
    pages.push({ pageNumber: 1, text: `[Empty Spreadsheet: ${docName}]` });
  }

  return { pages, images, numPages: pages.length };
}

/**
 * Processes PPTX presentations using AdmZip
 * Extracts text slide-by-slide preserving slide numbers and extracts images from ppt/media/
 */
async function processPptx(filePath, outputDir, docName) {
  const pages = [];
  const images = [];

  try {
    const zip = new AdmZip(filePath);
    const zipEntries = zip.getEntries();

    // 1. Find and sort slide XML files
    const slideEntries = zipEntries
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
      .sort((a, b) => {
        const numA = parseInt(a.entryName.match(/\d+/)?.[0] || "0", 10);
        const numB = parseInt(b.entryName.match(/\d+/)?.[0] || "0", 10);
        return numA - numB;
      });

    for (let i = 0; i < slideEntries.length; i++) {
      const slideNum = i + 1;
      const xmlContent = slideEntries[i].getData().toString("utf-8");

      // Extract text inside PowerPoint text tags <a:t>...</a:t>
      const textMatches = [];
      const regex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/gi;
      let match;
      while ((match = regex.exec(xmlContent)) !== null) {
        if (match[1]) {
          textMatches.push(match[1]);
        }
      }

      const slideText = textMatches.join(" ").replace(/\s+/g, " ").trim();
      if (slideText) {
        pages.push({
          pageNumber: slideNum,
          slideNumber: slideNum,
          text: `[Slide ${slideNum}]\n${slideText}`
        });
      }
    }

    // 2. Extract embedded images from ppt/media/
    let imgCounter = 1;
    for (const entry of zipEntries) {
      if (entry.entryName.startsWith("ppt/media/") && !entry.isDirectory) {
        const imgExt = path.extname(entry.name).toLowerCase() || ".png";
        const filename = `pptx_img_${imgCounter}${imgExt}`;
        const destPath = path.join(outputDir, filename);

        const imgBuffer = entry.getData();
        if (imgBuffer.length > 512) {
          fs.writeFileSync(destPath, imgBuffer);
          const mimeType = imgExt === ".jpg" || imgExt === ".jpeg" ? "image/jpeg" : "image/png";
          images.push({
            imageId: uuidv4(),
            filename,
            filePath: destPath,
            pageNumber: Math.min(imgCounter, pages.length || 1),
            mimeType
          });
          imgCounter++;
        }
      }
    }
  } catch (err) {
    console.warn(`[DocumentProcessor] Notice during PPTX extraction: ${err.message}`);
  }

  if (pages.length === 0) {
    pages.push({ pageNumber: 1, text: `[Empty Presentation: ${docName}]` });
  }

  return { pages, images, numPages: pages.length };
}

/**
 * Processes legacy binary PPT files
 */
async function processPpt(filePath, outputDir, docName) {
  const buffer = fs.readFileSync(filePath);
  const strings = [];

  for (let i = 0; i < buffer.length - 8; i += 2) {
    let s = "";
    let j = i;
    while (j < buffer.length - 1) {
      const code = buffer.readUInt16LE(j);
      if (code >= 32 && code <= 126) {
        s += String.fromCharCode(code);
        j += 2;
      } else {
        break;
      }
    }
    if (s.length >= 5) {
      strings.push(s.trim());
      i = j;
    }
  }

  const cleanText = strings.filter((s) => s.length > 3).join("\n");
  const pages = [];
  const pageSize = 2000;

  if (!cleanText || cleanText.length <= pageSize) {
    pages.push({ pageNumber: 1, text: cleanText || `[PPT Presentation: ${docName}]` });
  } else {
    let pNum = 1;
    for (let i = 0; i < cleanText.length; i += pageSize) {
      pages.push({
        pageNumber: pNum,
        slideNumber: pNum,
        text: `[Slide ${pNum}]\n` + cleanText.slice(i, i + pageSize).trim()
      });
      pNum++;
    }
  }

  return { pages, images: [], numPages: pages.length };
}

/**
 * Processes legacy binary Word DOC files
 */
async function processDoc(filePath, outputDir, docName) {
  try {
    const textResult = await mammoth.extractRawText({ path: filePath });
    if (textResult.value && textResult.value.trim()) {
      return processTxtString(textResult.value);
    }
  } catch (e) {
    // Fallback to binary text extraction
  }

  const buffer = fs.readFileSync(filePath);
  const strings = [];
  for (let i = 0; i < buffer.length - 4; i++) {
    let s = "";
    let j = i;
    while (j < buffer.length) {
      const byte = buffer[j];
      if ((byte >= 32 && byte <= 126) || byte === 10 || byte === 13) {
        s += String.fromCharCode(byte);
        j++;
      } else {
        break;
      }
    }
    if (s.length >= 8) {
      strings.push(s.trim());
      i = j;
    }
  }

  const fullText = strings.join("\n").replace(/\n{3,}/g, "\n\n");
  return processTxtString(fullText || `[DOC Document: ${docName}]`);
}

/**
 * Helper to split a plain string into synthetic pages
 */
function processTxtString(content, pageSize = 2500) {
  const pages = [];
  if (content.length <= pageSize) {
    pages.push({ pageNumber: 1, text: content.trim() });
  } else {
    let pNum = 1;
    for (let i = 0; i < content.length; i += pageSize) {
      pages.push({
        pageNumber: pNum++,
        text: content.slice(i, i + pageSize).trim()
      });
    }
  }
  return { pages, images: [], numPages: pages.length };
}

/**
 * Processes Markdown files preserving section headers
 */
async function processMarkdown(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const sections = content.split(/\n(?=#{1,3}\s+)/);
  const pages = [];
  let pageNum = 1;

  for (const sec of sections) {
    const trimmed = sec.trim();
    if (!trimmed) continue;
    const firstLine = trimmed.split("\n")[0].replace(/^#+\s*/, "").trim();
    pages.push({
      pageNumber: pageNum++,
      section: firstLine || `Section ${pageNum}`,
      text: trimmed
    });
  }

  if (pages.length === 0) {
    pages.push({ pageNumber: 1, text: content.trim() });
  }

  return { pages, images: [], numPages: pages.length };
}

/**
 * Processes JSON files into human-readable key-value representation
 */
async function processJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return processTxt(filePath);
  }

  const pages = [];
  if (Array.isArray(data)) {
    const batchSize = 10;
    let pageNum = 1;
    for (let i = 0; i < data.length; i += batchSize) {
      const slice = data.slice(i, i + batchSize);
      const text = slice
        .map((item, idx) => `[Item ${i + idx + 1}]\n${JSON.stringify(item, null, 2)}`)
        .join("\n\n");
      pages.push({
        pageNumber: pageNum++,
        section: `Items ${i + 1} - ${i + slice.length}`,
        text
      });
    }
  } else {
    let pageNum = 1;
    const keys = Object.keys(data);
    for (const key of keys) {
      const val = data[key];
      const text = `[Section: ${key}]\n${typeof val === "object" ? JSON.stringify(val, null, 2) : String(val)}`;
      pages.push({
        pageNumber: pageNum++,
        section: key,
        text
      });
    }
  }

  if (pages.length === 0) {
    pages.push({ pageNumber: 1, text: JSON.stringify(data, null, 2) });
  }

  return { pages, images: [], numPages: pages.length };
}

/**
 * Processes HTML documents stripping tags and extracting headings/content
 */
async function processHtml(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const clean = raw
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");

  const titleMatch = clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";

  const sections = clean.split(/<h[1-3][^>]*>/i);
  const pages = [];
  let pageNum = 1;

  for (const sec of sections) {
    const text = sec.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text) {
      pages.push({
        pageNumber: pageNum++,
        section: title || `Section ${pageNum}`,
        text: (title && pageNum === 2 ? `[Page Title: ${title}]\n` : "") + text
      });
    }
  }

  if (pages.length === 0) {
    const fallbackText = clean.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    pages.push({ pageNumber: 1, text: fallbackText });
  }

  return { pages, images: [], numPages: pages.length };
}

/**
 * Processes XML files extracting element content
 */
async function processXml(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const clean = raw.replace(/<\?xml[^>]*\?>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const pageSize = 2000;
  const pages = [];

  if (clean.length <= pageSize) {
    const text = clean.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    pages.push({ pageNumber: 1, text });
  } else {
    let pNum = 1;
    for (let i = 0; i < clean.length; i += pageSize) {
      const slice = clean.slice(i, i + pageSize);
      const text = slice.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      pages.push({
        pageNumber: pNum++,
        text: `[XML Section ${pNum - 1}]\n` + text
      });
    }
  }

  return { pages, images: [], numPages: pages.length };
}

/**
 * Builds ONE text chunk from: page heading/native text + caption + OCR text.
 * Stores an imageRef pointing back to the visual asset.
 */
function buildImageChunkContent(img, pages = [], ocrText = "") {
  const pageNum = img.pageNumber || 1;
  const pageObj = pages.find((p) => p.pageNumber === pageNum);
  const rawPageText = pageObj ? pageObj.text || "" : "";

  // Extract non-numeric lines
  const lines = rawPageText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\d+$/.test(l));

  let headingText = lines.length > 0 ? lines[0] : "";

  // If this page had only numbers / no text (common for dedicated image pages),
  // inherit the most recent non-empty heading from previous pages
  if (!headingText && pageNum > 1) {
    for (let p = pageNum - 1; p >= Math.max(1, pageNum - 3); p--) {
      const prevPage = pages.find((pg) => pg.pageNumber === p);
      if (prevPage && prevPage.text) {
        const prevLines = prevPage.text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !/^\d+$/.test(l));
        if (prevLines.length > 0) {
          headingText = prevLines[0];
          break;
        }
      }
    }
  }

  const nativeText = lines.slice(0, 3).join("\n").slice(0, 400);

  const parts = [];
  if (headingText) {
    parts.push(headingText);
  }
  if (nativeText && nativeText !== headingText) {
    parts.push(nativeText);
  }
  if (img.caption && img.caption.trim() && !parts.some((p) => p.includes(img.caption.trim()))) {
    parts.push(`Caption: ${img.caption.trim()}`);
  }
  if (ocrText && ocrText.trim()) {
    parts.push(`OCR: ${ocrText.trim()}`);
  }

  return parts.join("\n\n").trim();
}

/**
 * Main orchestration entry point for processing a Document
 * @param {string} documentId
 */
export async function processDocument(documentId) {
  console.log(`[DocumentProcessor] Starting processing for document ID: ${documentId}`);

  const document = await Document.findById(documentId);
  if (!document) {
    throw new Error(`Document with ID ${documentId} not found`);
  }

  // Update status to processing
  document.status = "processing";
  document.errorMessage = null;
  await document.save();

  try {
    // Ensure image storage directory exists
    const docImageDir = path.join(ENV.UPLOAD_DIR, "images", document._id.toString());
    fs.mkdirSync(docImageDir, { recursive: true });

    let extractedData = { pages: [], images: [], numPages: 1 };

    const fType = (document.fileType || "").toLowerCase();

    if (fType === "pdf") {
      extractedData = await processPdf(document.path, docImageDir, document.originalName);
    } else if (fType === "docx") {
      extractedData = await processDocx(document.path, docImageDir, document.originalName);
    } else if (fType === "doc") {
      extractedData = await processDoc(document.path, docImageDir, document.originalName);
    } else if (fType === "txt") {
      extractedData = await processTxt(document.path);
    } else if (fType === "xlsx" || fType === "xls" || fType === "csv") {
      extractedData = await processSpreadsheet(document.path, docImageDir, document.originalName);
    } else if (fType === "pptx") {
      extractedData = await processPptx(document.path, docImageDir, document.originalName);
    } else if (fType === "ppt") {
      extractedData = await processPpt(document.path, docImageDir, document.originalName);
    } else if (fType === "markdown" || fType === "md") {
      extractedData = await processMarkdown(document.path);
    } else if (fType === "json") {
      extractedData = await processJson(document.path);
    } else if (fType === "html" || fType === "htm") {
      extractedData = await processHtml(document.path);
    } else if (fType === "xml") {
      extractedData = await processXml(document.path);
    } else {
      // Graceful fallback to text processing
      extractedData = await processTxt(document.path);
    }

    console.log(
      `[DocumentProcessor] Extracted ${extractedData.pages.length} pages and ${extractedData.images.length} images from ${document.originalName}`
    );

    // 1. Process and save images with SigLIP2 embeddings and OCR text extraction
    await ImageModel.deleteMany({ documentId: document._id });
    const savedImages = [];
    const imageDerivedChunks = [];

    for (const img of extractedData.images) {
      try {
        const siglipEmb =
          img.embedding && Array.isArray(img.embedding) && img.embedding.length > 0
            ? img.embedding
            : await siglipClient.embedImage(img.filePath);

        // Deterministic OCR text extraction on image/screenshot
        let ocrText = "";
        try {
          ocrText = await extractOcrText(img.filePath);
        } catch (ocrErr) {
          console.warn(`[DocumentProcessor] OCR extraction notice for ${img.filename}: ${ocrErr.message}`);
        }

        const imageRecord = await ImageModel.create({
          imageId: img.imageId,
          documentId: document._id,
          documentName: document.originalName,
          pageNumber: img.pageNumber,
          filename: img.filename,
          imagePath: img.filePath,
          mimeType: img.mimeType,
          department: document.department || "General",
          embedding: siglipEmb,
          caption: img.caption || "",
          description: img.description || "",
          ocrText: ocrText || ""
        });
        savedImages.push(imageRecord);

        // Design 1: For every extracted image, build ONE text chunk from:
        // page heading/native text on that page + image caption + OCR text.
        // Store imageRef on the chunk.
        const chunkContent = buildImageChunkContent(img, extractedData.pages, ocrText);
        if (chunkContent.length >= 10) {
          imageDerivedChunks.push({
            documentId: document._id,
            documentName: document.originalName,
            pageNumber: img.pageNumber || 1,
            chunkIndex: 0, // reassigned below
            content: chunkContent,
            department: document.department || "General",
            sourceType: "image_chunk",
            sourcePath: img.filePath,
            imageRef: {
              documentId: document._id,
              filename: img.filename,
              pageNumber: img.pageNumber || 1
            }
          });
        }
      } catch (imgErr) {
        console.warn(`[DocumentProcessor] Failed to embed image ${img.filename}: ${imgErr.message}`);
      }
    }

    // 2. Chunk text pages
    const chunkObjects = chunkDocumentPages(extractedData.pages, document);

    // Append image-derived chunks with consistent chunk indices
    for (const ic of imageDerivedChunks) {
      ic.chunkIndex = chunkObjects.length;
      chunkObjects.push(ic);
    }
    console.log(`[DocumentProcessor] Generated ${chunkObjects.length} text chunks (including ${imageDerivedChunks.length} image-derived chunks)`);

    if (chunkObjects.length > 0) {
      // 3. Generate Ollama text embeddings in batches
      const chunkTexts = chunkObjects.map((c) => c.content);
      const embeddings = await generateBatchTextEmbeddings(chunkTexts, 4);

      for (let i = 0; i < chunkObjects.length; i++) {
        chunkObjects[i].embedding = embeddings[i];
      }

      // Bulk insert chunks into MongoDB
      await DocumentChunk.deleteMany({ documentId: document._id });
      await DocumentChunk.insertMany(chunkObjects);
    }

    // 4. Update Document record to completed
    document.status = "completed";
    document.chunkCount = chunkObjects.length;
    document.imageCount = savedImages.length;
    document.metadata = {
      pagesCount: extractedData.numPages,
      processedAt: new Date()
    };
    await document.save();

    // Invalidate cached department profiles for dynamic router
    try {
      invalidateDepartmentProfilesCache();
    } catch (e) {}

    console.log(`[DocumentProcessor] Successfully finished processing document: ${document.originalName}`);
    return document;
  } catch (error) {
    console.error(`[DocumentProcessor Error] Document processing failed: ${error.message}`);
    document.status = "failed";
    document.errorMessage = error.message;
    await document.save();
    throw error;
  }
}
