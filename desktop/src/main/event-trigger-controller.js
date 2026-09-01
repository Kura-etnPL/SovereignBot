import { realpathSync, statSync, watch as fsWatch } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";
import { normalizeEventRelativePath, sanitizeRecentFireAt } from "./lib/event-metadata.js";

export const EVENT_TRIGGERS_SCHEMA = "sovereignbot.desktop.event-triggers.v1";
export const EVENT_TRIGGER_QUIET_WINDOW_MS = 750;
export const EVENT_TRIGGER_STORM_MAX_FIRES = 10;
export const EVENT_TRIGGER_STORM_WINDOW_MS = 10 * 60 * 1000;

const MAX_NAME = 120;
const MAX_PATH_PREFIX = 512;
const MAX_ERROR = 500;
const MAX_FAILURE_COUNT = 1000;
const MAX_RAW_SAMPLES = 24;
const MAX_RAW_SAMPLE_VALUE = 512;
const EVENT_TYPES = new Set(["change", "rename"]);
const IDENTIFIER = /^[A-Za-z0-9][\w:.-]{0,159}$/;
const TRIGGER_ID = /^trigger_[a-f0-9]{16}$/i;

function makeTriggerId() { return `trigger_${randomBytes(8).toString("hex")}`; }
function makeEventId() { return `event_${randomBytes(8).toString("hex")}`; }
function clone(value) { return structuredClone(value); }
function nowMs(now) { const value = Number(now()); return Number.isFinite(value) ? value : Date.now(); }
function nowIso(now) { return new Date(nowMs(now)).toISOString(); }
function boundedError(error) { return String(error?.message ?? error).slice(0, MAX_ERROR); }
function windowsPathRules() { return process.platform === "win32"; }
function pathKey(value) { return windowsPathRules() ? value.toLowerCase() : value; }

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function exactKeys(value, allowed, label) {
  assertObject(value, label);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unexpected ${label} field: ${key}`);
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} must be an identifier`);
  return value;
}

export function normalizeEventPathPrefix(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("pathPrefix must be a string");
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > MAX_PATH_PREFIX) throw new Error(`pathPrefix exceeds ${MAX_PATH_PREFIX} characters`);
  return normalizeEventRelativePath(trimmed, "pathPrefix");
}

function sanitizeTrigger(entry) {
  try {
    if (!entry || typeof entry !== "object" || !TRIGGER_ID.test(entry.id)) return undefined;
    const name = String(entry.name ?? "").trim();
    if (!name || name.length > MAX_NAME) return undefined;
    const routineId = identifier(entry.routineId, "routineId");
    const workspaceId = identifier(entry.workspaceId, "workspaceId");
    const trigger = {
      id: entry.id,
      name,
      enabled: entry.enabled !== false,
      routineId,
      workspaceId,
      pathPrefix: normalizeEventPathPrefix(entry.pathPrefix),
      createdAt: String(entry.createdAt ?? ""),
      updatedAt: String(entry.updatedAt ?? ""),
      lastEventAt: entry.lastEventAt ? String(entry.lastEventAt) : undefined,
      lastRelativePath: entry.lastRelativePath ? normalizeEventRelativePath(String(entry.lastRelativePath)) : undefined,
      lastStatus: entry.lastStatus ? String(entry.lastStatus).slice(0, 40) : undefined,
      lastError: entry.lastError ? String(entry.lastError).slice(0, MAX_ERROR) : undefined,
      failureCount: Number.isInteger(entry.failureCount) && entry.failureCount >= 0
        ? Math.min(entry.failureCount, MAX_FAILURE_COUNT)
        : 0,
      recentFireAt: Array.isArray(entry.recentFireAt) ? [...entry.recentFireAt] : [],
    };
    return trigger;
  } catch {
    return undefined;
  }
}

function realpath(value) {
  const native = realpathSync.native;
  return typeof native === "function" ? native(value) : realpathSync(value);
}

function realpathWithExistingAncestor(value) {
  const absolute = resolve(value);
  let probe = absolute;
  const suffix = [];
  while (true) {
    try {
      const resolved = realpath(probe);
      return suffix.length ? join(resolved, ...suffix) : resolved;
    } catch (error) {
      const parent = dirname(probe);
      if (parent === probe) throw error;
      suffix.unshift(basename(probe));
      probe = parent;
    }
  }
}

function safeRelative(root, candidate, { allowEmpty = false } = {}) {
  const lexical = relative(resolve(root), resolve(candidate)).replaceAll("\\", "/");
  if (!lexical || lexical === ".") {
    if (!allowEmpty) throw new Error("path resolves to the trusted workspace root");
    return "";
  }
  if (isAbsolute(lexical) || win32.isAbsolute(lexical) || posix.isAbsolute(lexical) || lexical === ".." || lexical.startsWith("../"))
    throw new Error("path resolves outside the trusted workspace");
  return normalizeEventRelativePath(lexical, "watcher path");
}

function realRelativeInside(root, candidate, { allowEmpty = false } = {}) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const realRoot = realpath(rootPath);
  const realCandidate = realpathWithExistingAncestor(candidatePath);
  return safeRelative(realRoot, realCandidate, { allowEmpty });
}

function isAbsoluteCallbackPath(value) {
  return isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value);
}

function filenameKind(filename) {
  if (filename === null || filename === undefined) return "null";
  if (Buffer.isBuffer(filename)) return "buffer";
  return typeof filename;
}

function rawFilename(filename) {
  if (filename === null || filename === undefined) return null;
  if (Buffer.isBuffer(filename)) return filename.toString("utf8").slice(0, MAX_RAW_SAMPLE_VALUE);
  if (typeof filename === "string") return filename.slice(0, MAX_RAW_SAMPLE_VALUE);
  return `[${typeof filename}]`;
}

function sanitizeRawFilename(filename, workspaceRoot) {
  let value = rawFilename(filename);
  if (typeof value !== "string") return value;
  if (isAbsoluteCallbackPath(value)) {
    if (!workspaceRoot) return "<absolute-untrusted>";
    try {
      const relativePath = realRelativeInside(workspaceRoot, value, { allowEmpty: true });
      return `<workspace>${relativePath ? `/${relativePath}` : ""}`;
    } catch {
      return "<absolute-outside>";
    }
  }
  const normalized = value.replaceAll("\\", "/");
  const root = String(workspaceRoot ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
  const variants = normalized.startsWith("//?/") ? [normalized.slice(4), normalized] : [normalized];
  const foldedRoot = pathKey(root);
  const matched = variants.find((candidate) => {
    const folded = pathKey(candidate);
    return root && (folded === foldedRoot || folded.startsWith(`${foldedRoot}/`));
  });
  if (matched) value = `<workspace>${matched.slice(root.length)}`;
  return value.slice(0, MAX_RAW_SAMPLE_VALUE);
}

function normalizeCallbackText(filename) {
  if (filename === null || filename === undefined) throw new Error("filename-unavailable");
  if (Buffer.isBuffer(filename)) {
    const decoded = filename.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(filename)) throw new Error("filename-invalid-utf8");
    return decoded;
  }
  if (typeof filename !== "string") throw new Error("filename-unsupported-type");
  return filename;
}

function candidateFromRoot(descriptor, root, raw) {
  const normalized = normalizeEventRelativePath(raw, "watcher filename");
  const candidate = resolve(root, ...normalized.split("/"));
  return realRelativeInside(descriptor.workspaceRoot, candidate);
}

function descriptorMatchesPath(pathPrefixes, relativePath) {
  return !pathPrefixes.length || pathPrefixes.some((prefix) => pathMatches(prefix, relativePath));
}

function rejectedDecode(diagnostic, reason) {
  return { diagnostic: { ...diagnostic, rejectedReason: reason } };
}

/**
 * Decode a platform-dependent fs.watch filename into one canonical, trusted
 * Workspace-relative path. This accepts the two documented relative callback
 * shapes (watchRoot-relative and Workspace-relative), plus an absolute path
 * only after real-path containment is proven. It never reads file contents.
 */
export function decodeWatcherCallback(descriptor, filename, { pathPrefixes = [] } = {}) {
  const diagnostic = {
    filenameKind: filenameKind(filename),
    raw: sanitizeRawFilename(filename, descriptor?.workspaceRoot),
  };
  if (!descriptor?.workspaceRoot || !descriptor?.watchRoot) return rejectedDecode(diagnostic, "descriptor-unavailable");

  let raw;
  try { raw = normalizeCallbackText(filename); }
  catch (error) { return rejectedDecode(diagnostic, error.message); }

  if (isAbsoluteCallbackPath(raw)) {
    try {
      const relativePath = realRelativeInside(descriptor.workspaceRoot, raw);
      if (!descriptorMatchesPath(pathPrefixes, relativePath)) return rejectedDecode({ ...diagnostic, workspaceCandidate: relativePath }, "no-matching-safe-candidate");
      return { relativePath, diagnostic: { ...diagnostic, workspaceCandidate: relativePath, acceptedRelativePath: relativePath } };
    } catch (error) {
      return rejectedDecode(diagnostic, boundedError(error));
    }
  }

  const candidates = [];
  let anchoredCandidate;
  let workspaceCandidate;
  let normalizationError;
  try { anchoredCandidate = candidateFromRoot(descriptor, descriptor.watchRoot, raw); }
  catch (error) { normalizationError = error; }
  try { workspaceCandidate = candidateFromRoot(descriptor, descriptor.workspaceRoot, raw); }
  catch (error) { normalizationError ??= error; }

  const candidateDiagnostics = { ...diagnostic, anchoredCandidate, workspaceCandidate };
  for (const [candidateType, relativePath] of [["anchored", anchoredCandidate], ["workspace", workspaceCandidate]]) {
    if (!relativePath || !descriptorMatchesPath(pathPrefixes, relativePath)) continue;
    if (!candidates.some((entry) => pathKey(entry.relativePath) === pathKey(relativePath))) candidates.push({ candidateType, relativePath });
  }
  if (candidates.length > 1) return rejectedDecode(candidateDiagnostics, "ambiguous-callback");
  if (!candidates.length) return rejectedDecode(candidateDiagnostics, normalizationError ? boundedError(normalizationError) : "no-matching-safe-candidate");
  const [{ relativePath }] = candidates;
  return { relativePath, diagnostic: { ...candidateDiagnostics, acceptedRelativePath: relativePath } };
}

function descriptorRelative(root, candidate) {
  return realRelativeInside(root, candidate, { allowEmpty: true });
}

/**
 * Derive a safe fs.watch anchor from a normalized trigger prefix. Existing
 * files watch their parent non-recursively; existing directories and missing
 * paths watch the deepest existing directory recursively. All anchors are
 * realpath-contained in the trusted Workspace and no file body is read.
 */
export function deriveWatchDescriptor(trigger, workspaceRootValue) {
  const workspaceRoot = realpath(resolve(workspaceRootValue));
  if (!statSync(workspaceRoot).isDirectory()) throw new Error("trusted workspace root is not a directory");
  const pathPrefix = normalizeEventPathPrefix(trigger?.pathPrefix);
  const target = pathPrefix ? resolve(workspaceRoot, ...pathPrefix.split("/")) : workspaceRoot;
  let probe = target;
  const missingParts = [];
  let stats;
  while (true) {
    try {
      stats = statSync(probe);
      break;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
      const parent = dirname(probe);
      if (parent === probe) throw new Error("trusted workspace anchor is unavailable");
      missingParts.unshift(basename(probe));
      probe = parent;
    }
  }

  let watchRoot;
  let recursive;
  if (!missingParts.length && !stats.isDirectory()) {
    if (!stats.isFile()) throw new Error("pathPrefix must resolve to a file or directory");
    const realTarget = realpath(target);
    descriptorRelative(workspaceRoot, realTarget);
    watchRoot = dirname(realTarget);
    recursive = false;
  } else {
    if (!stats.isDirectory()) throw new Error("pathPrefix cannot descend through a file");
    watchRoot = realpath(probe);
    descriptorRelative(workspaceRoot, watchRoot);
    recursive = true;
  }

  const baseRelative = descriptorRelative(workspaceRoot, watchRoot);
  return {
    workspaceRoot,
    watchRoot,
    baseRelative,
    recursive,
  };
}

function pathMatches(prefix, relativePath) {
  const foldedPrefix = pathKey(prefix);
  const foldedPath = pathKey(relativePath);
  return !foldedPrefix || foldedPath === foldedPrefix || foldedPath.startsWith(`${foldedPrefix}/`);
}

function makeDescriptorKey(workspaceId, descriptor) {
  return [
    workspaceId,
    pathKey(descriptor.workspaceRoot),
    pathKey(descriptor.watchRoot),
    descriptor.recursive ? "recursive" : "single",
  ].join("\u0000");
}

function setField(target, key, value) {
  if (value === undefined) {
    if (!Object.hasOwn(target, key)) return false;
    delete target[key];
    return true;
  }
  if (target[key] === value) return false;
  target[key] = value;
  return true;
}

export function createEventTriggerController({
  dataDir,
  routineController,
  services,
  persistPath,
  now = () => Date.now(),
  makeId = makeTriggerId,
  makeEventId: makeEventIdFactory = makeEventId,
  watchFactory = fsWatch,
  scheduleTimer = setTimeout,
  cancelTimer = clearTimeout,
  quietMs = EVENT_TRIGGER_QUIET_WINDOW_MS,
  maxFires = EVENT_TRIGGER_STORM_MAX_FIRES,
  windowMs = EVENT_TRIGGER_STORM_WINDOW_MS,
} = {}) {
  if (!dataDir) throw new Error("event trigger controller requires dataDir");
  if (!routineController?.get || !routineController?.triggerEvent) throw new Error("event trigger controller requires routineController");
  if (!services?.workspacePath) throw new Error("event trigger controller requires workspace services");
  if (typeof watchFactory !== "function") throw new Error("event trigger controller requires watchFactory");
  if (typeof scheduleTimer !== "function" || typeof cancelTimer !== "function") throw new Error("event trigger controller requires timer hooks");
  if (!Number.isFinite(quietMs) || quietMs < 0 || !Number.isInteger(maxFires) || maxFires < 1 || !Number.isInteger(windowMs) || windowMs < 1)
    throw new Error("event trigger controller timing limits are invalid");

  persistPath = persistPath ?? join(dataDir, "desktop-state", "event-triggers.json");
  const loaded = loadJsonState(persistPath, null);
  const triggers = loaded?.schema === EVENT_TRIGGERS_SCHEMA && Array.isArray(loaded.triggers)
    ? loaded.triggers.map(sanitizeTrigger).filter(Boolean)
    : [];
  const loadedAt = nowMs(now);
  for (const trigger of triggers) {
    trigger.recentFireAt = sanitizeRecentFireAt(trigger.recentFireAt, loadedAt, windowMs, maxFires);
    if (trigger.lastStatus === "pending") trigger.lastStatus = trigger.enabled ? "ready" : "disabled";
  }

  const watchers = new Map();
  const pending = new Map();
  let running = false;
  let eventChain = Promise.resolve();
  let watcherInstallCount = 0;

  function save() { saveJsonState(persistPath, { schema: EVENT_TRIGGERS_SCHEMA, triggers }); }
  function findTrigger(id) {
    const trigger = triggers.find((entry) => entry.id === String(id));
    if (!trigger) throw new Error(`unknown event trigger id: ${id}`);
    return trigger;
  }
  function publicTrigger(trigger) {
    return {
      id: trigger.id,
      name: trigger.name,
      enabled: trigger.enabled,
      routineId: trigger.routineId,
      workspaceId: trigger.workspaceId,
      pathPrefix: trigger.pathPrefix,
      createdAt: trigger.createdAt,
      updatedAt: trigger.updatedAt,
      lastEventAt: trigger.lastEventAt,
      lastRelativePath: trigger.lastRelativePath,
      lastStatus: trigger.lastStatus,
      lastError: trigger.lastError,
      failureCount: trigger.failureCount,
    };
  }
  function markFailure(trigger, status, error, observedAt, relativePath) {
    let changed = false;
    if (setField(trigger, "lastStatus", status)) changed = true;
    if (setField(trigger, "lastError", boundedError(error))) changed = true;
    if (observedAt !== undefined && setField(trigger, "lastEventAt", observedAt)) changed = true;
    if (relativePath !== undefined && setField(trigger, "lastRelativePath", relativePath)) changed = true;
    if (changed) trigger.failureCount = Math.min(MAX_FAILURE_COUNT, trigger.failureCount + 1);
    return changed;
  }
  function closeWatcher(key) {
    const existing = watchers.get(key);
    if (!existing) return;
    watchers.delete(key);
    try { existing.watcher.close(); } catch {}
  }
  function workspaceRoot(workspaceId) {
    try {
      const value = services.workspacePath(workspaceId);
      if (typeof value !== "string" || !value) return undefined;
      const root = realpath(resolve(value));
      return statSync(root).isDirectory() ? root : undefined;
    } catch {
      return undefined;
    }
  }
  function validateTrigger(trigger) {
    if (!trigger.enabled) return { ok: false, status: "disabled", error: undefined };
    const root = workspaceRoot(trigger.workspaceId);
    if (!root) return { ok: false, status: "blocked", error: "trusted workspace is unavailable" };
    let routine;
    try { routine = routineController.get(trigger.routineId); }
    catch (error) { return { ok: false, status: "blocked", error: `Routine unavailable: ${boundedError(error)}` }; }
    if (!routine?.enabled) return { ok: false, status: "blocked", error: "linked Routine is disabled" };
    if (!["hourly", "daily", "weekly", "custom"].includes(routine.schedule?.type)) return { ok: false, status: "blocked", error: "event triggers require a recurring Routine" };
    if (routine.workspaceId !== trigger.workspaceId) return { ok: false, status: "blocked", error: "Routine workspace does not match trigger workspace" };
    return { ok: true, root, routine };
  }
  function isSafetyLatch(trigger) {
    return trigger.lastStatus === "blocked" && /^(event storm protection:|workspace watcher failed:)/.test(trigger.lastError ?? "");
  }
  function setReferenceBlocked(trigger, status, error) {
    if (status === "disabled") {
      if (!trigger.enabled && isSafetyLatch(trigger)) return false;
      let changed = false;
      if (setField(trigger, "lastStatus", "disabled")) changed = true;
      if (setField(trigger, "lastError", undefined)) changed = true;
      return changed;
    }
    const beforeStatus = trigger.lastStatus;
    const beforeError = trigger.lastError;
    let changed = false;
    if (setField(trigger, "lastStatus", "blocked")) changed = true;
    if (setField(trigger, "lastError", boundedError(error))) changed = true;
    if (changed && (beforeStatus !== "blocked" || beforeError !== trigger.lastError))
      trigger.failureCount = Math.min(MAX_FAILURE_COUNT, trigger.failureCount + 1);
    return changed;
  }

  function settlePending(state) {
    if (state.settled) return;
    state.settled = true;
    state.resolve();
  }
  function cancelPendingState(state, { restoreReady = false } = {}) {
    try { if (state.timer !== undefined) cancelTimer(state.timer); } catch {}
    if (pending.get(state.key) === state) pending.delete(state.key);
    if (restoreReady) {
      const trigger = triggers.find((entry) => entry.id === state.triggerId);
      if (trigger?.enabled && trigger.lastStatus === "pending") {
        trigger.lastStatus = "ready";
        delete trigger.lastError;
        trigger.updatedAt = nowIso(now);
      }
    }
    settlePending(state);
  }
  function cancelPendingForTrigger(triggerId, options) {
    for (const state of [...pending.values()]) if (state.triggerId === triggerId) cancelPendingState(state, options);
  }
  function failWatcher(descriptor, error) {
    if (!descriptor) return;
    if (descriptor.key && watchers.get(descriptor.key) === descriptor) closeWatcher(descriptor.key);
    else try { descriptor.watcher?.close?.(); } catch {}
    const message = boundedError({ message: `workspace watcher failed: ${boundedError(error)}` });
    let changed = false;
    const triggerIds = new Set(descriptor.triggerIds ?? []);
    for (const trigger of triggers.filter((entry) => entry.enabled && triggerIds.has(entry.id))) {
      cancelPendingForTrigger(trigger.id, { restoreReady: false });
      trigger.enabled = false;
      trigger.lastStatus = "blocked";
      trigger.lastError = message;
      trigger.failureCount = Math.min(MAX_FAILURE_COUNT, trigger.failureCount + 1);
      trigger.updatedAt = nowIso(now);
      changed = true;
    }
    if (changed) save();
  }

  function processPending(state) {
    const trigger = triggers.find((entry) => entry.id === state.triggerId);
    if (!running || !trigger || !trigger.enabled) return;

    const validation = validateTrigger(trigger);
    if (!validation.ok) {
      cancelPendingForTrigger(trigger.id, { restoreReady: false });
      setReferenceBlocked(trigger, validation.status, validation.error);
      trigger.updatedAt = nowIso(now);
      save();
      reconcile();
      return;
    }

    const processedAt = nowMs(now);
    const recent = (trigger.recentFireAt ?? [])
      .map((stamp) => Date.parse(stamp))
      .filter((stamp) => Number.isFinite(stamp) && stamp >= processedAt - windowMs && stamp <= processedAt)
      .sort((a, b) => a - b)
      .slice(-maxFires)
      .map((stamp) => new Date(stamp).toISOString());
    trigger.recentFireAt = recent;

    if (recent.length >= maxFires) {
      trigger.enabled = false;
      trigger.lastStatus = "blocked";
      trigger.lastError = "event storm protection: maximum event rate exceeded";
      trigger.lastEventAt = state.observedAt;
      trigger.lastRelativePath = state.relativePath;
      trigger.failureCount = Math.min(MAX_FAILURE_COUNT, trigger.failureCount + 1);
      trigger.updatedAt = nowIso(now);
      cancelPendingForTrigger(trigger.id, { restoreReady: false });
      closeWatcher(trigger.workspaceId);
      save();
      reconcile();
      return;
    }

    recent.push(new Date(processedAt).toISOString());
    trigger.recentFireAt = recent.slice(-maxFires);
    trigger.lastEventAt = state.observedAt;
    trigger.lastRelativePath = state.relativePath;
    trigger.lastStatus = "pending";
    delete trigger.lastError;
    trigger.updatedAt = nowIso(now);
    save();

    try {
      const result = routineController.triggerEvent(trigger.routineId, {
        triggerId: trigger.id,
        eventId: makeEventIdFactory(),
        relativePath: state.relativePath,
        eventType: state.eventType,
        workspaceId: state.workspaceId,
        observedAt: state.observedAt,
      });
      if (!result?.job?.id) throw new Error("Routine did not return a Job");
      trigger.lastStatus = "fired";
      delete trigger.lastError;
      trigger.updatedAt = nowIso(now);
      save();
    } catch (error) {
      markFailure(trigger, "error", error, state.observedAt, state.relativePath);
      trigger.updatedAt = nowIso(now);
      save();
    }
  }

  function schedulePending(state) {
    if (state.timer !== undefined) {
      try { cancelTimer(state.timer); } catch {}
    }
    const generation = ++state.generation;
    state.dueAt = state.observedAtMs + quietMs;
    state.timer = scheduleTimer(() => {
      const current = pending.get(state.key);
      if (!current || current !== state || current.generation !== generation) return;
      const remaining = current.dueAt - nowMs(now);
      if (remaining > 0) {
        schedulePending(current);
        return;
      }
      pending.delete(state.key);
      current.timer = undefined;
      const run = eventChain.then(() => processPending(current));
      eventChain = run.catch(() => {});
      run.then(() => settlePending(current), () => settlePending(current));
    }, Math.max(0, quietMs));
    if (state.timer && typeof state.timer.unref === "function") state.timer.unref();
  }

  function triggerPrefixes(descriptor) {
    return [...(descriptor.triggerIds ?? [])]
      .map((triggerId) => triggers.find((entry) => entry.id === triggerId)?.pathPrefix)
      .filter((prefix) => prefix !== undefined);
  }

  function recordRawSample(descriptor, eventType, decoded) {
    if (descriptor.rawSamples.length >= MAX_RAW_SAMPLES) return;
    const detail = decoded?.diagnostic ?? {};
    const sample = {
      eventType: String(eventType ?? "").slice(0, 40),
      filenameKind: detail.filenameKind,
      raw: detail.raw,
    };
    for (const key of ["anchoredCandidate", "workspaceCandidate", "acceptedRelativePath", "rejectedReason"])
      if (detail[key] !== undefined) sample[key] = String(detail[key]).slice(0, MAX_RAW_SAMPLE_VALUE);
    descriptor.rawSamples.push(sample);
  }

  function enqueueFsEvent(descriptor, eventType, relativePath) {
    const workspaceId = descriptor.workspaceId;
    if (!running) return;
    if (!relativePath) return;
    const observedAtMs = nowMs(now);
    const observedAt = new Date(observedAtMs).toISOString();
    let stateChanged = false;
    const type = EVENT_TYPES.has(eventType) ? eventType : "change";
    for (const trigger of triggers) {
      if (!trigger.enabled || trigger.workspaceId !== workspaceId || !pathMatches(trigger.pathPrefix, relativePath)) continue;
      const key = `${trigger.id}\u0000${pathKey(relativePath)}`;
      let state = pending.get(key);
      if (!state) {
        state = {
          key,
          triggerId: trigger.id,
          workspaceId,
          eventType: type,
          relativePath,
          observedAt,
          observedAtMs,
          dueAt: observedAtMs + quietMs,
          generation: 0,
          timer: undefined,
          settled: false,
          completion: undefined,
          resolve: undefined,
        };
        state.completion = new Promise((resolve) => { state.resolve = resolve; });
        pending.set(key, state);
      } else {
        state.eventType = type;
        state.relativePath = relativePath;
        state.observedAt = observedAt;
        state.observedAtMs = observedAtMs;
      }
      schedulePending(state);
      if (setField(trigger, "lastEventAt", observedAt)) stateChanged = true;
      if (setField(trigger, "lastRelativePath", relativePath)) stateChanged = true;
      if (setField(trigger, "lastStatus", "pending")) stateChanged = true;
      if (setField(trigger, "lastError", undefined)) stateChanged = true;
      trigger.updatedAt = nowIso(now);
    }
    if (stateChanged) save();
  }

  function ensureWatcher(spec) {
    const current = watchers.get(spec.key);
    if (current) {
      current.triggerIds = new Set(spec.triggerIds);
      return;
    }
    const state = {
      ...spec,
      triggerIds: new Set(spec.triggerIds),
      watcher: undefined,
      rawCallbackCount: 0,
      acceptedCallbackCount: 0,
      rawSamples: [],
    };
    try {
      const watcher = watchFactory(state.watchRoot, { persistent: false, recursive: state.recursive }, (eventType, filename) => {
        if (watchers.get(state.key) !== state) return;
        state.rawCallbackCount += 1;
        const decoded = decodeWatcherCallback(state, filename, { pathPrefixes: triggerPrefixes(state) });
        recordRawSample(state, eventType, decoded);
        if (!decoded.relativePath) return;
        state.acceptedCallbackCount += 1;
        enqueueFsEvent(state, eventType, decoded.relativePath);
      });
      state.watcher = watcher;
      watchers.set(state.key, state);
      watcherInstallCount += 1;
      if (watcher && typeof watcher.on === "function") watcher.on("error", (error) => {
        if (watchers.get(state.key) === state) failWatcher(state, error);
      });
    } catch (error) {
      failWatcher(state, error);
    }
  }

  function reconcile() {
    const desired = new Map();
    let changed = false;
    for (const trigger of triggers) {
      const validation = validateTrigger(trigger);
      if (!validation.ok) {
        cancelPendingForTrigger(trigger.id, { restoreReady: false });
        if (setReferenceBlocked(trigger, validation.status, validation.error)) changed = true;
        continue;
      }
      let descriptor;
      try {
        descriptor = deriveWatchDescriptor(trigger, validation.root);
      } catch (error) {
        cancelPendingForTrigger(trigger.id, { restoreReady: false });
        if (setReferenceBlocked(trigger, "blocked", `trusted workspace anchor unavailable: ${boundedError(error)}`)) changed = true;
        continue;
      }
      const key = makeDescriptorKey(trigger.workspaceId, descriptor);
      let spec = desired.get(key);
      if (!spec) {
        spec = { ...descriptor, key, workspaceId: trigger.workspaceId, triggerIds: new Set() };
        desired.set(key, spec);
      }
      spec.triggerIds.add(trigger.id);
      if (!trigger.lastStatus || trigger.lastStatus === "blocked" || trigger.lastStatus === "pending") {
        if (setField(trigger, "lastStatus", "ready")) changed = true;
        if (setField(trigger, "lastError", undefined)) changed = true;
      }
    }
    for (const key of watchers.keys()) if (!desired.has(key)) closeWatcher(key);
    if (running) for (const spec of desired.values()) ensureWatcher(spec);
    if (changed) {
      const stamp = nowIso(now);
      for (const trigger of triggers) if (trigger.lastStatus !== "pending") trigger.updatedAt = stamp;
      save();
    }
    return { schema: EVENT_TRIGGERS_SCHEMA, triggers: triggers.map(publicTrigger) };
  }

  async function flush() {
    while (true) {
      const chain = eventChain;
      const completions = [...pending.values()].map((state) => state.completion);
      await chain;
      if (completions.length) await Promise.all(completions);
      if (chain === eventChain && [...pending.values()].every((state) => completions.includes(state.completion))) return;
    }
  }

  return {
    create(payload = {}) {
      exactKeys(payload, new Set(["name", "routineId", "workspaceId", "pathPrefix"]), "event trigger");
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      if (!name) throw new Error("trigger name is required");
      if (name.length > MAX_NAME) throw new Error(`trigger name exceeds ${MAX_NAME} characters`);
      const routineId = identifier(payload.routineId, "routineId");
      const workspaceId = identifier(payload.workspaceId, "workspaceId");
      const pathPrefix = normalizeEventPathPrefix(payload.pathPrefix);
      const routine = routineController.get(routineId);
      if (!routine?.enabled) throw new Error("event triggers require an enabled Routine");
      if (!["hourly", "daily", "weekly", "custom"].includes(routine.schedule?.type)) throw new Error("event triggers require a recurring Routine");
      if (routine.workspaceId !== workspaceId) throw new Error("trigger workspace must match the Routine workspace");
      if (!workspaceRoot(workspaceId)) throw new Error(`unknown trusted workspace: ${workspaceId}`);
      const id = makeId();
      if (typeof id !== "string" || !TRIGGER_ID.test(id) || triggers.some((entry) => entry.id === id)) throw new Error("trigger id factory returned invalid or duplicate id");
      const stamp = nowIso(now);
      const trigger = { id, name, enabled: true, routineId, workspaceId, pathPrefix, createdAt: stamp, updatedAt: stamp, lastStatus: "ready", failureCount: 0, recentFireAt: [] };
      triggers.push(trigger);
      save();
      if (running) reconcile();
      return publicTrigger(trigger);
    },
    list() { reconcile(); return { schema: EVENT_TRIGGERS_SCHEMA, triggers: triggers.map(publicTrigger) }; },
    get(triggerId) { reconcile(); return publicTrigger(findTrigger(triggerId)); },
    setEnabled(triggerId, enabled) {
      if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
      const trigger = findTrigger(triggerId);
      cancelPendingForTrigger(trigger.id, { restoreReady: false });
      trigger.enabled = enabled;
      if (enabled) {
        // Re-enabling is an explicit operator action: clear both safety latches and
        // the persisted storm window before validating and rebuilding the watcher.
        trigger.recentFireAt = [];
        delete trigger.lastError;
        const validation = validateTrigger(trigger);
        if (validation.ok) trigger.lastStatus = "ready";
        else setReferenceBlocked(trigger, validation.status, validation.error);
      } else {
        trigger.lastStatus = "disabled";
        delete trigger.lastError;
      }
      trigger.updatedAt = nowIso(now);
      save();
      if (running) reconcile();
      return publicTrigger(trigger);
    },
    remove(triggerId) {
      const index = triggers.findIndex((entry) => entry.id === String(triggerId));
      if (index < 0) throw new Error(`unknown event trigger id: ${triggerId}`);
      const [removed] = triggers.splice(index, 1);
      cancelPendingForTrigger(removed.id, { restoreReady: false });
      save();
      if (running) reconcile();
      return publicTrigger(removed);
    },
    reconcile,
    start() { if (running) return; running = true; reconcile(); },
    stop() {
      running = false;
      for (const state of [...pending.values()]) cancelPendingState(state, { restoreReady: true });
      for (const key of watchers.keys()) closeWatcher(key);
      save();
    },
    async flush() { await flush(); },
    // Internal real-gate diagnostics only. This object is not exposed through IPC or
    // the preload bridge and contains no file contents or absolute paths in public state.
    diagnostics() {
      return {
        running,
        watcherInstallCount,
        watchers: [...watchers.entries()].map(([key, state]) => ({
          key,
          workspaceId: state.workspaceId,
          workspaceRoot: state.workspaceRoot,
          watchRoot: state.watchRoot,
          baseRelative: state.baseRelative,
          recursive: state.recursive,
          triggerIds: [...state.triggerIds],
          rawCallbackCount: state.rawCallbackCount,
          acceptedCallbackCount: state.acceptedCallbackCount,
          rawSamples: clone(state.rawSamples),
          emitError: (error) => { if (watchers.get(state.key) === state) failWatcher(state, error); },
        })),
        pending: [...pending.values()].map((state) => ({ triggerId: state.triggerId, workspaceId: state.workspaceId, relativePath: state.relativePath, eventType: state.eventType, observedAt: state.observedAt, dueAt: state.dueAt })),
        rawCallbackCount: [...watchers.values()].reduce((total, state) => total + state.rawCallbackCount, 0),
      };
    },
  };
}
