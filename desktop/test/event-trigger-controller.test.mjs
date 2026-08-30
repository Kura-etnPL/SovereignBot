import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventTriggerController, EVENT_TRIGGERS_SCHEMA } from "../src/main/event-trigger-controller.js";

function fakeTimers(clock) {
  let sequence = 0;
  const timers = new Map();
  return {
    schedule(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, dueAt: clock.value + Math.max(0, delay) });
      return id;
    },
    cancel(id) { timers.delete(id); },
    advance(ms) {
      clock.value += ms;
      let fired;
      do {
        fired = false;
        for (const [id, timer] of [...timers]) {
          if (timer.dueAt > clock.value) continue;
          timers.delete(id);
          timer.callback();
          fired = true;
        }
      } while (fired);
    },
    size() { return timers.size; },
  };
}

function harness(dataDir, calls, { clock = { value: Date.parse("2026-08-30T01:00:00.000Z") }, maxFires, quietMs = 1000, windowMs, routineState } = {}) {
  const root = join(dataDir, "trusted-workspace");
  const timers = fakeTimers(clock);
  const watchers = new Map();
  let triggerSeq = 0;
  const routine = { id: "routine_0000000000000001", name: "Recurring review", enabled: true, workspaceId: "workspace.test", schedule: { type: "hourly", minute: 15 } };
  const routineController = {
    get(id) {
      if (id !== routine.id) throw new Error(`unknown routine ${id}`);
      return structuredClone(routineState ? { ...routine, ...routineState } : routine);
    },
    triggerEvent(id, event) {
      if (id !== routine.id) throw new Error("unexpected routine");
      calls.push(structuredClone(event));
      return { job: { id: `job_${calls.length}`, status: "queued" }, run: { id: `run_${calls.length}` } };
    },
  };
  const controller = createEventTriggerController({
    dataDir,
    routineController,
    services: { workspacePath(id) { return id === routine.workspaceId ? root : undefined; } },
    now: () => clock.value,
    quietMs,
    maxFires,
    windowMs,
    scheduleTimer: timers.schedule,
    cancelTimer: timers.cancel,
    makeId: () => `trigger_${(++triggerSeq).toString(16).padStart(16, "0")}`,
    makeEventId: () => `event_${(calls.length + 1).toString(16).padStart(16, "0")}`,
    watchFactory: (watchRoot, _options, callback) => {
      const entry = { callback, closed: false, emitError(error) { entry.errorHandler?.(error); } };
      watchers.set(watchRoot, entry);
      return {
        on(event, handler) { if (event === "error") entry.errorHandler = handler; },
        close() { entry.closed = true; },
      };
    },
  });
  return { controller, routine, root, watchers, clock, timers };
}

async function fireAndFlush(harnessValue, filename, eventType = "change", elapsed = 1000) {
  const watcher = harnessValue.watchers.get(harnessValue.root);
  assert.ok(watcher, "one watcher should be installed for the trusted workspace");
  watcher.callback(eventType, filename);
  harnessValue.timers.advance(elapsed);
  await harnessValue.controller.flush();
}

test("trailing debounce resets on the final callback and emits one event only after quiet", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-event-trailing-"));
  const calls = [];
  try {
    const value = harness(dataDir, calls, { quietMs: 1000 });
    const trigger = value.controller.create({ name: "Inbox review", routineId: value.routine.id, workspaceId: value.routine.workspaceId, pathPrefix: "./Inbox//" });
    value.controller.start();
    const watcher = value.watchers.get(value.root);

    watcher.callback("change", "INBOX/order.json");
    const beforeQuiet = value.controller.flush();
    await Promise.resolve();
    assert.equal(calls.length, 0, "the first callback must only create pending state");
    value.timers.advance(500);
    watcher.callback("rename", "inbox/order.json");
    value.timers.advance(499);
    assert.equal(calls.length, 0, "a callback inside the quiet window must reset the timer");
    value.timers.advance(501);
    await beforeQuiet;
    assert.equal(calls.length, 1, "only the final quiet expiry may create one event run");
    assert.equal(calls[0].eventType, "rename");
    assert.equal(calls[0].relativePath, "inbox/order.json");
    assert.equal(value.controller.get(trigger.id).lastStatus, "fired");

    watcher.callback("change", "inbox-old/order.json");
    watcher.callback("change", "other/inbox/order.json");
    value.timers.advance(1000);
    await value.controller.flush();
    assert.equal(calls.length, 1, "prefix matching must be segment-aware");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("disable, remove, and stop cancel pending events without creating Jobs", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-event-cancel-"));
  const calls = [];
  try {
    const value = harness(dataDir, calls, { quietMs: 1000 });
    const trigger = value.controller.create({ name: "Cancel me", routineId: value.routine.id, workspaceId: value.routine.workspaceId });
    value.controller.start();
    let watcher = value.watchers.get(value.root);
    watcher.callback("change", "one.json");
    value.controller.setEnabled(trigger.id, false);
    value.timers.advance(2000);
    await value.controller.flush();
    assert.equal(calls.length, 0, "disabled pending event must not create a Job");

    value.controller.setEnabled(trigger.id, true);
    watcher = value.watchers.get(value.root);
    watcher.callback("change", "two.json");
    value.controller.remove(trigger.id);
    value.timers.advance(2000);
    await value.controller.flush();
    assert.equal(calls.length, 0, "removed pending event must not create a Job");

    const second = value.controller.create({ name: "Stop me", routineId: value.routine.id, workspaceId: value.routine.workspaceId });
    watcher = value.watchers.get(value.root);
    watcher.callback("change", "three.json");
    value.controller.stop();
    value.timers.advance(2000);
    await value.controller.flush();
    assert.equal(calls.length, 0, "stopped pending event must not create a Job");
    assert.equal(value.controller.get(second.id).lastStatus, "ready");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("persisted storm accounting survives restart while recentFireAt stays out of public state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-event-storm-restart-"));
  const calls = [];
  try {
    const first = harness(dataDir, calls, { quietMs: 0, maxFires: 2, windowMs: 10_000 });
    const trigger = first.controller.create({ name: "Storm limited", routineId: first.routine.id, workspaceId: first.routine.workspaceId });
    first.controller.start();
    await fireAndFlush(first, "a.json", "change", 0);
    await fireAndFlush(first, "b.json", "change", 0);
    assert.equal(calls.length, 2);
    assert.equal("recentFireAt" in first.controller.get(trigger.id), false, "recentFireAt must not be public");
    first.controller.stop();

    const persisted = JSON.parse(await readFile(join(dataDir, "desktop-state", "event-triggers.json"), "utf8"));
    assert.equal(persisted.triggers[0].recentFireAt.length, 2, "recent fire timestamps must be persisted internally");

    first.clock.value += 100;
    const restarted = harness(dataDir, calls, { clock: first.clock, quietMs: 0, maxFires: 2, windowMs: 10_000 });
    restarted.controller.start();
    await fireAndFlush(restarted, "c.json", "change", 0);
    const state = restarted.controller.get(trigger.id);
    assert.equal(calls.length, 2, "restart storm accounting must block the next event");
    assert.equal(state.enabled, false);
    assert.equal(state.lastStatus, "blocked");
    assert.match(state.lastError, /event storm protection/);
    assert.equal(restarted.watchers.get(restarted.root).closed, true);

    const persistedAfter = JSON.parse(await readFile(join(dataDir, "desktop-state", "event-triggers.json"), "utf8"));
    assert.equal(persistedAfter.triggers[0].recentFireAt.length, 2);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("watcher failure latches all triggers, list/get/reconcile do not reopen, explicit enable rebuilds", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-event-watcher-error-"));
  const calls = [];
  try {
    const value = harness(dataDir, calls, { quietMs: 1000 });
    const trigger = value.controller.create({ name: "Watcher failure", routineId: value.routine.id, workspaceId: value.routine.workspaceId });
    value.controller.start();
    const firstWatcher = value.watchers.get(value.root);
    firstWatcher.callback("change", "pending.json");
    firstWatcher.emitError(new Error("simulated fatal"));
    await value.controller.flush();
    let state = value.controller.get(trigger.id);
    assert.equal(state.enabled, false);
    assert.equal(state.lastStatus, "blocked");
    assert.match(state.lastError, /workspace watcher failed: simulated fatal/);
    assert.equal(state.failureCount, 1);
    const installed = value.watchers.size;
    value.controller.list();
    value.controller.get(trigger.id);
    value.controller.reconcile();
    assert.equal(value.watchers.size, installed, "inspection and reconcile must not reopen a latched watcher");

    value.controller.setEnabled(trigger.id, true);
    assert.equal(value.watchers.size, 1, "explicit enable must rebuild the watcher");
    state = value.controller.get(trigger.id);
    assert.equal(state.enabled, true);
    assert.equal(state.lastStatus, "ready");
    assert.equal(state.lastError, undefined);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("missing workspace, disabled Routine, one-time Routine, and unsafe paths fail closed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-event-blocked-"));
  const calls = [];
  try {
    const state = { workspace: true, routine: true, schedule: { type: "daily", time: "09:00" } };
    const root = join(dataDir, "trusted-workspace");
    const routine = { id: "routine_0000000000000001", enabled: true, workspaceId: "workspace.test", schedule: { type: "daily", time: "09:00" } };
    const watchers = [];
    const controller = createEventTriggerController({
      dataDir,
      routineController: {
        get(id) {
          if (id !== routine.id) throw new Error("unknown routine");
          return { ...routine, enabled: state.routine, schedule: { ...state.schedule } };
        },
        triggerEvent(_id, event) { calls.push(event); return { job: { id: "job_1" } }; },
      },
      services: { workspacePath() { return state.workspace ? root : undefined; } },
      scheduleTimer: (callback) => setTimeout(callback, 0),
      cancelTimer: clearTimeout,
      watchFactory: (_root, _options, callback) => { watchers.push(callback); return { on() {}, close() {} }; },
      quietMs: 0,
      makeId: () => "trigger_0000000000000001",
    });
    const trigger = controller.create({ name: "Fail closed", routineId: routine.id, workspaceId: routine.workspaceId });
    controller.start();
    state.routine = false;
    controller.reconcile();
    assert.equal(controller.get(trigger.id).lastStatus, "blocked");
    state.routine = true;
    state.workspace = false;
    controller.reconcile();
    assert.equal(controller.get(trigger.id).lastStatus, "blocked");
    assert.equal(watchers.length, 1);
    state.workspace = true;
    state.schedule = { type: "one-time", at: "2026-08-30T03:00:00.000Z" };
    assert.throws(() => controller.create({ name: "One time", routineId: routine.id, workspaceId: routine.workspaceId }), /recurring/);
    assert.throws(() => controller.create({ name: "Escape", routineId: routine.id, workspaceId: routine.workspaceId, pathPrefix: "../outside" }), /traversal/);
    assert.throws(() => controller.create({ name: "Absolute", routineId: routine.id, workspaceId: routine.workspaceId, pathPrefix: "C:\\outside" }), /trusted workspace/);
    assert.equal(calls.length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
