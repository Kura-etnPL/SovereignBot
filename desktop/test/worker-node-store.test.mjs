import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WORKER_NODE_PROTOCOL } from "../vendor/core/src/worker-node-protocol.js";
import { createWorkerNodeStore, WORKER_NODE_CREDENTIALS_SCHEMA, WORKER_NODES_SCHEMA } from "../src/main/worker-node-store.js";

const NODE_ID = "worker_0123456789abcdef";
const WORKSPACE_ID = "workspace.node";
const ENDPOINT = "http://127.0.0.1:43123";

function bundle(token) {
    return { protocol: WORKER_NODE_PROTOCOL, nodeId: NODE_ID, name: "Local Worker", endpoint: ENDPOINT, token };
}

function health() {
    return {
        protocol: WORKER_NODE_PROTOCOL,
        node: { id: NODE_ID, name: "Local Worker", platform: "win32", arch: "x64" },
        ready: true,
        capabilities: ["general"],
        workspaces: [{ id: WORKSPACE_ID, name: "Node Workspace" }],
    };
}

function fakeClientFactory(calls) {
    return ({ endpoint, token }) => {
        calls.push({ endpoint, token });
        return {
            async health() {
                if (token === "C".repeat(43)) throw new Error("Worker Node authentication failed");
                return health();
            },
            async cancel(remoteTaskId) { return { protocol: WORKER_NODE_PROTOCOL, remoteTaskId, status: "cancelled", confirmed: true }; },
        };
    };
}

test("Worker Node store keeps credentials private and only resolves healthy advertised workspaces", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-worker-store-"));
    const calls = [];
    const token = "A".repeat(43);
    const publicPath = join(dataDir, "desktop-state", "worker-nodes.json");
    const privatePath = join(dataDir, "desktop-state", "worker-node-credentials.json");
    try {
        const store = createWorkerNodeStore({ dataDir, clientFactory: fakeClientFactory(calls) });
        const paired = await store.pair(bundle(token));
        assert.equal(paired.nodeId, NODE_ID);
        assert.equal(paired.status, "online");
        assert.equal(paired.protocol, WORKER_NODE_PROTOCOL);
        assert.ok(!Object.hasOwn(paired, "token"));
        assert.ok(!Object.hasOwn(paired, "credentials"));
        assert.ok(!Object.hasOwn(paired, "privatePath"));
        assert.ok(!Object.hasOwn(paired, "endpoint"));
        assert.deepEqual(paired.workspaces, [{ id: WORKSPACE_ID, name: "Node Workspace" }]);

        const publicState = JSON.parse(await readFile(publicPath, "utf8"));
        const privateState = JSON.parse(await readFile(privatePath, "utf8"));
        assert.equal(publicState.schema, WORKER_NODES_SCHEMA);
        assert.equal(privateState.schema, WORKER_NODE_CREDENTIALS_SCHEMA);
        assert.ok(!JSON.stringify(publicState).includes(token), "public state must not contain the pairing token");
        assert.ok(!JSON.stringify(publicState).includes(privatePath), "public state must not contain credential paths");
        assert.ok(!JSON.stringify(publicState).includes(ENDPOINT), "public state must not contain the trusted transport endpoint");
        assert.equal(privateState.credentials[0].token, token);

        const reloaded = createWorkerNodeStore({ dataDir, clientFactory: fakeClientFactory(calls) });
        assert.deepEqual(reloaded.list().nodes[0].workspaces, [{ id: WORKSPACE_ID, name: "Node Workspace" }]);
        await assert.rejects(() => reloaded.pair(bundle("C".repeat(43))), /authentication failed/);
        const unchangedPrivateState = JSON.parse(await readFile(privatePath, "utf8"));
        assert.equal(unchangedPrivateState.credentials[0].token, token);
        const rotatedToken = "B".repeat(43);
        const rotated = await reloaded.pair(bundle(rotatedToken));
        assert.equal(rotated.status, "online");
        const rotatedPrivateState = JSON.parse(await readFile(privatePath, "utf8"));
        assert.equal(rotatedPrivateState.credentials[0].token, rotatedToken);

        assert.equal(reloaded.setEnabled(NODE_ID, false).status, "blocked");
        assert.throws(() => reloaded.resolveDispatchTarget(NODE_ID, WORKSPACE_ID), /unavailable or disabled/);
        assert.equal(reloaded.setEnabled(NODE_ID, true).status, "offline");
        const refreshed = await reloaded.refresh(NODE_ID);
        assert.equal(refreshed.status, "online");
        const target = reloaded.resolveDispatchTarget(NODE_ID, WORKSPACE_ID);
        assert.equal(target.node.nodeId, NODE_ID);
        assert.equal(target.workspace.id, WORKSPACE_ID);
        assert.ok(!Object.hasOwn(target.node, "token"));
        const cancelled = await reloaded.cancel(NODE_ID, "task_0123456789abcdef");
        assert.equal(cancelled.confirmed, true);
        assert.equal(calls.at(-1).token, rotatedToken);

        assert.deepEqual(reloaded.remove(NODE_ID), { removed: true });
        assert.deepEqual(reloaded.list().nodes, []);
        await assert.rejects(() => access(publicPath));
        await assert.rejects(() => access(privatePath));
    }
    finally {
        await rm(dataDir, { recursive: true, force: true });
    }
});
