import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJobController } from "../src/main/job-controller.js";
import { coworkerAgentId } from "../src/main/provider-roster.js";
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
    assert.deepEqual(submitted[0].internalContext.eventMetadata, {
      source: "workspace-file-change",
      triggerId: "trigger_0000000000000001",
      eventId: "event_0000000000000001",
      relativePath: "inbox/order.json",
      observedAt: "2026-08-30T03:01:00.000Z",
    });
    const after = controller.get(routine.id);
    assert.equal(after.nextRunAt, nextRunAt, "event runs must not alter recurring schedule state");
    assert.equal(after.history[0].source, "event");
    assert.equal(after.history[0].triggerId, "trigger_0000000000000001");
    assert.equal(after.history[0].eventId, "event_0000000000000001");
    assert.equal(after.history[0].relativePath, "inbox/order.json");
    assert.equal(after.history[0].workspaceId, "workspace.test");
    assert.equal(after.history[0].eventType, "change");
    assert.equal(after.history[0].observedAt, "2026-08-30T03:01:00.000Z");
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

test("event metadata reaches the model-facing delegated instruction without changing the Job objective", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-routine-event-job-"));
  const coworkerId = "coworker_0000000000000001";
  const root = join(dataDir, "trusted");
  const tasks = [];
  let planNumber = 0;
  let taskNumber = 0;
  try {
    const runtime = {
      orchestrator: {
        async createPlan(input) { return { id: `plan_${++planNumber}`, ...input }; },
        async delegateTrusted(planId, spec, executionContext, supervisorId) {
          const task = { id: `task_${++taskNumber}`, planId, status: "queued", input: spec.input, executionContext, supervisorId };
          tasks.push(task);
          return structuredClone(task);
        },
        async runUntilIdle() {
          for (const task of tasks) if (task.status === "queued") { task.status = "completed"; task.result = { text: "done" }; }
        },
        async listTasks() { return structuredClone(tasks); },
        async aggregatePlan(planId) { return { planId, status: "completed" }; },
      },
    };
    const workspaceServices = { workspacePath(id) { return id === "workspace.test" ? root : undefined; } };
    const roster = () => ({
      ready: true,
      mode: "provider",
      roles: { planner: "test-supervisor" },
      coworkerBindings: { [coworkerId]: { ready: true, agentId: coworkerAgentId(coworkerId), provider: "fake" } },
    });
    const jobs = createJobController({
      dataDir,
      runtime,
      roster,
      coworkerStore: { get(id) { if (id !== coworkerId) throw new Error("unknown coworker"); return { id, name: "Chief", workspaceIds: ["workspace.test"] }; } },
      services: workspaceServices,
      supervisorAgentId: "test-supervisor",
      readiness: () => ({ allowed: true }),
    });
    const routines = createRoutineController({
      dataDir,
      jobController: jobs,
      coworkerStore: { get(id) { if (id !== coworkerId) throw new Error("unknown coworker"); return { id }; } },
      services: workspaceServices,
      now: () => Date.parse("2026-08-30T04:00:00.000Z"),
      makeId: () => "routine_0000000000000001",
      makeHistoryId: () => "run_0000000000000001",
      makeEventId: () => "event_0000000000000001",
    });
    const routine = routines.create({
      name: "Workspace review",
      coworkerId,
      instruction: "Review the changed workspace item.",
      workspaceId: "workspace.test",
      schedule: { type: "daily", time: "09:00" },
    });
    const result = routines.triggerEvent(routine.id, {
      triggerId: "trigger_0000000000000001",
      eventId: "event_0000000000000001",
      relativePath: "inbox/order.json",
      eventType: "change",
      workspaceId: "workspace.test",
      observedAt: "2026-08-30T04:01:00.000Z",
    });
    assert.equal(result.job.objective, "Review the changed workspace item.");
    assert.equal("eventMetadata" in result.job, false, "public Job projection must omit event metadata");
    await jobs.wakeDueJobs();
    await jobs.flush();
    assert.equal(tasks.length, 1);
    const delegated = tasks[0].input.instruction;
    assert.match(delegated, /<untrusted_event_data>/);
    assert.match(delegated, /workspace-file-change/);
    assert.match(delegated, /inbox\/order\.json/);
    assert.doesNotMatch(delegated, /V44_FILE_BODY_MUST_NEVER_REACH_PROVIDER/);
    assert.doesNotMatch(delegated, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(routines.history(routine.id).history[0].source, "event");

    const normal = jobs.submitJob({ title: "Normal scheduled job", objective: "Run the normal scheduled path.", ownerCoworkerId: coworkerId });
    await jobs.flush();
    const normalTask = tasks.find((task) => task.input?.jobId === normal.id);
    assert.ok(normalTask);
    assert.doesNotMatch(normalTask.input.instruction, /<untrusted_event_data>/);

    const persisted = JSON.parse(await readFile(join(dataDir, "desktop-state", "jobs.json"), "utf8"));
    persisted.jobs.push({
      id: "job_0000000000000002",
      status: "completed",
      eventMetadata: {
        source: "workspace-file-change",
        triggerId: "trigger_0000000000000001",
        eventId: "event_0000000000000001",
        relativePath: "inbox/order.json",
        observedAt: "2026-08-30T04:01:00.000Z",
      },
    });
    await writeFile(join(dataDir, "desktop-state", "jobs.json"), `${JSON.stringify(persisted)}\n`, "utf8");
    const reloadedJobs = createJobController({
      dataDir,
      runtime,
      roster,
      coworkerStore: { get(id) { if (id !== coworkerId) throw new Error("unknown coworker"); return { id, name: "Chief", workspaceIds: ["workspace.test"] }; } },
      services: workspaceServices,
      supervisorAgentId: "test-supervisor",
      readiness: () => ({ allowed: true }),
    });
    assert.equal("eventMetadata" in reloadedJobs.getJob("job_0000000000000002"), false, "orphaned persisted event metadata must fail closed");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
