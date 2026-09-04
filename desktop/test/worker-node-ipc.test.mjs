import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateIpcRequest } from "../src/main/lib/ipc-schema.js";

const NODE_ID = "worker_0123456789abcdef";
const WORKSPACE_ID = "workspace.node";

test("Worker Node IPC facade is enumerated and keeps authority out of renderer payloads", async () => {
    const ipcSource = await readFile(new URL("../src/main/ipc.js", import.meta.url), "utf8");
    const preloadSource = await readFile(new URL("../src/main/preload.cjs", import.meta.url), "utf8");
    const channels = [
        "workerNode:pairViaDialog",
        "workerNode:list",
        "workerNode:get",
        "workerNode:refresh",
        "workerNode:setEnabled",
        "workerNode:remove",
    ];
    for (const channel of channels) {
        assert.match(ipcSource, new RegExp(`['\"]${channel.replace(":", "\\:")}['\"]`), channel);
    }
    assert.match(ipcSource, /if \(WORKER_NODE_CHANNELS\[channel\]\)\s*return validateWorkerNodeRequest/);
    assert.match(preloadSource, /workerNodes:\s*Object\.freeze\(/);
    assert.match(preloadSource, /pairViaDialog:\s*invoke\("workerNode:pairViaDialog"\)/);
    assert.match(preloadSource, /remove:\s*invoke\("workerNode:remove"\)/);
});

test("Worker Node execution targets use exact IPC shapes", () => {
    const base = {
        title: "Remote review",
        objective: "Review the bounded Worker Node task.",
        ownerCoworkerId: "coworker_0123456789abcdef",
    };
    assert.deepEqual(
        validateIpcRequest("job:submit", {
            ...base,
            executionTarget: { kind: "worker-node", nodeId: NODE_ID, workspaceId: WORKSPACE_ID },
        }).executionTarget,
        { kind: "worker-node", nodeId: NODE_ID, workspaceId: WORKSPACE_ID },
    );
    assert.deepEqual(validateIpcRequest("job:submit", { ...base, executionTarget: { kind: "local" } }).executionTarget, { kind: "local" });
    assert.throws(
        () => validateIpcRequest("job:submit", { ...base, executionTarget: { kind: "worker-node", nodeId: NODE_ID, workspaceId: WORKSPACE_ID, cwd: "C:\\escape" } }),
        /unexpected .*field/,
    );
    assert.throws(
        () => validateIpcRequest("job:submit", { ...base, executionTarget: { kind: "worker-node", nodeId: NODE_ID, workspaceId: WORKSPACE_ID, token: "secret" } }),
        /unexpected .*field/,
    );
    assert.throws(
        () => validateIpcRequest("job:submit", { ...base, executionTarget: { kind: "local", nodeId: NODE_ID } }),
        /unexpected .*field/,
    );
});

test("Routines and Event Triggers cannot select a Worker Node", async () => {
    const ipcSource = await readFile(new URL("../src/main/ipc.js", import.meta.url), "utf8");
    const routineStart = ipcSource.indexOf("function validateRoutineRequest");
    const eventStart = ipcSource.indexOf("function validateEventTriggerRequest");
    const workerStart = ipcSource.indexOf("function validateWorkerNodeRequest");
    assert.ok(routineStart >= 0 && eventStart > routineStart && workerStart > eventStart);
    const routineValidator = ipcSource.slice(routineStart, eventStart);
    const eventValidator = ipcSource.slice(eventStart, workerStart);
    assert.match(routineValidator, /exactKeys\(payload, new Set\(\[\"name\", \"coworkerId\", \"teamId\", \"projectId\", \"instruction\", \"skillId\", \"workspaceId\", \"schedule\"\]\)/);
    assert.match(eventValidator, /exactKeys\(payload, new Set\(\[\"name\", \"routineId\", \"workspaceId\", \"pathPrefix\"\]\)/);
    assert.doesNotMatch(routineValidator, /executionTarget/);
    assert.doesNotMatch(eventValidator, /executionTarget/);
});
