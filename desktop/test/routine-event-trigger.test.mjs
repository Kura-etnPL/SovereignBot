import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRoutineController } from "../src/main/routine-controller.js";

function makeHarness(dataDir, submitted, jobStates) {
  let sequence = submitted.length;
  const jobController = {
    submitJob(input) {
      const job = { id: `job_${++sequence}`, status: "queued", ...input };
      submitted.push(job);
      jobStates.set(job.id, job);
      return structuredClone(job);
    },
    getJob(id) {
      const job = jobStates.get(id);
      if (!job) throw new Error(`unknown job ${id}`);
      return structuredClone(job);
    },
  };
  return createRoutineController({
    dataDir,
    jobController,
    coworkerStore: { get(id) { if (id !== "chief") throw new Error("unknown coworker"); return { id }; } },
    skillStore: { requireActive() { return { id: "skill_0123456789abcdef" }; } },
    services: { workspacePath(id) { return id === "workspace.test" ? join(dataDir, "trusted") : undefined; } },
    persistPath: join(dataDir, "desktop-state", "routines.json"),
    now: () => Date.parse("2026-08-30T03:00:00.000Z"),
    makeId: () => "routine_0000000000000001",
    makeHistoryId: (() => { let n = 0; return () => `run_${(++n).toString(16).padStart(16, "0")}`; })(),
    makeEventId: () => "event_0000000000000001",
  });
}

test("event entrypoint creates a normal governed Job without advancing the schedule", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-routine-event-"));
  const submitted = [];
  const jobStates = new Map();
  try {
    let controller = makeHarness(dataDir, submitted, jobStates);
    const routine = controller.create({
      name: "Workspace review",
      coworkerId: "chief",
      instruction: "Review the changed workspace item.",
      workspaceId: "workspace.test",
      schedule: { type: "daily", time: "09:00" },
    });
    const nextRunAt = routine.nextRunAt;
    const result = controller.triggerEvent(routine.id, {
      triggerId: "trigger_0000000000000001",
      eventId: "event_0000000000000001",
      relativePath: "inbox/order.json",
      eventType: "change",
      workspaceId: "workspace.test",
      observedAt: "2026-08-30T03:01:00.000Z",
    });
    assert.equal(submitted.length, 1);
    assert.equal(result.job.id, "job_1");
    assert.equal(submitted[0].internalContext.routineId, routine.id);
    assert.equal(submitted[0].internalContext.workspaceId, "workspace.test");
    assert.equal(submitted[0].internalContext.deferSchedule, true);
    const after = controller.get(routine.id);
    assert.equal(after.nextRunAt, nextRunAt, "event runs must not alter recurring schedule state");
    assert.equal(after.history[0].source, "event");
    assert.equal(after.history[0].triggerId, "trigger_0000000000000001");
    assert.equal(after.history[0].eventId, "event_0000000000000001");
    assert.equal(after.history[0].relativePath, "inbox/order.json");
    assert.equal(after.history[0].workspaceId, "workspace.test");
    assert.equal(after.history[0].jobId, "job_1");

    controller.stop();
    controller = makeHarness(dataDir, submitted, jobStates);
    const restored = controller.history(routine.id).history[0];
    assert.equal(restored.source, "event");
    assert.equal(restored.relativePath, "inbox/order.json");
    assert.equal(restored.jobId, "job_1");

    assert.throws(() => controller.triggerEvent(routine.id, {
      triggerId: "trigger_0000000000000001",
      eventId: "event_0000000000000001",
      relativePath: "../escape.txt",
      eventType: "change",
      workspaceId: "workspace.test",
      observedAt: "2026-08-30T03:02:00.000Z",
    }), /traversal/);
    assert.throws(() => controller.triggerEvent(routine.id, {
      triggerId: "trigger_0000000000000001",
      eventId: "event_0000000000000001",
      relativePath: "inbox/once.json",
      eventType: "change",
      workspaceId: "other.workspace",
      observedAt: "2026-08-30T03:02:00.000Z",
    }), /workspace/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("one-time routines cannot be used as event targets", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-routine-event-once-"));
  try {
    const submitted = [];
    const controller = makeHarness(dataDir, submitted, new Map());
    const routine = controller.create({ name: "One shot", coworkerId: "chief", instruction: "Do once.", workspaceId: "workspace.test", schedule: { type: "one-time", at: "2026-08-30T02:00:00.000Z" } });
    assert.throws(() => controller.triggerEvent(routine.id, {
      triggerId: "trigger_0000000000000001",
      relativePath: "inbox/once.json",
      eventType: "change",
      workspaceId: "workspace.test",
    }), /one-time/);
    assert.equal(submitted.length, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
