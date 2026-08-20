import { createHarness, harnessTarget } from "./harness.js";
import { createId } from "./id.js";

export class Orchestrator {
    agents;
    tasks;
    memory;
    governor;
    audit;
    #busy = new Map();
    #controllers = new Map();

    constructor(agents, tasks, memory, governor, audit) {
        this.agents = agents;
        this.tasks = tasks;
        this.memory = memory;
        this.governor = governor;
        this.audit = audit;
        for (const agent of agents)
            this.#busy.set(agent.id, 0);
    }

    listAgents() {
        return structuredClone(this.agents);
    }

    async submit(spec) {
        if (!spec.title.trim())
            throw new Error("task title is required");
        if (spec.parentTaskId && !(await this.tasks.get(spec.parentTaskId))) {
            throw new Error(`parent task not found: ${spec.parentTaskId}`);
        }
        const now = new Date().toISOString();
        const task = {
            ...spec,
            id: createId("task"),
            status: "queued",
            requiredCapabilities: spec.requiredCapabilities ?? [],
            createdAt: now,
            updatedAt: now,
        };
        await this.tasks.upsert(task);
        await this.audit.append({
            type: "task.submitted",
            actor: "user",
            subject: task.id,
            data: { title: task.title, parentTaskId: task.parentTaskId },
        });
        return task;
    }

    async delegate(parentTaskId, spec) {
        return this.submit({ ...spec, parentTaskId });
    }

    async listTasks() {
        return this.tasks.list();
    }

    async retry(taskId) {
        const task = await this.requireTask(taskId);
        if (!['failed', 'blocked', 'cancelled'].includes(task.status)) {
            throw new Error(`task ${task.id} cannot be retried from status ${task.status}`);
        }
        const queued = await this.patch(task, {
            status: "queued",
            error: undefined,
            result: undefined,
        });
        await this.audit.append({
            type: "task.retried",
            actor: "user",
            subject: task.id,
            data: {
                assignedAgentId: task.assignedAgentId,
                hasHarnessState: Boolean(task.harnessState),
            },
        });
        return queued;
    }

    async cancel(taskId) {
        const task = await this.requireTask(taskId);
        if (["completed", "failed", "blocked", "cancelled"].includes(task.status))
            return task;
        this.#controllers.get(taskId)?.abort();
        const updated = await this.patch(task, { status: "cancelled", error: "cancelled by user" });
        await this.audit.append({ type: "task.cancelled", actor: "user", subject: task.id });
        return updated;
    }

    async runNext() {
        const queued = (await this.tasks.list()).find((task) => task.status === "queued");
        if (!queued)
            return undefined;
        const agent = this.pickAgent(queued);
        if (!agent)
            return undefined;
        return this.runTask(queued, agent);
    }

    async runUntilIdle(maxTasks = 100) {
        const finished = [];
        for (let index = 0; index < maxTasks; index += 1) {
            const result = await this.runNext();
            if (!result)
                break;
            finished.push(result);
        }
        return finished;
    }

    pickAgent(task) {
        const required = new Set(task.requiredCapabilities ?? []);
        const pinnedAgentId = task.harnessState?.sessionId ? task.assignedAgentId : undefined;
        const eligible = this.agents.filter((agent) => {
            if (pinnedAgentId && agent.id !== pinnedAgentId)
                return false;
            if (task.preferredAgentId && agent.id !== task.preferredAgentId)
                return false;
            if (![...required].every((capability) => agent.capabilities.includes(capability)))
                return false;
            const busy = this.#busy.get(agent.id) ?? 0;
            return busy < (agent.maxConcurrency ?? 1);
        });
        return eligible.sort((a, b) => {
            const busyDelta = (this.#busy.get(a.id) ?? 0) - (this.#busy.get(b.id) ?? 0);
            if (busyDelta)
                return busyDelta;
            const priorityDelta = (b.priority ?? 0) - (a.priority ?? 0);
            if (priorityDelta)
                return priorityDelta;
            return a.id.localeCompare(b.id);
        })[0];
    }

    async runTask(task, agent) {
        const action = {
            category: "harness",
            operation: "run",
            target: harnessTarget(agent.harness),
            agentId: agent.id,
            taskId: task.id,
            metadata: { role: agent.role, harnessKind: agent.harness.kind },
        };
        const decision = await this.governor.authorize(action);
        if (!decision.allowed) {
            const blocked = await this.patch(task, {
                status: "blocked",
                assignedAgentId: agent.id,
                error: decision.reason,
            });
            await this.audit.append({
                type: "task.blocked",
                actor: agent.id,
                subject: task.id,
                data: { reason: decision.reason, ruleId: decision.ruleId },
            });
            return blocked;
        }

        this.#busy.set(agent.id, (this.#busy.get(agent.id) ?? 0) + 1);
        const controller = new AbortController();
        this.#controllers.set(task.id, controller);
        await this.patch(task, { status: "running", assignedAgentId: agent.id });
        await this.audit.append({
            type: "task.started",
            actor: agent.id,
            subject: task.id,
            data: { title: task.title, resumed: Boolean(task.harnessState?.sessionId) },
        });

        const updateHarnessState = async (statePatch) => {
            const current = await this.requireTask(task.id);
            const previous = current.harnessState ?? {};
            const changed = Object.entries(statePatch).some(([key, value]) => previous[key] !== value);
            if (!changed)
                return current;
            const updated = await this.patch(current, {
                harnessState: { ...previous, ...statePatch },
            });
            await this.audit.append({
                type: "task.harness_state_updated",
                actor: agent.id,
                subject: task.id,
                data: { keys: Object.keys(statePatch), kind: updated.harnessState?.kind },
            });
            return updated;
        };

        try {
            const latest = await this.requireTask(task.id);
            const result = await createHarness(agent).run({
                task: latest,
                agent,
                signal: controller.signal,
                updateHarnessState,
            });
            const afterRun = await this.requireTask(task.id);
            if (afterRun.status === "cancelled")
                return afterRun;

            if (!result.ok) {
                const failed = await this.patch(afterRun, {
                    status: "failed",
                    error: result.error ?? "harness failed",
                });
                await this.audit.append({
                    type: "task.failed",
                    actor: agent.id,
                    subject: task.id,
                    data: { error: failed.error, harnessMetadata: result.metadata },
                });
                return failed;
            }

            const completed = await this.patch(afterRun, {
                status: "completed",
                result: result.output,
                error: undefined,
            });
            await this.memory.put({
                scope: `task:${task.id}`,
                key: "result",
                value: result.output,
                tags: ["task-result", agent.id],
            });
            await this.memory.put({
                scope: `agent:${agent.id}`,
                key: `task:${task.id}:result`,
                value: result.output,
                tags: ["task-result"],
            });
            await this.audit.append({
                type: "task.completed",
                actor: agent.id,
                subject: task.id,
                data: { hasOutput: result.output !== undefined, harnessMetadata: result.metadata },
            });
            return completed;
        }
        catch (error) {
            const latest = await this.requireTask(task.id);
            if (latest.status === "cancelled")
                return latest;
            const status = controller.signal.aborted ? "cancelled" : "failed";
            const updated = await this.patch(latest, { status, error: error.message });
            await this.audit.append({
                type: status === "cancelled" ? "task.cancelled" : "task.failed",
                actor: agent.id,
                subject: task.id,
                data: { error: error.message },
            });
            return updated;
        }
        finally {
            this.#busy.set(agent.id, Math.max(0, (this.#busy.get(agent.id) ?? 1) - 1));
            this.#controllers.delete(task.id);
        }
    }

    async requireTask(id) {
        const task = await this.tasks.get(id);
        if (!task)
            throw new Error(`task not found: ${id}`);
        return task;
    }

    async patch(task, patch) {
        const updated = { ...task, ...patch, updatedAt: new Date().toISOString() };
        await this.tasks.upsert(updated);
        return updated;
    }
}
