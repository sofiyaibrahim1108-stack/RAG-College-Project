import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import axios from "axios";
import { RAG_CONFIG } from "../config/rag.js";
import { ENV } from "../config/env.js";

const execFileAsync = promisify(execFile);

/**
 * Calculates pixel count and grayscale variance for an image file.
 * Evaluates via siglip-service with a local Python fallback.
 *
 * @param {string} imagePath
 * @returns {Promise<{ pixels: number, variance: number, width: number, height: number }>}
 */
export async function getImageStats(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    return { pixels: 0, variance: 0, width: 0, height: 0, error: "file_not_found" };
  }

  // 1. Try siglip-service microservice
  const baseUrl = ENV.SIGLIP_SERVICE_URL || "http://127.0.0.1:8000";
  try {
    const res = await axios.post(
      `${baseUrl}/image/quality`,
      { image_path: imagePath },
      { timeout: 3000 }
    );
    if (res.data && typeof res.data.pixels === "number") {
      return res.data;
    }
  } catch (err) {
    // Fall back to local Python runtime if microservice is busy or unreachable
  }

  // 2. Python fallback
  try {
    const script = `
import sys, os
from PIL import Image
import numpy as np
try:
    with Image.open(sys.argv[1]) as im:
        pixels = im.width * im.height
        arr = np.array(im.convert("L"))
        var = float(np.var(arr))
        print(f"{pixels},{var:.2f},{im.width},{im.height}")
except Exception as e:
    print("0,0,0,0")
`;
    const { stdout } = await execFileAsync("python", ["-c", script, imagePath], { timeout: 4000 });
    const parts = stdout.trim().split(",");
    if (parts.length === 4) {
      return {
        pixels: parseInt(parts[0], 10) || 0,
        variance: parseFloat(parts[1]) || 0,
        width: parseInt(parts[2], 10) || 0,
        height: parseInt(parts[3], 10) || 0
      };
    }
  } catch (e) {}

  return { pixels: 0, variance: 0, width: 0, height: 0 };
}

/**
 * Checks whether an image meets the minimum pixels and variance thresholds.
 *
 * @param {string} imagePath
 * @returns {Promise<{ useful: boolean, pixels: number, variance: number, reason?: string }>}
 */
export async function isImageUseful(imagePath) {
  const stats = await getImageStats(imagePath);
  const minPixels = RAG_CONFIG.minImagePixels ?? 15000;
  const minVariance = RAG_CONFIG.minImageVariance ?? 100;

  if (stats.pixels < minPixels) {
    return { useful: false, reason: "tiny_image", ...stats };
  }
  if (stats.variance < minVariance) {
    return { useful: false, reason: "near_uniform_or_blank", ...stats };
  }

  return { useful: true, ...stats };
}
