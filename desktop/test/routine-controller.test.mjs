import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRoutineController, nextRoutineOccurrence, normalizeRoutineSchedule, ROUTINES_SCHEMA } from "../src/main/routine-controller.js";

function harness(dataDir, clock, submitted, jobStates) {
  let sequence = submitted.length;
  const jobController = {
    submitJob(input) {
      const id = `job_${++sequence}`;
      const job = { id, status: "queued", ...input };
      submitted.push(job);
      jobStates.set(id, job);
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
    coworkerStore: { get(id) { if (id !== "chief") throw new Error("unknown coworker"); return { id, name: "Chief of Staff" }; } },
    skillStore: { requireActive(id) { if (id !== "skill_0123456789abcdef") throw new Error("unknown skill"); return { id, name: "Review" }; } },
    services: { workspacePath(id) { return id === "workspace.one" ? join(dataDir, "workspace") : undefined; } },
    persistPath: join(dataDir, "desktop-state", "routines.json"),
    now: () => clock.value,
    makeId: (() => { let n = 0; return () => `routine_${(++n).toString(16).padStart(16, "0")}`; })(),
    makeHistoryId: (() => { let n = 0; return () => `run_${(++n).toString(16).padStart(16, "0")}`; })(),
  });
}

test("schedule normalization supports only one-time/hourly/daily/weekly", () => {
  assert.deepEqual(normalizeRoutineSchedule({ type: "hourly", minute: 15 }), { type: "hourly", minute: 15 });
  assert.deepEqual(normalizeRoutineSchedule({ type: "daily", time: "09:30" }), { type: "daily", time: "09:30" });
  assert.deepEqual(normalizeRoutineSchedule({ type: "weekly", weekday: 1, time: "08:05" }), { type: "weekly", weekday: 1, time: "08:05" });
  assert.equal(normalizeRoutineSchedule({ type: "one-time", at: "2026-08-29T01:00:00.000Z" }).at, "2026-08-29T01:00:00.000Z");
  assert.throws(() => normalizeRoutineSchedule({ type: "cron", value: "* * * * *" }), /schedule type/);
  assert.throws(() => normalizeRoutineSchedule({ type: "hourly", minute: 60 }), /0-59/);
});

test("next occurrence always advances past the supplied instant", () => {
  const base = new Date(2026, 7, 29, 10, 20, 30, 0).getTime();
  const hourly = new Date(nextRoutineOccurrence({ type: "hourly", minute: 21 }, base));
  assert.ok(hourly.getTime() > base);
  assert.equal(hourly.getMinutes(), 21);
  const daily = new Date(nextRoutineOccurrence({ type: "daily", time: "10:21" }, base));
  assert.ok(daily.getTime() > base);
  assert.equal(daily.getHours(), 10);
  assert.equal(daily.getMinutes(), 21);
  const weekly = new Date(nextRoutineOccurrence({ type: "weekly", weekday: (new Date(base).getDay() + 1) % 7, time: "09:00" }, base));
  assert.ok(weekly.getTime() > base);
});

test("due recurring routine creates exactly one governed Job and restart does not duplicate it", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-routine-"));
  const clock = { value: new Date(2026, 7, 29, 10, 20, 0, 0).getTime() };
  const submitted = [];
  const jobStates = new Map();
  try {
    let controller = harness(dataDir, clock, submitted, jobStates);
    const minute = (new Date(clock.value).getMinutes() + 1) % 60;
    const routine = controller.create({
      name: "Hourly review",
      coworkerId: "chief",
      instruction: "Review the test workspace.",
      skillId: "skill_0123456789abcdef",
      workspaceId: "workspace.one",
      schedule: { type: "hourly", minute },
    });
    assert.equal(controller.list().schema, ROUTINES_SCHEMA);
    assert.ok(Date.parse(routine.nextRunAt) > clock.value);

    clock.value = Date.parse(routine.nextRunAt) + 1000;
    await controller.tickNow();
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].internalContext.routineId, routine.id);
    assert.equal(submitted[0].internalContext.skillId, "skill_0123456789abcdef");
    assert.equal(submitted[0].internalContext.workspaceId, "workspace.one");
    assert.equal(submitted[0].internalContext.deferSchedule, true);
    const afterFire = controller.get(routine.id);
    assert.equal(afterFire.history.length, 1);
    assert.equal(afterFire.history[0].jobId, "job_1");
    assert.ok(Date.parse(afterFire.nextRunAt) > clock.value);

    await controller.tickNow();
    assert.equal(submitted.length, 1, "same occurrence must not fire twice");

    jobStates.get("job_1").status = "completed";
    assert.equal(controller.get(routine.id).history[0].status, "completed", "reads reconcile Job outcome immediately");

    const nextRunAt = controller.get(routine.id).nextRunAt;
    controller.stop();
    controller = harness(dataDir, clock, submitted, jobStates);
    assert.equal(controller.get(routine.id).nextRunAt, nextRunAt);
    await controller.tickNow();
    assert.equal(submitted.length, 1, "restart must not replay the previous occurrence");

    controller.setEnabled(routine.id, false);
    clock.value = Date.parse(nextRunAt) + 24 * 3600_000;
    await controller.tickNow();
    assert.equal(submitted.length, 1, "disabled routine must not fire");
    const enabled = controller.setEnabled(routine.id, true);
    assert.ok(Date.parse(enabled.nextRunAt) > clock.value, "re-enable must schedule a future occurrence");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("long offline gap catches up at most once instead of creating a missed-run storm", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-routine-catchup-"));
  const clock = { value: new Date(2026, 7, 29, 8, 10, 0, 0).getTime() };
  const submitted = [];
  const jobStates = new Map();
  try {
    const controller = harness(dataDir, clock, submitted, jobStates);
    const minute = (new Date(clock.value).getMinutes() + 1) % 60;
    const routine = controller.create({ name: "Hourly catch-up", coworkerId: "chief", instruction: "Check once after wake.", schedule: { type: "hourly", minute } });
    const original = Date.parse(routine.nextRunAt);
    clock.value = original + 8 * 3600_000;
    await controller.tickNow();
    assert.equal(submitted.length, 1, "only one catch-up Job should be created");
    const next = Date.parse(controller.get(routine.id).nextRunAt);
    assert.ok(next > clock.value, "next occurrence must jump to the future after catch-up");
    await controller.tickNow();
    assert.equal(submitted.length, 1, "second immediate tick must not replay missed hours");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("one-time routine fires once, disables itself and stays consumed after restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-routine-once-"));
  const clock = { value: Date.parse("2026-08-29T02:00:00.000Z") };
  const submitted = [];
  const jobStates = new Map();
  try {
    let controller = harness(dataDir, clock, submitted, jobStates);
    const routine = controller.create({ name: "One shot", coworkerId: "chief", instruction: "Do it once.", schedule: { type: "one-time", at: new Date(clock.value - 1000).toISOString() } });
    await controller.tickNow();
    assert.equal(submitted.length, 1);
    assert.equal(controller.get(routine.id).enabled, false);
    assert.equal(controller.get(routine.id).nextRunAt, undefined);
    assert.throws(() => controller.setEnabled(routine.id, true), /cannot be re-enabled/);
    controller = harness(dataDir, clock, submitted, jobStates);
    assert.throws(() => controller.setEnabled(routine.id, true), /cannot be re-enabled/);
    await controller.tickNow();
    assert.equal(submitted.length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
