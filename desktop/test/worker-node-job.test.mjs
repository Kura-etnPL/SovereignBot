import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJobController } from "../src/main/job-controller.js";
import { coworkerAgentId } from "../src/main/provider-roster.js";

const COWORKER_ID = "coworker_0123456789abcdef";
const NODE_ID = "worker_0123456789abcdef";
const WORKSPACE_ID = "workspace.node";

function makeHarness(dataDir, { resolveDispatchTarget, runUntilIdle, cancelRemote } = {}) {
    const plans = [];
    const delegated = [];
    const tasks = [];
    let taskSequence = 0;
    let jobSequence = 0;
    const remoteTaskId = "task_0123456789abcdef";
    const workerNodeStore = {
        resolveDispatchTarget: resolveDispatchTarget ?? (() => ({
            node: { nodeId: NODE_ID, name: "Local Worker" },
            workspace: { id: WORKSPACE_ID, name: "Node Workspace" },
            client: {},
        })),
        async cancel(nodeId, taskId) {
            delegated.push({ cancel: { nodeId, taskId } });
            if (cancelRemote) return cancelRemote(nodeId, taskId);
            return { remoteTaskId: taskId, status: "cancelled", confirmed: true };
        },
    };
    const runtime = {
        orchestrator: {
            async createPlan(input) {
                const plan = { id: `plan_${plans.length + 1}`, ...input };
                plans.push(plan);
                return plan;
            },
            async delegateTrusted(planId, spec, executionContext, supervisorId) {
                const task = { id: `task_${String(++taskSequence).padStart(16, "0")}`, planId, spec, executionContext, supervisorId, status: "queued" };
                delegated.push(structuredClone(task));
                tasks.push(task);
                return structuredClone(task);
            },
            async runUntilIdle() {
                if (runUntilIdle) return runUntilIdle(tasks);
                for (const task of tasks) {
                    if (task.status !== "queued") continue;
                    task.status = "completed";
                    task.result = { text: "remote Worker Node completed" };
                    task.harnessState = { remoteTaskId, status: "completed" };
                }
            },
            async listTasks() { return structuredClone(tasks); },
            async aggregatePlan(planId) { return { planId, status: "completed" }; },
            async cancel(taskId) {
                const task = tasks.find((entry) => entry.id === taskId);
                if (task) task.status = "cancelled";
            },
        },
    };
    const coworkerStore = {
        get(id) {
            if (id !== COWORKER_ID) throw new Error(`unknown coworker: ${id}`);
            return { id, name: "Operator", workspaceIds: [] };
        },
    };
    const roster = () => ({
        ready: true,
        mode: "provider",
        roles: { planner: "local-planner" },
        coworkerBindings: { [COWORKER_ID]: { ready: true, agentId: coworkerAgentId(COWORKER_ID) } },
    });
    const services = { workspacePath() { throw new Error("local workspace path must not be consulted for a Worker Node Job"); } };
    const jobs = createJobController({
        dataDir,
        runtime,
        roster,
        coworkerStore,
        services,
        workerNodeStore,
        supervisorAgentId: "local-planner",
        makeId: () => `job_${String(++jobSequence).padStart(16, "0")}`,
        makeRequestId: () => "worker_request_0123456789abcdef",
        readiness: () => ({ allowed: true }),
    });
    return { jobs, plans, delegated, tasks, workerNodeStore };
}

test("manual Worker Node Job uses the typed remote context and never falls back locally", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-worker-job-"));
    try {
        const harness = makeHarness(dataDir);
        const submitted = harness.jobs.submitJob({
            title: "Remote review",
            objective: "Review the bounded Worker Node task.",
            ownerCoworkerId: COWORKER_ID,
            executionTarget: { kind: "worker-node", nodeId: NODE_ID, workspaceId: WORKSPACE_ID },
        });
        await harness.jobs.flush();

        const job = harness.jobs.getJob(submitted.id);
        assert.equal(job.status, "completed");
        assert.deepEqual(job.executionTarget, { kind: "worker-node", nodeId: NODE_ID, workspaceId: WORKSPACE_ID });
        assert.equal(job.workerNodeName, "Local Worker");
        assert.equal(job.workerWorkspaceName, "Node Workspace");
        assert.ok(!Object.hasOwn(job, "requestId"));
        assert.ok(!Object.hasOwn(job, "remoteTaskId"));
        assert.equal(harness.plans.length, 1);
        assert.equal(harness.delegated.length, 1);
        const delegation = harness.delegated[0];
        assert.deepEqual(delegation.executionContext, { kind: "worker-node", nodeId: NODE_ID, workspaceId: WORKSPACE_ID });
        assert.ok(!Object.hasOwn(delegation.executionContext, "cwd"));
        assert.equal(delegation.spec.preferredAgentId, "worker-node-dispatcher");
        assert.deepEqual(delegation.spec.requiredCapabilities, ["worker-node"]);
        assert.equal(delegation.spec.input.jobId, submitted.id);
        assert.equal(delegation.spec.input.requestId, "worker_request_0123456789abcdef");
        assert.deepEqual(delegation.spec.input.requiredCapabilities, ["general"]);
        assert.ok(!Object.hasOwn(delegation.spec.input, "cwd"));
        assert.ok(!Object.hasOwn(delegation.spec.input, "endpoint"));
        assert.ok(!Object.hasOwn(delegation.spec.input, "token"));
    }
    finally {
        await rm(dataDir, { recursive: true, force: true });
    }
});

test("unavailable Worker Node Job becomes attention and performs no local fallback", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-worker-job-unavailable-"));
    try {
        const harness = makeHarness(dataDir, { resolveDispatchTarget() { throw new Error("selected Worker Node is unavailable or disabled"); } });
        const submitted = harness.jobs.submitJob({
            title: "Unavailable remote review",
            objective: "Do not execute locally.",
            ownerCoworkerId: COWORKER_ID,
            executionTarget: { kind: "worker-node", nodeId: NODE_ID, workspaceId: WORKSPACE_ID },
        });
        await harness.jobs.flush();
        const job = harness.jobs.getJob(submitted.id);
        assert.equal(job.status, "needs_attention");
        assert.match(job.error, /unavailable/);
        assert.equal(harness.plans.length, 0);
        assert.equal(harness.tasks.length, 0);
    }
    finally {
        await rm(dataDir, { recursive: true, force: true });
    }
});

test("cancelling a running Worker Node Job cannot be overwritten by the pump", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-worker-job-cancel-race-"));
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    let release;
    const releasePromise = new Promise((resolve) => { release = resolve; });
    try {
        const harness = makeHarness(dataDir, {
            runUntilIdle: async (tasks) => {
                const task = tasks[0];
                task.status = "working";
                task.harnessState = { remoteTaskId: "task_0123456789abcdef", status: "running" };
                started();
                await releasePromise;
            },
        });
        const submitted = harness.jobs.submitJob({
            title: "Cancel remote review",
            objective: "Cancel this running Worker Node task.",
            ownerCoworkerId: COWORKER_ID,
            executionTarget: { kind: "worker-node", nodeId: NODE_ID, workspaceId: WORKSPACE_ID },
        });
        await startedPromise;
        const cancelled = await harness.jobs.cancel(submitted.id);
        assert.equal(cancelled.status, "cancelled");
        release();
        await harness.jobs.flush();
        assert.equal(harness.jobs.getJob(submitted.id).status, "cancelled");
    }
    finally {
        release?.();
        await rm(dataDir, { recursive: true, force: true });
    }
});

test("unconfirmed Worker Node cancellation becomes attention and does not claim cancelled", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-worker-job-cancel-unconfirmed-"));
    try {
        const harness = makeHarness(dataDir, {
            runUntilIdle: async (tasks) => {
                const task = tasks[0];
                task.status = "working";
                task.harnessState = { remoteTaskId: "task_0123456789abcdef", status: "running" };
            },
            cancelRemote: async () => ({ remoteTaskId: "task_0123456789abcdef", status: "running", confirmed: false }),
        });
        const submitted = harness.jobs.submitJob({
            title: "Cancel confirmation required",
            objective: "The remote cancellation must be confirmed before local terminal state.",
            ownerCoworkerId: COWORKER_ID,
            executionTarget: { kind: "worker-node", nodeId: NODE_ID, workspaceId: WORKSPACE_ID },
        });
        await harness.jobs.flush();

        const result = await harness.jobs.cancel(submitted.id);
        assert.equal(result.status, "needs_attention");
        assert.equal(harness.jobs.getJob(submitted.id).status, "needs_attention");
        assert.match(result.error, /unconfirmed/);
        assert.equal(harness.tasks[0].status, "working");
    }
    finally {
        await rm(dataDir, { recursive: true, force: true });
    }
});
