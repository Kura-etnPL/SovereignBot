import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createWorkerNodeClient } from "../src/worker-node-client.js";
import { WorkerNodeDispatchStore } from "../src/worker-node-dispatch-store.js";
import { startWorkerNodeServer, validateWorkerNodeConfig } from "../src/worker-node-server.js";

const protocol = "sovereign-worker/1";
const token = "b".repeat(43);

function fakeRuntime(resultText = "completed") {
    const tasks = [];
    let sequence = 0;
    let providerInvocations = 0;
    const makeTaskId = () => `task_${String(++sequence).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const orchestrator = {
        async createPlan(value) { return { id: `task_plan-${sequence}`, ...value }; },
        async delegateTrusted(planId, spec, context) {
            const task = { id: makeTaskId(), planId, ...spec, executionContext: context, status: "queued" };
            tasks.push(task);
            return structuredClone(task);
        },
        async runUntilIdle() {
            for (const task of tasks) {
                if (task.status !== "queued") continue;
                task.status = "completed";
                task.result = { text: resultText, sessionId: "provider-session-canary" };
                providerInvocations += 1;
            }
        },
        async listTasks() { return structuredClone(tasks); },
        async requireTask(id) {
            const task = tasks.find((entry) => entry.id === id);
            if (!task) throw new Error("missing task");
            return structuredClone(task);
        },
        async cancel(id) {
            const task = tasks.find((entry) => entry.id === id);
            if (task) task.status = "cancelled";
            return task;
        },
    };
    return { orchestrator, get providerInvocations() { return providerInvocations; }, tasks };
}

async function rawRequest(url, { method = "GET", tokenValue, body } = {}) {
    const target = new URL(url);
    const text = body === undefined ? "" : JSON.stringify(body);
    return await new Promise((resolve, reject) => {
        const request = httpRequest({ hostname: target.hostname.replace(/^\[|\]$/g, ""), port: target.port, path: target.pathname, method, headers: { ...(tokenValue ? { authorization: `Bearer ${tokenValue}` } : {}), "content-type": "application/json", "content-length": Buffer.byteLength(text) } }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        });
        request.on("error", reject);
        if (text) request.write(text);
        request.end();
    });
}

async function fixture({ bindHost = "127.0.0.1" } = {}) {
    const root = await mkdtemp(join(tmpdir(), "sovereign-v45-unit-server-"));
    const dataDir = join(root, "node-data");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const config = {
        dataDir,
        name: "Unit Worker",
        bindHost,
        port: 0,
        supervisorAgentId: "supervisor",
        workerAgentId: "worker",
        workspaces: [{ id: "ws_main", name: "Main workspace", path: workspace }],
        agents: [
            { id: "supervisor", name: "Supervisor", role: "supervisor", capabilities: ["planning"], harness: { kind: "echo" } },
            { id: "worker", name: "Worker", role: "worker", capabilities: ["general", "coding"], harness: { kind: "echo" } },
        ],
        policy: { repeatWindowMs: 180000, repeatMaxActiveFingerprints: 10000, rules: [] },
    };
    const runtime = fakeRuntime(`completed cwd=${workspace} /home/runner/project /opt/worker/result`);
    const identity = { nodeId: "worker_0123456789abcdef", token, name: "Unit Worker" };
    const server = await startWorkerNodeServer({ config, runtime, identity });
    return { root, dataDir, workspace, config, runtime, identity, server, client: createWorkerNodeClient({ endpoint: server.url, token }) };
}

test("Worker Node server is authenticated, redacted, idempotent, and fail-closed", async () => {
    const f = await fixture();
    try {
        const health = await f.client.health();
        const healthText = JSON.stringify(health);
        assert.equal(health.protocol, protocol);
        assert.equal(health.workspaces[0].id, "ws_main");
        assert.equal(healthText.includes(token), false);
        assert.equal(healthText.includes(f.workspace), false);
        assert.equal((await rawRequest(`${f.server.url}/v1/health`, { tokenValue: "wrong" })).status, 401);
        assert.equal((await rawRequest(`${f.server.url}/v1/health`)).status, 401);
        assert.equal((await rawRequest(`${f.server.url}/v1/dispatch`, { tokenValue: "wrong", method: "POST", body: {} })).status, 401);

        const body = { protocol, requestId: "worker_request_0123456789abcdef", jobId: "job_0123456789abcdef", title: "One task", instruction: "Do it", workspaceId: "ws_main", requiredCapabilities: ["general"], attempt: 0, createdAt: new Date().toISOString() };
        const first = await f.client.dispatch(body);
        const same = await f.client.dispatch(body);
        assert.match(first.remoteTaskId, /^task_/);
        assert.equal(same.remoteTaskId, first.remoteTaskId);
        assert.equal(same.duplicate, true);
        await assert.rejects(() => f.client.dispatch({ ...body, instruction: "different" }), /conflicts/);
        await assert.rejects(() => f.client.dispatch({ ...body, requestId: "worker_request_fedcba9876543210", workspaceId: "ws_missing" }), /rejected/);
        await assert.rejects(() => f.client.dispatch({ ...body, requestId: "worker_request_1111111111111111", requiredCapabilities: ["browser"] }), /rejected/);
        let status;
        for (let i = 0; i < 20; i += 1) { status = await f.client.getTask(first.remoteTaskId); if (status.status === "completed") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
        assert.equal(status.status, "completed");
        assert.equal(status.result, "completed cwd=<node-local-workspace> <node-local-path> <node-local-path>");
        assert.equal(status.result.includes(f.workspace), false);
        assert.equal(status.result.includes("/home/runner/project"), false);
        assert.equal(status.result.includes("/opt/worker/result"), false);
        assert.equal(JSON.stringify(status).includes("provider-session-canary"), false);
        assert.equal(f.runtime.providerInvocations, 1);

        const rejected = await rawRequest(`${f.server.url}/v1/dispatch`, { tokenValue: token, method: "POST", body: { ...body, requestId: "worker_request_2222222222222222", cwd: f.workspace } });
        assert.equal(rejected.status, 400);
        const publicLedger = JSON.parse(await readFile(join(f.dataDir, "worker-node-dispatch-ledger.json"), "utf8"));
        assert.equal(JSON.stringify(publicLedger).includes(token), false);
        assert.equal(JSON.stringify(publicLedger).includes(f.workspace), false);
    }
    finally {
        await f.server.close();
        await rm(f.root, { recursive: true, force: true });
    }
});

test("Worker Node accepts numeric IPv6 loopback and authenticates every v1 route", async () => {
    const f = await fixture({ bindHost: "::1" });
    try {
        const health = await f.client.health();
        assert.equal(health.protocol, protocol);
        assert.equal((await rawRequest(`${f.server.url}/v1/health`, { tokenValue: token })).status, 200);
        assert.equal((await rawRequest(`${f.server.url}/v1/health`, { tokenValue: "wrong" })).status, 401);
    }
    finally {
        await f.server.close();
        await rm(f.root, { recursive: true, force: true });
    }
});

test("dispatch ledger marks active work interrupted after restart and never replays", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-v45-unit-ledger-"));
    try {
        const first = new WorkerNodeDispatchStore(root);
        await first.put({ requestId: "worker_request_0123456789abcdef", bodyHash: "a".repeat(64), planId: "task_plan", remoteTaskId: "task_00000001-1111-4111-8111-111111111111", status: "running", statusSummary: "running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        const restarted = new WorkerNodeDispatchStore(root);
        const record = await restarted.get("worker_request_0123456789abcdef");
        assert.equal(record.status, "failed");
        assert.match(record.statusSummary, /interrupted/);
    }
    finally { await rm(root, { recursive: true, force: true }); }
});

test("worker node configuration rejects non-loopback bind and authority-bearing worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-v45-config-"));
    try {
        const workspace = join(root, "workspace");
        const base = { dataDir: join(root, "data"), name: "x", bindHost: "127.0.0.1", port: 1, supervisorAgentId: "sup", workerAgentId: "wrk", workspaces: [{ id: "ws_main", name: "Main", path: workspace }], agents: [{ id: "sup", role: "supervisor", capabilities: [], harness: { kind: "echo" } }, { id: "wrk", role: "worker", capabilities: [], harness: { kind: "echo" } }], policy: { rules: [] } };
        await mkdir(workspace, { recursive: true });
        assert.throws(() => validateWorkerNodeConfig({ ...base, bindHost: "0.0.0.0" }), /loopback/);
        assert.throws(() => validateWorkerNodeConfig({ ...base, agents: [...base.agents.slice(0, 1), { ...base.agents[1], capabilities: ["browser"] }] }), /browser/);
    }
    finally { await rm(root, { recursive: true, force: true }); }
});
