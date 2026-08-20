import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

function config(dataDir) {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [{ id: "worker", name: "Worker", capabilities: [], harness: { kind: "echo" } }],
        policy: { rules: [{ id: "allow-computer", effect: "allow", match: { category: "computer" } }] },
    };
}

test("operator token owns health/start/stop/reset lifecycle", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-lifecycle-"));
    const calls = [];
    const driver = {
        async health() { calls.push("health"); return { ok: true, processLease: "p1", sessionLease: "s1" }; },
        async start() { calls.push("start"); return { started: true }; },
        async stop() { calls.push("stop"); return { stopped: true }; },
        async reset() { calls.push("reset"); return { reset: true }; },
    };
    const factory = { forComputer() { return driver; } };
    const runtime = await createRuntime(config(dataDir), { computerDriverFactory: factory, bindComputerToTasks: false });
    const operator = (await runtime.computer.operatorCredentials()).token;
    const agent = (await runtime.computer.agentCredentials("worker")).token;
    const server = await startServer(runtime);

    const auth = (token) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
    try {
        const denied = await fetch(`${server.url}/computers/worker/health`, { headers: auth(agent) });
        assert.equal(denied.status, 401);

        const health = await fetch(`${server.url}/computers/worker/health`, { headers: auth(operator) });
        assert.equal(health.status, 200);
        assert.equal((await health.json()).ok, true);

        for (const operation of ["start", "stop", "reset"]) {
            const response = await fetch(`${server.url}/computers/worker/lifecycle/${operation}`, {
                method: "POST",
                headers: auth(operator),
                body: JSON.stringify({ actorId: "human-operator" }),
            });
            assert.equal(response.status, 200);
        }
        assert.deepEqual(calls, ["health", "start", "stop", "reset"]);
        assert.equal((await runtime.audit.verify()).ok, true);
    }
    finally {
        await server.close();
    }
});
