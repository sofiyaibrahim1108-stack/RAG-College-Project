import { createWorker } from "tesseract.js";
import fs from "fs";

let workerInstance = null;

/**
 * Initializes and caches a Tesseract worker
 */
async function getWorker() {
  if (!workerInstance) {
    workerInstance = await createWorker("eng");
  }
  return workerInstance;
}

/**
 * Extracts text from an image file using OCR
 * @param {string} imagePath
 * @returns {Promise<string>}
 */
export async function extractOcrText(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    return "";
  }

  try {
    const worker = await getWorker();
    const ret = await worker.recognize(imagePath);
    const text = (ret.data?.text || "").trim();
    return text;
  } catch (err) {
    console.warn(`[OCR Service] OCR extraction failed for ${imagePath}: ${err.message}`);
    return "";
  }
}

/**
 * Closes the Tesseract worker instance gracefully
 */
export async function terminateOcrWorker() {
  if (workerInstance) {
    await workerInstance.terminate();
    workerInstance = null;
  }
}
