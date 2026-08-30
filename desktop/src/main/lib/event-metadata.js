const MAX_EVENT_PATH = 512;
const IDENTIFIER = /^[A-Za-z0-9][\w:.-]{0,159}$/;

export const EVENT_METADATA_SOURCE = "workspace-file-change";
export const EVENT_METADATA_KEYS = Object.freeze(["source", "triggerId", "eventId", "relativePath", "observedAt"]);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function exactKeys(value, allowed, label) {
  assertObject(value, label);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unexpected ${label} field: ${key}`);
}

function identifier(value, label, prefix) {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || (prefix && !value.startsWith(prefix)))
    throw new Error(`${label} must be an identifier`);
  return value;
}

/**
 * Canonicalize an untrusted watcher path without ever resolving it against the
 * filesystem. Empty/repeated separators and harmless dot segments are removed;
 * traversal, absolute, drive, UNC, NUL, and colon-bearing paths are rejected.
 */
export function normalizeEventRelativePath(value, label = "relativePath") {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a relative path`);
  const raw = value.trim().replaceAll("\\", "/");
  if (raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.includes(":"))
    throw new Error(`${label} must stay inside the trusted workspace`);

  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error(`${label} must not contain traversal segments`);
    parts.push(part);
  }
  if (!parts.length) throw new Error(`${label} must be a relative path`);
  const normalized = parts.join("/");
  if (normalized.length > MAX_EVENT_PATH) throw new Error(`${label} exceeds ${MAX_EVENT_PATH} characters`);
  return normalized;
}

export function normalizeEventMetadata(value, label = "event metadata") {
  exactKeys(value, new Set(EVENT_METADATA_KEYS), label);
  if (value.source !== EVENT_METADATA_SOURCE) throw new Error(`${label}.source is invalid`);
  const triggerId = identifier(value.triggerId, `${label}.triggerId`, "trigger_");
  const eventId = identifier(value.eventId, `${label}.eventId`, "event_");
  if (!/^trigger_[a-f0-9]{16}$/i.test(triggerId)) throw new Error(`${label}.triggerId is invalid`);
  if (!/^event_[a-f0-9]{16}$/i.test(eventId)) throw new Error(`${label}.eventId is invalid`);
  const relativePath = normalizeEventRelativePath(value.relativePath, `${label}.relativePath`);
  const observed = new Date(value.observedAt);
  if (Number.isNaN(observed.getTime())) throw new Error(`${label}.observedAt must be a valid date`);
  return {
    source: EVENT_METADATA_SOURCE,
    triggerId,
    eventId,
    relativePath,
    observedAt: observed.toISOString(),
  };
}

export function sanitizeRecentFireAt(value, nowMs, windowMs, maxEntries) {
  if (!Array.isArray(value)) return [];
  const lowerBound = nowMs - windowMs;
  const stamps = value
    .map((entry) => typeof entry === "string" ? Date.parse(entry) : Number(entry))
    .filter((stamp) => Number.isFinite(stamp) && stamp >= lowerBound && stamp <= nowMs)
    .sort((a, b) => a - b)
    .slice(-Math.max(1, maxEntries));
  return stamps.map((stamp) => new Date(stamp).toISOString());
}
