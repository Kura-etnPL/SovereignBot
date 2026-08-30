import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventTriggerController, decodeWatcherCallback, deriveWatchDescriptor, EVENT_TRIGGERS_SCHEMA } from "../src/main/event-trigger-controller.js";

function canonicalPathIdentity(value) {
  const resolved = typeof realpathSync.native === "function" ? realpathSync.native(value) : realpathSync(value);
  let normalized = resolved.replaceAll("\\", "/");
  if (normalized.startsWith("//?/")) normalized = normalized.slice(4);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertSameCanonicalPath(actual, expected, message) {
  assert.equal(canonicalPathIdentity(actual), canonicalPathIdentity(expected), message);
}

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
  mkdirSync(join(root, "inbox"), { recursive: true });
  const timers = fakeTimers(clock);
  const watchers = new Map();
  const installations = [];
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
    watchFactory: (watchRoot, options, callback) => {
      const entry = { callback, closed: false, emitError(error) { entry.errorHandler?.(error); } };
      entry.watchRoot = watchRoot;
      entry.options = { ...options };
      installations.push(entry);
      watchers.set(watchRoot, entry);
      return {
        on(event, handler) { if (event === "error") entry.errorHandler = handler; },
        close() { entry.closed = true; },
      };
    },
  });
  return { controller, routine, root, watchers, installations, clock, timers };
}

async function fireAndFlush(harnessValue, filename, eventType = "change", elapsed = 1000) {
  const watcher = [...harnessValue.watchers.values()].find((entry) => !entry.closed);
  assert.ok(watcher, "one active watcher should be installed for the trusted workspace");
  watcher.callback(eventType, filename);
  harnessValue.timers.advance(elapsed);
  await harnessValue.controller.flush();
}

test("trailing debounce resets on the final callback and emits one event only after quiet", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-event-trailing-"));
  const calls = [];
  try {
    const value = harness(dataDir, calls, { quietMs: 1000 });
    writeFileSync(join(value.root, "inbox", "order.json"), "baseline", "utf8");
    const trigger = value.controller.create({ name: "Inbox review", routineId: value.routine.id, workspaceId: value.routine.workspaceId, pathPrefix: "./inbox/order.json//" });
    value.controller.start();
    const diagnostics = value.controller.diagnostics();
    const descriptor = diagnostics.watchers.find((entry) => entry.triggerIds.includes(trigger.id));
    assert.ok(descriptor, "trigger must own a real watcher descriptor");
    assert.equal(descriptor.baseRelative, "inbox");
    assert.equal(descriptor.recursive, false);
    assertSameCanonicalPath(descriptor.watchRoot, join(value.root, "inbox"), "the existing-file watcher must use the canonical inbox parent");
    const watcher = value.watchers.get(descriptor.watchRoot) ?? value.installations.find((entry) => !entry.closed && canonicalPathIdentity(entry.watchRoot) === canonicalPathIdentity(descriptor.watchRoot));
    assert.ok(watcher, "the canonical descriptor must map to an active fake watcher");

    watcher.callback("change", "order.json");
    const beforeQuiet = value.controller.flush();
    await Promise.resolve();
    assert.equal(calls.length, 0, "the first callback must only create pending state");
    value.timers.advance(500);
    watcher.callback("rename", "order.json");
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

test("watch descriptor anchors existing files and decodes every safe callback shape", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-event-callback-shapes-"));
  const calls = [];
  try {
    const value = harness(dataDir, calls, { quietMs: 0 });
    writeFileSync(join(value.root, "inbox", "order.json"), "baseline", "utf8");
    const trigger = { pathPrefix: "inbox/order.json" };
    const descriptor = deriveWatchDescriptor(trigger, value.root);
    assert.equal(descriptor.baseRelative, "inbox");
    assertSameCanonicalPath(descriptor.watchRoot, join(value.root, "inbox"), "8.3 and long-path spellings must resolve to the same watcher anchor");
    assert.equal(descriptor.recursive, false);
    mkdirSync(join(value.root, "inbox", "existing"), { recursive: true });
    const directoryDescriptor = deriveWatchDescriptor({ pathPrefix: "inbox/existing" }, value.root);
    assert.equal(directoryDescriptor.baseRelative, "inbox/existing");
    assert.equal(directoryDescriptor.recursive, true);
    const missingDescriptor = deriveWatchDescriptor({ pathPrefix: "inbox/future/order.json" }, value.root);
    assert.equal(missingDescriptor.baseRelative, "inbox");
    assert.equal(missingDescriptor.recursive, true);
    const options = { pathPrefixes: [trigger.pathPrefix] };

    assert.equal(decodeWatcherCallback(descriptor, "order.json", options).relativePath, "inbox/order.json");
    assert.equal(decodeWatcherCallback(descriptor, "inbox/order.json", options).relativePath, "inbox/order.json");
    assert.equal(decodeWatcherCallback(descriptor, Buffer.from("order.json"), options).relativePath, "inbox/order.json");
    assert.equal(decodeWatcherCallback(descriptor, join(value.root, "inbox", "order.json"), options).relativePath, "inbox/order.json");
    assert.equal(decodeWatcherCallback(descriptor, join(dataDir, "outside.json"), options).relativePath, undefined);
    assert.equal(decodeWatcherCallback(descriptor, null, options).diagnostic.rejectedReason, "filename-unavailable");
    assert.match(decodeWatcherCallback(descriptor, "../escape", options).diagnostic.rejectedReason, /traversal/);
    assert.equal(decodeWatcherCallback(descriptor, "inbox-old/order.json", options).relativePath, undefined);
    assert.equal(decodeWatcherCallback(descriptor, Buffer.from([0xff]), options).relativePath, undefined);

    const ambiguous = decodeWatcherCallback({ ...descriptor, watchRoot: join(value.root, "inbox") }, "inbox/order.json", { pathPrefixes: ["inbox"] });
    assert.equal(ambiguous.relativePath, undefined);
    assert.equal(ambiguous.diagnostic.rejectedReason, "ambiguous-callback");
    if (process.platform === "win32") {
      assert.equal(decodeWatcherCallback(descriptor, "ORDER.JSON", options).relativePath, "inbox/order.json");
    }

    const publicDescriptor = value.controller.create({ name: "Anchored file", routineId: value.routine.id, workspaceId: value.routine.workspaceId, pathPrefix: trigger.pathPrefix });
    value.controller.start();
    const publicDiagnostics = value.controller.diagnostics();
    const publicWatcherDescriptor = publicDiagnostics.watchers.find((entry) => entry.triggerIds.includes(publicDescriptor.id));
    assert.ok(publicWatcherDescriptor, "public trigger must own a real watcher descriptor");
    const watcher = value.watchers.get(publicWatcherDescriptor.watchRoot) ?? value.installations.find((entry) => !entry.closed && canonicalPathIdentity(entry.watchRoot) === canonicalPathIdentity(publicWatcherDescriptor.watchRoot));
    assert.ok(watcher, "the canonical descriptor must map to an active fake watcher");
    watcher.callback("change", "order.json");
    value.timers.advance(0);
    await value.controller.flush();
    const diagnostics = value.controller.diagnostics();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].relativePath, "inbox/order.json");
    assert.equal(diagnostics.watchers[0].acceptedCallbackCount, 1);
    assert.equal(diagnostics.watchers[0].rawSamples[0].acceptedRelativePath, "inbox/order.json");
    assert.equal("rawSamples" in value.controller.get(publicDescriptor.id), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("shared watcher descriptors preserve surviving triggers and isolate different anchors", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-event-shared-watchers-"));
  const calls = [];
  try {
    const value = harness(dataDir, calls, { quietMs: 0 });
    writeFileSync(join(value.root, "inbox", "order.json"), "baseline", "utf8");
    writeFileSync(join(value.root, "inbox", "reports"), "baseline", "utf8");
    const first = value.controller.create({ name: "Order file", routineId: value.routine.id, workspaceId: value.routine.workspaceId, pathPrefix: "inbox/order.json" });
    const second = value.controller.create({ name: "Reports file", routineId: value.routine.id, workspaceId: value.routine.workspaceId, pathPrefix: "inbox/reports" });
    value.controller.start();
    assert.equal(value.installations.length, 1, "same parent anchor should install one shared watcher");
    let diagnostics = value.controller.diagnostics();
    assert.equal(diagnostics.watchers.length, 1);
    assert.deepEqual(new Set(diagnostics.watchers[0].triggerIds), new Set([first.id, second.id]));
    assert.equal(diagnostics.watchers[0].baseRelative, "inbox");
    assert.equal(diagnostics.watchers[0].recursive, false);

    const watcher = value.installations[0];
    watcher.callback("change", "order.json");
    value.timers.advance(0);
    await value.controller.flush();
    watcher.callback("change", "reports");
    value.timers.advance(0);
    await value.controller.flush();
    assert.deepEqual(calls.map((entry) => entry.relativePath), ["inbox/order.json", "inbox/reports"]);

    value.controller.setEnabled(first.id, false);
    diagnostics = value.controller.diagnostics();
    assert.equal(diagnostics.watchers.length, 1, "disabling one trigger must preserve the shared watcher");
    assert.deepEqual(diagnostics.watchers[0].triggerIds, [second.id]);
    watcher.callback("change", "reports");
    value.timers.advance(0);
    await value.controller.flush();
    assert.equal(calls.length, 3);

    const third = value.controller.create({ name: "Exports", routineId: value.routine.id, workspaceId: value.routine.workspaceId, pathPrefix: "exports" });
    diagnostics = value.controller.diagnostics();
    assert.equal(diagnostics.watchers.length, 2, "a different anchor must not reuse the inbox watcher");
    assert.ok(diagnostics.watchers.some((entry) => entry.triggerIds.includes(third.id) && entry.baseRelative === "" && entry.recursive === true));
    value.controller.setEnabled(third.id, false);
    assert.equal(value.controller.diagnostics().watchers.length, 1, "closing one anchor must preserve the other anchor");

    value.controller.remove(second.id);
    assert.equal(value.controller.diagnostics().watchers.length, 0);
    assert.equal(watcher.closed, true, "removing the last trigger closes the shared watcher");
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
    let watcher = [...value.watchers.values()].find((entry) => !entry.closed);
    watcher.callback("change", "one.json");
    value.controller.setEnabled(trigger.id, false);
    value.timers.advance(2000);
    await value.controller.flush();
    assert.equal(calls.length, 0, "disabled pending event must not create a Job");

    value.controller.setEnabled(trigger.id, true);
    watcher = [...value.watchers.values()].find((entry) => !entry.closed);
    watcher.callback("change", "two.json");
    value.controller.remove(trigger.id);
    value.timers.advance(2000);
    await value.controller.flush();
    assert.equal(calls.length, 0, "removed pending event must not create a Job");

    const second = value.controller.create({ name: "Stop me", routineId: value.routine.id, workspaceId: value.routine.workspaceId });
    watcher = [...value.watchers.values()].find((entry) => !entry.closed);
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
    assert.equal(restarted.installations.at(-1)?.closed, true);

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
    const firstWatcher = [...value.watchers.values()].find((entry) => !entry.closed);
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
    mkdirSync(root, { recursive: true });
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
