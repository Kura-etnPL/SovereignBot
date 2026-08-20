import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

async function createClaudeRuntime(harnessPatch = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-claude-"));
    return createRuntime({
        dataDir,
        agents: [
            {
                id: "claude-worker",
                name: "Claude Code Worker",
                role: "worker",
                capabilities: ["coding"],
                harness: {
                    kind: "claude-code",
                    command: process.execPath,
                    prefixArgs: [fixture],
                    timeoutMs: 5_000,
                    ...harnessPatch,
                },
            },
        ],
        policy: {
            rules: [
                {
                    id: "allow-claude-test",
                    effect: "allow",
                    match: { category: "harness", operation: "run" },
                },
            ],
        },
    });
}

async function getTask(runtime, id) {
    return (await runtime.orchestrator.listTasks()).find((task) => task.id === id);
}

test("Claude Code harness captures init session, progress, and result metadata", async () => {
    const runtime = await createClaudeRuntime();
    const task = await runtime.orchestrator.submit({
        title: "Implement feature",
        input: { file: "src/example.js" },
        requiredCapabilities: ["coding"],
    });

    const result = await runtime.orchestrator.runNext();
    assert.equal(result.status, "completed");
    assert.equal(result.harnessState.sessionId, "fake-claude-session-001");
    assert.match(result.result.text, /^new:fake-claude-session-001:/);
    assert.equal(result.result.numTurns, 2);
    assert.equal(result.result.terminalReason, "completed");
    assert.equal(result.progress.message, "fake Claude progress");

    const events = await runtime.orchestrator.listTaskEvents(task.id);
    assert.equal(events.filter((event) => event.type === "task.progress").length, 1);
    assert.equal((await runtime.audit.verify()).ok, true);
});

test("retry resumes a Claude Code session persisted before process failure", async () => {
    const runtime = await createClaudeRuntime();
    const task = await runtime.orchestrator.submit({
        title: "FAIL_AFTER_START",
        requiredCapabilities: ["coding"],
    });

    const first = await runtime.orchestrator.runNext();
    assert.equal(first.status, "failed");
    assert.equal(first.harnessState.sessionId, "fake-claude-session-001");

    await runtime.orchestrator.retry(task.id);
    const second = await runtime.orchestrator.runNext();
    assert.equal(second.status, "completed");
    assert.match(second.result.text, /^resumed:fake-claude-session-001:/);
    assert.equal(second.assignedAgentId, "claude-worker");
});

test("malformed Claude Code stream fails without losing the captured session", async () => {
    const runtime = await createClaudeRuntime();
    const task = await runtime.orchestrator.submit({
        title: "MALFORMED",
        requiredCapabilities: ["coding"],
    });
    const result = await runtime.orchestrator.runNext();
    assert.equal(result.status, "failed");
    assert.match(result.error, /invalid Claude Code stream-json event/);
    assert.equal((await getTask(runtime, task.id)).harnessState.sessionId, "fake-claude-session-001");
});

test("cancelling a running Claude Code task preserves cancelled status", async () => {
    const runtime = await createClaudeRuntime({ timeoutMs: 10_000 });
    const task = await runtime.orchestrator.submit({
        title: "HANG",
        requiredCapabilities: ["coding"],
    });
    const running = runtime.orchestrator.runNext();

    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await getTask(runtime, task.id);
        if (current?.status === "running" && current.harnessState?.sessionId) {
            ready = true;
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(ready, true, "fake Claude Code session should start before cancellation");

    await runtime.orchestrator.cancel(task.id);
    const result = await running;
    assert.equal(result.status, "cancelled");
    assert.equal((await getTask(runtime, task.id)).status, "cancelled");
    assert.equal((await runtime.audit.verify()).ok, true);
});

test("missing Claude Code executable produces an actionable failure", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-claude-missing-"));
    const runtime = await createRuntime({
        dataDir,
        agents: [
            {
                id: "missing-claude",
                name: "Missing Claude",
                role: "worker",
                capabilities: ["coding"],
                harness: { kind: "claude-code", command: join(dataDir, "definitely-missing-claude") },
            },
        ],
        policy: {
            rules: [{ id: "allow-test", effect: "allow", match: { category: "harness" } }],
        },
    });
    await runtime.orchestrator.submit({ title: "test missing binary", requiredCapabilities: ["coding"] });
    const result = await runtime.orchestrator.runNext();
    assert.equal(result.status, "failed");
    assert.match(result.error, /Claude Code CLI executable was not found|Claude Code failed to start/);
});

test("Claude Code authentication failure is surfaced with a sign-in action", async () => {
    const runtime = await createClaudeRuntime();
    await runtime.orchestrator.submit({ title: "AUTH_FAIL", requiredCapabilities: ["coding"] });
    const result = await runtime.orchestrator.runNext();
    assert.equal(result.status, "failed");
    assert.match(result.error, /authentication is unavailable.*sign in/i);
});
