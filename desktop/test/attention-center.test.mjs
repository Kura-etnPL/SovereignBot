import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJobController, JOBS_SCHEMA } from "../src/main/job-controller.js";
import { coworkerAgentId } from "../src/main/provider-roster.js";

const chiefId = "coworker_0000000000000001";

function seedJob({ id, title, status, priority = "normal", routineId, attentionState, updatedAt, createdAt = "2026-08-30T00:00:00.000Z" }) {
  return {
    id,
    title,
    objective: `Objective for ${title}`,
    ownerCoworkerId: chiefId,
    status,
    priority,
    workspaceId: undefined,
    requestedWorkspaceId: undefined,
    routineId,
    skillId: undefined,
    scheduledFor: undefined,
    conversationId: `job-conv-${id}`,
    planId: undefined,
    taskIds: [],
    parentJobId: undefined,
    childJobIds: [],
    attempt: 0,
    nextActionAt: undefined,
    attentionState,
    outcomeSummary: undefined,
    error: status === "failed" ? "seed failure" : undefined,
    createdAt,
    updatedAt: updatedAt ?? createdAt,
    conversation: { messages: [{ at: createdAt, role: "system", kind: "seed", text: `seed ${id}` }] },
  };
}

function runtimeHarness() {
  let planNumber = 0;
  let taskNumber = 0;
  const tasks = [];
  return {
    tasks,
    runtime: {
      orchestrator: {
        async createPlan(input) { return { id: `plan_${++planNumber}`, ...input }; },
        async delegateTrusted(planId, spec, executionContext, supervisorId) {
          const task = { id: `task_${++taskNumber}`, planId, status: "queued", input: spec.input, executionContext, supervisorId };
          tasks.push(task);
          return structuredClone(task);
        },
        async runUntilIdle() {
          for (const task of tasks) {
            if (task.status === "queued") { task.status = "completed"; task.result = { text: `Completed ${task.id}` }; }
          }
        },
        async listTasks() { return structuredClone(tasks); },
        async aggregatePlan(planId) { return { planId, status: "completed" }; },
        async cancel(taskId) { const task = tasks.find((entry) => entry.id === taskId); if (task) task.status = "cancelled"; },
      },
    },
  };
}

async function createHarness(dataDir, clock) {
  const persistPath = join(dataDir, "desktop-state", "jobs.json");
  const coworkerStore = { get(id) { if (id !== chiefId) throw new Error(`unknown coworker ${id}`); return { id, name: "Chief of Staff", workspaceIds: [] }; } };
  const runtime = runtimeHarness();
  const roster = () => ({
    ready: true,
    mode: "provider",
    roles: { planner: "test-supervisor" },
    coworkerBindings: { [chiefId]: { ready: true, agentId: coworkerAgentId(chiefId), provider: "fake" } },
  });
  const controller = createJobController({
    dataDir,
    runtime: runtime.runtime,
    roster,
    coworkerStore,
    services: { workspacePath() { return undefined; } },
    supervisorAgentId: "test-supervisor",
    now: () => clock.value,
    persistPath,
  });
  return { controller, runtime, persistPath };
}

test("Attention projection survives restart, sorts deterministically, and records operator decisions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-attention-"));
  const clock = { value: "2026-08-30T12:00:00.000Z" };
  const jobs = [
    seedJob({ id: "job-high", title: "High routine attention", status: "needs_attention", priority: "high", routineId: "routine_1", attentionState: { reason: "high reason", at: "2026-08-30T11:00:00.000Z" } }),
    seedJob({ id: "job-normal-old", title: "Normal old attention", status: "needs_attention", priority: "normal", attentionState: { reason: "old reason", at: "2026-08-30T09:00:00.000Z" } }),
    seedJob({ id: "job-normal-fallback", title: "Normal fallback attention", status: "needs_attention", priority: "normal", attentionState: { reason: "fallback reason" }, updatedAt: "2026-08-30T08:00:00.000Z" }),
    seedJob({ id: "job-completed", title: "Completed job", status: "completed" }),
    seedJob({ id: "job-queued", title: "Queued at restart", status: "queued" }),
    seedJob({ id: "job-working", title: "Working at restart", status: "working" }),
    seedJob({ id: "job-waiting", title: "Waiting at restart", status: "waiting" }),
  ];
  const persistPath = join(dataDir, "desktop-state", "jobs.json");
  await mkdir(join(dataDir, "desktop-state"), { recursive: true });
  await writeFile(persistPath, `${JSON.stringify({ schema: JOBS_SCHEMA, jobs }, null, 2)}\n`, "utf8");
  try {
    let { controller, runtime } = await createHarness(dataDir, clock);
    assert.deepEqual(controller.attentionJobs().jobs.map((job) => job.id), ["job-high", "job-normal-fallback", "job-normal-old"]);
    assert.equal(controller.getJob("job-queued").status, "failed");
    assert.equal(controller.getJob("job-working").status, "failed");
    assert.equal(controller.getJob("job-waiting").status, "failed");
    assert.equal(controller.getJob("job-completed").status, "completed");

    await controller.approve("job-high");
    await controller.flush();
    assert.equal(controller.getJob("job-high").status, "completed", JSON.stringify(controller.getJob("job-high")));
    assert.equal(runtime.tasks.length, 1);
    assert.equal(controller.attentionJobs().jobs.map((job) => job.id).includes("job-high"), false);
    const retriedConversation = controller.getConversation("job-high");
    assert.ok(retriedConversation.messages.some((message) => message.text === "Attention retried by operator."));

    await controller.dismiss("job-normal-fallback");
    assert.equal(controller.getJob("job-normal-fallback").status, "failed");
    assert.deepEqual(controller.attentionJobs().jobs.map((job) => job.id), ["job-normal-old"]);
    const dismissed = controller.getJob("job-normal-fallback");
    assert.ok(dismissed.attentionState.dismissedAt);
    const dismissedConversation = controller.getConversation("job-normal-fallback");
    assert.ok(dismissedConversation.messages.some((message) => message.text === "Attention dismissed by operator."));

    ({ controller } = await createHarness(dataDir, clock));
    assert.deepEqual(controller.attentionJobs().jobs.map((job) => job.id), ["job-normal-old"]);
    assert.equal(controller.getJob("job-high").status, "completed");
    assert.equal(controller.getJob("job-normal-fallback").status, "failed");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
