import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerNodeClient } from "../src/worker-node-client.js";
import { startWorkerNodeServer } from "../src/worker-node-server.js";

const token = "c".repeat(43);
const nodeId = "worker_0123456789abcdef";
const computerId = "computer_0123456789abcdef";

test("loopback Worker Node exposes only bounded Worker Computer actions with durable idempotency", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-worker-computer-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const calls = [];
    const config = {
        dataDir: join(root, "data"), name: "Computer Node", bindHost: "127.0.0.1", port: 0,
        supervisorAgentId: "supervisor", workerAgentId: "worker",
        workspaces: [{ id: "ws_main", name: "Main", path: workspace }],
        agents: [
            { id: "supervisor", role: "supervisor", capabilities: ["planning"], harness: { kind: "echo" } },
            { id: "worker", role: "worker", capabilities: ["general"], harness: { kind: "echo" } },
        ],
        policy: { rules: [] },
    };
    const runtime = { orchestrator: { async listTasks() { return []; }, async createPlan() { return { id: "plan_1" }; }, async delegateTrusted() { throw new Error("not used"); }, async runUntilIdle() {} } };
    const server = await startWorkerNodeServer({
        config,
        runtime,
        identity: { nodeId, name: "Computer Node", token },
        computerAdapter: {
            health() { return { computer: { id: computerId, name: "Loopback Computer", state: "online", capacity: 1, currentLoad: 0, capabilities: ["snapshot", "type"] } }; },
            async execute(action) { calls.push(action); return { snapshotId: "snapshot_0123456789abcdef", operation: action.operation, applied: true, privatePath: workspace }; },
        },
    });
    try {
        const client = createWorkerNodeClient({ endpoint: server.url, token });
        const health = await client.computerHealth();
        assert.deepEqual(health.computer, { id: computerId, name: "Loopback Computer", state: "online", capacity: 1, currentLoad: 0, capabilities: ["snapshot", "type"] });
        const body = { protocol: "sovereign-worker-computer/1", requestId: "computer_request_0123456789abcdef", jobId: "job_0123456789abcdef", ownerCoworkerId: "coworker_0123456789abcdef", workspaceId: "ws_main", computerId, operation: "snapshot", input: {}, attempt: 0, createdAt: new Date().toISOString() };
        const first = await client.computerAction(body);
        const same = await client.computerAction(body);
        assert.equal(first.status, "completed");
        assert.equal(same.duplicate, true);
        assert.equal(calls.length, 1);
        assert.equal(JSON.stringify(first).includes(workspace), false);
        await assert.rejects(() => client.computerAction({ ...body, requestId: "computer_request_fedcba9876543210", operation: "type", input: { snapshotId: "s", ref: "r", text: "bearer: leaked" } }), /private|secret|rejected|failed/);
        await assert.rejects(() => client.computerAction({ ...body, requestId: "computer_request_1111111111111111", computerId: "computer_ffffffffffffffff" }), /rejected|failed/);
        const ledger = JSON.parse(await readFile(join(config.dataDir, "worker-computer-action-ledger.json"), "utf8"));
        assert.equal(ledger.entries.length, 1);
        assert.equal(JSON.stringify(ledger).includes(workspace), false);
        assert.equal(JSON.stringify(ledger).includes(token), false);
    } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
    }
});
