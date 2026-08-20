import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";

function config(dataDir, workerDelayMs = 0) {
    return {
        dataDir,
        agents: [
            {
                id: "supervisor",
                name: "Supervisor",
                role: "supervisor",
                capabilities: ["planning", "review", "research", "writing"],
                harness: { kind: "echo" },
            },
            {
                id: "researcher",
                name: "Researcher",
                role: "worker",
                capabilities: ["research"],
                harness: { kind: "echo", delayMs: workerDelayMs },
            },
            {
                id: "writer",
                name: "Writer",
                role: "worker",
                capabilities: ["writing"],
                harness: { kind: "echo", delayMs: workerDelayMs },
            },
            {
                id: "reviewer",
                name: "Reviewer",
                role: "reviewer",
                capabilities: ["review"],
                harness: { kind: "echo" },
            },
        ],
        policy: {
            rules: [
                { id: "allow-echo", effect: "allow", match: { category: "harness", targetGlob: "echo" } },
            ],
        },
    };
}

async function newRuntime(workerDelayMs = 0) {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-graph-"));
    return { dataDir, runtime: await createRuntime(config(dataDir, workerDelayMs)) };
}

async function taskById(runtime, id) {
    return (await runtime.orchestrator.listTasks()).find((task) => task.id === id);
}

async function waitForStatus(runtime, taskId, status, attempts = 100) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const task = await taskById(runtime, taskId);
        if (task?.status === status)
            return task;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`task ${taskId} did not reach ${status}`);
}

test("supervisor plan delegates dependency-ordered work and aggregates success", async () => {
    const { runtime } = await newRuntime();
    const plan = await runtime.orchestrator.createPlan({
        title: "Produce brief",
        ownerAgentId: "supervisor",
    });
    const research = await runtime.orchestrator.delegate(
        plan.id,
        {
            title: "Research",
            requiredCapabilities: ["research"],
            preferredAgentId: "researcher",
        },
        "supervisor",
    );
    const writing = await runtime.orchestrator.delegate(
        plan.id,
        {
            title: "Write",
            requiredCapabilities: ["writing"],
            preferredAgentId: "writer",
            dependencyIds: [research.id],
        },
        "supervisor",
    );

    const results = await runtime.orchestrator.runUntilIdle();
    assert.deepEqual(results.map((task) => task.id), [research.id, writing.id]);
    assert.equal(results.every((task) => task.status === "completed"), true);
    assert.equal(results.some((task) => task.assignedAgentId === "supervisor"), false);

    const aggregated = await runtime.orchestrator.aggregatePlan(plan.id, "supervisor");
    assert.equal(aggregated.status, "completed");
    assert.equal(aggregated.result.outcome, "success");

    const graph = await runtime.orchestrator.getTaskGraph(plan.id);
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.edges.filter((edge) => edge.type === "parent").length, 2);
    assert.equal(graph.edges.filter((edge) => edge.type === "dependency").length, 1);
});

test("a task with no compatible worker is explicitly blocked and yields partial plan failure", async () => {
    const { runtime } = await newRuntime();
    const plan = await runtime.orchestrator.createPlan({ title: "Impossible plan", ownerAgentId: "supervisor" });
    const child = await runtime.orchestrator.delegate(
        plan.id,
        { title: "Need specialist", requiredCapabilities: ["nonexistent-specialty"] },
        "supervisor",
    );

    const blocked = await runtime.orchestrator.runNext();
    assert.equal(blocked.id, child.id);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.error, /no compatible worker/);

    const aggregated = await runtime.orchestrator.aggregatePlan(plan.id, "supervisor");
    assert.equal(aggregated.status, "failed");
    assert.equal(aggregated.result.outcome, "partial_failure");
    assert.equal(aggregated.result.statusCounts.blocked, 1);
});

test("failed dependency blocks downstream work before any harness is launched", async () => {
    const { runtime } = await newRuntime();
    const plan = await runtime.orchestrator.createPlan({ title: "Dependency plan", ownerAgentId: "supervisor" });
    const impossible = await runtime.orchestrator.delegate(
        plan.id,
        { title: "Unavailable", requiredCapabilities: ["missing"] },
        "supervisor",
    );
    const downstream = await runtime.orchestrator.delegate(
        plan.id,
        {
            title: "Downstream",
            requiredCapabilities: ["writing"],
            dependencyIds: [impossible.id],
        },
        "supervisor",
    );

    assert.equal((await runtime.orchestrator.runNext()).status, "blocked");
    const second = await runtime.orchestrator.runNext();
    assert.equal(second.id, downstream.id);
    assert.equal(second.status, "blocked");
    assert.match(second.error, /dependency .* ended as blocked/);
});

test("progress events are idempotent and survive a runtime restart", async () => {
    const { dataDir, runtime } = await newRuntime(5_000);
    const task = await runtime.orchestrator.submit({
        title: "Long research",
        requiredCapabilities: ["research"],
        preferredAgentId: "researcher",
    });
    const running = runtime.orchestrator.runNext();
    await waitForStatus(runtime, task.id, "running");

    const first = await runtime.orchestrator.reportProgress(
        task.id,
        { eventId: "progress-1", percent: 40, message: "collecting sources" },
        "researcher",
    );
    const duplicate = await runtime.orchestrator.reportProgress(
        task.id,
        { eventId: "progress-1", percent: 90, message: "this duplicate must not overwrite state" },
        "researcher",
    );
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await taskById(runtime, task.id)).progress.percent, 40);

    await runtime.orchestrator.cancel(task.id);
    await running;

    const restarted = await createRuntime(config(dataDir, 0));
    const events = await restarted.orchestrator.listTaskEvents(task.id);
    assert.equal(events.filter((event) => event.id === "progress-1").length, 1);
    assert.equal((await taskById(restarted, task.id)).progress.message, "collecting sources");
});

test("cancelling a plan propagates to a running child and queued descendants", async () => {
    const { runtime } = await newRuntime(5_000);
    const plan = await runtime.orchestrator.createPlan({ title: "Cancel plan", ownerAgentId: "supervisor" });
    const first = await runtime.orchestrator.delegate(
        plan.id,
        { title: "Running child", requiredCapabilities: ["research"], preferredAgentId: "researcher" },
        "supervisor",
    );
    const second = await runtime.orchestrator.delegate(
        plan.id,
        {
            title: "Queued child",
            requiredCapabilities: ["writing"],
            preferredAgentId: "writer",
            dependencyIds: [first.id],
        },
        "supervisor",
    );

    const running = runtime.orchestrator.runNext();
    await waitForStatus(runtime, first.id, "running");
    await runtime.orchestrator.cancel(plan.id, { actor: "supervisor", reason: "plan superseded" });
    await running;

    assert.equal((await taskById(runtime, plan.id)).status, "cancelled");
    assert.equal((await taskById(runtime, first.id)).status, "cancelled");
    assert.equal((await taskById(runtime, second.id)).status, "cancelled");
});

test("independent review can request changes, retry, and approve without duplicate review events", async () => {
    const { runtime } = await newRuntime();
    const task = await runtime.orchestrator.submit({
        title: "Draft result",
        requiredCapabilities: ["research"],
        preferredAgentId: "researcher",
        review: { required: true, requiredCapabilities: ["review"], independent: true },
    });

    const firstRun = await runtime.orchestrator.runNext();
    assert.equal(firstRun.status, "awaiting_review");
    assert.equal(firstRun.result, undefined);
    assert.notEqual(firstRun.candidateResult, undefined);

    await assert.rejects(
        () => runtime.orchestrator.reviewTask(
            task.id,
            { decision: "approve", eventId: "bad-self-review" },
            "researcher",
        ),
        /independent review/,
    );

    const changes = await runtime.orchestrator.reviewTask(
        task.id,
        { decision: "changes_requested", notes: "add evidence", eventId: "review-1" },
        "reviewer",
    );
    assert.equal(changes.status, "changes_requested");

    const duplicate = await runtime.orchestrator.reviewTask(
        task.id,
        { decision: "changes_requested", notes: "duplicate", eventId: "review-1" },
        "reviewer",
    );
    assert.equal(duplicate.status, "changes_requested");
    assert.equal(duplicate.review.history.length, 1);

    const queued = await runtime.orchestrator.retry(task.id);
    assert.equal(queued.status, "queued");
    const idempotentRetry = await runtime.orchestrator.retry(task.id);
    assert.equal(idempotentRetry.status, "queued");
    assert.equal(idempotentRetry.attempt, 1);

    const secondRun = await runtime.orchestrator.runNext();
    assert.equal(secondRun.status, "awaiting_review");
    assert.equal(secondRun.review.history.length, 1);

    const approved = await runtime.orchestrator.reviewTask(
        task.id,
        { decision: "approve", notes: "ship it", eventId: "review-2" },
        "reviewer",
    );
    assert.equal(approved.status, "completed");
    assert.equal(approved.review.status, "approved");
    assert.equal(approved.review.history.length, 2);
    assert.notEqual(approved.result, undefined);
});
