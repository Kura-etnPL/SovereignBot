import assert from "node:assert/strict";
import test from "node:test";
import { WorkerNodeHarness, registerAgentWorkerNodeClient } from "../src/worker-node-harness.js";
import { publicTaskView } from "../src/task-view.js";

test("WorkerNodeHarness dispatches through a registered client and reconnects without a second dispatch", async () => {
    const calls = [];
    let polls = 0;
    const client = {
        async dispatch(body) { calls.push({ type: "dispatch", body }); return { remoteTaskId: "task_00000001-1111-4111-8111-111111111111", status: "accepted" }; },
        async getTask(id) { calls.push({ type: "poll", id }); polls += 1; return polls < 2 ? { remoteTaskId: id, status: "running" } : { remoteTaskId: id, status: "completed", result: "done" }; },
    };
    const agent = { id: "worker-node-dispatcher", harness: { kind: "worker-node" } };
    registerAgentWorkerNodeClient(agent, () => client);
    const states = [];
    const result = await new WorkerNodeHarness(agent).run({
        task: { id: "task_local", title: "Remote task", input: { instruction: "bounded", jobId: "job_0123456789abcdef", requestId: "worker_request_0123456789abcdef", requiredCapabilities: ["general"], attempt: 0 }, createdAt: new Date().toISOString() },
        agent,
        executionContext: { kind: "worker-node", nodeId: "worker_0123456789abcdef", workspaceId: "ws_main" },
        signal: new AbortController().signal,
        updateHarnessState: async (patch) => states.push(patch),
    });
    assert.deepEqual(result, { ok: true, output: "done" });
    assert.equal(calls.filter((entry) => entry.type === "dispatch").length, 1);
    assert.equal(calls[0].body.cwd, undefined);
    assert.equal(calls[0].body.path, undefined);
    assert.equal(JSON.stringify(calls[0].body).includes("token"), false);
    assert.equal(states.at(-1).remoteTaskId, "task_00000001-1111-4111-8111-111111111111");
    const publicView = publicTaskView({ title: "Remote task", executionContext: { kind: "worker-node", nodeId: "worker_0123456789abcdef", workspaceId: "ws_main" }, harnessState: states.at(-1), input: { instruction: "bounded" } });
    assert.equal(publicView.executionContext, undefined);
    assert.equal(publicView.harnessState, undefined);
    registerAgentWorkerNodeClient(agent, undefined);
});
test("WorkerNodeHarness rejects local context and does not accept a smuggled cwd", async () => {
    const agent = { id: "worker-node-dispatcher", harness: { kind: "worker-node" } };
    registerAgentWorkerNodeClient(agent, { dispatch: async () => { throw new Error("must not dispatch"); }, getTask: async () => ({ status: "failed" }) });
    const input = { instruction: "bounded", jobId: "job_0123456789abcdef", requestId: "worker_request_0123456789abcdef", requiredCapabilities: ["general"], attempt: 0 };
    await assert.rejects(() => new WorkerNodeHarness(agent).run({ task: { title: "x", input, createdAt: new Date().toISOString() }, executionContext: { workspaceId: "ws_main", cwd: "E:/Eternal/Auto_Empire" }, signal: new AbortController().signal }), /tagged execution context|worker-node/);
    registerAgentWorkerNodeClient(agent, undefined);
});
