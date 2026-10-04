/**
 * Converts technical errors and API failures into clear, friendly user-facing messages.
 * Keeps raw technical details logged to the console for debugging.
 */
export function toFriendlyErrorMessage(err, fallback = "Something went wrong. Please try again.") {
  if (!err) return fallback;

  // Log raw technical error for developer inspection
  console.error("[App Error Log]:", err);

  const raw = typeof err === "string" ? err : err?.response?.data?.error || err?.message || "";
  const status = err?.response?.status;

  if (status === 400 || raw.includes("400") || /validation/i.test(raw)) {
    if (/department/i.test(raw)) {
      return "Please select a department before continuing.";
    }
    return "Please check the required fields and try again.";
  }

  if (status === 401 || status === 403 || /unauthorized|forbidden|token/i.test(raw)) {
    return "Authentication required. Please connect your account and try again.";
  }

  if (status === 404 || /not found/i.test(raw)) {
    return "The requested item could not be found.";
  }

  if (
    /network|econnrefused|econnreset|offline|timeout/i.test(raw) ||
    /ollama|siglip|mongodb|langgraph|vector/i.test(raw)
  ) {
    return "Something went wrong while processing your request. Please check your connection and try again.";
  }

  if (status >= 500) {
    return "Something went wrong. Please try again.";
  }

  return raw && raw.length < 120 && !/error:|exception|at\s+/i.test(raw)
    ? raw
    : fallback;
}
