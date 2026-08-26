const MAX_FRAME_BASE64 = 8 * 1024 * 1024;

function endpointUrl(base, path) {
  return `${String(base).replace(/\/$/, "")}${path}`;
}

export async function captureWebDriverFrame({ endpoint, sessionId, timeoutMs = 15_000 }) {
  if (!endpoint || !sessionId) throw new Error("live frame requires an active WebDriver session");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpointUrl(endpoint, `/session/${encodeURIComponent(sessionId)}/screenshot`), {
      method: "GET",
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`WebDriver screenshot returned non-JSON status ${response.status}`); }
    const value = payload?.value;
    if (!response.ok || typeof value !== "string") {
      const detail = payload?.value?.message || payload?.value?.error || `HTTP ${response.status}`;
      throw new Error(`WebDriver screenshot failed: ${String(detail).slice(0, 600)}`);
    }
    if (value.length === 0 || value.length > MAX_FRAME_BASE64 || !/^[A-Za-z0-9+/]+=*$/.test(value))
      throw new Error("WebDriver screenshot payload is invalid or too large");
    return { mimeType: "image/png", data: value };
  } finally {
    clearTimeout(timeout);
  }
}
