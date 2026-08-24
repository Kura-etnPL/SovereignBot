import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGoalController, MAX_STEPS, parseProposal } from "../src/main/goal-controller.js";
import { createRuntime } from "../vendor/core/src/runtime.js";

const ECHO_CONFIG = (dataDir) => ({
    dataDir,
    bindHost: "127.0.0.1",
    port: 0,
    agents: [
        { id: "supervisor", name: "Supervisor", role: "supervisor", capabilities: ["planning"], harness: { kind: "echo" } },
        { id: "worker", name: "Worker", role: "worker", capabilities: ["demo"], harness: { kind: "echo" } },
    ],
    policy: {
        repeatWindowMs: 180_000,
        rules: [
            { id: "deny-runaway-loop", effect: "deny", match: { category: "harness", operation: "run", repeatAtLeast: 10 } },
            { id: "allow-echo", effect: "allow", match: { category: "harness", operation: "run", targetGlob: "echo" } },
        ],
    },
});

test("parseProposal accepts only strictly-shaped backward-referencing step lists", () => {
    const valid = parseProposal({
        title: "ship it",
        steps: [
            { title: "research", capability: "research" },
            { title: "write", capability: "writing", dependsOn: [0, 0] },
            { title: "review", dependsOn: [0, 1], extraJunk: "dropped silently is fine" },
        ],
    });
    assert.equal(valid.title, "ship it");
    assert.equal(valid.steps.length, 3);
    assert.deepEqual(valid.steps[1].dependsOn, [0]); // deduplicated
    assert.equal(valid.steps[2].capability, undefined);

    // Forward or self references are dropped; a step keeps only what remains.
    const pruned = parseProposal({ steps: [{ title: "a", dependsOn: [0, 5] }, { title: "b" }] });
    assert.deepEqual(pruned.steps[0].dependsOn, []);

    assert.equal(parseProposal({ agent: "supervisor", title: "x", input: { goal: "y" } }), undefined); // echo output
    assert.equal(parseProposal("plain text"), undefined);
    assert.equal(parseProposal({ steps: [] }), undefined);
    assert.equal(parseProposal({ steps: [{ noTitle: true }] }), undefined);

    const many = parseProposal({ steps: Array.from({ length: 30 }, (_, index) => ({ title: `s${index}` })) });
    assert.equal(many.steps.length, MAX_STEPS);
});

function fakeRuntime({ planningStatus = "completed", workerStatus = "completed" } = {}) {
    const tasks = [];
    let seq = 0;
    const orchestrator = {
        async createPlan(spec) {
            const plan = { id: `t${++seq}`, kind: "plan", status: "active", ownerAgentId: spec.ownerAgentId, result: undefined };
            tasks.push(plan);
            return plan;
        },
        async delegate(_parent, spec) {
            const task = { id: `t${++seq}`, status: "queued", ...spec };
            tasks.push(task);
            return task;
        },
        async runUntilIdle() {
            for (const task of tasks) {
                if (task.status !== "queued")
                    continue;
                if (task.requiredCapabilities?.includes("planning"))
                    task.status = planningStatus;
                else
                    task.status = workerStatus;
                if (task.status === "completed")
                    task.result = { agent: "worker", title: task.title, input: task.input ?? {} };
            }
        },
        async listTasks() {
            return tasks;
        },
        async cancel(taskId) {
            const task = tasks.find((entry) => entry.id === taskId);
            if (task)
                task.status = "cancelled";
        },
        async aggregatePlan(planId) {
            const children = tasks.filter((task) => task.id !== planId);
            const ok = children.every((task) => task.status === "completed");
            return {
                id: planId,
                status: ok ? "completed" : "failed",
                result: { outcome: ok ? "success" : "partial_failure", tasks: children.map(({ title, status }) => ({ title, status })) },
            };
        },
    };
    return {
        tasks,
        config: { agents: [
            { id: "supervisor", role: "supervisor", capabilities: ["planning"] },
            { id: "worker", role: "worker", capabilities: ["demo"] },
        ] },
        orchestrator,
    };
}

function fakeServices() {
    return {
        workspacePath: (id) => (id === "ws_1" ? "/tmp/wsx" : undefined),
        defaultWorkspacePath: () => "/tmp/wsx",
    };
}

async function withTempDir(prefix, fn) {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    try {
        return await fn(dir);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test("goal controller end-to-end over the offline echo roster, durable across restart", async () => {
    await withTempDir("sovereign-goal-e2e-", async (dataDir) => {
        const runtime = await createRuntime(ECHO_CONFIG(dataDir));
        const persistPath = join(dataDir, "goals.json");
        try {
            const controller = createGoalController({
                runtime,
                services: fakeServices(),
                supervisorAgentId: "supervisor",
                persistPath,
            });
            const submitted = await controller.submitGoal({ text: "  write and review a haiku about governed autonomy  " });
            assert.equal(submitted.status, "planning");

            const deadline = Date.now() + 20_000;
            let final = controller.getGoal(submitted.id);
            while (!["completed", "failed", "cancelled"].includes(final.status) && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                final = controller.getGoal(submitted.id);
            }
            assert.equal(final.status, "completed", JSON.stringify(final));
            assert.match(final.finalAnswer, /Goal completed/);

            const conversation = controller.getConversation(submitted.id);
            const kinds = conversation.messages.map((message) => message.kind);
            assert.ok(kinds.includes("goal")); // user message preserved verbatim-ish
            assert.ok(kinds.includes("plan")); // fallback proposal recorded honestly
            assert.ok(kinds.includes("answer"));
            assert.equal(controller.listGoals().goals.length, 1);

            // Durable: a fresh controller over the same store sees the finished goal.
            const revived = createGoalController({
                runtime,
                services: fakeServices(),
                supervisorAgentId: "supervisor",
                persistPath,
            });
            assert.equal(revived.listGoals().goals[0]?.id, submitted.id);
            assert.match(revived.getConversation(submitted.id).messages.at(-1).text, /Goal completed|status/);
        }
        finally {
            await runtime.close();
        }
    });
});

test("planning failure propagates honestly into goal status and conversation", async () => {
    await withTempDir("sovereign-goal-fail-", async (dir) => {
        const controller = createGoalController({
            runtime: fakeRuntime({ planningStatus: "failed" }),
            services: fakeServices(),
            supervisorAgentId: "supervisor",
            persistPath: join(dir, "goals.json"),
        });
        const submitted = await controller.submitGoal({ text: "will fail at planning" });
        await controller.flush();
        const final = controller.getGoal(submitted.id);
        assert.equal(final.status, "failed");
        assert.match(final.error ?? "", /planning task did not complete/);
    });
});

test("operator cancellation stops a running goal best-effort", async () => {
    await withTempDir("sovereign-goal-cancel-", async (dir) => {
        const runtime = fakeRuntime();
        const controller = createGoalController({
            runtime,
            services: fakeServices(),
            supervisorAgentId: "supervisor",
            persistPath: join(dir, "goals.json"),
        });
        // Block the pump chain so the goal is still pending when we cancel.
        const originalRunUntilIdle = runtime.orchestrator.runUntilIdle;
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        runtime.orchestrator.runUntilIdle = (...args) => gate.then(() => originalRunUntilIdle(...args));

        const submitted = await controller.submitGoal({ text: "cancel me mid-flight" });
        const cancelled = await controller.cancel(submitted.id);
        release();
        await controller.flush();
        assert.equal(cancelled.status, "cancelled");
        assert.ok(runtime.tasks.every((task) => task.status !== "running"));
        assert.match(controller.getConversation(submitted.id).messages.at(-1).text, /cancelled/i);
    });
});

test("submitGoal validates text and workspace before any side effect", async () => {
    await withTempDir("sovereign-goal-validate-", async (dir) => {
        const controller = createGoalController({
            runtime: fakeRuntime(),
            services: { workspacePath: () => undefined, defaultWorkspacePath: () => undefined },
            supervisorAgentId: "supervisor",
            persistPath: join(dir, "goals.json"),
        });
        await assert.rejects(() => controller.submitGoal({ text: "   " }), /required/);
        await assert.rejects(() => controller.submitGoal({ text: "x".repeat(8001) }), /8000/);
        await assert.rejects(() => controller.submitGoal({ text: "no workspaces yet" }), /no workspace registered/);
        assert.equal(existsSync(join(dir, "goals.json")), false); // nothing persisted for rejected goals
    });
});
