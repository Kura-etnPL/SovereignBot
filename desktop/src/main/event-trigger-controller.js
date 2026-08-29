import { watch as fsWatch } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";
import { normalizeEventRelativePath } from "./routine-controller.js";

export const EVENT_TRIGGERS_SCHEMA = "sovereignbot.desktop.event-triggers.v1";
export const EVENT_TRIGGER_QUIET_WINDOW_MS = 750;
export const EVENT_TRIGGER_STORM_MAX_FIRES = 10;
export const EVENT_TRIGGER_STORM_WINDOW_MS = 10 * 60 * 1000;

const MAX_NAME = 120;
const MAX_PATH_PREFIX = 512;
const MAX_ERROR = 500;
const MAX_FAILURE_COUNT = 1000;
const EVENT_TYPES = new Set(["change", "rename"]);
const IDENTIFIER = /^[A-Za-z0-9][\w:.-]{0,159}$/;

function makeTriggerId() { return `trigger_${randomBytes(8).toString("hex")}`; }
function makeEventId() { return `event_${randomBytes(8).toString("hex")}`; }
function clone(value) { return structuredClone(value); }
function nowMs(now) { const value = Number(now()); return Number.isFinite(value) ? value : Date.now(); }
function nowIso(now) { return new Date(nowMs(now)).toISOString(); }
function boundedError(error) { return String(error?.message ?? error).slice(0, MAX_ERROR); }

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
    if (!entry || typeof entry !== "object" || !/^trigger_[a-f0-9]{16}$/i.test(entry.id)) return undefined;
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
    };
    return trigger;
  } catch {
    return undefined;
  }
}

function pathInside(root, filename) {
  if (filename === undefined || filename === null) return undefined;
  const raw = Buffer.isBuffer(filename) ? filename.toString("utf8") : String(filename);
  const relativeName = normalizeEventRelativePath(raw, "watcher filename");
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, ...relativeName.split("/"));
  const check = relative(rootPath, candidate);
  if (!check || check === "." || isAbsolute(check) || win32.isAbsolute(check) || posix.isAbsolute(check)) return undefined;
  if (check === ".." || check.startsWith("..")) return undefined;
  return normalizeEventRelativePath(check.replaceAll("\\", "/"), "watcher filename");
}

function pathMatches(prefix, relativePath) {
  return !prefix || relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

function sameOrNestedPath(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
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
  quietMs = EVENT_TRIGGER_QUIET_WINDOW_MS,
  maxFires = EVENT_TRIGGER_STORM_MAX_FIRES,
  windowMs = EVENT_TRIGGER_STORM_WINDOW_MS,
} = {}) {
  if (!dataDir) throw new Error("event trigger controller requires dataDir");
  if (!routineController?.get || !routineController?.triggerEvent) throw new Error("event trigger controller requires routineController");
  if (!services?.workspacePath) throw new Error("event trigger controller requires workspace services");
  if (typeof watchFactory !== "function") throw new Error("event trigger controller requires watchFactory");
  if (!Number.isFinite(quietMs) || quietMs < 0 || !Number.isFinite(maxFires) || maxFires < 1 || !Number.isFinite(windowMs) || windowMs < 1)
    throw new Error("event trigger controller timing limits are invalid");

  persistPath = persistPath ?? join(dataDir, "desktop-state", "event-triggers.json");
  const loaded = loadJsonState(persistPath, null);
  const triggers = loaded?.schema === EVENT_TRIGGERS_SCHEMA && Array.isArray(loaded.triggers)
    ? loaded.triggers.map(sanitizeTrigger).filter(Boolean)
    : [];
  const watchers = new Map();
  const debounce = new Map();
  const fireWindows = new Map();
  let running = false;
  let eventChain = Promise.resolve();

  function save() { saveJsonState(persistPath, { schema: EVENT_TRIGGERS_SCHEMA, triggers }); }
  function findTrigger(id) {
    const trigger = triggers.find((entry) => entry.id === String(id));
    if (!trigger) throw new Error(`unknown event trigger id: ${id}`);
    return trigger;
  }
  function publicTrigger(trigger) { return clone(trigger); }
  function markFailure(trigger, status, error, observedAt, relativePath) {
    const changed = setField(trigger, "lastStatus", status)
      | setField(trigger, "lastError", boundedError(error));
    if (observedAt !== undefined) changed |= setField(trigger, "lastEventAt", observedAt);
    if (relativePath !== undefined) changed |= setField(trigger, "lastRelativePath", relativePath);
    if (changed) trigger.failureCount = Math.min(MAX_FAILURE_COUNT, trigger.failureCount + 1);
    return Boolean(changed);
  }
  function closeWatcher(workspaceId) {
    const existing = watchers.get(workspaceId);
    if (!existing) return;
    watchers.delete(workspaceId);
    try { existing.watcher.close(); } catch {}
  }
  function workspaceRoot(workspaceId) {
    try {
      const value = services.workspacePath(workspaceId);
      if (typeof value !== "string" || !value) return undefined;
      return resolve(value);
    } catch {
      return undefined;
    }
  }
  function validateTrigger(trigger, { allowAcceptedDisabled = false } = {}) {
    if (!trigger.enabled && !allowAcceptedDisabled) return { ok: false, status: "disabled", error: undefined };
    const root = workspaceRoot(trigger.workspaceId);
    if (!root) return { ok: false, status: "blocked", error: "trusted workspace is unavailable" };
    let routine;
    try { routine = routineController.get(trigger.routineId); }
    catch (error) { return { ok: false, status: "blocked", error: `Routine unavailable: ${boundedError(error)}` }; }
    if (!routine?.enabled) return { ok: false, status: "blocked", error: "linked Routine is disabled" };
    if (!["hourly", "daily", "weekly"].includes(routine.schedule?.type)) return { ok: false, status: "blocked", error: "event triggers require a recurring Routine" };
    if (routine.workspaceId !== trigger.workspaceId) return { ok: false, status: "blocked", error: "Routine workspace does not match trigger workspace" };
    return { ok: true, root, routine };
  }
  function setReferenceBlocked(trigger, status, error) {
    let changed = false;
    if (status === "disabled") {
      if (!trigger.enabled && trigger.lastStatus === "blocked" && trigger.lastError?.startsWith("event storm protection:")) return false;
      changed |= setField(trigger, "lastStatus", "disabled");
      changed |= setField(trigger, "lastError", undefined);
    } else {
      changed |= setField(trigger, "lastStatus", "blocked");
      if (error) changed |= setField(trigger, "lastError", boundedError(error));
      if (changed && trigger.lastError === error) trigger.failureCount = Math.min(MAX_FAILURE_COUNT, trigger.failureCount + 1);
    }
    return Boolean(changed);
  }

  function handleWatcherError(workspaceId, error) {
    closeWatcher(workspaceId);
    let changed = false;
    const message = `workspace watcher failed: ${boundedError(error)}`;
    for (const trigger of triggers.filter((entry) => entry.enabled && entry.workspaceId === workspaceId)) {
      changed |= markFailure(trigger, "error", message);
    }
    if (changed) save();
  }

  function enqueueFsEvent(workspaceId, eventType, filename) {
    if (!running) return;
    let relativePath;
    try { relativePath = pathInside(workspaceRoot(workspaceId), filename); } catch { return; }
    if (!relativePath) return;
    const observedAtMs = nowMs(now);
    const observedAt = new Date(observedAtMs).toISOString();
    let stateChanged = false;
    for (const trigger of triggers) {
      if (!trigger.enabled || trigger.workspaceId !== workspaceId || !pathMatches(trigger.pathPrefix, relativePath)) continue;
      const recentEvents = (debounce.get(trigger.id) ?? []).filter((entry) => observedAtMs - entry.at < quietMs);
      if (recentEvents.some((entry) => sameOrNestedPath(entry.path, relativePath))) continue;
      recentEvents.push({ path: relativePath, at: observedAtMs });
      debounce.set(trigger.id, recentEvents);

      const window = (fireWindows.get(trigger.id) ?? []).filter((stamp) => observedAtMs - stamp < windowMs);
      if (window.length >= maxFires) {
        fireWindows.set(trigger.id, window);
        trigger.enabled = false;
        stateChanged |= setField(trigger, "lastStatus", "blocked");
        stateChanged |= setField(trigger, "lastError", "event storm protection: maximum event rate exceeded");
        stateChanged |= setField(trigger, "lastEventAt", observedAt);
        stateChanged |= setField(trigger, "lastRelativePath", relativePath);
        trigger.failureCount = Math.min(MAX_FAILURE_COUNT, trigger.failureCount + 1);
        continue;
      }
      window.push(observedAtMs);
      fireWindows.set(trigger.id, window);
      stateChanged |= setField(trigger, "lastEventAt", observedAt);
      stateChanged |= setField(trigger, "lastRelativePath", relativePath);
      stateChanged |= setField(trigger, "lastStatus", "pending");
      stateChanged |= setField(trigger, "lastError", undefined);
      const type = EVENT_TYPES.has(eventType) ? eventType : "change";
      eventChain = eventChain.then(() => handleAcceptedEvent(trigger.id, workspaceId, type, relativePath, observedAt)).catch(() => {});
    }
    if (stateChanged) save();
    if ([...triggers].some((trigger) => trigger.lastError === "event storm protection: maximum event rate exceeded" && !trigger.enabled)) reconcile();
  }

  function handleAcceptedEvent(triggerId, workspaceId, eventType, relativePath, observedAt) {
    const trigger = triggers.find((entry) => entry.id === triggerId);
    if (!running || !trigger) return;
    // A burst can be accepted just before storm protection disables the trigger. Those
    // already-accepted events are still drained in order; future callbacks are closed.
    const validation = validateTrigger(trigger, { allowAcceptedDisabled: true });
    if (!validation.ok) {
      setReferenceBlocked(trigger, validation.status, validation.error);
      save();
      reconcile();
      return;
    }
    try {
      const result = routineController.triggerEvent(trigger.routineId, {
        triggerId: trigger.id,
        eventId: makeEventIdFactory(),
        relativePath,
        eventType,
        workspaceId,
        observedAt,
      });
      if (!result?.job?.id) throw new Error("Routine did not return a Job");
      const stormBlocked = !trigger.enabled && trigger.lastError?.startsWith("event storm protection:");
      const manuallyDisabled = !trigger.enabled && trigger.lastStatus === "disabled";
      if (!stormBlocked && !manuallyDisabled) {
        setField(trigger, "lastStatus", "fired");
        setField(trigger, "lastError", undefined);
      }
      trigger.updatedAt = nowIso(now);
      save();
    } catch (error) {
      markFailure(trigger, "error", error, observedAt, relativePath);
      trigger.updatedAt = nowIso(now);
      save();
    }
  }

  function ensureWatcher(workspaceId, root) {
    const current = watchers.get(workspaceId);
    if (current?.root === root) return;
    closeWatcher(workspaceId);
    try {
      const watcher = watchFactory(root, { persistent: false, recursive: true }, (eventType, filename) => enqueueFsEvent(workspaceId, eventType, filename));
      if (watcher && typeof watcher.on === "function") watcher.on("error", (error) => handleWatcherError(workspaceId, error));
      watchers.set(workspaceId, { root, watcher });
    } catch (error) {
      let changed = false;
      for (const trigger of triggers.filter((entry) => entry.enabled && entry.workspaceId === workspaceId)) changed |= markFailure(trigger, "error", `workspace watcher failed: ${boundedError(error)}`);
      if (changed) save();
    }
  }

  function reconcile() {
    const desired = new Map();
    let changed = false;
    for (const trigger of triggers) {
      const validation = validateTrigger(trigger);
      if (!validation.ok) {
        closeWatcher(trigger.workspaceId);
        changed |= setReferenceBlocked(trigger, validation.status, validation.error);
        continue;
      }
      desired.set(trigger.workspaceId, validation.root);
      if (!trigger.lastStatus || trigger.lastStatus === "blocked") {
        changed |= setField(trigger, "lastStatus", "ready");
        changed |= setField(trigger, "lastError", undefined);
      }
    }
    for (const workspaceId of watchers.keys()) if (!desired.has(workspaceId)) closeWatcher(workspaceId);
    if (running) for (const [workspaceId, root] of desired) ensureWatcher(workspaceId, root);
    if (changed) {
      for (const trigger of triggers) if (trigger.updatedAt !== undefined) trigger.updatedAt = nowIso(now);
      save();
    }
    return { schema: EVENT_TRIGGERS_SCHEMA, triggers: triggers.map(publicTrigger) };
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
      if (!["hourly", "daily", "weekly"].includes(routine.schedule?.type)) throw new Error("event triggers require a recurring Routine");
      if (routine.workspaceId !== workspaceId) throw new Error("trigger workspace must match the Routine workspace");
      if (!workspaceRoot(workspaceId)) throw new Error(`unknown trusted workspace: ${workspaceId}`);
      const id = makeId();
      if (typeof id !== "string" || !/^trigger_[a-f0-9]{16}$/i.test(id) || triggers.some((entry) => entry.id === id)) throw new Error("trigger id factory returned invalid or duplicate id");
      const stamp = nowIso(now);
      const trigger = { id, name, enabled: true, routineId, workspaceId, pathPrefix, createdAt: stamp, updatedAt: stamp, lastStatus: "ready", failureCount: 0 };
      triggers.push(trigger);
      save();
      if (running) reconcile();
      return publicTrigger(trigger);
    },
    list() { if (running) reconcile(); return { schema: EVENT_TRIGGERS_SCHEMA, triggers: triggers.map(publicTrigger) }; },
    get(triggerId) { if (running) reconcile(); return publicTrigger(findTrigger(triggerId)); },
    setEnabled(triggerId, enabled) {
      if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
      const trigger = findTrigger(triggerId);
      trigger.enabled = enabled;
      trigger.updatedAt = nowIso(now);
      if (!enabled) {
        trigger.lastStatus = "disabled";
        delete trigger.lastError;
        closeWatcher(trigger.workspaceId);
        debounce.delete(trigger.id);
        fireWindows.delete(trigger.id);
      }
      save();
      if (running) reconcile();
      return publicTrigger(trigger);
    },
    remove(triggerId) {
      const index = triggers.findIndex((entry) => entry.id === String(triggerId));
      if (index < 0) throw new Error(`unknown event trigger id: ${triggerId}`);
      const [removed] = triggers.splice(index, 1);
      closeWatcher(removed.workspaceId);
      save();
      if (running) reconcile();
      return publicTrigger(removed);
    },
    reconcile,
    start() { if (running) return; running = true; reconcile(); },
    stop() { running = false; for (const workspaceId of watchers.keys()) closeWatcher(workspaceId); },
    async flush() { await eventChain; },
  };
}
