import { registerAgentWorkerNodeClient as registerClient } from "./worker-node-registry.js";
import {
    WORKER_NODE_PROTOCOL,
    WorkerNodeProtocolError,
    validateDispatchPayload,
    validateNodeId,
    validateRequestId,
    validateJobId,
    validateWorkspaceId,
} from "./worker-node-protocol.js";

// The registry is intentionally WeakMap-backed: a client, and therefore its private
// pairing token, is attached to one in-memory agent object and can never be serialized
// into the Core task/agent configuration.
export function registerAgentWorkerNodeClient(agent, resolver) {
    return registerClient(agent, resolver);
}

function getClient(agent, nodeId) {
    const resolver = registerClient.get(agent);
    const client = typeof resolver === "function" ? resolver(nodeId) : resolver;
    if (!client || typeof client.dispatch !== "function" || typeof client.getTask !== "function")
        throw new Error("worker node client is not registered");
    return client;
}

function executionContext(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("worker-node harness requires a tagged execution context");
    const keys = Object.keys(value).sort();
    if (keys.length !== 3 || keys[0] !== "kind" || keys[1] !== "nodeId" || keys[2] !== "workspaceId")
        throw new Error("worker-node execution context accepts exactly kind, nodeId, and workspaceId");
    if (value.kind !== "worker-node")
        throw new Error("worker-node harness cannot use a local execution context");
    return { kind: "worker-node", nodeId: validateNodeId(value.nodeId), workspaceId: validateWorkspaceId(value.workspaceId) };
}

function inputForTask(task) {
    if (!task.input || typeof task.input !== "object" || Array.isArray(task.input))
        throw new Error("worker-node task input must be an object");
    const allowed = new Set(["instruction", "jobId", "requestId", "requiredCapabilities", "attempt", "remoteTaskId", "objective"]);
    for (const key of Object.keys(task.input)) {
        if (!allowed.has(key))
            throw new Error(`worker-node task input contains unsupported field: ${key}`);
    }
    const instruction = task.input.instruction;
    if (typeof instruction !== "string" || !instruction.trim() || instruction.length > 20_000)
        throw new Error("worker-node task instruction is invalid");
    const jobId = validateJobId(task.input.jobId);
    const requestId = validateRequestId(task.input.requestId);
    const requiredCapabilities = Array.isArray(task.input.requiredCapabilities) ? task.input.requiredCapabilities : ["general"];
    const attempt = task.input.attempt ?? 0;
    return { instruction, jobId, requestId, requiredCapabilities, attempt, remoteTaskId: task.input.remoteTaskId };
}

function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        const abort = () => {
            clearTimeout(timer);
            reject(new Error("worker-node polling aborted"));
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted)
            abort();
    });
}

function transportFailure(error) {
    return error?.code === "WORKER_NODE_TRANSPORT" || /transport unavailable/i.test(String(error?.message ?? ""));
}

export class WorkerNodeHarness {
    constructor(agent) {
        this.agent = agent;
    }

    async run(context) {
        const bound = executionContext(context.executionContext);
        const input = inputForTask(context.task);
        const client = getClient(this.agent, bound.nodeId);
        let remoteTaskId = context.task.harnessState?.remoteTaskId ?? input.remoteTaskId;
        if (remoteTaskId !== undefined && (typeof remoteTaskId !== "string" || !/^task_[0-9a-f-]{16,64}$/i.test(remoteTaskId)))
            throw new Error("worker-node remoteTaskId is invalid");

        if (!remoteTaskId) {
            const dispatch = validateDispatchPayload({
                protocol: WORKER_NODE_PROTOCOL,
                requestId: input.requestId,
                jobId: input.jobId,
                title: context.task.title,
                instruction: input.instruction,
                workspaceId: bound.workspaceId,
                requiredCapabilities: input.requiredCapabilities,
                attempt: input.attempt,
                createdAt: context.task.createdAt,
            });
            const accepted = await client.dispatch(dispatch);
            remoteTaskId = accepted.remoteTaskId;
            if (typeof remoteTaskId !== "string" || !/^task_[0-9a-f-]{16,64}$/i.test(remoteTaskId))
                throw new Error("Worker Node returned an invalid remote task id");
            await context.updateHarnessState?.({
                kind: "worker-node",
                nodeId: bound.nodeId,
                workspaceId: bound.workspaceId,
                requestId: input.requestId,
                remoteTaskId,
            });
        }

        let transportFailures = 0;
        while (true) {
            if (context.signal.aborted) {
                try {
                    const cancelled = await client.cancel?.(remoteTaskId);
                    if (cancelled?.confirmed !== true && cancelled?.status !== "cancelled")
                        throw new Error("remote cancellation unconfirmed");
                }
                catch (error) {
                    if (transportFailure(error))
                        throw new Error("worker-node transport unavailable: remote cancellation unconfirmed");
                    throw error;
                }
                throw new Error("worker-node task cancelled");
            }
            let status;
            try {
                status = await client.getTask(remoteTaskId);
                transportFailures = 0;
            }
            catch (error) {
                if (!transportFailure(error))
                    throw error;
                transportFailures += 1;
                if (transportFailures > 12)
                    throw new Error("worker-node transport unavailable: reconnect required");
                await delay(Math.min(2_000, 150 * transportFailures), context.signal);
                continue;
            }
            await context.updateHarnessState?.({
                kind: "worker-node",
                nodeId: bound.nodeId,
                workspaceId: bound.workspaceId,
                requestId: input.requestId,
                remoteTaskId,
                status: status.status,
            });
            if (context.reportProgress && ["accepted", "running"].includes(status.status)) {
                await context.reportProgress({
                    eventId: `worker-node-${remoteTaskId}-${status.status}`,
                    message: `Worker Node task ${status.status}`,
                    data: { source: "worker-node", protocol: WORKER_NODE_PROTOCOL },
                });
            }
            if (status.status === "completed")
                return { ok: true, output: status.result };
            if (["failed", "cancelled", "blocked"].includes(status.status))
                return { ok: false, error: status.summary ?? `Worker Node task ended as ${status.status}` };
            await delay(150, context.signal);
        }
    }
}
