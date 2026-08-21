import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { harnessActivitySubscriberCount } from "../src/harness.js";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

function streamReader(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return {
        reader,
        async next(timeoutMs = 3000) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const newline = buffer.indexOf("\n");
                if (newline >= 0) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    if (line.trim()) return JSON.parse(line);
                    continue;
                }
                const remaining = Math.max(1, deadline - Date.now());
                const result = await Promise.race([
                    reader.read(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("worker stream read timed out")), remaining)),
                ]);
                if (result.done) return undefined;
                buffer += decoder.decode(result.value, { stream: true });
            }
            throw new Error("worker stream read timed out");
        },
    };
}

async function nextWorker(stream, count) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const notice = await stream.next();
        if (notice?.source === "worker" && notice.inFlightHarnessCount === count)
            return notice;
    }
    throw new Error(`worker activity ${count} was not observed`);
}

async function waitFor(predicate, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("condition did not become true");
}

test("operator stream publishes runtime-scoped harness activity 1 -> 0 and cleans listener", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-worker-stream-"));
    const runtime = await createRuntime({
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [{ id: "worker", name: "Worker", role: "worker", capabilities: ["demo"], harness: { kind: "echo", delayMs: 400 } }],
        policy: { rules: [{ id: "allow-harness", effect: "allow", match: { category: "harness" } }] },
    });
    const session = await runtime.operatorSessions.issue({ ttlMs: 60_000 });
    const server = await startServer(runtime);
    const controller = new AbortController();
    const baseline = harnessActivitySubscriberCount();
    try {
        const response = await fetch(`${server.url}/operator/stream`, {
            signal: controller.signal,
            headers: { authorization: `Bearer ${session.token}`, origin: server.url },
        });
        assert.equal(response.status, 200);
        const stream = streamReader(response);
        assert.equal((await stream.next()).type, "connected");
        assert.equal(harnessActivitySubscriberCount(), baseline + 1);

        await runtime.orchestrator.submit({ title: "live worker", requiredCapabilities: ["demo"], preferredAgentId: "worker" });
        const running = runtime.orchestrator.runNext();
        const busy = await nextWorker(stream, 1);
        assert.equal(busy.agentId, "worker");
        assert.equal(Object.hasOwn(busy, "sessionId"), false);
        assert.equal(Object.hasOwn(busy, "data"), false);
        await running;
        const idle = await nextWorker(stream, 0);
        assert.equal(idle.agentId, "worker");

        controller.abort();
        await stream.reader.cancel().catch(() => undefined);
        await waitFor(() => harnessActivitySubscriberCount() === baseline);
    }
    finally {
        await server.close();
        await runtime.close();
    }
});
