import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";
import { normalizeEventMetadata, normalizeEventRelativePath } from "./lib/event-metadata.js";
import { normalizeComputerTarget } from "./computer-target-controller.js";

export const ROUTINES_SCHEMA = "sovereignbot.desktop.routines.v1";
export const ROUTINE_HISTORY_LIMIT = 100;
const MAX_NAME = 120;
const MAX_INSTRUCTION = 8000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const SCHEDULE_TYPES = new Set(["one-time", "hourly", "daily", "weekly", "custom"]);
const TERMINAL_JOB = new Set(["completed", "failed", "cancelled"]);
const EVENT_TYPES = new Set(["change", "rename"]);

function makeRoutineId() { return `routine_${randomBytes(8).toString("hex")}`; }
function makeRunId() { return `run_${randomBytes(8).toString("hex")}`; }
function makeEventRunId() { return `event_${randomBytes(8).toString("hex")}`; }
function clone(value) { return structuredClone(value); }
function nowIso(now) { return new Date(now()).toISOString(); }
function asIso(value, label) { const d = new Date(value); if (Number.isNaN(d.getTime())) throw new Error(`${label} must be a valid date`); return d.toISOString(); }
function validateTime(value, label = "time") { if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`${label} must be HH:MM`); return value; }
function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unexpected ${label} field: ${key}`);
}

// Keep the historical export stable while the path and event-metadata contract lives
// in one shared module used by the watcher, Routine, Job, and IPC boundaries.
export { normalizeEventRelativePath } from "./lib/event-metadata.js";

export function normalizeRoutineSchedule(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schedule must be an object");
  if (!SCHEDULE_TYPES.has(value.type)) throw new Error("schedule type must be one-time, hourly, daily, weekly, or custom");
  if (value.type === "one-time") {
    exactKeys(value, new Set(["type", "at"]), "schedule");
    return { type: "one-time", at: asIso(value.at, "schedule.at") };
  }
  if (value.type === "hourly") {
    exactKeys(value, new Set(["type", "minute"]), "schedule");
    if (!Number.isInteger(value.minute) || value.minute < 0 || value.minute > 59) throw new Error("schedule.minute must be 0-59");
    return { type: "hourly", minute: value.minute };
  }
  if (value.type === "custom") {
    exactKeys(value, new Set(["type", "intervalMinutes"]), "schedule");
    if (!Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 1 || value.intervalMinutes > 10080) throw new Error("schedule.intervalMinutes must be 1-10080");
    return { type: "custom", intervalMinutes: value.intervalMinutes };
  }
  if (value.type === "daily") {
    exactKeys(value, new Set(["type", "time"]), "schedule");
    return { type: "daily", time: validateTime(value.time, "schedule.time") };
  }
  exactKeys(value, new Set(["type", "weekday", "time"]), "schedule");
  if (!Number.isInteger(value.weekday) || value.weekday < 0 || value.weekday > 6) throw new Error("schedule.weekday must be 0-6");
  return { type: "weekly", weekday: value.weekday, time: validateTime(value.time, "schedule.time") };
}

function setLocalTime(date, hhmm) {
  const [hour, minute] = hhmm.split(":").map(Number);
  date.setHours(hour, minute, 0, 0);
  return date;
}

export function nextRoutineOccurrence(scheduleValue, afterMs) {
  const schedule = normalizeRoutineSchedule(scheduleValue);
  if (schedule.type === "one-time") return null;
  if (schedule.type === "hourly") {
    const next = new Date(afterMs);
    next.setSeconds(0, 0);
    next.setMinutes(schedule.minute);
    if (next.getTime() <= afterMs) next.setHours(next.getHours() + 1);
    return next.toISOString();
  }
  if (schedule.type === "custom") return new Date(afterMs + schedule.intervalMinutes * 60_000).toISOString();
  if (schedule.type === "daily") {
    const next = setLocalTime(new Date(afterMs), schedule.time);
    if (next.getTime() <= afterMs) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  const next = setLocalTime(new Date(afterMs), schedule.time);
  const delta = (schedule.weekday - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + delta);
  if (next.getTime() <= afterMs) next.setDate(next.getDate() + 7);
  return next.toISOString();
}

function initialNextRun(schedule, currentMs) {
  if (schedule.type === "one-time") return schedule.at;
  return nextRoutineOccurrence(schedule, currentMs);
}

function sanitizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && typeof entry.id === "string" && typeof entry.scheduledFor === "string")
    .map((entry) => {
      const source = entry.source === "event" ? "event" : entry.source === "manual" ? "manual" : "schedule";
      const run = {
        id: entry.id,
        scheduledFor: entry.scheduledFor,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
        jobId: entry.jobId,
        status: entry.status,
        error: entry.error,
        source,
      };
      if (source === "event") {
        if (typeof entry.triggerId === "string" && /^trigger_[a-f0-9]{16}$/i.test(entry.triggerId)) run.triggerId = entry.triggerId;
        if (typeof entry.eventId === "string" && /^event_[a-f0-9]{16}$/i.test(entry.eventId)) run.eventId = entry.eventId;
        if (typeof entry.relativePath === "string") {
          try { run.relativePath = normalizeEventRelativePath(entry.relativePath); } catch {}
        }
        if (EVENT_TYPES.has(entry.eventType)) run.eventType = entry.eventType;
        if (typeof entry.workspaceId === "string" && /^[A-Za-z0-9][\w:.-]{0,159}$/.test(entry.workspaceId)) run.workspaceId = entry.workspaceId;
        if (typeof entry.observedAt === "string" && Number.isFinite(Date.parse(entry.observedAt))) run.observedAt = new Date(entry.observedAt).toISOString();
      }
      return run;
    })
    .slice(-ROUTINE_HISTORY_LIMIT);
}

function sanitizeRoutine(entry) {
  try {
    if (!entry || typeof entry !== "object" || !/^routine_[a-f0-9]{16}$/i.test(entry.id)) return undefined;
    const name = String(entry.name ?? "").trim();
    const instruction = String(entry.instruction ?? "").trim();
    if (!name || name.length > MAX_NAME || !instruction || instruction.length > MAX_INSTRUCTION) return undefined;
    const computerTarget = entry.computerTarget === undefined ? undefined : normalizeComputerTarget(entry.computerTarget);
    return {
      id: entry.id,
      name,
      state: entry.state === "archived" ? "archived" : "active",
      enabled: entry.state === "archived" ? false : entry.enabled !== false,
      coworkerId: String(entry.coworkerId ?? ""),
      teamId: entry.teamId ? String(entry.teamId) : undefined,
      projectId: entry.projectId ? String(entry.projectId) : undefined,
      instruction,
      skillId: entry.skillId ? String(entry.skillId) : undefined,
      workspaceId: entry.workspaceId ? String(entry.workspaceId) : undefined,
      computerTarget,
      computerActions: Array.isArray(entry.computerActions) ? entry.computerActions.map((action) => ({ operation: String(action.operation), input: structuredClone(action.input ?? {}) })) : undefined,
      schedule: normalizeRoutineSchedule(entry.schedule),
      createdAt: String(entry.createdAt ?? ""),
      updatedAt: String(entry.updatedAt ?? ""),
      lastRunAt: entry.lastRunAt ? String(entry.lastRunAt) : undefined,
      nextRunAt: entry.nextRunAt ? String(entry.nextRunAt) : undefined,
      lastStatus: entry.lastStatus ? String(entry.lastStatus) : undefined,
      failureCount: Number.isInteger(entry.failureCount) && entry.failureCount >= 0 ? entry.failureCount : 0,
      history: sanitizeHistory(entry.history),
    };
  } catch { return undefined; }
}

export function createRoutineController({ dataDir, jobController, coworkerStore, skillStore, services, projectService, teamService, computerTargetController, persistPath, now = () => Date.now(), makeId = makeRoutineId, makeHistoryId = makeRunId, makeEventId = makeEventRunId } = {}) {
  if (!dataDir) throw new Error("routine controller requires dataDir");
  if (!jobController?.submitJob || !jobController?.getJob) throw new Error("routine controller requires jobController");
  if (!coworkerStore?.get) throw new Error("routine controller requires coworkerStore");
  if (!services?.workspacePath) throw new Error("routine controller requires workspace services");
  persistPath = persistPath ?? join(dataDir, "desktop-state", "routines.json");

  const loaded = loadJsonState(persistPath, null);
  const routines = loaded?.schema === ROUTINES_SCHEMA && Array.isArray(loaded.routines)
    ? loaded.routines.map(sanitizeRoutine).filter(Boolean)
    : [];

  function save() { saveJsonState(persistPath, { schema: ROUTINES_SCHEMA, routines }); }
  function requireRoutine(id) { const routine = routines.find((entry) => entry.id === String(id)); if (!routine) throw new Error(`unknown routine id: ${id}`); return routine; }
  function validateRefs({ coworkerId, skillId, workspaceId, teamId, projectId }) {
    const coworker = coworkerStore.get(coworkerId);
    if (coworker.state && coworker.state !== "active") throw new Error("Routine owner Coworker is not active");
    if (teamId !== undefined) {
      if (!teamService?.get) throw new Error("Routine Team binding is unavailable");
      const team = teamService.get(teamId);
      if (team.state && team.state !== "active") throw new Error("Routine Team is not active");
      if (!team.coworkerIds.includes(String(coworkerId))) throw new Error("Routine Coworker is not a member of the selected Team");
    }
    if (projectId !== undefined) {
      if (!projectService?.resolveScope) throw new Error("Routine Project binding is unavailable");
      const project = projectService.resolveScope(projectId);
      if (project.state !== "active") throw new Error("Routine Project is not active");
      if (!project.coworkerIds?.includes(String(coworkerId)) && (!teamId || !project.teamIds?.includes(String(teamId)))) throw new Error("Routine Coworker or Team is not a member of the selected Project");
      if (workspaceId !== undefined && project.workspaceId !== String(workspaceId)) throw new Error("Routine workspace does not match Project workspace");
    }
    if (skillId !== undefined) {
      if (!skillStore?.requireActive) throw new Error("routine skills require skill store");
      skillStore.requireActive(skillId);
    }
    if (workspaceId !== undefined && !services.workspacePath(workspaceId)) throw new Error(`unknown trusted workspace: ${workspaceId}`);
  }
  function publicRoutine(routine, withHistory = false) {
    return {
      id: routine.id,
      name: routine.name,
      enabled: routine.enabled,
      coworkerId: routine.coworkerId,
      instruction: routine.instruction,
      skillId: routine.skillId,
      teamId: routine.teamId,
      projectId: routine.projectId,
      workspaceId: routine.workspaceId,
      computerTarget: routine.computerTarget ? clone(routine.computerTarget) : undefined,
      computerActions: routine.computerActions?.map(({ operation }) => ({ operation })),
      state: routine.state,
      schedule: clone(routine.schedule),
      createdAt: routine.createdAt,
      updatedAt: routine.updatedAt,
      lastRunAt: routine.lastRunAt,
      nextRunAt: routine.nextRunAt,
      lastStatus: routine.lastStatus,
      failureCount: routine.failureCount,
      ...(withHistory ? { history: clone(routine.history) } : {}),
    };
  }
  function trimHistory(routine) { if (routine.history.length > ROUTINE_HISTORY_LIMIT) routine.history.splice(0, routine.history.length - ROUTINE_HISTORY_LIMIT); }

  let changedOnLoad = false;
  const loadStamp = nowIso(now);
  for (const routine of routines) {
    let routineDirty = false;
    for (const run of routine.history) {
      if (run.status === "submitting" && !run.jobId) {
        run.status = "failed";
        run.error = run.error ?? "interrupted before Job creation";
        run.finishedAt = run.finishedAt ?? loadStamp;
        routine.failureCount += 1;
        if (run === routine.history.at(-1)) routine.lastStatus = "failed";
        routineDirty = true;
      }
    }
    if (routine.enabled && !routine.nextRunAt) {
      if (routine.schedule.type === "one-time" && routine.lastRunAt) routine.enabled = false;
      else routine.nextRunAt = initialNextRun(routine.schedule, now());
      routineDirty = true;
    }
    if (routineDirty) {
      routine.updatedAt = loadStamp;
      changedOnLoad = true;
    }
  }
  if (changedOnLoad) save();

  function reconcileHistory() {
    let anyDirty = false;
    for (const routine of routines) {
      let routineDirty = false;
      for (const run of routine.history) {
        if (!run.jobId || TERMINAL_JOB.has(run.status)) continue;
        let job;
        try { job = jobController.getJob(run.jobId); } catch { continue; }
        if (job.status === run.status) continue;
        const previous = run.status;
        run.status = job.status;
        if (TERMINAL_JOB.has(job.status)) run.finishedAt = nowIso(now);
        if (job.status === "failed" && previous !== "failed") routine.failureCount += 1;
        if (job.status === "completed") routine.failureCount = 0;
        if (run === routine.history.at(-1)) routine.lastStatus = job.status;
        routineDirty = true;
      }
      if (routineDirty) {
        routine.updatedAt = nowIso(now);
        anyDirty = true;
      }
    }
    if (anyDirty) save();
  }

  function submitRoutineRun(routine, { scheduledFor, source = "schedule", eventHistory, eventMetadata } = {}) {
    const startedAt = nowIso(now);
    const run = { id: makeHistoryId(), scheduledFor, startedAt, status: "submitting", source };
    if (source === "event") Object.assign(run, eventHistory);
    routine.history.push(run);
    trimHistory(routine);
    routine.lastRunAt = startedAt;
    routine.lastStatus = "submitting";
    if (source === "schedule" && routine.schedule.type === "one-time") {
      routine.enabled = false;
      routine.nextRunAt = undefined;
    } else if (source === "schedule") {
      routine.nextRunAt = nextRoutineOccurrence(routine.schedule, Math.max(Date.parse(scheduledFor), now()));
    }
    routine.updatedAt = startedAt;
    save();

    try {
      validateRefs(routine);
      const job = jobController.submitJob({
        title: routine.name,
        objective: routine.instruction,
        ownerCoworkerId: routine.coworkerId,
        ...(routine.computerTarget ? { computerTarget: routine.computerTarget, computerActions: routine.computerActions } : {}),
        internalContext: {
          routineId: routine.id,
          scheduledFor,
          skillId: routine.skillId,
          teamId: routine.teamId,
          projectId: routine.projectId,
          workspaceId: routine.workspaceId,
          deferSchedule: true,
          ...(eventMetadata ? { eventMetadata } : {}),
        },
      });
      run.jobId = job.id;
      run.status = job.status;
      routine.lastStatus = job.status;
      routine.updatedAt = nowIso(now);
      save();
      return { job, run: clone(run) };
    } catch (error) {
      run.status = "failed";
      run.error = String(error?.message ?? error).slice(0, 500);
      run.finishedAt = nowIso(now);
      routine.lastStatus = "failed";
      routine.failureCount += 1;
      routine.updatedAt = run.finishedAt;
      save();
      return undefined;
    }
  }

  function fireRoutine(routine) {
    if (routine.state !== "active" || !routine.enabled || !routine.nextRunAt || Date.parse(routine.nextRunAt) > now()) return undefined;
    return submitRoutineRun(routine, { scheduledFor: routine.nextRunAt })?.job;
  }

  function runRoutineNow(routineId) {
    const routine = requireRoutine(routineId);
    if (routine.state !== "active" || !routine.enabled) throw new Error("routine is archived or disabled");
    const result = submitRoutineRun(routine, { scheduledFor: nowIso(now), source: "manual" });
    if (!result) throw new Error("Routine Job could not be created");
    return { routine: publicRoutine(routine, true), job: result.job, run: result.run };
  }

  function triggerEvent(routineId, event = {}) {
    exactKeys(event, new Set(["triggerId", "eventId", "relativePath", "eventType", "workspaceId", "observedAt"]), "routine event");
    const routine = requireRoutine(routineId);
    if (!routine.enabled) throw new Error("routine is disabled");
    if (routine.schedule.type === "one-time") throw new Error("one-time routines cannot be event-triggered");
    if (!routine.workspaceId || event.workspaceId !== routine.workspaceId) throw new Error("event workspace does not match routine workspace");
    if (typeof event.triggerId !== "string" || !/^trigger_[a-f0-9]{16}$/i.test(event.triggerId)) throw new Error("triggerId must be a trigger identifier");
    const eventId = event.eventId ?? makeEventId();
    if (typeof eventId !== "string" || !/^event_[a-f0-9]{16}$/i.test(eventId)) throw new Error("eventId must be an event identifier");
    if (!EVENT_TYPES.has(event.eventType)) throw new Error("eventType must be change or rename");
    const relativePath = normalizeEventRelativePath(event.relativePath);
    const observedAt = asIso(event.observedAt ?? nowIso(now), "event.observedAt");
    const eventMetadata = normalizeEventMetadata({
      source: "workspace-file-change",
      triggerId: event.triggerId,
      eventId,
      relativePath,
      observedAt,
    });
    const result = submitRoutineRun(routine, {
      scheduledFor: observedAt,
      source: "event",
      eventMetadata,
      eventHistory: {
        triggerId: eventMetadata.triggerId,
        eventId: eventMetadata.eventId,
        relativePath: eventMetadata.relativePath,
        observedAt: eventMetadata.observedAt,
        eventType: event.eventType,
        workspaceId: event.workspaceId,
      },
    });
    if (!result) throw new Error("event-triggered Routine Job could not be created");
    return result;
  }

  let timer;
  let running = false;
  let tickChain = Promise.resolve();
  function clearTimer() { if (timer) clearTimeout(timer); timer = undefined; }
  function scheduleWake() {
    clearTimer();
    if (!running) return;
    const enabled = routines.filter((r) => r.enabled && r.nextRunAt).map((r) => Date.parse(r.nextRunAt)).filter(Number.isFinite);
    if (!enabled.length) return;
    const earliest = Math.min(...enabled);
    const delay = Math.max(1, Math.min(MAX_TIMER_DELAY_MS, earliest - now()));
    timer = setTimeout(() => { void tickNow(); }, delay);
    if (timer.unref) timer.unref();
  }
  function tickOnce() {
    reconcileHistory();
    const due = routines.filter((r) => r.enabled && r.nextRunAt && Date.parse(r.nextRunAt) <= now()).sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
    for (const routine of due) fireRoutine(routine);
    reconcileHistory();
  }
  async function tickNow() {
    const run = tickChain.then(() => tickOnce());
    tickChain = run.catch(() => {});
    try { await run; } finally { scheduleWake(); }
  }

  return {
    create({ name, coworkerId, teamId, projectId, instruction, skillId, workspaceId, schedule, computerTarget, computerActions } = {}) {
      const cleanName = typeof name === "string" ? name.trim() : "";
      const cleanInstruction = typeof instruction === "string" ? instruction.trim() : "";
      if (!cleanName) throw new Error("routine name is required");
      if (cleanName.length > MAX_NAME) throw new Error(`routine name exceeds ${MAX_NAME} characters`);
      if (!cleanInstruction) throw new Error("routine instruction is required");
      if (cleanInstruction.length > MAX_INSTRUCTION) throw new Error(`routine instruction exceeds ${MAX_INSTRUCTION} characters`);
      if (!coworkerId) throw new Error("routine coworkerId is required");
      const normalizedSchedule = normalizeRoutineSchedule(schedule);
      const refs = { coworkerId: String(coworkerId), teamId: teamId ? String(teamId) : undefined, projectId: projectId ? String(projectId) : undefined, skillId: skillId ? String(skillId) : undefined, workspaceId: workspaceId ? String(workspaceId) : undefined };
      const normalizedComputerTarget = computerTarget === undefined ? undefined : normalizeComputerTarget(computerTarget);
      if (normalizedComputerTarget && refs.workspaceId && refs.workspaceId !== normalizedComputerTarget.workspaceId) throw new Error("Routine Computer target workspace does not match Routine workspace");
      if (normalizedComputerTarget && !computerTargetController) throw new Error("Worker Computer target is unavailable");
      const normalizedComputerActions = normalizedComputerTarget ? computerTargetController.normalizeActions(computerActions) : undefined;
      validateRefs(refs);
      const stamp = nowIso(now);
      const routine = {
        id: makeId(),
        name: cleanName,
        state: "active",
        enabled: true,
        coworkerId: refs.coworkerId,
        teamId: refs.teamId,
        projectId: refs.projectId,
        instruction: cleanInstruction,
        skillId: refs.skillId,
        workspaceId: refs.workspaceId,
        computerTarget: normalizedComputerTarget,
        computerActions: normalizedComputerActions,
        schedule: normalizedSchedule,
        createdAt: stamp,
        updatedAt: stamp,
        lastRunAt: undefined,
        nextRunAt: initialNextRun(normalizedSchedule, now()),
        lastStatus: undefined,
        failureCount: 0,
        history: [],
      };
      if (!/^routine_[a-f0-9]{16}$/i.test(routine.id) || routines.some((entry) => entry.id === routine.id)) throw new Error("routine id factory returned invalid or duplicate id");
      routines.push(routine);
      save();
      scheduleWake();
      return publicRoutine(routine, true);
    },
    list({ includeArchived = false } = {}) { reconcileHistory(); return { schema: ROUTINES_SCHEMA, routines: routines.filter((routine) => includeArchived || routine.state !== "archived").map((routine) => publicRoutine(routine, false)) }; },
    get(routineId) { reconcileHistory(); return publicRoutine(requireRoutine(routineId), true); },
    history(routineId) { reconcileHistory(); const routine = requireRoutine(routineId); return { routineId: routine.id, history: clone(routine.history).reverse() }; },
    triggerEvent,
    setEnabled(routineId, enabled) {
      if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
      const routine = requireRoutine(routineId);
      if (enabled && routine.state === "archived") throw new Error("restore the archived Routine before enabling it");
      if (enabled && routine.schedule.type === "one-time" && routine.lastRunAt) throw new Error("completed one-time routine cannot be re-enabled; create a new routine instead");
      routine.enabled = enabled;
      routine.updatedAt = nowIso(now);
      routine.nextRunAt = enabled ? initialNextRun(routine.schedule, now()) : undefined;
      save();
      scheduleWake();
      return publicRoutine(routine, true);
    },
    remove(routineId) {
      const index = routines.findIndex((entry) => entry.id === String(routineId));
      if (index < 0) throw new Error(`unknown routine id: ${routineId}`);
      const [removed] = routines.splice(index, 1);
      save();
      scheduleWake();
      return publicRoutine(removed, true);
    },
    archive(routineId) {
      const routine = requireRoutine(routineId);
      routine.state = "archived";
      routine.enabled = false;
      routine.nextRunAt = undefined;
      routine.updatedAt = nowIso(now);
      save();
      scheduleWake();
      return publicRoutine(routine, true);
    },
    restore(routineId) {
      const routine = requireRoutine(routineId);
      validateRefs(routine);
      if (routine.schedule.type === "one-time" && routine.lastRunAt) throw new Error("completed one-time routine cannot be restored; create a new routine instead");
      routine.state = "active";
      routine.enabled = true;
      routine.nextRunAt = initialNextRun(routine.schedule, now());
      routine.updatedAt = nowIso(now);
      save();
      scheduleWake();
      return publicRoutine(routine, true);
    },
    retry(routineId, runId) {
      const routine = requireRoutine(routineId);
      if (routine.state !== "active") throw new Error("archived Routine cannot be retried");
      const run = [...routine.history].reverse().find((entry) => !runId || entry.id === String(runId));
      if (!run?.jobId) throw new Error("Routine run has no ordinary Job to retry");
      const job = jobController.getJob(run.jobId);
      if (!job || !["waiting", "needs_attention"].includes(job.status)) throw new Error("Routine Job is not waiting for retry");
      return jobController.resume(run.jobId);
    },
    async tickNow() { await tickNow(); return this.list(); },
    runNow(routineId) { return runRoutineNow(routineId); },
    start() { if (running) return; running = true; scheduleWake(); },
    stop() { running = false; clearTimer(); },
    async flush() { await tickChain; },
  };
}
