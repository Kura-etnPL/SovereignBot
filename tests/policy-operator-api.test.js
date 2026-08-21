import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

const initialPolicy = {
    rules: [{ id: "allow-harness", effect: "allow", match: { category: "harness" } }],
};
const denyPolicy = {
    rules: [
        { id: "deny-echo", effect: "deny", match: { category: "harness", operation: "run", targetGlob: "echo" } },
        { id: "allow-harness", effect: "allow", match: { category: "harness" } },
    ],
};
const action = { category: "harness", operation: "run", target: "echo", agentId: "worker", taskId: "sim" };
const checks = [{ action, repeatCount: 1, expect: { allowed: false, ruleId: "deny-echo" } }];

function config(dataDir) {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [{ id: "worker", name: "Worker", role: "worker", capabilities: [], harness: { kind: "echo" } }],
        policy: initialPolicy,
    };
}

test("operator policy apply/history/rollback require the short-lived operator session and remain redacted", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-policy-api-"));
    const runtime = await createRuntime(config(dataDir));
    const session = await runtime.operatorSessions.issue({ ttlMs: 60_000, label: "policy-test" });
    const workerToken = (await runtime.computer.agentCredentials("worker")).token;
    const server = await startServer(runtime);
    const auth = { authorization: `Bearer ${session.token}` };
    const mutationHeaders = { ...auth, origin: server.url, "content-type": "application/json" };
    try {
        assert.equal((await fetch(`${server.url}/operator/policy`)).status, 401);
        assert.equal((await fetch(`${server.url}/operator/policy`, {
            headers: { authorization: `Bearer ${workerToken}` },
        })).status, 401);

        const beforeResponse = await fetch(`${server.url}/operator/policy`, { headers: auth });
        assert.equal(beforeResponse.status, 200);
        const before = await beforeResponse.json();
        const initialId = before.version.id;
        assert.equal(before.version.active, true);
        assert.equal(JSON.stringify(before).includes(session.token), false);

        const crossOrigin = await fetch(`${server.url}/operator/policy/apply`, {
            method: "POST",
            headers: { ...auth, origin: "https://evil.example", "content-type": "application/json" },
            body: JSON.stringify({ policy: denyPolicy, checks }),
        });
        assert.equal(crossOrigin.status, 403);

        const applyResponse = await fetch(`${server.url}/operator/policy/apply`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({ policy: denyPolicy, checks, label: "deny echo" }),
        });
        const applyText = await applyResponse.text();
        assert.equal(applyResponse.status, 200, applyText);
        const applied = JSON.parse(applyText);
        assert.equal(applied.active.active, true);
        assert.notEqual(applied.active.id, initialId);
        assert.equal(JSON.stringify(applied).includes(session.token), false);

        const snapshot = await (await fetch(`${server.url}/operator/policy`, { headers: auth })).json();
        assert.equal(snapshot.version.id, applied.active.id);
        assert.equal(snapshot.versions.length, 2);

        const versionResponse = await fetch(`${server.url}/operator/policy/versions/${encodeURIComponent(applied.active.id)}`, { headers: auth });
        assert.equal(versionResponse.status, 200);
        const version = await versionResponse.json();
        assert.equal(version.policy.rules[0].id, "deny-echo");
        assert.equal(JSON.stringify(version).includes(session.token), false);

        const rollbackResponse = await fetch(`${server.url}/operator/policy/rollback`, {
            method: "POST",
            headers: mutationHeaders,
            body: JSON.stringify({ versionId: initialId }),
        });
        assert.equal(rollbackResponse.status, 200);
        const rolled = await rollbackResponse.json();
        assert.equal(rolled.active.id, initialId);

        const audit = await runtime.audit.readAll();
        assert.ok(audit.some((row) => row.type === "policy.activated" && row.subject === applied.active.id));
        assert.ok(audit.some((row) => row.type === "policy.rolled_back" && row.subject === initialId));
        assert.equal(JSON.stringify(audit).includes(session.token), false);

        const versionDir = join(dataDir, "policy-versions", "versions");
        let durable = "";
        for (const name of await readdir(versionDir))
            durable += await readFile(join(versionDir, name), "utf8");
        durable += await readFile(join(dataDir, "policy-versions", "active.json"), "utf8");
        assert.equal(durable.includes(session.token), false);
    }
    finally {
        await server.close();
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});
