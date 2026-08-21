import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperatorSessionStore } from "../src/operator-session.js";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

test("operator session stores only a hash, expires, and can be revoked", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-operator-session-"));
    let now = 10_000;
    const store = new OperatorSessionStore(dataDir, { now: () => now });
    await store.init();
    const session = await store.issue({ ttlMs: 1_000, label: "test" });
    assert.equal(await store.authenticate(session.token), true);
    const raw = await readFile(join(dataDir, "operator-sessions.json"), "utf8");
    assert.equal(raw.includes(session.token), false);
    assert.match(raw, /[0-9a-f]{64}/);

    assert.equal(await store.revoke(session.token), true);
    assert.equal(await store.authenticate(session.token), false);

    const expiring = await store.issue({ ttlMs: 100 });
    now += 101;
    assert.equal(await store.authenticate(expiring.token), false);
});

test("operator console is session-authenticated, same-origin for mutations, and never exposes durable operator token", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-operator-console-"));
    const runtime = await createRuntime({
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [{ id: "worker", name: "Worker", role: "worker", capabilities: [], harness: { kind: "echo" } }],
        policy: { rules: [] },
    });
    const durable = (await runtime.computer.operatorCredentials()).token;
    const session = await runtime.operatorSessions.issue({ ttlMs: 60_000 });
    const server = await startServer(runtime);
    const auth = { authorization: `Bearer ${session.token}` };
    try {
        const htmlResponse = await fetch(`${server.url}/ui/`);
        assert.equal(htmlResponse.status, 200);
        const html = await htmlResponse.text();
        assert.match(html, /SovereignBot Operator Console/);
        assert.equal(html.includes(durable), false);
        assert.match(htmlResponse.headers.get("content-security-policy"), /default-src 'none'/);

        assert.equal((await fetch(`${server.url}/operator/session`)).status, 401);
        const sessionResponse = await fetch(`${server.url}/operator/session`, { headers: auth });
        assert.equal(sessionResponse.status, 200);
        assert.equal((await sessionResponse.text()).includes(durable), false);

        const overview = await fetch(`${server.url}/operator/overview`, { headers: auth });
        assert.equal(overview.status, 200);
        const overviewText = await overview.text();
        assert.equal(overviewText.includes(durable), false);
        assert.equal(overviewText.includes(session.token), false);

        const crossOrigin = await fetch(`${server.url}/operator/computers/worker/control/take`, {
            method: "POST",
            headers: { ...auth, origin: "https://evil.example", "content-type": "application/json" },
            body: JSON.stringify({ actorId: "test" }),
        });
        assert.equal(crossOrigin.status, 403);
        assert.equal((await runtime.computer.control("worker")).mode, "agent");

        const sameOrigin = await fetch(`${server.url}/operator/computers/worker/control/take`, {
            method: "POST",
            headers: { ...auth, origin: server.url, "content-type": "application/json" },
            body: JSON.stringify({ actorId: "operator-console-test" }),
        });
        assert.equal(sameOrigin.status, 200);
        assert.equal((await runtime.computer.control("worker")).mode, "human");

        const release = await fetch(`${server.url}/operator/computers/worker/control/release`, {
            method: "POST",
            headers: { ...auth, origin: server.url, "content-type": "application/json" },
            body: JSON.stringify({ actorId: "operator-console-test" }),
        });
        assert.equal(release.status, 200);
        assert.equal((await runtime.computer.control("worker")).mode, "agent");

        const revoke = await fetch(`${server.url}/operator/session/revoke`, {
            method: "POST",
            headers: { ...auth, origin: server.url, "content-type": "application/json" },
            body: "{}",
        });
        assert.equal(revoke.status, 200);
        assert.equal((await fetch(`${server.url}/operator/session`, { headers: auth })).status, 401);
    }
    finally {
        await server.close();
        await runtime.close();
    }
});
