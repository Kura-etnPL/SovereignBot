import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    createGoalController,
    extractProposalJson,
    MAX_STEPS,
    validateProposal,
} from "../src/main/goal-controller.js";

// ---------------------------------------------------------------------------
// Strict proposal validation (BLOCKER B): untrusted planner output is rejected,
// never silently repaired by dropping fields.
// ---------------------------------------------------------------------------

const CAPABILITIES = new Set(["coding", "research", "general", "review", "planning", "synthesis"]);

const VALID_PROPOSAL = {
    title: "ship it",
    synthesis: true,
    steps: [
        { key: "research", title: "Research", instructions: "Find the fix.", capability: "research", dependsOn: [] },
        {
            key: "implement",
            title: "Implement",
            instructions: "Apply the fix.",
            capability: "coding",
            dependsOn: ["research"],
            reviewRequired: true,
        },
    ],
};

function proposalCopy() {
    return structuredClone(VALID_PROPOSAL);
}

test("validateProposal rejects unknown or unavailable capabilities instead of dropping them", () => {
    const unknown = proposalCopy();
    unknown.steps[0].capability = "teleport";
    const result = validateProposal(unknown, CAPABILITIES);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /capability/i.test(error)), result.errors.join("; "));
});

test("validateProposal enforces keys, instructions, sizes and backward-only dependencies", () => {
    // duplicate step keys
    const dupe = proposalCopy();
    dupe.steps[1].key = "research";
    assert.equal(validateProposal(dupe, CAPABILITIES).ok, false);

    // missing instructions
    const noInstructions = proposalCopy();
    delete noInstructions.steps[0].instructions;
    assert.equal(validateProposal(noInstructions, CAPABILITIES).ok, false);

    // dependency on a later step (forward reference)
    const forward = proposalCopy();
    forward.steps[0].dependsOn = ["implement"];
    assert.equal(validateProposal(forward, CAPABILITIES).ok, false);

    // self dependency and unknown dependency
    const selfDep = proposalCopy();
    selfDep.steps[0].dependsOn = ["research"];
    assert.equal(validateProposal(selfDep, CAPABILITIES).ok, false);
    const ghostDep = proposalCopy();
    ghostDep.steps[1].dependsOn = ["ghost"];
    assert.equal(validateProposal(ghostDep, CAPABILITIES).ok, false);

    // too many steps
    const many = { title: "x", steps: Array.from({ length: MAX_STEPS + 1 }, (_, index) => ({
        key: `s${index}`,
        title: `s${index}`,
        instructions: "do it",
        dependsOn: [],
    })) };
    assert.equal(validateProposal(many, CAPABILITIES).ok, false);

    // synthesis must be true or absent — a plan that declares no synthesis is invalid.
    const noSynth = proposalCopy();
    noSynth.synthesis = false;
    assert.equal(validateProposal(noSynth, CAPABILITIES).ok, false);
});

test("validateProposal refuses authority-bearing fields anywhere in the proposal", () => {
    for (const [where, key] of [
        ["root", "cwd"],
        ["root", "sessionId"],
        ["root", "command"],
        ["root", "env"],
        ["step", "workspacePath"],
        ["step", "prefixArgs"],
        ["step", "harnessState"],
        ["step", "preferredAgentId"],
    ]) {
        const evil = proposalCopy();
        if (where === "root")
            evil[key] = "injected";
        else
            evil.steps[0][key] = "injected";
        const result = validateProposal(evil, CAPABILITIES);
        assert.equal(result.ok, false, `${key} at ${where} must invalidate the whole proposal`);
        assert.ok(result.errors.some((error) => /not allowed|forbidden/i.test(error)), result.errors.join("; "));
    }
});

test("extractProposalJson unwraps fenced provider text and fails closed otherwise", () => {
    const fromText = extractProposalJson({ text: `${"```json"}\n${JSON.stringify(VALID_PROPOSAL)}\n${"```"}` });
    assert.deepEqual(fromText, VALID_PROPOSAL);
    assert.deepEqual(extractProposalJson({ text: JSON.stringify(VALID_PROPOSAL) }), VALID_PROPOSAL);
    assert.equal(extractProposalJson({ text: "no json here at all" }), undefined);
    assert.equal(extractProposalJson({ agent: "supervisor", title: "echo output" }), undefined); // echo shape
    assert.equal(extractProposalJson("plain string"), undefined);
});

// ---------------------------------------------------------------------------
// Fake runtime exercising the trusted pipeline end-to-end.
// ---------------------------------------------------------------------------

const WORKSPACE = "/tmp/trusted-ws";

function fakeRuntime({
    plannerOutputs = [],
    reviewDecisions = [],
    planningStatus = "completed",
} = {}) {
    const tasks = [];
    let seq = 0;
    let plannerCall = 0;
    let reviewCall = 0;

    function nextPlannerOutput() {
        const entry = plannerOutputs[Math.min(plannerCall, plannerOutputs.length - 1)];
        plannerCall += 1;
        return typeof entry === "string" ? { text: entry } : entry;
    }

    const orchestrator = {
        recordedTrustedContexts: [],
        async createPlan(spec) {
            const plan = { id: `t${++seq}`, kind: "plan", status: "active", ownerAgentId: spec.ownerAgentId };
            tasks.push(plan);
            return plan;
        },
        async delegate() {
            throw new Error("public delegate must not be used by the goal controller");
        },
        async delegateTrusted(_parent, spec, trustedContext) {
            assert.deepEqual(trustedContext, { workspaceId: "ws_1", cwd: WORKSPACE });
            this.recordedTrustedContexts.push(trustedContext);
            const task = { id: `t${++seq}`, status: "queued", ...spec };
            tasks.push(task);
            return task;
        },
        async runUntilIdle() {
            for (const task of tasks) {
                if (task.status !== "queued")
                    continue;
                const caps = task.requiredCapabilities ?? [];
                if (caps.includes("planning")) {
                    task.status = planningStatus;
                    if (task.status === "completed")
                        task.result = nextPlannerOutput();
                }
                else if (caps.includes("review")) {
                    task.status = "completed";
                    const decision = reviewDecisions[Math.min(reviewCall, reviewDecisions.length - 1)];
                    reviewCall += 1;
                    task.result = { text: JSON.stringify(decision) };
                }
                else if (caps.includes("synthesis")) {
                    task.status = "completed";
                    task.result = { text: "SYNTHESIS: all work accounted for.", usage: {} };
                }
                else {
                    // Model Core: reviewed work lands in awaiting_review with a candidate;
                    // unreviewed work completes directly.
                    const output = { text: `work done: ${task.input?.instruction ?? task.title}` };
                    if (task.review?.required) {
                        task.status = "awaiting_review";
                        task.candidateResult = output;
                        task.result = undefined;
                    }
                    else {
                        task.status = "completed";
                        task.result = output;
                    }
                }
            }
        },
        async listTasks() {
            return tasks;
        },
        async requireTask(id) {
            return tasks.find((entry) => entry.id === id);
        },
        async reviewTask(taskId, reviewInput, reviewerAgentId) {
            const task = tasks.find((entry) => entry.id === taskId);
            assert.ok(task.review?.required, "only reviewed tasks reach reviewTask");
            assert.equal(reviewerAgentId, "claude-reviewer");
            if (reviewInput.decision === "approve") {
                task.status = "completed";
                task.result = task.candidateResult;
            }
            else {
                task.status = "changes_requested";
            }
            task.lastReviewDecision = reviewInput.decision;
            return task;
        },
        async retry(taskId) {
            const task = tasks.find((entry) => entry.id === taskId);
            task.status = "queued";
            task.attempt = (task.attempt ?? 0) + 1;
            return task;
        },
        async cancel(taskId) {
            const task = tasks.find((entry) => entry.id === taskId);
            if (task)
                task.status = "cancelled";
        },
        async aggregatePlan(planId) {
            const children = tasks.filter((task) => task.id !== planId && task.kind !== "plan");
            const ok = children.every((task) => task.status === "completed");
            return {
                id: planId,
                status: ok ? "completed" : "failed",
                result: {
                    outcome: ok ? "success" : "partial_failure",
                    tasks: children.map(({ title, status }) => ({ title, status })),
                },
            };
        },
    };

    return {
        tasks,
        orchestrator,
        config: { agents: [{ id: "supervisor", role: "supervisor", capabilities: ["planning"] }] },
    };
}

const ROSTER = () => ({
    mode: "provider",
    ready: true,
    roles: { planner: "supervisor", worker: "codex-worker", reviewer: "claude-reviewer", synthesizer: "claude-synthesizer" },
    agents: [
        { id: "supervisor", name: "Claude Planner", role: "supervisor", capabilities: ["planning"], harnessKind: "claude-code" },
        { id: "codex-worker", name: "Codex Worker", role: "worker", capabilities: ["coding", "research", "general"], harnessKind: "codex" },
        { id: "claude-reviewer", name: "Claude Reviewer", role: "worker", capabilities: ["review", "research"], harnessKind: "claude-code" },
        { id: "claude-synthesizer", name: "Claude Synthesizer", role: "worker", capabilities: ["synthesis", "general"], harnessKind: "claude-code" },
    ],
});

function fakeServices() {
    return {
        workspacePath: (id) => (id === "ws_1" ? WORKSPACE : undefined),
        defaultWorkspacePath: () => WORKSPACE,
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

function makeController(runtime, extra = {}) {
    return createGoalController({
        runtime,
        services: fakeServices(),
        supervisorAgentId: "supervisor",
        readiness: () => ({ allowed: true }),
        roster: ROSTER,
        persistPath: join(extra.dir ?? tmpdir(), "goals.json"),
        now: () => new Date().toISOString(),
    });
}

async function waitForTerminal(controller, goalId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let goal = controller.getGoal(goalId);
    while (!["completed", "failed", "cancelled"].includes(goal.status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        goal = controller.getGoal(goalId);
    }
    return goal;
}

test("goal pump runs real planner -> workers -> reviewer -> synthesizer through the trusted channel", async () => {
    await withTempDir("sovereign-goal-v2-", async (dir) => {
        const proposal = `${"```json"}\n${JSON.stringify(VALID_PROPOSAL)}\n${"```"}`;
        const runtime = fakeRuntime({ plannerOutputs: [proposal], reviewDecisions: [{ decision: "approve", notes: "fine" }] });
        const controller = makeController(runtime, { dir });

        const submitted = await controller.submitGoal({ text: "fix the bug in the login flow", workspaceId: "ws_1" });
        const goal = await waitForTerminal(controller, submitted.id);
        assert.equal(goal.status, "completed");
        assert.match(goal.finalAnswer ?? "", /^SYNTHESIS:/);

        assert.ok(runtime.orchestrator.recordedTrustedContexts.length >= 5,
            `expected planning+2 workers+review+synthesis via delegateTrusted, got ${runtime.orchestrator.recordedTrustedContexts.length}`);

        const delegated = runtime.tasks.filter((task) => task.kind !== "plan");
        const worker = delegated.find((task) => task.requiredCapabilities?.includes("coding"));
        assert.equal(worker.input.instruction, "Apply the fix.");
        assert.equal(worker.input.userGoal, "fix the bug in the login flow");
        assert.deepEqual(worker.input.dependencyResults.map((entry) => entry.text), ["work done: Find the fix."]);
        assert.equal(worker.review.required, true);

        const conversation = controller.getConversation(submitted.id);
        const flattened = JSON.stringify(conversation.messages);
        // Public surfaces carry model text and phase attribution — never session references.
        assert.ok(!/"sessionId"|harnessState/.test(flattened));
        assert.ok(conversation.messages.some((message) => message.kind === "phase" && /Review/.test(message.text)));
        assert.ok(conversation.messages.some((message) => message.kind === "answer"));
    });
});

test("invalid proposals trigger bounded repair rounds and honest failure without any worker run", async () => {
    await withTempDir("sovereign-goal-repair-", async (dir) => {
        const garbage = "I cannot produce JSON, sorry!";
        const runtime = fakeRuntime({ plannerOutputs: [garbage] });
        const controller = makeController(runtime, { dir });

        const submitted = await controller.submitGoal({ text: "impossible goal", workspaceId: "ws_1" });
        const goal = await waitForTerminal(controller, submitted.id);
        assert.equal(goal.status, "failed");
        assert.match(goal.error ?? "", /valid proposal/i);

        const planningCalls = runtime.tasks.filter((task) => task.requiredCapabilities?.includes("planning")).length;
        assert.ok(planningCalls >= 2 && planningCalls <= 3, `bounded repairs expected, got ${planningCalls}`);
        // No silent single-step fallback: zero work/review/synthesis tasks were ever delegated.
        assert.equal(runtime.tasks.filter((task) => {
            const caps = task.requiredCapabilities ?? [];
            return task.kind !== "plan" && !caps.includes("planning");
        }).length, 0);
    });
});

test("review changes_requested retries the same worker then approves on the second pass", async () => {
    await withTempDir("sovereign-goal-review-", async (dir) => {
        const proposal = JSON.stringify(VALID_PROPOSAL);
        const runtime = fakeRuntime({
            plannerOutputs: [proposal],
            reviewDecisions: [{ decision: "changes_requested", notes: "add tests" }, { decision: "approve", notes: "ok" }],
        });
        const controller = makeController(runtime, { dir });

        const submitted = await controller.submitGoal({ text: "implement feature x", workspaceId: "ws_1" });
        const goal = await waitForTerminal(controller, submitted.id);
        assert.equal(goal.status, "completed");

        const reviewed = runtime.tasks.filter((task) => task.lastReviewDecision !== undefined);
        assert.equal(reviewed.length, 1);
        assert.equal(reviewed[0].attempt, 1);
        assert.equal(reviewed[0].lastReviewDecision, "approve");

        const conversation = JSON.stringify(controller.getConversation(submitted.id).messages);
        assert.ok(/changes_requested/i.test(conversation));
        assert.ok(/add tests/.test(conversation));
    });
});

test("submitGate still refuses goals when readiness says no, before any side effect", async () => {
    await withTempDir("sovereign-goal-gate2-", async (dir) => {
        const controller = createGoalController({
            runtime: fakeRuntime(),
            services: { workspacePath: () => WORKSPACE, defaultWorkspacePath: () => WORKSPACE },
            supervisorAgentId: "supervisor",
            roster: ROSTER,
            readiness: () => ({ allowed: false, reason: "Connect at least one AI provider to run goals." }),
            persistPath: join(dir, "goals.json"),
        });
        await assert.rejects(
            () => controller.submitGoal({ text: "should be refused" }),
            /Connect at least one AI provider/,
        );
        assert.equal(controller.listGoals().goals.length, 0);
        assert.equal(existsSync(join(dir, "goals.json")), false);
    });
});

test("restart marks interrupted goals failed without touching terminal history", async () => {
    await withTempDir("sovereign-goal-restart2-", async (dir) => {
        const persistPath = join(dir, "goals.json");
        const first = createGoalController({
            runtime: fakeRuntime(),
            services: fakeServices(),
            supervisorAgentId: "supervisor",
            roster: ROSTER,
            persistPath,
        });
        await first.submitGoal({ text: "will be interrupted", workspaceId: "ws_1" });

        const revived = createGoalController({
            runtime: fakeRuntime(),
            services: fakeServices(),
            supervisorAgentId: "supervisor",
            roster: ROSTER,
            persistPath,
        });
        const goals = revived.listGoals().goals;
        assert.equal(goals.length, 1);
        assert.equal(goals[0].status, "failed");
        assert.match(revived.getConversation(goals[0].id).messages.at(-1)?.text ?? "", /shutdown|interrupted/i);
    });
});
