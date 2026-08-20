import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMemoryComputerDriverFactory } from "../src/computer-driver.js";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

function config(dataDir) {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [
            {
                id: "worker-a",
                name: "Worker A",
                role: "worker",
                capabilities: ["browser"],
                harness: { kind: "echo", delayMs: 10_000 },
            },
            {
                id: "worker-b",
                name: "Worker B",
                role: "worker",
                capabilities: ["browser"],
                harness: { kind: "echo", delayMs: 10_000 },
            },
        ],
        policy: {
            rules: [
                { id: "allow-harness", effect: "allow", match: { category: "harness" } },
                { id: "allow-computer", effect: "allow", match: { category: "computer" } },
            ],
        },
    };
}

async function waitFor(runtime, id, status) {
    for (let index = 0; index < 100; index += 1) {
        const task = (await runtime.orchestrator.listTasks()).find((candidate) => candidate.id === id);
        if (task?.status === status)
            return task;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`task ${id} did not reach ${status}`);
}

test("production computer gateway requires a running task owned by the worker", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-task-bound-computer-"));
    const factory = createMemoryComputerDriverFactory();
    const runtime = await createRuntime(config(dataDir), { computerDriverFactory: factory });
    const task = await runtime.orchestrator.submit({
        title: "Use browser",
        requiredCapabilities: ["browser"],
        preferredAgentId: "worker-a",
    });
    const running = runtime.orchestrator.runNext();
    await waitFor(runtime, task.id, "running");

    factory.forComputer((await runtime.computerRegistry.list()).find((entry) => entry.agentId === "worker-a"))
        .setPage("https://example.com", [{ ref: "go", role: "button", name: "Go" }]);

    const snapshot = await runtime.computer.snapshot("worker-a", task.id);
    assert.equal(snapshot.url, "https://example.com");

    await assert.rejects(
        () => runtime.computer.snapshot("worker-b", task.id),
        /not owned by agent worker-b/,
    );
    await assert.rejects(
        () => runtime.computer.snapshot("worker-a", "invented-task"),
        /not bound to a known task/,
    );

    await runtime.orchestrator.cancel(task.id);
    await running;
    await assert.rejects(
        () => runtime.computer.snapshot("worker-a", task.id),
        /not running/,
    );
    assert.equal((await runtime.audit.verify()).ok, true);
});

test("HTTP computer API enforces token plus task ownership", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-task-bound-api-"));
    const factory = createMemoryComputerDriverFactory();
    const runtime = await createRuntime(config(dataDir), { computerDriverFactory: factory });
    const task = await runtime.orchestrator.submit({
        title: "API browser work",
        requiredCapabilities: ["browser"],
        preferredAgentId: "worker-a",
    });
    const running = runtime.orchestrator.runNext();
    await waitFor(runtime, task.id, "running");

    const tokenA = (await runtime.computer.agentCredentials("worker-a")).token;
    const tokenB = (await runtime.computer.agentCredentials("worker-b")).token;
    const server = await startServer(runtime);
    const post = (agentId, token, taskId) => fetch(`${server.url}/computers/${agentId}/snapshot`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ taskId }),
    });

    try {
        assert.equal((await post("worker-a", tokenA, task.id)).status, 200);
        assert.equal((await post("worker-a", tokenA, "invented")).status, 403);
        assert.equal((await post("worker-a", tokenB, task.id)).status, 401);
        assert.equal((await post("worker-b", tokenB, task.id)).status, 403);
    }
    finally {
        await runtime.orchestrator.cancel(task.id);
        await running;
        await server.close();
    }
});
