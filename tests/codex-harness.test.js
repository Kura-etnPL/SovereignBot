import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

async function createCodexRuntime(harnessPatch = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-codex-"));
    return createRuntime({
        dataDir,
        agents: [
            {
                id: "codex-worker",
                name: "Codex Worker",
                role: "worker",
                capabilities: ["coding"],
                harness: {
                    kind: "codex",
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
                    id: "allow-codex-test",
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

test("Codex harness captures the thread id and structured final response", async () => {
    const runtime = await createCodexRuntime();
    const task = await runtime.orchestrator.submit({
        title: "Implement feature",
        input: { file: "src/example.js" },
        requiredCapabilities: ["coding"],
    });

    const result = await runtime.orchestrator.runNext();
    assert.equal(result.status, "completed");
    assert.equal(result.harnessState.sessionId, "fake-codex-session-001");
    assert.match(result.result.text, /^new:fake-codex-session-001:/);
    assert.equal(result.result.usage.input_tokens, 10);

    const persisted = await getTask(runtime, task.id);
    assert.equal(persisted.harnessState.sessionId, "fake-codex-session-001");
    assert.equal((await runtime.audit.verify()).ok, true);
});

test("retry resumes a Codex session that was persisted before failure", async () => {
    const runtime = await createCodexRuntime();
    const task = await runtime.orchestrator.submit({
        title: "FAIL_AFTER_START",
        requiredCapabilities: ["coding"],
    });

    const first = await runtime.orchestrator.runNext();
    assert.equal(first.status, "failed");
    assert.equal(first.harnessState.sessionId, "fake-codex-session-001");

    await runtime.orchestrator.retry(task.id);
    const second = await runtime.orchestrator.runNext();
    assert.equal(second.status, "completed");
    assert.match(second.result.text, /^resumed:fake-codex-session-001:/);
    assert.equal(second.assignedAgentId, "codex-worker");
});

test("malformed Codex JSONL fails without losing the captured session", async () => {
    const runtime = await createCodexRuntime();
    const task = await runtime.orchestrator.submit({
        title: "MALFORMED",
        requiredCapabilities: ["coding"],
    });
    const result = await runtime.orchestrator.runNext();
    assert.equal(result.status, "failed");
    assert.match(result.error, /invalid Codex JSONL event/);
    assert.equal((await getTask(runtime, task.id)).harnessState.sessionId, "fake-codex-session-001");
});

test("cancelling a running Codex task preserves cancelled status", async () => {
    const runtime = await createCodexRuntime({ timeoutMs: 10_000 });
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
    assert.equal(ready, true, "fake Codex session should start before cancellation");

    await runtime.orchestrator.cancel(task.id);
    const result = await running;
    assert.equal(result.status, "cancelled");
    assert.equal((await getTask(runtime, task.id)).status, "cancelled");
});

test("timing out a Codex task reports timeout and preserves the resumable session", async () => {
    const runtime = await createCodexRuntime({ timeoutMs: 500 });
    const task = await runtime.orchestrator.submit({ title: "HANG", requiredCapabilities: ["coding"] });
    const result = await runtime.orchestrator.runNext();
    assert.equal(result.status, "failed");
    assert.match(result.error, /Codex execution timed out/);
    assert.equal(result.harnessState.sessionId, "fake-codex-session-001");
});

test("missing Codex executable produces an actionable failure", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-codex-missing-"));
    const runtime = await createRuntime({
        dataDir,
        agents: [
            {
                id: "missing-codex",
                name: "Missing Codex",
                role: "worker",
                capabilities: ["coding"],
                harness: { kind: "codex", command: join(dataDir, "definitely-missing-codex") },
            },
        ],
        policy: {
            rules: [{ id: "allow-test", effect: "allow", match: { category: "harness" } }],
        },
    });
    await runtime.orchestrator.submit({ title: "test missing binary", requiredCapabilities: ["coding"] });
    const result = await runtime.orchestrator.runNext();
    assert.equal(result.status, "failed");
    assert.match(result.error, /Codex CLI executable was not found|Codex failed to start/);
});
