import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";

const SOAK_CYCLES = 4;
const REPEAT_THRESHOLD = 4;

function basePolicy(allowRuleId = "allow-echo") {
    return {
        repeatWindowMs: 120_000,
        repeatMaxActiveFingerprints: 10_000,
        rules: [
            {
                id: "deny-soak-repeat",
                effect: "deny",
                match: {
                    category: "harness",
                    operation: "run",
                    repeatAtLeast: REPEAT_THRESHOLD,
                },
            },
            {
                id: allowRuleId,
                effect: "allow",
                match: { category: "harness", operation: "run", targetGlob: "echo" },
            },
        ],
    };
}

function config(dataDir, allowRuleId = "allow-echo") {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [
            {
                id: "supervisor",
                name: "Supervisor",
                role: "supervisor",
                capabilities: ["planning"],
                harness: { kind: "echo" },
            },
            {
                id: "researcher",
                name: "Researcher",
                role: "worker",
                capabilities: ["research"],
                harness: { kind: "echo", delayMs: 90 },
            },
            {
                id: "writer",
                name: "Writer",
                role: "worker",
                capabilities: ["writing"],
                harness: { kind: "echo", delayMs: 20 },
            },
            {
                id: "reviewer",
                name: "Reviewer",
                role: "reviewer",
                capabilities: ["review"],
                harness: { kind: "echo" },
            },
        ],
        policy: basePolicy(allowRuleId),
    };
}

async function taskById(runtime, id) {
    return (await runtime.orchestrator.listTasks()).find((task) => task.id === id);
}

async function waitForStatus(runtime, taskId, status, attempts = 200) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const task = await taskById(runtime, taskId);
        if (task?.status === status)
            return task;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`task ${taskId} did not reach ${status}`);
}

async function reopen(runtime, dataDir) {
    await runtime?.close();
    return createRuntime(config(dataDir));
}

async function assertHealthy(runtime) {
    const audit = await runtime.audit.verify();
    assert.equal(audit.ok, true, audit.reason);
    const snapshot = await runtime.policyManager.snapshot();
    assert.equal(snapshot.recoveryPending, false);
}

test("v1 RC stateful orchestration/policy/repeat soak survives repeated restart cycles", { timeout: 60_000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-v1-rc-soak-"));
    let runtime;
    try {
        runtime = await createRuntime(config(dataDir));
        const initialPolicyVersion = runtime.policyManager.current().id;

        for (let cycle = 0; cycle < SOAK_CYCLES; cycle += 1) {
            const plan = await runtime.orchestrator.createPlan({
                title: `soak plan ${cycle}`,
                ownerAgentId: "supervisor",
            });
            const research = await runtime.orchestrator.delegate(
                plan.id,
                {
                    title: `research ${cycle}`,
                    requiredCapabilities: ["research"],
                    preferredAgentId: "researcher",
                },
                "supervisor",
            );
            const writing = await runtime.orchestrator.delegate(
                plan.id,
                {
                    title: `write ${cycle}`,
                    requiredCapabilities: ["writing"],
                    preferredAgentId: "writer",
                    dependencyIds: [research.id],
                },
                "supervisor",
            );
            const finished = await runtime.orchestrator.runUntilIdle();
            assert.deepEqual(finished.map((task) => task.id), [research.id, writing.id]);
            assert.equal(finished.every((task) => task.status === "completed"), true);
            const aggregated = await runtime.orchestrator.aggregatePlan(plan.id, "supervisor");
            assert.equal(aggregated.status, "completed");
            assert.equal(aggregated.result.outcome, "success");

            const reviewTask = await runtime.orchestrator.submit({
                title: `review cycle ${cycle}`,
                requiredCapabilities: ["research"],
                preferredAgentId: "researcher",
                review: {
                    required: true,
                    requiredCapabilities: ["review"],
                    independent: true,
                },
            });
            const firstRun = await runtime.orchestrator.runNext();
            assert.equal(firstRun.id, reviewTask.id);
            assert.equal(firstRun.status, "awaiting_review");
            const changeEventId = `soak-review-${cycle}-changes`;
            const changes = await runtime.orchestrator.reviewTask(
                reviewTask.id,
                { decision: "changes_requested", notes: "soak requests another pass", eventId: changeEventId },
                "reviewer",
            );
            assert.equal(changes.status, "changes_requested");
            const duplicateChange = await runtime.orchestrator.reviewTask(
                reviewTask.id,
                { decision: "changes_requested", notes: "duplicate must not append", eventId: changeEventId },
                "reviewer",
            );
            assert.equal(duplicateChange.review.history.length, 1);

            runtime = await reopen(runtime, dataDir);
            const queued = await runtime.orchestrator.retry(reviewTask.id);
            assert.equal(queued.status, "queued");
            assert.equal(queued.attempt, 1);
            const duplicateRetry = await runtime.orchestrator.retry(reviewTask.id);
            assert.equal(duplicateRetry.status, "queued");
            assert.equal(duplicateRetry.attempt, 1);
            const secondRun = await runtime.orchestrator.runNext();
            assert.equal(secondRun.status, "awaiting_review");
            const approved = await runtime.orchestrator.reviewTask(
                reviewTask.id,
                { decision: "approve", notes: "soak approval", eventId: `soak-review-${cycle}-approve` },
                "reviewer",
            );
            assert.equal(approved.status, "completed");
            assert.equal(approved.review.history.length, 2);

            const cancellable = await runtime.orchestrator.submit({
                title: `cancel cycle ${cycle}`,
                requiredCapabilities: ["research"],
                preferredAgentId: "researcher",
            });
            const runningPromise = runtime.orchestrator.runNext();
            await waitForStatus(runtime, cancellable.id, "running");
            const progressEventId = `soak-progress-${cycle}`;
            const firstProgress = await runtime.orchestrator.reportProgress(
                cancellable.id,
                { eventId: progressEventId, percent: 25, message: "soak progress" },
                "researcher",
            );
            const duplicateProgress = await runtime.orchestrator.reportProgress(
                cancellable.id,
                { eventId: progressEventId, percent: 90, message: "duplicate must not overwrite" },
                "researcher",
            );
            assert.equal(firstProgress.duplicate, false);
            assert.equal(duplicateProgress.duplicate, true);
            assert.equal((await taskById(runtime, cancellable.id)).progress.percent, 25);
            await runtime.orchestrator.cancel(cancellable.id, { reason: "soak cancellation" });
            await runningPromise;
            assert.equal((await taskById(runtime, cancellable.id)).status, "cancelled");

            const previous = runtime.policyManager.current();
            const allowRuleId = `allow-echo-soak-${cycle}`;
            const nextPolicy = basePolicy(allowRuleId);
            const policyAction = {
                category: "harness",
                operation: "run",
                target: "echo",
                agentId: "researcher",
                taskId: `soak-policy-check-${cycle}`,
            };
            const applied = await runtime.policyManager.apply({
                policy: nextPolicy,
                checks: [{
                    action: policyAction,
                    repeatCount: 1,
                    expect: { allowed: true, ruleId: allowRuleId },
                }],
                actor: "rc-soak",
                label: `RC soak policy ${cycle}`,
            });
            assert.notEqual(applied.active.id, previous.id);
            const appliedId = applied.active.id;

            runtime = await reopen(runtime, dataDir);
            assert.equal(runtime.policyManager.current().id, appliedId);
            assert.equal(runtime.policyManager.current().policy.rules.some((rule) => rule.id === allowRuleId), true);
            const rolledBack = await runtime.policyManager.rollback({
                versionId: previous.id,
                actor: "rc-soak",
            });
            assert.equal(rolledBack.active.id, previous.id);

            runtime = await reopen(runtime, dataDir);
            assert.equal(runtime.policyManager.current().id, previous.id);
            await assertHealthy(runtime);
        }

        assert.equal(runtime.policyManager.current().id, initialPolicyVersion);

        const repeatedAction = {
            category: "harness",
            operation: "run",
            target: "echo",
            agentId: "researcher",
            taskId: "rc-soak-repeat-across-restart",
        };
        for (let attempt = 1; attempt < REPEAT_THRESHOLD; attempt += 1) {
            const decision = await runtime.orchestrator.governor.authorize(repeatedAction);
            assert.equal(decision.allowed, true, `attempt ${attempt} should remain below repeat threshold`);
        }
        runtime = await reopen(runtime, dataDir);
        const denied = await runtime.orchestrator.governor.authorize(repeatedAction);
        assert.equal(denied.allowed, false);
        assert.equal(denied.ruleId, "deny-soak-repeat");
        await assertHealthy(runtime);

        const tasks = await runtime.orchestrator.listTasks();
        assert.equal(tasks.filter((task) => task.title?.startsWith("review cycle")).length, SOAK_CYCLES);
        assert.equal(tasks.filter((task) => task.title?.startsWith("cancel cycle") && task.status === "cancelled").length, SOAK_CYCLES);
        assert.equal(tasks.filter((task) => task.kind === "plan" && task.status === "completed").length, SOAK_CYCLES);
    }
    finally {
        await runtime?.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});
