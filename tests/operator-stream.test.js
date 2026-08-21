import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

function ndjsonReader(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return {
        reader,
        async next(timeoutMs = 3500) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const newline = buffer.indexOf("\n");
                if (newline >= 0) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    if (line.trim())
                        return JSON.parse(line);
                    continue;
                }
                const remaining = Math.max(1, deadline - Date.now());
                const result = await Promise.race([
                    reader.read(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("stream read timed out")), remaining)),
                ]);
                if (result.done) {
                    if (buffer.trim()) {
                        const value = JSON.parse(buffer);
                        buffer = "";
                        return value;
                    }
                    return undefined;
                }
                buffer += decoder.decode(result.value, { stream: true });
            }
            throw new Error("stream read timed out");
        },
    };
}

async function waitFor(predicate, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate())
            return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("condition did not become true");
}

async function runtimeAndServer() {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-operator-stream-"));
    const runtime = await createRuntime({
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [{ id: "worker", name: "Worker", role: "worker", capabilities: [], harness: { kind: "echo" } }],
        policy: { rules: [] },
    });
    const server = await startServer(runtime);
    return { runtime, server };
}

test("operator telemetry requires a valid same-origin short-lived session", async () => {
    const { runtime, server } = await runtimeAndServer();
    const session = await runtime.operatorSessions.issue({ ttlMs: 60_000 });
    try {
        assert.equal((await fetch(`${server.url}/operator/stream`)).status, 401);
        const crossOrigin = await fetch(`${server.url}/operator/stream`, {
            headers: {
                authorization: `Bearer ${session.token}`,
                origin: "https://evil.example",
            },
        });
        assert.equal(crossOrigin.status, 403);
    }
    finally {
        await server.close();
        await runtime.close();
    }
});

test("operator telemetry emits minimal task/audit notifications and revoke closes the stream", async () => {
    const { runtime, server } = await runtimeAndServer();
    const session = await runtime.operatorSessions.issue({ ttlMs: 60_000 });
    const secret = "STREAM-SECRET-MUST-NOT-LEAK";
    try {
        const response = await fetch(`${server.url}/operator/stream`, {
            headers: {
                authorization: `Bearer ${session.token}`,
                origin: server.url,
            },
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
        const stream = ndjsonReader(response);
        const connected = await stream.next();
        assert.equal(connected.source, "system");
        assert.equal(connected.type, "connected");
        assert.equal(runtime.taskEvents.subscriberCount(), 1);
        assert.equal(runtime.audit.subscriberCount(), 1);

        await runtime.taskEvents.append({
            taskId: "task-stream",
            type: "task.progress",
            actor: "worker",
            data: { message: secret, secret },
        });
        await runtime.audit.append({
            type: "computer.secret_requested",
            actor: "worker",
            subject: `secret-subject-${secret}`,
            data: { secret, value: secret },
        });

        const taskNotice = await stream.next();
        const auditNotice = await stream.next();
        assert.deepEqual(
            { source: taskNotice.source, type: taskNotice.type, taskId: taskNotice.taskId },
            { source: "task", type: "task.progress", taskId: "task-stream" },
        );
        assert.equal(auditNotice.source, "audit");
        assert.equal(auditNotice.type, "computer.secret_requested");
        const serialized = JSON.stringify([taskNotice, auditNotice]);
        assert.equal(serialized.includes(secret), false);
        assert.equal(serialized.includes(session.token), false);
        assert.equal("data" in taskNotice, false);
        assert.equal("subject" in auditNotice, false);
        assert.equal("actor" in auditNotice, false);

        await runtime.operatorSessions.revoke(session.token);
        let ended;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const notice = await stream.next(2500);
            if (!notice)
                break;
            if (notice.type === "session-ended") {
                ended = notice;
                break;
            }
        }
        assert.equal(ended?.source, "system");
        await waitFor(() => runtime.taskEvents.subscriberCount() === 0 && runtime.audit.subscriberCount() === 0);
    }
    finally {
        await server.close();
        await runtime.close();
    }
});

test("operator telemetry expires an already-open stream", async () => {
    const { runtime, server } = await runtimeAndServer();
    const session = await runtime.operatorSessions.issue({ ttlMs: 1_500 });
    try {
        const response = await fetch(`${server.url}/operator/stream`, {
            headers: {
                authorization: `Bearer ${session.token}`,
                origin: server.url,
            },
        });
        assert.equal(response.status, 200);
        const stream = ndjsonReader(response);
        assert.equal((await stream.next()).type, "connected");

        let ended;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const notice = await stream.next(3500);
            if (!notice)
                break;
            if (notice.type === "session-ended") {
                ended = notice;
                break;
            }
        }
        assert.equal(ended?.source, "system");
        assert.equal(ended?.type, "session-ended");
        assert.equal(await runtime.operatorSessions.authenticate(session.token), false);
        await waitFor(() => runtime.taskEvents.subscriberCount() === 0 && runtime.audit.subscriberCount() === 0);
    }
    finally {
        await server.close();
        await runtime.close();
    }
});

test("operator telemetry removes listeners when the client disconnects", async () => {
    const { runtime, server } = await runtimeAndServer();
    const session = await runtime.operatorSessions.issue({ ttlMs: 60_000 });
    const controller = new AbortController();
    try {
        const response = await fetch(`${server.url}/operator/stream`, {
            signal: controller.signal,
            headers: {
                authorization: `Bearer ${session.token}`,
                origin: server.url,
            },
        });
        const stream = ndjsonReader(response);
        assert.equal((await stream.next()).type, "connected");
        assert.equal(runtime.taskEvents.subscriberCount(), 1);
        assert.equal(runtime.audit.subscriberCount(), 1);
        controller.abort();
        await stream.reader.cancel().catch(() => undefined);
        await waitFor(() => runtime.taskEvents.subscriberCount() === 0 && runtime.audit.subscriberCount() === 0);
    }
    finally {
        await server.close();
        await runtime.close();
    }
});
