import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComputerActionRefusedError } from "../src/computer-gateway.js";
import { createMemoryComputerDriverFactory } from "../src/computer-driver.js";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

function config(dataDir, computer = {}) {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        computer,
        agents: [
            { id: "worker-a", name: "Worker A", role: "worker", capabilities: [], harness: { kind: "echo" } },
            { id: "worker-b", name: "Worker B", role: "worker", capabilities: [], harness: { kind: "echo" } },
        ],
        policy: {
            rules: [
                {
                    id: "deny-blocked-host",
                    effect: "deny",
                    match: { category: "computer", pageHostGlob: "blocked.example" },
                },
                {
                    id: "allow-computer-core",
                    effect: "allow",
                    match: { category: "computer" },
                },
            ],
        },
    };
}

async function runtimeFor(computer = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-computer-"));
    const factory = createMemoryComputerDriverFactory();
    const runtime = await createRuntime(config(dataDir, computer), { computerDriverFactory: factory });
    return { dataDir, factory, runtime };
}

async function preparePage(runtime, factory, agentId, url, elements) {
    await runtime.computer.snapshot(agentId, `bootstrap:${agentId}`);
    factory.get(agentId).setPage(url, elements);
    return runtime.computer.snapshot(agentId, `snapshot:${agentId}`);
}

test("server-held snapshots isolate agents and reject stale or invented refs", async () => {
    const { dataDir, factory, runtime } = await runtimeFor();
    const a = await preparePage(runtime, factory, "worker-a", "https://a.example/app", [
        { ref: "login", backendRef: "backend-a", role: "button", name: "Sign in" },
        { ref: "field", backendRef: "field-a", role: "textbox", name: "Email" },
    ]);
    const b = await preparePage(runtime, factory, "worker-b", "https://b.example/app", [
        { ref: "login", backendRef: "backend-b", role: "button", name: "Different button" },
    ]);

    assert.equal(a.elements[0].backendRef, undefined);
    assert.equal(b.elements[0].name, "Different button");

    await runtime.computer.click("worker-a", "task-a", { snapshotId: a.snapshotId, ref: "login" });
    const clicks = factory.get("worker-a").actions().filter((action) => action.operation === "click");
    assert.equal(clicks.at(-1).backendRef, "backend-a");

    await runtime.computer.type("worker-a", "task-a", {
        snapshotId: a.snapshotId,
        ref: "field",
        text: "NORMAL-TEXT-MUST-NOT-ENTER-AUDIT",
    });
    assert.equal((await readFile(join(dataDir, "audit.jsonl"), "utf8")).includes("NORMAL-TEXT-MUST-NOT-ENTER-AUDIT"), false);

    const fresh = await runtime.computer.snapshot("worker-a", "task-a");
    const clickCount = factory.get("worker-a").actions().filter((action) => action.operation === "click").length;
    await assert.rejects(
        () => runtime.computer.click("worker-a", "task-a", { snapshotId: a.snapshotId, ref: "login" }),
        (error) => error instanceof ComputerActionRefusedError && /stale/.test(error.message),
    );
    await assert.rejects(
        () => runtime.computer.click("worker-a", "task-a", { snapshotId: fresh.snapshotId, ref: "made-up" }),
        (error) => error instanceof ComputerActionRefusedError && /not present/.test(error.message),
    );
    assert.equal(factory.get("worker-a").actions().filter((action) => action.operation === "click").length, clickCount);
    assert.equal((await runtime.audit.verify()).ok, true);
});

test("navigation hard guards beat broad allow rules and audit strips query secrets", async () => {
    const { dataDir, runtime } = await runtimeFor();
    await assert.rejects(
        () => runtime.computer.navigate("worker-a", "nav", "http://169.254.169.254/latest/meta-data"),
        (error) => error instanceof ComputerActionRefusedError && /metadata/.test(error.message),
    );
    await assert.rejects(
        () => runtime.computer.navigate("worker-a", "nav", "http://127.0.0.1:3000/private"),
        (error) => error instanceof ComputerActionRefusedError && /private\/loopback/.test(error.message),
    );
    await assert.rejects(
        () => runtime.computer.navigate("worker-a", "nav", "javascript:alert(1)"),
        (error) => error instanceof ComputerActionRefusedError && /http\/https/.test(error.message),
    );
    await assert.rejects(
        () => runtime.computer.navigate("worker-a", "nav", "https://blocked.example/path"),
        (error) => error instanceof ComputerActionRefusedError && error.decision?.ruleId === "deny-blocked-host",
    );

    await runtime.computer.navigate(
        "worker-a",
        "nav",
        "https://example.com/path?token=QUERY-SECRET-MUST-NOT-BE-AUDITED#fragment",
    );
    const audit = await readFile(join(dataDir, "audit.jsonl"), "utf8");
    assert.equal(audit.includes("QUERY-SECRET-MUST-NOT-BE-AUDITED"), false);

    const privateRuntime = await runtimeFor({ allowPrivateHosts: true });
    await privateRuntime.runtime.computer.navigate("worker-a", "nav", "http://127.0.0.1:3000/allowed-local");
    await assert.rejects(
        () => privateRuntime.runtime.computer.navigate("worker-a", "nav", "http://169.254.169.254/latest/meta-data"),
        /metadata/,
    );
});

test("per-agent workspaces isolate files and fail closed on traversal", async () => {
    const { runtime } = await runtimeFor();
    await runtime.computer.writeFile("worker-a", "files", { path: "notes/a.txt", content: "only-a" });
    assert.equal(await runtime.computer.readFile("worker-a", "files", { path: "notes/a.txt" }), "only-a");
    await assert.rejects(
        () => runtime.computer.readFile("worker-b", "files", { path: "notes/a.txt" }),
        /ENOENT/,
    );
    await assert.rejects(
        () => runtime.computer.writeFile("worker-a", "files", { path: "../escape.txt", content: "nope" }),
        (error) => error instanceof ComputerActionRefusedError && /escapes/.test(error.message),
    );
});

test("help and human takeover freeze agent actions and control survives restart", async () => {
    const { dataDir, factory, runtime } = await runtimeFor();
    const page = await preparePage(runtime, factory, "worker-a", "https://example.com", [
        { ref: "go", backendRef: "go-backend", role: "button", name: "Go" },
    ]);

    await runtime.computer.requestHelp("worker-a", "task-a", "2FA required");
    await assert.rejects(
        () => runtime.computer.click("worker-a", "task-a", { snapshotId: page.snapshotId, ref: "go" }),
        /human help was requested/,
    );

    await runtime.computer.takeControl("worker-a", "operator@example");
    await assert.rejects(
        () => runtime.computer.click("worker-a", "task-a", { snapshotId: page.snapshotId, ref: "go" }),
        /human control is active/,
    );

    const restarted = await createRuntime(config(dataDir), { computerDriverFactory: createMemoryComputerDriverFactory() });
    assert.equal((await restarted.computer.control("worker-a")).mode, "human");

    await runtime.computer.releaseControl("worker-a", "operator@example");
    await runtime.computer.click("worker-a", "task-a", { snapshotId: page.snapshotId, ref: "go" });
    assert.equal((await runtime.audit.verify()).ok, true);
});

test("secret channel pauses the agent and never writes plaintext to audit", async () => {
    const { dataDir, factory, runtime } = await runtimeFor();
    const page = await preparePage(runtime, factory, "worker-a", "https://login.example", [
        { ref: "password", backendRef: "password-backend", role: "textbox", name: "Password", type: "password" },
    ]);
    const request = await runtime.computer.requestSecret("worker-a", "task-secret", {
        snapshotId: page.snapshotId,
        ref: "password",
        label: "account password",
    });
    assert.equal((await runtime.computer.control("worker-a")).mode, "requested");
    await assert.rejects(
        () => runtime.computer.type("worker-a", "task-secret", {
            snapshotId: page.snapshotId,
            ref: "password",
            text: "agent-should-not-type-now",
        }),
        /human help was requested/,
    );

    const secret = "SUPER-SECRET-123!";
    const supplied = await runtime.computer.supplySecret("worker-a", "operator@example", request.id, secret);
    assert.equal(supplied.characters, [...secret].length);
    assert.equal((await runtime.computer.control("worker-a")).mode, "agent");
    const secretActions = factory.get("worker-a").actions().filter((action) => action.operation === "secret");
    assert.equal(secretActions.at(-1).characters, [...secret].length);

    const audit = await readFile(join(dataDir, "audit.jsonl"), "utf8");
    assert.equal(audit.includes(secret), false);
    assert.equal(audit.includes("agent-should-not-type-now"), false);
    assert.equal((await runtime.audit.verify()).ok, true);

    const nextPage = await runtime.computer.snapshot("worker-a", "task-secret-2");
    const nextRequest = await runtime.computer.requestSecret("worker-a", "task-secret-2", {
        snapshotId: nextPage.snapshotId,
        ref: "password",
        label: "second password",
    });
    const restarted = await createRuntime(config(dataDir), { computerDriverFactory: createMemoryComputerDriverFactory() });
    await assert.rejects(
        () => restarted.computer.supplySecret("worker-a", "operator@example", nextRequest.id, "NEVER-LOG-ME"),
        /fresh snapshot/,
    );
    assert.equal((await readFile(join(dataDir, "audit.jsonl"), "utf8")).includes("NEVER-LOG-ME"), false);
});

test("computer API enforces per-agent tokens and a separate operator token", async () => {
    const { factory, runtime } = await runtimeFor();
    await preparePage(runtime, factory, "worker-a", "https://example.com", []);
    await preparePage(runtime, factory, "worker-b", "https://example.org", []);
    const a = await runtime.computer.agentCredentials("worker-a");
    const operator = await runtime.computer.operatorCredentials();
    const server = await startServer(runtime);

    const post = (path, token, body) => fetch(`${server.url}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body ?? {}),
    });

    try {
        assert.equal((await post("/computers/worker-a/snapshot", undefined, { taskId: "api" })).status, 401);
        assert.equal((await post("/computers/worker-a/snapshot", a.token, { taskId: "api" })).status, 200);
        assert.equal((await post("/computers/worker-b/snapshot", a.token, { taskId: "api" })).status, 401);
        assert.equal((await post("/computers/worker-a/control/take", a.token, { actorId: "operator" })).status, 401);
        assert.equal((await post("/computers/worker-a/control/take", operator.token, { actorId: "operator" })).status, 200);
        assert.equal((await post("/computers/worker-a/snapshot", a.token, { taskId: "api" })).status, 403);
        assert.equal((await post("/computers/worker-a/control/release", operator.token, { actorId: "operator" })).status, 200);
        assert.equal((await post("/computers/worker-a/snapshot", a.token, { taskId: "api" })).status, 200);

        const list = await fetch(`${server.url}/computers`, {
            headers: { authorization: `Bearer ${operator.token}` },
        });
        assert.equal(list.status, 200);
        assert.equal((await list.json()).length, 2);
    }
    finally {
        await server.close();
    }
});
