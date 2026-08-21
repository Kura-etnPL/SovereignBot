import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GovernedToolBridgeManager } from "../src/governed-tool-bridge.js";
import { startMcpClient } from "./helpers/mcp-client.mjs";

const task = {
    id: "task-audit-bridge",
    status: "running",
    assignedAgentId: "worker",
};
const agent = {
    id: "worker",
    name: "Worker",
    role: "worker",
    capabilities: ["browser"],
    governedTools: ["computer"],
    harness: { kind: "codex" },
};

test("bridge opening audit failure revokes authority and removes bootstrap files", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-bridge-open-audit-"));
    const manager = new GovernedToolBridgeManager({
        dataDir: root,
        computer: {},
        audit: {
            async append(record) {
                if (record.type === "tool_bridge.opened")
                    throw new Error("simulated audit failure");
            },
        },
    });

    try {
        await assert.rejects(
            () => manager.prepare({ task, agent, signal: new AbortController().signal }),
            /simulated audit failure/,
        );
        const files = await readdir(join(root, "tool-bridges")).catch(() => []);
        assert.deepEqual(files, []);
    }
    finally {
        await manager.close();
    }
});

test("bridge invocation audit failure happens before computer side effects and close audit cannot fail a task", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-bridge-call-audit-"));
    let snapshots = 0;
    const manager = new GovernedToolBridgeManager({
        dataDir: root,
        computer: {
            async snapshot() {
                snapshots += 1;
                return { snapshotId: "snapshot-1", url: "https://example.test", elements: [] };
            },
        },
        audit: {
            async append(record) {
                if (record.type === "tool_bridge.invoking")
                    throw new Error("simulated invocation audit failure");
                if (record.type === "tool_bridge.closed")
                    throw new Error("simulated close audit failure");
            },
        },
    });

    const bridge = await manager.prepare({ task, agent, signal: new AbortController().signal });
    const mcp = await startMcpClient(bridge.command, bridge.args);
    try {
        const result = await mcp.call("snapshot");
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /simulated invocation audit failure/);
        assert.equal(snapshots, 0, "computer side effect must not occur when pre-action audit fails");

        await assert.doesNotReject(() => bridge.close("test cleanup"));
    }
    finally {
        await mcp.close();
        await manager.close();
    }
});
