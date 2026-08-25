import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";
import { publicTaskView } from "../src/task-view.js";

// Trusted task-scoped execution context (Desktop v1.1.1 BLOCKER C):
//  - ordinary submit/delegate can never smuggle an executionContext;
//  - only the internal delegateTrusted channel stamps one, after strict validation;
//  - provider harness launches use the trusted cwd as the real child-process cwd;
//  - public projections strip the internal field entirely.

const fixture = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

async function createCodexRuntime(extraAgents = []) {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-trusted-ctx-"));
    return createRuntime({
        dataDir,
        agents: [
            {
                id: "planner",
                name: "Planner",
                role: "supervisor",
                capabilities: ["planning"],
                harness: {
                    kind: "codex",
                    command: process.execPath,
                    prefixArgs: [fixture],
                    timeoutMs: 10_000,
                },
            },
            ...extraAgents,
        ],
        policy: {
            rules: [
                { id: "allow-harness-test", effect: "allow", match: { category: "harness", operation: "run" } },
            ],
        },
    });
}

test("public submit cannot smuggle an execution context", async () => {
    const runtime = await createCodexRuntime();
    const smuggled = await runtime.orchestrator.submit({
        title: "smuggled context",
        requiredCapabilities: [],
        executionContext: { workspaceId: "ws_evil", cwd: "C:\\Windows\\System32" },
    });
    assert.equal(smuggled.executionContext, undefined);

    const delegated = await runtime.orchestrator.delegate(smuggled.id, {
        title: "child with smuggled context",
        executionContext: { workspaceId: "ws_evil", cwd: "C:\\Windows\\System32" },
    }, "planner");
    assert.equal(delegated.executionContext, undefined);
});

test("delegateTrusted stamps a strictly validated execution context", async () => {
    const runtime = await createCodexRuntime();
    const plan = await runtime.orchestrator.createPlan({ title: "plan", ownerAgentId: "planner" });
    const workspace = await mkdtemp(join(tmpdir(), "trusted-ws-"));

    const task = await runtime.orchestrator.delegateTrusted(plan.id, {
        title: "trusted step",
    }, { workspaceId: "ws_abc", cwd: workspace }, "planner");
    assert.deepEqual(task.executionContext, { workspaceId: "ws_abc", cwd: workspace });

    // The trusted channel itself must reject malformed or unsafe contexts.
    await assert.rejects(
        () => runtime.orchestrator.delegateTrusted(plan.id, { title: "no cwd" }, { workspaceId: "ws_abc" }, "planner"),
        /cwd/,
    );
    await assert.rejects(
        () => runtime.orchestrator.delegateTrusted(plan.id, { title: "relative cwd" }, { workspaceId: "ws_abc", cwd: "relative/path" }, "planner"),
        /cwd/,
    );
    await assert.rejects(
        () => runtime.orchestrator.delegateTrusted(plan.id, { title: "missing dir" }, { workspaceId: "ws_abc", cwd: join(workspace, "gone") }, "planner"),
        /cwd/,
    );
    await assert.rejects(
        () => runtime.orchestrator.delegateTrusted(plan.id, { title: "extra keys" }, { workspaceId: "ws_abc", cwd: workspace, env: { EVIL: "1" } }, "planner"),
        /execution context/,
    );
    // Only the owning supervisor may use the trusted channel.
    await assert.rejects(
        () => runtime.orchestrator.delegateTrusted(plan.id, { title: "bad actor" }, { workspaceId: "ws_abc", cwd: workspace }, "ghost"),
        /supervisor|not found/,
    );

    await rm(workspace, { recursive: true, force: true });
});

test("provider harness runs with the trusted workspace as its real child-process cwd", async () => {
    const capture = join(await mkdtemp(join(tmpdir(), "capture-")), "args.json");
    process.env.SOVEREIGNBOT_CAPTURE_ARGS = capture;
    const workspace = await mkdtemp(join(tmpdir(), "real-cwd-ws-"));
    try {
        const runtime = await createCodexRuntime();
        const plan = await runtime.orchestrator.createPlan({ title: "plan", ownerAgentId: "planner" });
        const task = await runtime.orchestrator.delegateTrusted(plan.id, {
            title: "run in workspace",
            // The roster's only agent here is the supervisor-planner itself; production
            // planning tasks use the same explicit opt-in.
            allowSupervisorExecution: true,
        }, { workspaceId: "ws_cwd", cwd: workspace }, "planner");
        const result = await runtime.orchestrator.runNext();
        assert.equal(result.status, "completed");

        const args = JSON.parse(await readFile(capture, "utf8"));
        const cdIndex = args.indexOf("--cd");
        assert.ok(cdIndex >= 0, `expected --cd in codex argv: ${JSON.stringify(args)}`);
        assert.equal(args[cdIndex + 1], workspace);
        assert.equal((await runtime.orchestrator.requireTask(task.id)).executionContext.cwd, workspace);
    }
    finally {
        delete process.env.SOVEREIGNBOT_CAPTURE_ARGS;
        await rm(workspace, { recursive: true, force: true });
    }
});

test("public task projection strips the internal execution context", async () => {
    const runtime = await createCodexRuntime();
    const plan = await runtime.orchestrator.createPlan({ title: "plan", ownerAgentId: "planner" });
    const workspace = await mkdtemp(join(tmpdir(), "projection-ws-"));
    try {
        const task = await runtime.orchestrator.delegateTrusted(plan.id, {
            title: "projected step",
        }, { workspaceId: "ws_pub", cwd: workspace }, "planner");

        const view = publicTaskView(task);
        assert.equal(view.executionContext, undefined);
        assert.ok(!JSON.stringify(view).includes(workspace), "canonical cwd must not leak through public views");
        // The durable record keeps it for the trusted launcher only.
        assert.equal(task.executionContext.workspaceId, "ws_pub");
    }
    finally {
        await rm(workspace, { recursive: true, force: true });
    }
});
