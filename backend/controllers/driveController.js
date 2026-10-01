import { driveService } from "../services/driveService.js";
import { ENV } from "../config/env.js";
import { Department } from "../models/Department.js";

/**
 * Returns Google Drive integration configuration status
 */
export function getDriveStatus(req, res) {
  const isConfigured = Boolean(ENV.GOOGLE_CLIENT_ID && ENV.GOOGLE_CLIENT_SECRET);
  res.json({
    success: true,
    configured: isConfigured,
    redirectUri: ENV.GOOGLE_REDIRECT_URI,
    clientIdConfigured: Boolean(ENV.GOOGLE_CLIENT_ID)
  });
}

/**
 * Returns Google Drive OAuth authorization URL
 */
export function getAuthUrl(req, res) {
  try {
    const authUrl = driveService.getAuthUrl();
    res.json({ success: true, authUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * OAuth Callback handler
 */
export async function handleOAuthCallback(req, res) {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).json({ error: "No authorization code provided" });
    }

    const tokens = await driveService.getTokens(code);

    // In a browser flow, we can redirect back to frontend with token info or set a cookie
    const redirectUrl = `http://localhost:5173/documents?google_auth=success&tokens=${encodeURIComponent(
      JSON.stringify(tokens)
    )}`;
    res.redirect(redirectUrl);
  } catch (err) {
    res.redirect(`http://localhost:5173/documents?google_auth=error&message=${encodeURIComponent(err.message)}`);
  }
}

/**
 * Lists user files from Google Drive
 */
export async function listDriveFiles(req, res) {
  try {
    const authHeader = req.headers.authorization;
    let tokens = null;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        tokens = JSON.parse(decodeURIComponent(authHeader.replace("Bearer ", "")));
      } catch (e) {
        tokens = { access_token: authHeader.replace("Bearer ", "") };
      }
    }

    if (!tokens) {
      return res.status(401).json({ error: "Google Drive authentication required" });
    }

    const { pageToken } = req.query;
    const result = await driveService.listFiles(tokens, pageToken);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Import a selected document from Google Drive
 */
export async function importDriveFile(req, res) {
  try {
    const authHeader = req.headers.authorization;
    let tokens = null;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        tokens = JSON.parse(decodeURIComponent(authHeader.replace("Bearer ", "")));
      } catch (e) {
        tokens = { access_token: authHeader.replace("Bearer ", "") };
      }
    }

    if (!tokens) {
      return res.status(401).json({ error: "Google Drive authentication required" });
    }

    const { fileId, departmentId, department: deptNameParam, isTestData } = req.body;
    if (!fileId) {
      return res.status(400).json({ error: "fileId is required" });
    }

    // Requirement: Department selection is mandatory - no silent default
    if (!departmentId && (!deptNameParam || !deptNameParam.trim())) {
      return res.status(400).json({
        error: "Department selection is mandatory. Please select or create a department before importing."
      });
    }

    // Verify department against database
    let departmentDoc = null;
    if (departmentId) {
      departmentDoc = await Department.findById(departmentId);
    } else if (deptNameParam) {
      departmentDoc = await Department.findOne({
        name: { $regex: new RegExp(`^${deptNameParam.trim()}$`, "i") }
      });
    }

    if (!departmentDoc) {
      return res.status(400).json({
        error: "Selected department does not exist in the database. Please select a valid department."
      });
    }

    const result = await driveService.importFile(
      tokens,
      fileId,
      departmentDoc.name,
      departmentDoc._id,
      isTestData === true || departmentDoc.isTestData === true
    );
    res.json({
      success: true,
      message: result.alreadyImported ? "Document was already imported" : "Document import initiated",
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
