import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectWorkerTelemetry } from "../src/worker-telemetry.js";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

async function waitFor(predicate, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate())
            return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("condition did not become true");
}

function config(dataDir) {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [
            { id: "worker", name: "Worker", role: "worker", capabilities: ["demo"], maxConcurrency: 2, harness: { kind: "echo", delayMs: 600 } },
            { id: "supervisor", name: "Supervisor", role: "supervisor", capabilities: ["demo"], harness: { kind: "echo", delayMs: 10 } },
        ],
        policy: { rules: [{ id: "allow-harness", effect: "allow", match: { category: "harness" } }] },
    };
}

test("worker telemetry is passive and reports true in-flight harness execution", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-worker-telemetry-"));
    const runtime = await createRuntime(config(dataDir));
    try {
        const queued = await runtime.orchestrator.submit({ title: "delayed work", requiredCapabilities: ["demo"], preferredAgentId: "worker" });
        const before = await collectWorkerTelemetry(runtime.orchestrator);
        const workerBefore = before.find((entry) => entry.id === "worker");
        assert.equal(workerBefore.inFlightHarnessCount, 0);
        assert.equal(workerBefore.compatibleQueuedCount, 1);
        assert.equal(workerBefore.runnableQueuedCount, 1);
        assert.equal((await runtime.orchestrator.listTasks()).find((task) => task.id === queued.id).status, "queued");

        const runningPromise = runtime.orchestrator.runNext();
        await waitFor(async () => (await collectWorkerTelemetry(runtime.orchestrator)).find((entry) => entry.id === "worker")?.inFlightHarnessCount === 1);
        const workerDuring = (await collectWorkerTelemetry(runtime.orchestrator)).find((entry) => entry.id === "worker");
        assert.equal(workerDuring.inFlightHarnessCount, 1);
        assert.equal(workerDuring.remainingHarnessCapacity, 1);
        assert.deepEqual(workerDuring.activeTaskIds, [queued.id]);
        await runningPromise;
        assert.equal((await collectWorkerTelemetry(runtime.orchestrator)).find((entry) => entry.id === "worker").inFlightHarnessCount, 0);
    }
    finally { await runtime.close(); }
});

test("same agent ids in different runtimes do not share harness activity", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "sovereign-worker-runtime-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "sovereign-worker-runtime-b-"));
    const runtimeA = await createRuntime(config(dirA));
    const runtimeB = await createRuntime(config(dirB));
    try {
        await runtimeA.orchestrator.submit({ title: "runtime A work", requiredCapabilities: ["demo"], preferredAgentId: "worker" });
        const running = runtimeA.orchestrator.runNext();
        await waitFor(async () => (await collectWorkerTelemetry(runtimeA.orchestrator)).find((entry) => entry.id === "worker")?.inFlightHarnessCount === 1);
        assert.equal((await collectWorkerTelemetry(runtimeB.orchestrator)).find((entry) => entry.id === "worker").inFlightHarnessCount, 0);
        await running;
    }
    finally { await runtimeA.close(); await runtimeB.close(); }
});

test("worker telemetry never exposes provider session ids or task payloads", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-worker-redaction-"));
    const runtime = await createRuntime(config(dataDir));
    const secretSession = "provider-session-SHOULD-NEVER-LEAK";
    const secretInput = "PRIVATE-TASK-INPUT-SHOULD-NOT-LEAK";
    try {
        const task = await runtime.orchestrator.submit({ title: "session task", input: secretInput, requiredCapabilities: ["demo"], preferredAgentId: "worker" });
        await runtime.orchestrator.tasks.update(task.id, (current) => ({ ...current, assignedAgentId: "worker", harnessState: { kind: "codex", sessionId: secretSession } }));
        const snapshot = await collectWorkerTelemetry(runtime.orchestrator);
        const serialized = JSON.stringify(snapshot);
        assert.equal(serialized.includes(secretSession), false);
        assert.equal(serialized.includes(secretInput), false);
        assert.equal(serialized.includes("harnessState"), false);
        assert.equal(snapshot.find((entry) => entry.id === "worker").resumableSessionTaskCount, 1);
    }
    finally { await runtime.close(); }
});

test("supervisor is not counted as compatible execution capacity unless task explicitly allows it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-worker-supervisor-"));
    const runtime = await createRuntime(config(dataDir));
    try {
        await runtime.orchestrator.submit({ title: "worker only", requiredCapabilities: ["demo"] });
        await runtime.orchestrator.submit({ title: "supervisor allowed", requiredCapabilities: ["demo"], allowSupervisorExecution: true });
        const snapshot = await collectWorkerTelemetry(runtime.orchestrator);
        assert.equal(snapshot.find((entry) => entry.id === "worker").compatibleQueuedCount, 2);
        assert.equal(snapshot.find((entry) => entry.id === "supervisor").compatibleQueuedCount, 1);
    }
    finally { await runtime.close(); }
});

test("operator workers endpoint remains session-authenticated and redacted", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-worker-api-"));
    const runtime = await createRuntime(config(dataDir));
    const session = await runtime.operatorSessions.issue({ ttlMs: 60_000 });
    const server = await startServer(runtime);
    try {
        assert.equal((await fetch(`${server.url}/operator/workers`)).status, 401);
        const response = await fetch(`${server.url}/operator/workers`, { headers: { authorization: `Bearer ${session.token}` } });
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.equal(body.includes(session.token), false);
        assert.equal(body.includes("harnessState"), false);
    }
    finally { await server.close(); await runtime.close(); }
});
