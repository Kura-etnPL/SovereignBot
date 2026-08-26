import { dryRunPolicy, validatePolicyDraft } from "./policy-dry-run.js";
import { publicMemoryRecords, publicRuntimeRecords, publicTaskGraphView, publicTaskListView } from "./task-view.js";
import { collectWorkerTelemetry } from "./worker-telemetry.js";

export const OPERATOR_ACTORS = Object.freeze({
    console: "operator-console",
    desktop: "desktop-operator",
});

async function computerDetails(runtime) {
    const computers = await runtime.computer.listComputers();
    return Promise.all(computers.map(async (computer) => {
        const pending = await runtime.computerRegistry.secretRequest(computer.agentId);
        let lifecycle;
        try {
            lifecycle = await runtime.computerLifecycle.status(computer.agentId);
        }
        catch (error) {
            lifecycle = { managed: false, running: false, error: error.message };
        }
        return { ...computer, lifecycle, pendingSecret: pending ? { id: pending.id, taskId: pending.taskId, label: pending.label, createdAt: pending.createdAt, ref: pending.ref } : undefined };
    }));
}

function clampLimit(value, fallback = 100, max = 500) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function boundedText(value, max) {
    const text = String(value ?? "");
    return text.slice(0, max);
}

export function createOperatorFacade(runtime, { actor }) {
    if (!Object.values(OPERATOR_ACTORS).includes(actor))
        throw new Error(`unknown operator actor: ${String(actor)}`);

    async function tasks() {
        return runtime.orchestrator.listTasks();
    }

    return {
        actor,

        async getSessionInfo() {
            return { ok: true, scope: "operator-console", actor };
        },

        async getOverview() {
            const taskList = publicTaskListView(await tasks());
            const agents = runtime.orchestrator.listAgents().map((agent) => ({
                id: agent.id,
                name: agent.name,
                role: agent.role,
                capabilities: agent.capabilities,
                governedTools: agent.governedTools,
                harnessKind: agent.harness?.kind,
            }));
            return { tasks: taskList, agents, computers: await computerDetails(runtime), audit: await runtime.audit.verify() };
        },

        async getWorkers() {
            return collectWorkerTelemetry(runtime.orchestrator);
        },

        async getAudit({ limit } = {}) {
            const rows = await runtime.audit.readAll();
            return publicRuntimeRecords(rows.slice(-clampLimit(limit)).reverse(), await tasks());
        },

        async searchMemory({ scope, query } = {}) {
            const records = await runtime.memory.search({ scope: scope || undefined, query: query || undefined, limit: 100 });
            return publicMemoryRecords(records, await tasks());
        },

        async getPolicy() {
            const snapshot = await runtime.policyManager.snapshot();
            return { ...snapshot, editable: false, note: "Draft editing and dry-run are side-effect free. Apply/rollback require explicit same-origin operator mutations." };
        },

        async getPolicyVersion(versionId) {
            return runtime.policyManager.getVersion(boundedText(versionId, 200));
        },

        async validatePolicy(policy) {
            const validated = validatePolicyDraft(policy);
            return { ok: true, ruleCount: validated.rules.length, repeatWindowMs: validated.repeatWindowMs ?? 180000, repeatMaxActiveFingerprints: validated.repeatMaxActiveFingerprints ?? 10000 };
        },

        async dryRunPolicy({ policy, action, repeatCount } = {}) {
            return dryRunPolicy({ policy, action, repeatCount: repeatCount ?? 1 });
        },

        async applyPolicy({ policy, checks, label } = {}) {
            return runtime.policyManager.apply({
                policy,
                checks,
                label: label === undefined ? undefined : boundedText(label, 200),
                actor,
            });
        },

        async rollbackPolicy({ versionId } = {}) {
            return runtime.policyManager.rollback({ versionId: boundedText(versionId, 200), actor });
        },

        async getTaskGraph(taskId) {
            return publicTaskGraphView(await runtime.orchestrator.getTaskGraph(boundedText(taskId, 200)));
        },

        async getTaskEvents(taskId) {
            const events = await runtime.orchestrator.listTaskEvents(boundedText(taskId, 200));
            return publicRuntimeRecords(events, await tasks());
        },

        async computerControl(agentId, action) {
            const id = boundedText(agentId, 120);
            if (action === "take")
                return runtime.computer.takeControl(id, actor);
            if (action === "release")
                return runtime.computer.releaseControl(id, actor);
            throw new Error("computer control requires take or release");
        },

        async computerLifecycle(agentId, action) {
            if (!["start", "stop", "reset"].includes(action))
                throw new Error("computer lifecycle requires start, stop, or reset");
            return runtime.computerLifecycle[action](boundedText(agentId, 120), actor);
        },

        async computerFrame(agentId) {
            return runtime.computerLifecycle.frame(boundedText(agentId, 120));
        },

        async supplySecret(agentId, requestId, value) {
            try {
                return await runtime.computer.supplySecret(boundedText(agentId, 120), actor, boundedText(requestId, 120), String(value ?? ""));
            }
            catch {
                throw new Error("secret supply failed");
            }
        },
    };
}