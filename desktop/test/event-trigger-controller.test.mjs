import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventTriggerController, EVENT_TRIGGERS_SCHEMA } from "../src/main/event-trigger-controller.js";

function harness(dataDir, calls, { now = () => Date.now(), maxFires, quietMs } = {}) {
  const root = join(dataDir, "trusted-workspace");
  const watchers = new Map();
  let triggerSeq = 0;
  const routine = { id: "routine_0000000000000001", name: "Recurring review", enabled: true, workspaceId: "workspace.test", schedule: { type: "hourly", minute: 15 } };
  const routineController = {
    get(id) { if (id !== routine.id) throw new Error(`unknown routine ${id}`); return structuredClone(routine); },
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
    now,
    quietMs,
    maxFires,
    makeId: () => `trigger_${(++triggerSeq).toString(16).padStart(16, "0")}`,
    makeEventId: () => `event_${(calls.length + 1).toString(16).padStart(16, "0")}`,
    watchFactory: (watchRoot, _options, callback) => {
      const entry = { callback, closed: false };
      watchers.set(watchRoot, entry);
      return { on() {}, close() { entry.closed = true; } };
    },
  });
  return { controller, routine, root, watchers };
}

test("trusted workspace event callbacks coalesce, match prefixes, and persist metadata", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-event-trigger-"));
  const calls = [];
  try {
    const clock = { value: Date.parse("2026-08-30T01:00:00.000Z") };
    const first = harness(dataDir, calls, { now: () => clock.value, quietMs: 1000 });
    const trigger = first.controller.create({ name: "Inbox review", routineId: first.routine.id, workspaceId: first.routine.workspaceId, pathPrefix: "inbox" });
    assert.equal(first.controller.list().schema, EVENT_TRIGGERS_SCHEMA);
    first.controller.start();
    const watcher = first.watchers.get(first.root);
    assert.ok(watcher, "one watcher should be installed for the trusted workspace");

    watcher.callback("change", "inbox/order.json");
    watcher.callback("rename", "inbox/order.json");
    watcher.callback("change", "outside/order.json");
    await first.controller.flush();
    assert.equal(calls.length, 1, "duplicate callbacks for one path must create one event run");
    assert.equal(calls[0].relativePath, "inbox/order.json");
    assert.equal(calls[0].workspaceId, first.routine.workspaceId);
    assert.equal(first.controller.get(trigger.id).lastStatus, "fired");
    assert.equal(first.controller.get(trigger.id).lastRelativePath, "inbox/order.json");

    first.controller.stop();
    const restarted = harness(dataDir, calls, { now: () => clock.value, quietMs: 1000 });
    restarted.controller.start();
    assert.equal(calls.length, 1, "restart must not replay the previous event");
    const restoredWatcher = restarted.watchers.get(restarted.root);
    clock.value += 2000;
    restoredWatcher.callback("change", "inbox/next.json");
    await restarted.controller.flush();
    assert.equal(calls.length, 2, "a future filesystem event should resume after restart");

    assert.throws(() => restarted.controller.create({ name: "Escape", routineId: restarted.routine.id, workspaceId: restarted.routine.workspaceId, pathPrefix: "../outside" }), /traversal/);
    assert.throws(() => restarted.controller.create({ name: "Absolute", routineId: restarted.routine.id, workspaceId: restarted.routine.workspaceId, pathPrefix: "C:\\outside" }), /trusted workspace/);
    assert.throws(() => restarted.controller.create({ name: "Whole", routineId: "routine_0000000000000002", workspaceId: restarted.routine.workspaceId }), /unknown routine/);

    restarted.controller.setEnabled(trigger.id, false);
    clock.value += 2000;
    restoredWatcher.callback("change", "inbox/disabled.json");
    await restarted.controller.flush();
    assert.equal(calls.length, 2, "disabled triggers must not create Jobs");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("event storm protection bounds accepted fires and disables the trigger", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-event-storm-"));
  const calls = [];
  try {
    let clock = Date.parse("2026-08-30T02:00:00.000Z");
    const { controller, routine, root, watchers } = harness(dataDir, calls, { now: () => clock, quietMs: 0, maxFires: 3, windowMs: 10_000 });
    const trigger = controller.create({ name: "Storm limited", routineId: routine.id, workspaceId: routine.workspaceId, pathPrefix: "inbox" });
    controller.start();
    const watcher = watchers.get(root);
    for (const filename of ["inbox/a.json", "inbox/b.json", "inbox/c.json", "inbox/d.json"]) {
      watcher.callback("change", filename);
      clock += 100;
    }
    await controller.flush();
    const state = controller.get(trigger.id);
    assert.equal(calls.length, 3, "the bounded threshold permits only the configured number of fires");
    assert.equal(state.enabled, false);
    assert.equal(state.lastStatus, "blocked");
    assert.match(state.lastError, /event storm protection/);
    assert.equal(watcher.closed, true, "storm protection must close the workspace watcher");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("missing workspace, disabled Routine, and one-time Routine fail closed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-event-blocked-"));
  const calls = [];
  try {
    const state = { workspace: true, routine: true, schedule: { type: "daily", time: "09:00" } };
    const root = join(dataDir, "trusted-workspace");
    const routine = { id: "routine_0000000000000001", enabled: true, workspaceId: "workspace.test", schedule: { type: "daily", time: "09:00" } };
    const routineController = {
      get(id) {
        if (id !== routine.id) throw new Error("unknown routine");
        return { ...routine, enabled: state.routine, schedule: { ...state.schedule } };
      },
      triggerEvent(_id, event) { calls.push(event); return { job: { id: "job_1", status: "queued" } }; },
    };
    const watchers = [];
    const controller = createEventTriggerController({
      dataDir,
      routineController,
      services: { workspacePath() { return state.workspace ? root : undefined; } },
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
    assert.equal(calls.length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
