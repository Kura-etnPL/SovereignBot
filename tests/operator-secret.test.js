import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMemoryComputerDriverFactory } from "../src/computer-driver.js";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

async function waitRunning(runtime, taskId) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const task = (await runtime.orchestrator.listTasks()).find((item) => item.id === taskId);
        if (task?.status === "running")
            return task;
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error("task did not enter running state");
}

test("operator console supplies requested secret without copying plaintext into durable records", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-operator-secret-"));
    const drivers = createMemoryComputerDriverFactory();
    const runtime = await createRuntime({
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [{
            id: "worker",
            name: "Worker",
            role: "worker",
            capabilities: ["browser"],
            harness: { kind: "echo", delayMs: 1_500 },
        }],
        policy: {
            rules: [
                { id: "allow-harness", effect: "allow", match: { category: "harness" } },
                { id: "allow-computer", effect: "allow", match: { category: "computer", agentId: "worker" } },
            ],
        },
    }, { computerDriverFactory: drivers });

    const record = await runtime.computerRegistry.ensure("worker");
    const driver = await drivers.forComputer(record);
    driver.setPage("https://example.test/login", [{ ref: "password", role: "textbox", name: "Password", type: "password" }]);

    const task = await runtime.orchestrator.submit({ title: "wait for operator", requiredCapabilities: ["browser"] });
    const runningPromise = runtime.orchestrator.runNext();
    await waitRunning(runtime, task.id);
    const snapshot = await runtime.computer.snapshot("worker", task.id);
    const password = snapshot.elements.find((element) => element.name === "Password");
    assert.ok(password);
    const request = await runtime.computer.requestSecret("worker", task.id, {
        snapshotId: snapshot.snapshotId,
        ref: password.ref,
        label: "Account password",
    });

    const session = await runtime.operatorSessions.issue({ ttlMs: 60_000 });
    const server = await startServer(runtime);
    const auth = { authorization: `Bearer ${session.token}` };
    const secret = "UI-SECRET-MUST-NOT-PERSIST";
    try {
        const overview = await (await fetch(`${server.url}/operator/overview`, { headers: auth })).json();
        const computer = overview.computers.find((item) => item.agentId === "worker");
        assert.equal(computer.pendingSecret.id, request.id);
        assert.equal(JSON.stringify(overview).includes(secret), false);

        const supplied = await fetch(`${server.url}/operator/computers/worker/secrets/${encodeURIComponent(request.id)}/supply`, {
            method: "POST",
            headers: { ...auth, origin: server.url, "content-type": "application/json" },
            body: JSON.stringify({ actorId: "operator-console-test", value: secret }),
        });
        assert.equal(supplied.status, 200);
        assert.equal((await runtime.computer.control("worker")).mode, "agent");
        const secretAction = driver.actions().find((action) => action.operation === "secret");
        assert.ok(secretAction);
        assert.equal(secretAction.characters, secret.length);

        const auditText = JSON.stringify(await runtime.audit.readAll());
        const tasksText = JSON.stringify(await runtime.orchestrator.listTasks());
        const memoryText = JSON.stringify(await runtime.memory.search({ limit: 100 }));
        assert.equal(auditText.includes(secret), false);
        assert.equal(tasksText.includes(secret), false);
        assert.equal(memoryText.includes(secret), false);
    }
    finally {
        await server.close();
        await runningPromise;
        await runtime.close();
    }
});
