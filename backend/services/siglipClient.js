import axios from "axios";
import fs from "fs";
import { ENV } from "../config/env.js";

let activeBaseUrl = ENV.SIGLIP_SERVICE_URL;

async function requestWithFallback(method, path, data, options = {}) {
  const candidateUrls = [
    activeBaseUrl,
    "http://127.0.0.1:8000"
  ];
  // Deduplicate
  const uniqueUrls = [...new Set(candidateUrls)];

  let lastErr = null;
  for (const url of uniqueUrls) {
    try {
      const res = await axios({
        method,
        url: `${url}${path}`,
        data,
        timeout: 30000,
        ...options
      });
      activeBaseUrl = url; // remember the working URL
      return res;
    } catch (err) {
      lastErr = err;
      if (err.code !== "ECONNREFUSED" && err.code !== "ETIMEDOUT") {
        throw err;
      }
    }
  }
  throw lastErr;
}

export const siglipClient = {
  /**
   * Health check for SigLIP service
   */
  async checkHealth() {
    try {
      const res = await requestWithFallback("get", "/health");
      return res.data;
    } catch (err) {
      console.warn(`[SigLIP Client] Service unreachable: ${err.message}`);
      return { status: "offline", error: err.message };
    }
  },

  /**
   * Embed text query into SigLIP2 multimodal space
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async embedText(text) {
    try {
      const res = await requestWithFallback("post", "/embed/text", { text: text || "" });
      return res.data.embedding;
    } catch (err) {
      console.error(`[SigLIP Client] embedText error: ${err.message}`);
      throw new Error(`SigLIP text embedding failed: ${err.message}`);
    }
  },

  /**
   * Embed single image from file path or buffer
   * @param {string|Buffer} imageInput
   * @returns {Promise<number[]>}
   */
  async embedImage(imageInput) {
    try {
      let payload = {};
      if (typeof imageInput === "string") {
        payload.image_path = imageInput;
      } else if (Buffer.isBuffer(imageInput)) {
        payload.image_base64 = imageInput.toString("base64");
      } else {
        throw new Error("Invalid image input type");
      }

      const res = await requestWithFallback("post", "/embed/image", payload);
      return res.data.embedding;
    } catch (err) {
      console.error(`[SigLIP Client] embedImage error: ${err.message}`);
      throw new Error(`SigLIP image embedding failed: ${err.message}`);
    }
  },

  /**
   * Embed batch of images from file paths
   * @param {string[]} imagePaths
   * @returns {Promise<number[][]>}
   */
  async embedImagesBatch(imagePaths) {
    if (!imagePaths || imagePaths.length === 0) return [];
    try {
      const res = await requestWithFallback("post", "/embed/images", { image_paths: imagePaths });
      return res.data.embeddings;
    } catch (err) {
      console.error(`[SigLIP Client] embedImagesBatch error: ${err.message}`);
      throw new Error(`SigLIP batch image embedding failed: ${err.message}`);
    }
  },

  /**
   * Extract raster screenshots and vector diagrams from PDF with true page numbers, captions, and SigLIP embeddings
   * @param {string} pdfPath
   * @param {string} outputDir
   * @returns {Promise<Array<Object>>}
   */
  async extractPdfVisuals(pdfPath, outputDir) {
    try {
      const res = await requestWithFallback(
        "post",
        "/extract/pdf-visuals",
        { pdf_path: pdfPath, output_dir: outputDir },
        { timeout: 60000 }
      );
      return res.data.images || [];
    } catch (err) {
      console.warn(`[SigLIP Client] extractPdfVisuals failed: ${err.message}`);
      return [];
    }
  }
};

