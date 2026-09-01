import { createHash } from "node:crypto";
import { validateComputerActionList } from "../../vendor/core/src/worker-computer-protocol.js";

export const COMPUTER_TARGET_KINDS = Object.freeze(["this-pc", "local-isolated", "worker-computer", "vm", "cloud"]);

function stableId(jobId, index, operation) {
    return `computer_request_${createHash("sha256").update(`${jobId}:${index}:${operation}`).digest("hex").slice(0, 24)}`;
}

function normalizeTarget(value) {
    if (value === undefined || value === null) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("computerTarget must be an object");
    const keys = Object.keys(value);
    const identifier = (entry, label) => {
        if (typeof entry !== "string" || !/^[A-Za-z0-9][\w:.-]{0,159}$/.test(entry)) throw new Error(`computerTarget.${label} is invalid`);
        return entry;
    };
    const workspaceId = identifier(value.workspaceId, "workspaceId");
    if (["worker-computer", "vm"].includes(value.kind)) {
        if (keys.some((key) => !["kind", "nodeId", "workspaceId", "computerId"].includes(key)) || keys.length !== 4)
            throw new Error("computerTarget must be a bounded Worker Computer target");
        if (!/^worker_[0-9a-f]{16}$/i.test(String(value.nodeId ?? ""))) throw new Error("computerTarget.nodeId is invalid");
        return { kind: value.kind, nodeId: value.nodeId, workspaceId, computerId: identifier(value.computerId, "computerId") };
    }
    if (["local-isolated", "cloud"].includes(value.kind)) {
        if (keys.some((key) => !["kind", "profileId", "workspaceId", "optIn"].includes(key)) || !["local-isolated", "cloud"].includes(value.kind) || keys.length !== (value.kind === "cloud" ? 4 : 3))
            throw new Error(`computerTarget must be a bounded ${value.kind} profile target`);
        const profileId = identifier(value.profileId, "profileId");
        if (value.kind === "cloud" && typeof value.optIn !== "boolean") throw new Error("computerTarget.optIn is required for Cloud Computer");
        return { kind: value.kind, profileId, workspaceId, ...(value.kind === "cloud" ? { optIn: value.optIn } : {}) };
    }
    if (value.kind === "this-pc") {
        if (keys.some((key) => !["kind", "workspaceId"].includes(key)) || keys.length !== 2) throw new Error("computerTarget must be a bounded This PC target");
        return { kind: "this-pc", workspaceId };
    }
    throw new Error(`computerTarget kind must be one of ${COMPUTER_TARGET_KINDS.join(", ")}`);
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

export function createComputerTargetController({ workerNodeStore, audit, localIsolatedComputer, cloudProfiles = [], cloudBudget, thisPcComputer, now = () => new Date().toISOString() } = {}) {
    if (!workerNodeStore?.resolveComputerTarget) throw new Error("Computer target controller requires Worker Computer registry");
    const active = new Map();
    const profiles = new Map((Array.isArray(cloudProfiles) ? cloudProfiles : []).map((profile) => [profile?.profileId, profile]));

    function actionType(target) { return ["worker-computer", "vm"].includes(target.kind) ? "worker" : target.kind.replaceAll("-", "_"); }
    function requireCloudProfile(target) {
        const profile = profiles.get(target.profileId);
        if (!profile || profile.enabled !== true) throw new Error("selected Cloud Computer profile is unavailable; external cloud execution is disabled");
        if (target.optIn !== true) throw new Error("Cloud Computer requires explicit opt-in before execution");
        if (!Number.isFinite(profile.estimate) || profile.estimate <= 0 || !Number.isFinite(profile.budget) || !Number.isFinite(profile.perRunCap) || !Number.isFinite(profile.totalCap) || profile.estimate > profile.budget || profile.estimate > profile.perRunCap || profile.estimate > profile.totalCap)
            throw new Error("Cloud Computer cost estimate exceeds the trusted budget gate");
        if (!cloudBudget?.reserve || !cloudBudget?.settle || !cloudBudget?.snapshot) throw new Error("Cloud Computer budget ledger is unavailable; execution is blocked");
        return profile;
    }

    async function resolveTarget(target) {
        if (["worker-computer", "vm"].includes(target.kind)) {
            if (target.kind === "vm" && typeof workerNodeStore.resolveVmTarget !== "function") throw new Error("VM Computer target requires a trusted secure Worker profile");
            const resolved = target.kind === "vm"
                ? await workerNodeStore.resolveVmTarget(target.nodeId, target.workspaceId, target.computerId)
                : await workerNodeStore.resolveComputerTarget(target.nodeId, target.workspaceId, target.computerId);
            return { ...resolved, target, adapter: resolved.client, invoke: (envelope) => resolved.client.computerAction(envelope), lease: (envelope) => resolved.client.computerAction(envelope) };
        }
        if (target.kind === "local-isolated") {
            if (!localIsolatedComputer?.resolve) throw new Error("Local isolated runtime is unavailable; execution is blocked");
            const resolved = await localIsolatedComputer.resolve({ profileId: target.profileId, workspaceId: target.workspaceId });
            return { ...resolved, target, adapter: localIsolatedComputer, invoke: async (envelope) => ({ result: await resolved.execute(envelope) }), lease: async (envelope) => ({ result: await resolved.lease({ jobId: envelope.jobId, operation: envelope.operation, actorId: envelope.input.actorId }) }) };
        }
        if (target.kind === "cloud") {
            const profile = requireCloudProfile(target);
            if (typeof profile.resolve !== "function") throw new Error("Cloud Computer profile has no trusted adapter");
            const resolved = await profile.resolve({ workspaceId: target.workspaceId });
            const health = resolved.computer ?? await resolved.health?.();
            if (!health || !["online", "capacity-limited"].includes(health.state)) throw new Error("Cloud Computer health is unavailable; execution is blocked");
            if (Number.isFinite(health.runtimeRemainingMs) && health.runtimeRemainingMs < (profile.runtimeMs ?? 0)) throw new Error("Cloud Computer runtime budget is exhausted");
            const invoke = resolved.computerAction ?? resolved.execute;
            if (typeof invoke !== "function") throw new Error("Cloud Computer profile adapter is invalid");
            return { ...resolved, target, profile, adapter: profile.adapter, invoke: async (envelope) => { const result = await invoke(envelope); return result?.result === undefined ? { result } : result; }, lease: async (envelope) => { const run = resolved.lease ?? resolved.computerAction; const result = await run(envelope); return result?.result === undefined ? { result } : result; } };
        }
        if (target.kind === "this-pc") {
            if (!thisPcComputer?.resolve) throw new Error("This PC Computer authority is unavailable");
            const resolved = await thisPcComputer.resolve({ workspaceId: target.workspaceId });
            return { ...resolved, target, invoke: async (envelope) => ({ result: await resolved.execute(envelope) }), lease: async (envelope) => ({ result: await resolved.lease({ jobId: envelope.jobId, operation: envelope.operation, actorId: envelope.input.actorId }) }) };
        }
        throw new Error("Computer target is unsupported");
    }

    async function execute({ job, actions } = {}) {
        if (!job?.id || !job.ownerCoworkerId) throw new Error("Computer Job identity is required");
        const target = normalizeTarget(job.computerTarget);
        if (!target) throw new Error("Computer target is required");
        const normalized = validateComputerActionList(actions ?? [{ operation: "snapshot", input: {} }]);
        let resolved;
        try { resolved = await resolveTarget(target); }
        catch (error) {
            await audit?.append?.({ type: `computer.${actionType(target)}_action_failed`, actor: job.ownerCoworkerId, subject: job.id, data: { targetKind: target.kind, profileId: target.profileId, nodeId: target.nodeId, workspaceId: target.workspaceId, computerId: target.computerId, reason: String(error?.message ?? error).slice(0, 300) } });
            throw error;
        }
        if (Number.isInteger(resolved.computer?.currentLoad) && Number.isInteger(resolved.computer?.capacity) && resolved.computer.currentLoad >= resolved.computer.capacity) {
            const error = new Error(`selected ${target.kind} Computer capacity is exhausted`);
            await audit?.append?.({ type: `computer.${actionType(target)}_action_failed`, actor: job.ownerCoworkerId, subject: job.id, data: { targetKind: target.kind, profileId: target.profileId, nodeId: target.nodeId, workspaceId: target.workspaceId, computerId: target.computerId, reason: error.message } });
            throw error;
        }
        const key = job.id;
        active.set(key, { cancelled: false, cancel: () => resolved.adapter?.cancel?.(job.id) ?? resolved.cancel?.(job.id) ?? false });
        const results = [];
        let cloudReservation;
        let cloudDuplicate = false;
        try {
            if (target.kind === "cloud") {
                const prior = cloudBudget.snapshot().entries?.[job.id];
                if (prior) cloudDuplicate = true;
                else cloudReservation = cloudBudget.reserve({ taskId: job.id, providerId: resolved.profile.profileId, budget: resolved.profile.budget, perRunCap: resolved.profile.perRunCap, totalCap: resolved.profile.totalCap });
            }
            if (cloudDuplicate) return { target: { ...target }, actions: [], duplicate: true, summary: "Cloud Computer duplicate execution suppressed; prior budget settlement retained" };
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
                await audit?.append?.({ type: `computer.${actionType(target)}_action_requested`, actor: job.ownerCoworkerId, subject: job.id, data: { requestId, targetKind: target.kind, profileId: target.profileId, nodeId: target.nodeId, workspaceId: target.workspaceId, computerId: target.computerId, operation: action.operation } });
                const response = await resolved.invoke(envelope);
                const result = publicResult(response?.result);
                results.push({ operation: action.operation, requestId, duplicate: response?.duplicate === true, result });
                await audit?.append?.({ type: `computer.${actionType(target)}_action_completed`, actor: job.ownerCoworkerId, subject: job.id, data: { requestId, operation: action.operation, duplicate: response?.duplicate === true } });
            }
            if (cloudReservation && !cloudReservation.reused) cloudBudget.settle(job.id, { success: true });
            return { target: { ...target }, actions: results, summary: `${results.length} ${target.kind} Computer action(s) completed` };
        }
        catch (error) {
            if (cloudReservation && !cloudReservation.reused) cloudBudget.settle(job.id, { success: false });
            await audit?.append?.({ type: `computer.${actionType(target)}_action_failed`, actor: job.ownerCoworkerId, subject: job.id, data: { targetKind: target.kind, profileId: target.profileId, nodeId: target.nodeId, workspaceId: target.workspaceId, computerId: target.computerId, reason: String(error?.message ?? error).slice(0, 300) } });
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
        const resolved = await resolveTarget(target);
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
        await audit?.append?.({ type: `computer.${actionType(target)}_${operation}_requested`, actor: job.ownerCoworkerId, subject: job.id, data: { requestId: envelope.requestId, targetKind: target.kind, profileId: target.profileId, nodeId: target.nodeId, workspaceId: target.workspaceId, computerId: target.computerId, operation } });
        try {
            const response = await resolved.lease(envelope);
            await audit?.append?.({ type: `computer.${actionType(target)}_${operation}_completed`, actor: job.ownerCoworkerId, subject: job.id, data: { requestId: envelope.requestId, operation, duplicate: response?.duplicate === true } });
            return { target, operation, requestId: envelope.requestId, duplicate: response?.duplicate === true, result: publicResult(response?.result) };
        }
        catch (error) {
            await audit?.append?.({ type: `computer.${actionType(target)}_${operation}_failed`, actor: job.ownerCoworkerId, subject: job.id, data: { requestId: envelope.requestId, operation, reason: String(error?.message ?? error).slice(0, 300) } });
            throw error;
        }
    }

    async function listTargets({ workspaceId } = {}) {
        const targets = [{ id: "this-pc", kind: "this-pc", state: thisPcComputer ? "available" : "unavailable", isolation: "host", billing: { mode: "local" }, capabilities: ["snapshot", "takeover", "release"] }];
        if (localIsolatedComputer) {
            const health = await localIsolatedComputer.health();
            targets.push({ id: localIsolatedComputer.profileId, kind: "local-isolated", profileId: localIsolatedComputer.profileId, state: health.state, isolation: health.isolation, runtime: health.runtime, billing: { mode: "local" }, capabilities: health.capabilities ?? [], ...(health.reason ? { reason: health.reason } : {}), target: { kind: "local-isolated", profileId: localIsolatedComputer.profileId, workspaceId: workspaceId ?? "workspace", } });
        }
        for (const node of workerNodeStore.list?.().nodes ?? []) {
            const computer = node.computer;
            const trusted = node.trust?.status === "trusted" && ["lan", "remote-relay"].includes(node.trust?.transport);
            if (!trusted || !node.enabled || node.status !== "online" || !computer?.id) continue;
            const workspace = (workspaceId ? node.workspaces?.find((entry) => entry.id === workspaceId) : node.workspaces?.[0]);
            if (!workspace) continue;
            targets.push({ id: `${node.nodeId}:${computer.id}`, kind: "vm", state: computer.state, isolation: "vm", runtime: "trusted-worker", billing: { mode: "local" }, capabilities: computer.capabilities ?? [], target: { kind: "vm", nodeId: node.nodeId, workspaceId: workspace.id, computerId: computer.id } });
        }
        for (const profile of profiles.values()) {
            const target = { kind: "cloud", profileId: profile.profileId, workspaceId: workspaceId ?? "workspace", optIn: false };
            let health = { state: profile.enabled === true ? "unavailable" : "disabled" };
            try { if (profile.health) health = await profile.health({ workspaceId }); } catch (error) { health = { state: "unavailable", reason: String(error?.message ?? error).slice(0, 240) }; }
            targets.push({ id: profile.profileId, kind: "cloud", state: health.state ?? "unavailable", isolation: "provider-managed", billing: { mode: "metered", estimate: profile.estimate, currency: profile.currency ?? "USD", budget: profile.budget, perRunCap: profile.perRunCap, totalCap: profile.totalCap, optInRequired: true }, capabilities: health.capabilities ?? [], target, ...(health.reason ? { reason: health.reason } : {}) });
        }
        return { targets };
    }

    return {
        normalizeTarget,
        normalizeActions(value) { return validateComputerActionList(value ?? [{ operation: "snapshot", input: {} }]); },
        execute,
        takeover(params) { return leaseAction({ ...params, operation: "takeover" }); },
        release(params) { return leaseAction({ ...params, operation: "release" }); },
        cancel(jobId) { const entry = active.get(jobId); if (!entry) return false; entry.cancelled = true; entry.cancel?.(); return true; },
        listTargets,
        publicTarget(value) { return normalizeTarget(value); },
    };
}

export { normalizeTarget as normalizeComputerTarget };
