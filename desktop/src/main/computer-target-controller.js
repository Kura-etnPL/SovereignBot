import { createHash } from "node:crypto";
import { validateComputerActionList } from "../../vendor/core/src/worker-computer-protocol.js";

function stableId(jobId, index, operation) {
    return `computer_request_${createHash("sha256").update(`${jobId}:${index}:${operation}`).digest("hex").slice(0, 24)}`;
}

function normalizeTarget(value) {
    if (value === undefined || value === null) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("computerTarget must be an object");
    const keys = Object.keys(value);
    if (value.kind !== "worker-computer" || keys.some((key) => !["kind", "nodeId", "workspaceId", "computerId"].includes(key)) || keys.length !== 4)
        throw new Error("computerTarget must be a Worker Computer target");
    if (!/^worker_[0-9a-f]{16}$/i.test(String(value.nodeId ?? ""))) throw new Error("computerTarget.nodeId is invalid");
    for (const key of ["workspaceId", "computerId"]) {
        if (typeof value[key] !== "string" || !/^[A-Za-z0-9][\w:.-]{0,159}$/.test(value[key])) throw new Error(`computerTarget.${key} is invalid`);
    }
    return { kind: "worker-computer", nodeId: value.nodeId, workspaceId: value.workspaceId, computerId: value.computerId };
}

function publicResult(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "completed" };
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (/token|secret|cookie|credential|endpoint|transport|path|cwd|session|continuation|provider|backend|raw/i.test(key)) continue;
        if (typeof entry === "string") out[key] = entry.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 8000);
        else if (typeof entry === "number" || typeof entry === "boolean" || entry === null) out[key] = entry;
        else if (Array.isArray(entry)) out[key] = entry.slice(0, 24).map((v) => typeof v === "string" ? v.slice(0, 500) : v);
        else if (entry && typeof entry === "object") out[key] = publicResult(entry);
    }
    return out;
}

export function createComputerTargetController({ workerNodeStore, audit, now = () => new Date().toISOString() } = {}) {
    if (!workerNodeStore?.resolveComputerTarget) throw new Error("Computer target controller requires Worker Computer registry");
    const active = new Map();

    async function execute({ job, actions } = {}) {
        if (!job?.id || !job.ownerCoworkerId) throw new Error("Computer Job identity is required");
        const target = normalizeTarget(job.computerTarget);
        if (!target) throw new Error("Computer target is required");
        const normalized = validateComputerActionList(actions ?? [{ operation: "snapshot", input: {} }]);
        let resolved;
        try { resolved = await workerNodeStore.resolveComputerTarget(target.nodeId, target.workspaceId, target.computerId); }
        catch (error) {
            await audit?.append?.({ type: "computer.worker_action_failed", actor: job.ownerCoworkerId, subject: job.id, data: { nodeId: target.nodeId, workspaceId: target.workspaceId, computerId: target.computerId, reason: String(error?.message ?? error).slice(0, 300) } });
            throw error;
        }
        if (resolved.computer.currentLoad >= resolved.computer.capacity) {
            const error = new Error("selected Worker Computer capacity is exhausted");
            await audit?.append?.({ type: "computer.worker_action_failed", actor: job.ownerCoworkerId, subject: job.id, data: { nodeId: target.nodeId, workspaceId: target.workspaceId, computerId: target.computerId, reason: error.message } });
            throw error;
        }
        const key = job.id;
        active.set(key, { cancelled: false });
        const results = [];
        try {
            for (let index = 0; index < normalized.length; index += 1) {
                if (active.get(key)?.cancelled) throw new Error("Computer Job cancelled");
                const action = normalized[index];
                const requestId = stableId(job.id, index, action.operation);
                const envelope = {
                    protocol: "sovereign-worker-computer/1",
                    requestId,
                    jobId: job.id,
                    ownerCoworkerId: job.ownerCoworkerId,
                    ...(job.projectId ? { projectId: job.projectId } : {}),
                    workspaceId: target.workspaceId,
                    computerId: target.computerId,
                    operation: action.operation,
                    input: action.input,
                    attempt: Number.isInteger(job.attempt) ? job.attempt : 0,
                    createdAt: now(),
                };
                await audit?.append?.({ type: "computer.worker_action_requested", actor: job.ownerCoworkerId, subject: job.id, data: { requestId, nodeId: target.nodeId, workspaceId: target.workspaceId, computerId: target.computerId, operation: action.operation } });
                const response = await resolved.client.computerAction(envelope);
                const result = publicResult(response?.result);
                results.push({ operation: action.operation, requestId, duplicate: response?.duplicate === true, result });
                await audit?.append?.({ type: "computer.worker_action_completed", actor: job.ownerCoworkerId, subject: job.id, data: { requestId, operation: action.operation, duplicate: response?.duplicate === true } });
            }
            return { target: { ...target }, actions: results, summary: `${results.length} Worker Computer action(s) completed` };
        }
        catch (error) {
            await audit?.append?.({ type: "computer.worker_action_failed", actor: job.ownerCoworkerId, subject: job.id, data: { nodeId: target.nodeId, workspaceId: target.workspaceId, computerId: target.computerId, reason: String(error?.message ?? error).slice(0, 300) } });
            throw error;
        }
        finally { active.delete(key); }
    }

    async function leaseAction({ job, operation, actorId } = {}) {
        if (!job?.id || !job.ownerCoworkerId) throw new Error("Computer lease identity is required");
        if (!["takeover", "release"].includes(operation)) throw new Error("Computer lease operation is not supported");
        const target = normalizeTarget(job.computerTarget);
        if (!target) throw new Error("computerTarget is required");
        if (typeof actorId !== "string" || !actorId.trim() || actorId.length > 120) throw new Error("actorId is invalid");
        const resolved = await workerNodeStore.resolveComputerTarget(target.nodeId, target.workspaceId, target.computerId);
        const envelope = {
            protocol: "sovereign-worker-computer/1",
            requestId: stableId(job.id, operation === "takeover" ? 9001 : 9002, operation),
            jobId: job.id,
            ownerCoworkerId: job.ownerCoworkerId,
            ...(job.projectId ? { projectId: job.projectId } : {}),
            workspaceId: target.workspaceId,
            computerId: target.computerId,
            operation,
            input: { actorId: actorId.trim() },
            attempt: Number.isInteger(job.attempt) ? job.attempt : 0,
            createdAt: now(),
        };
        await audit?.append?.({ type: `computer.worker_${operation}_requested`, actor: job.ownerCoworkerId, subject: job.id, data: { requestId: envelope.requestId, nodeId: target.nodeId, workspaceId: target.workspaceId, computerId: target.computerId, operation } });
        try {
            const response = await resolved.client.computerAction(envelope);
            await audit?.append?.({ type: `computer.worker_${operation}_completed`, actor: job.ownerCoworkerId, subject: job.id, data: { requestId: envelope.requestId, operation, duplicate: response?.duplicate === true } });
            return { target, operation, requestId: envelope.requestId, duplicate: response?.duplicate === true, result: publicResult(response?.result) };
        }
        catch (error) {
            await audit?.append?.({ type: `computer.worker_${operation}_failed`, actor: job.ownerCoworkerId, subject: job.id, data: { requestId: envelope.requestId, operation, reason: String(error?.message ?? error).slice(0, 300) } });
            throw error;
        }
    }

    return {
        normalizeTarget,
        normalizeActions(value) { return validateComputerActionList(value ?? [{ operation: "snapshot", input: {} }]); },
        execute,
        takeover(params) { return leaseAction({ ...params, operation: "takeover" }); },
        release(params) { return leaseAction({ ...params, operation: "release" }); },
        cancel(jobId) { const entry = active.get(jobId); if (!entry) return false; entry.cancelled = true; return true; },
        publicTarget(value) { return normalizeTarget(value); },
    };
}

export { normalizeTarget as normalizeComputerTarget };
