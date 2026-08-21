import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

test("operator overview uses passive computer status and never instantiates a driver", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-operator-passive-"));
    let instantiateCalls = 0;
    const factory = {
        get() { return undefined; },
        async forComputer() {
            instantiateCalls += 1;
            throw new Error("dashboard must not instantiate a computer driver");
        },
        async close() {},
    };
    const runtime = await createRuntime({
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [{ id: "worker", name: "Worker", role: "worker", capabilities: [], harness: { kind: "echo" } }],
        policy: { rules: [] },
    }, { computerDriverFactory: factory });
    const session = await runtime.operatorSessions.issue({ ttlMs: 60_000 });
    const server = await startServer(runtime);
    try {
        const response = await fetch(`${server.url}/operator/overview`, {
            headers: { authorization: `Bearer ${session.token}` },
        });
        assert.equal(response.status, 200);
        const overview = await response.json();
        assert.equal(instantiateCalls, 0);
        assert.equal(overview.computers[0].lifecycle.running, false);
    }
    finally {
        await server.close();
        await runtime.close();
    }
});
