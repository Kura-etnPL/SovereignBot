import { createHarness, harnessTarget } from "./harness.js";
import { createId } from "./id.js";

const TERMINAL = new Set(["completed", "failed", "blocked", "cancelled"]);
const ACTIVE_WORK = new Set(["queued", "accepted", "running", "awaiting_review", "changes_requested"]);

function normalizeReview(review) {
    if (!review?.required)
        return undefined;
    return {
        required: true,
        requiredCapabilities: review.requiredCapabilities?.length ? review.requiredCapabilities : ["review"],
        independent: review.independent !== false,
        status: "pending",
        history: [],
    };
}

function statusCounts(tasks) {
    const counts = {};
    for (const task of tasks)
        counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
}

export class Orchestrator {
    agents;
    tasks;
    taskEvents;
    memory;
    governor;
    audit;
    #busy = new Map();
    #controllers = new Map();

    constructor(agents, tasks, taskEvents, memory, governor, audit) {
        this.agents = agents;
        this.tasks = tasks;
        this.taskEvents = taskEvents;
        this.memory = memory;
        this.governor = governor;
        this.audit = audit;
        for (const agent of agents)
            this.#busy.set(agent.id, 0);
    }

    listAgents() {
        return structuredClone(this.agents);
    }

    async submit(spec, actor = "user") {
        if (!spec.title?.trim())
            throw new Error("task title is required");
        if (spec.parentTaskId && !(await this.tasks.get(spec.parentTaskId))) {
            throw new Error(`parent task not found: ${spec.parentTaskId}`);
        }
        for (const dependencyId of spec.dependencyIds ?? []) {
            if (!(await this.tasks.get(dependencyId)))
                throw new Error(`dependency task not found: ${dependencyId}`);
        }

        const now = new Date().toISOString();
        const task = {
            ...spec,
            id: createId("task"),
            kind: spec.kind ?? "work",
            status: "queued",
            attempt: spec.attempt ?? 0,
            requiredCapabilities: spec.requiredCapabilities ?? [],
            dependencyIds: spec.dependencyIds ?? [],
            review: normalizeReview(spec.review),
            createdAt: now,
            updatedAt: now,
        };
        await this.tasks.upsert(task);
        await this.taskEvents.append({
            taskId: task.id,
            type: "task.submitted",
            actor,
            data: {
                title: task.title,
                parentTaskId: task.parentTaskId,
                dependencyIds: task.dependencyIds,
            },
        });
        await this.audit.append({
            type: "task.submitted",
            actor,
            subject: task.id,
            data: { title: task.title, parentTaskId: task.parentTaskId },
        });
        return task;
    }

    async createPlan(spec) {
        const owner = this.requireAgent(spec.ownerAgentId);
        if (owner.role !== "supervisor")
            throw new Error(`plan owner ${owner.id} must have role supervisor`);
        if (!spec.title?.trim())
            throw new Error("plan title is required");

        const now = new Date().toISOString();
        const plan = {
            id: createId("task"),
            kind: "plan",
            title: spec.title,
            input: spec.input,
            status: "active",
            ownerAgentId: owner.id,
            supervisorAgentId: owner.id,
            dependencyIds: [],
            requiredCapabilities: [],
            attempt: 0,
            createdAt: now,
            updatedAt: now,
        };
        await this.tasks.upsert(plan);
        await this.taskEvents.append({
            taskId: plan.id,
            type: "plan.created",
            actor: owner.id,
            eventId: spec.eventId,
            data: { title: plan.title },
        });
        await this.audit.append({
            type: "plan.created",
            actor: owner.id,
            subject: plan.id,
            data: { title: plan.title },
        });
        return plan;
    }

    async delegate(parentTaskId, spec, actorAgentId) {
        const parent = await this.requireTask(parentTaskId);
        if (TERMINAL.has(parent.status))
            throw new Error(`cannot delegate from terminal task ${parent.id}`);

        const actor = actorAgentId ?? parent.ownerAgentId;
        if (!actor)
            throw new Error("delegation requires an explicit supervisor agent");
        const supervisor = this.requireAgent(actor);
        if (supervisor.role !== "supervisor")
            throw new Error(`agent ${actor} is not a supervisor`);
        if (parent.ownerAgentId && parent.ownerAgentId !== actor) {
            throw new Error(`agent ${actor} does not own parent task ${parent.id}`);
        }

        const task = await this.submit({
            ...spec,
            parentTaskId,
            supervisorAgentId: actor,
        }, actor);
        await this.taskEvents.append({
            taskId: parent.id,
            type: "task.delegated",
            actor,
            eventId: spec.delegationEventId,
            data: { childTaskId: task.id, dependencyIds: task.dependencyIds },
        });
        return task;
    }

    async listTasks() {
        return this.tasks.list();
    }

    async listTaskEvents(taskId) {
        return this.taskEvents.list(taskId);
    }

    async getTaskGraph(rootTaskId) {
        const root = await this.requireTask(rootTaskId);
        const descendants = await this.tasks.descendants(rootTaskId);
        const nodes = [root, ...descendants];
        const nodeIds = new Set(nodes.map((task) => task.id));
        const edges = [];
        for (const task of descendants) {
            if (task.parentTaskId) {
                edges.push({ type: "parent", from: task.parentTaskId, to: task.id });
            }
            for (const dependencyId of task.dependencyIds ?? []) {
                if (nodeIds.has(dependencyId))
                    edges.push({ type: "dependency", from: dependencyId, to: task.id });
            }
        }
        return {
            rootTaskId,
            nodes,
            edges,
            statusCounts: statusCounts(nodes),
            events: await this.taskEvents.list([...nodeIds]),
        };
    }

    async reportProgress(taskId, progress, actorAgentId) {
        const task = await this.requireTask(taskId);
        if (!ACTIVE_WORK.has(task.status))
            throw new Error(`task ${task.id} cannot report progress from status ${task.status}`);
        const actor = actorAgentId ?? task.ownerAgentId ?? task.assignedAgentId;
        if (!actor)
            throw new Error(`task ${task.id} has no worker identity for progress`);
        if (task.ownerAgentId && task.ownerAgentId !== actor)
            throw new Error(`agent ${actor} does not own task ${task.id}`);
        if (progress.percent !== undefined && (progress.percent < 0 || progress.percent > 100)) {
            throw new Error("progress.percent must be between 0 and 100");
        }

        const appended = await this.taskEvents.append({
            taskId,
            type: "task.progress",
            actor,
            eventId: progress.eventId,
            data: {
                percent: progress.percent,
                message: progress.message,
                data: progress.data,
            },
        });
        if (appended.duplicate)
            return { task, event: appended.event, duplicate: true };

        const updated = await this.patch(task, {
            progress: {
                eventId: appended.event.id,
                at: appended.event.at,
                percent: progress.percent,
                message: progress.message,
                data: progress.data,
            },
        });
        return { task: updated, event: appended.event, duplicate: false };
    }

    async retry(taskId) {
        const task = await this.requireTask(taskId);
        if (["queued", "accepted", "running"].includes(task.status) && task.lastRetryAt)
            return task;
        if (!["failed", "blocked", "cancelled", "changes_requested"].includes(task.status)) {
            throw new Error(`task ${task.id} cannot be retried from status ${task.status}`);
        }

        const now = new Date().toISOString();
        const review = task.review
            ? { ...task.review, status: "pending" }
            : undefined;
        const queued = await this.patch(task, {
            status: "queued",
            attempt: (task.attempt ?? 0) + 1,
            lastRetryAt: now,
            error: undefined,
            result: undefined,
            candidateResult: undefined,
            review,
        });
        await this.taskEvents.append({
            taskId: task.id,
            type: "task.retried",
            actor: "user",
            data: {
                attempt: queued.attempt,
                assignedAgentId: task.assignedAgentId,
                hasHarnessState: Boolean(task.harnessState),
            },
        });
        await this.audit.append({
            type: "task.retried",
            actor: "user",
            subject: task.id,
            data: {
                attempt: queued.attempt,
                assignedAgentId: task.assignedAgentId,
                hasHarnessState: Boolean(task.harnessState),
            },
        });
        return queued;
    }

    async cancel(taskId, options = {}) {
        const cascade = options.cascade !== false;
        const targets = [await this.requireTask(taskId)];
        if (cascade)
            targets.push(...(await this.tasks.descendants(taskId)));

        const cancelled = [];
        for (const task of targets) {
            if (TERMINAL.has(task.status)) {
                cancelled.push(task);
                continue;
            }
            this.#controllers.get(task.id)?.abort();
            const updated = await this.patch(task, {
                status: "cancelled",
                error: options.reason ?? "cancelled by user",
            });
            await this.taskEvents.append({
                taskId: task.id,
                type: "task.cancelled",
                actor: options.actor ?? "user",
                eventId: task.id === taskId ? options.eventId : undefined,
                data: { cascaded: task.id !== taskId, rootTaskId: taskId },
            });
            await this.audit.append({
                type: "task.cancelled",
                actor: options.actor ?? "user",
                subject: task.id,
                data: { cascaded: task.id !== taskId, rootTaskId: taskId },
            });
            cancelled.push(updated);
        }
        return cancelled[0];
    }

    async reviewTask(taskId, reviewInput, reviewerAgentId) {
        const task = await this.requireTask(taskId);
        if (task.status !== "awaiting_review") {
            const existing = reviewInput.eventId
                ? (await this.taskEvents.list(taskId)).find((event) => event.id === reviewInput.eventId)
                : undefined;
            if (existing)
                return task;
            throw new Error(`task ${task.id} is not awaiting review`);
        }
        if (!task.review?.required)
            throw new Error(`task ${task.id} does not require review`);
        if (!reviewerAgentId)
            throw new Error("reviewer agent id is required");
        const reviewer = this.requireAgent(reviewerAgentId);
        const required = task.review.requiredCapabilities ?? ["review"];
        if (!required.every((capability) => reviewer.capabilities.includes(capability))) {
            throw new Error(`reviewer ${reviewer.id} lacks required capabilities: ${required.join(", ")}`);
        }
        if (task.review.independent !== false && reviewer.id === task.assignedAgentId) {
            throw new Error("independent review cannot be performed by the executing worker");
        }
        if (!["approve", "changes_requested"].includes(reviewInput.decision)) {
            throw new Error("review decision must be approve or changes_requested");
        }

        const eventType = reviewInput.decision === "approve" ? "review.approved" : "review.changes_requested";
        const appended = await this.taskEvents.append({
            taskId,
            type: eventType,
            actor: reviewer.id,
            eventId: reviewInput.eventId,
            data: { notes: reviewInput.notes },
        });
        if (appended.duplicate)
            return this.requireTask(taskId);

        const reviewRecord = {
            eventId: appended.event.id,
            at: appended.event.at,
            reviewerAgentId: reviewer.id,
            decision: reviewInput.decision,
            notes: reviewInput.notes,
        };
        const history = [...(task.review.history ?? []), reviewRecord];

        if (reviewInput.decision === "changes_requested") {
            const updated = await this.patch(task, {
                status: "changes_requested",
                review: {
                    ...task.review,
                    status: "changes_requested",
                    reviewerAgentId: reviewer.id,
                    history,
                    latest: reviewRecord,
                },
            });
            await this.audit.append({
                type: "review.changes_requested",
                actor: reviewer.id,
                subject: task.id,
                data: { notes: reviewInput.notes },
            });
            return updated;
        }

        const approved = await this.patch(task, {
            status: "completed",
            result: task.candidateResult,
            candidateResult: undefined,
            review: {
                ...task.review,
                status: "approved",
                reviewerAgentId: reviewer.id,
                history,
                latest: reviewRecord,
            },
            error: undefined,
        });
        await this.persistFinalResult(approved, task.assignedAgentId ?? task.ownerAgentId ?? "runtime");
        await this.audit.append({
            type: "task.completed",
            actor: reviewer.id,
            subject: task.id,
            data: { reviewed: true, reviewerAgentId: reviewer.id },
        });
        return approved;
    }

    async aggregatePlan(planId, actorAgentId) {
        const plan = await this.requireTask(planId);
        if (plan.kind !== "plan")
            throw new Error(`task ${plan.id} is not a plan`);
        const actor = actorAgentId ?? plan.ownerAgentId;
        if (!actor || plan.ownerAgentId !== actor)
            throw new Error(`only plan owner ${plan.ownerAgentId} may aggregate plan ${plan.id}`);
        this.requireAgent(actor);
        if (TERMINAL.has(plan.status))
            return plan;

        const descendants = await this.tasks.descendants(plan.id);
        if (!descendants.length)
            throw new Error(`plan ${plan.id} has no delegated tasks`);
        const active = descendants.filter((task) => ACTIVE_WORK.has(task.status));
        if (active.length) {
            return {
                ...plan,
                aggregate: {
                    ready: false,
                    statusCounts: statusCounts(descendants),
                    activeTaskIds: active.map((task) => task.id),
                },
            };
        }

        const allSucceeded = descendants.every((task) => task.status === "completed");
        const result = {
            outcome: allSucceeded ? "success" : "partial_failure",
            statusCounts: statusCounts(descendants),
            tasks: descendants.map((task) => ({
                id: task.id,
                title: task.title,
                status: task.status,
                assignedAgentId: task.assignedAgentId,
                result: task.result,
                error: task.error,
            })),
        };
        const updated = await this.patch(plan, {
            status: allSucceeded ? "completed" : "failed",
            result,
            error: allSucceeded ? undefined : "one or more delegated tasks did not complete successfully",
        });
        const type = allSucceeded ? "plan.completed" : "plan.failed";
        await this.taskEvents.append({ taskId: plan.id, type, actor, data: result });
        await this.audit.append({
            type,
            actor,
            subject: plan.id,
            data: { statusCounts: result.statusCounts },
        });
        return updated;
    }

    async runNext() {
        const allTasks = await this.tasks.list();
        for (const queued of allTasks.filter((task) => task.status === "queued" && task.kind !== "plan")) {
            const dependencyState = this.dependencyState(queued, allTasks);
            if (dependencyState.blockedReason) {
                return this.blockTask(queued, "runtime", dependencyState.blockedReason);
            }
            if (!dependencyState.ready)
                continue;

            const compatible = this.compatibleAgents(queued);
            if (!compatible.length) {
                return this.blockTask(
                    queued,
                    "runtime",
                    `no compatible worker for capabilities: ${(queued.requiredCapabilities ?? []).join(", ") || "none"}`,
                );
            }
            const available = compatible.filter((agent) => {
                const busy = this.#busy.get(agent.id) ?? 0;
                return busy < (agent.maxConcurrency ?? 1);
            });
            if (!available.length)
                continue;
            const agent = this.sortAgents(available)[0];
            return this.runTask(queued, agent);
        }
        return undefined;
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

    compatibleAgents(task) {
        const required = new Set(task.requiredCapabilities ?? []);
        const pinnedAgentId = task.harnessState?.sessionId ? task.assignedAgentId : undefined;
        return this.agents.filter((agent) => {
            if (agent.role === "supervisor" && task.allowSupervisorExecution !== true)
                return false;
            if (pinnedAgentId && agent.id !== pinnedAgentId)
                return false;
            if (task.preferredAgentId && agent.id !== task.preferredAgentId)
                return false;
            return [...required].every((capability) => agent.capabilities.includes(capability));
        });
    }

    sortAgents(agents) {
        return [...agents].sort((a, b) => {
            const busyDelta = (this.#busy.get(a.id) ?? 0) - (this.#busy.get(b.id) ?? 0);
            if (busyDelta)
                return busyDelta;
            const priorityDelta = (b.priority ?? 0) - (a.priority ?? 0);
            if (priorityDelta)
                return priorityDelta;
            return a.id.localeCompare(b.id);
        });
    }

    dependencyState(task, allTasks) {
        const byId = new Map(allTasks.map((candidate) => [candidate.id, candidate]));
        for (const dependencyId of task.dependencyIds ?? []) {
            const dependency = byId.get(dependencyId);
            if (!dependency)
                return { ready: false, blockedReason: `dependency task missing: ${dependencyId}` };
            if (["failed", "blocked", "cancelled"].includes(dependency.status)) {
                return { ready: false, blockedReason: `dependency ${dependencyId} ended as ${dependency.status}` };
            }
            if (dependency.status !== "completed")
                return { ready: false };
        }
        return { ready: true };
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
        if (!decision.allowed)
            return this.blockTask(task, agent.id, decision.reason, decision.ruleId);

        const accepted = await this.patch(task, {
            status: "accepted",
            assignedAgentId: agent.id,
            ownerAgentId: agent.id,
        });
        await this.taskEvents.append({
            taskId: task.id,
            type: "task.accepted",
            actor: agent.id,
            data: { supervisorAgentId: task.supervisorAgentId },
        });

        this.#busy.set(agent.id, (this.#busy.get(agent.id) ?? 0) + 1);
        const controller = new AbortController();
        this.#controllers.set(task.id, controller);
        await this.patch(accepted, { status: "running" });
        await this.taskEvents.append({
            taskId: task.id,
            type: "task.started",
            actor: agent.id,
            data: { attempt: task.attempt ?? 0 },
        });
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
            await this.taskEvents.append({
                taskId: task.id,
                type: "task.harness_state_updated",
                actor: agent.id,
                data: { keys: Object.keys(statePatch), kind: updated.harnessState?.kind },
            });
            await this.audit.append({
                type: "task.harness_state_updated",
                actor: agent.id,
                subject: task.id,
                data: { keys: Object.keys(statePatch), kind: updated.harnessState?.kind },
            });
            return updated;
        };

        const reportProgress = async (progress) => this.reportProgress(task.id, progress, agent.id);

        try {
            const latest = await this.requireTask(task.id);
            const result = await createHarness(agent).run({
                task: latest,
                agent,
                signal: controller.signal,
                updateHarnessState,
                reportProgress,
            });
            const afterRun = await this.requireTask(task.id);
            if (afterRun.status === "cancelled")
                return afterRun;

            if (!result.ok) {
                const failed = await this.patch(afterRun, {
                    status: "failed",
                    error: result.error ?? "harness failed",
                });
                await this.taskEvents.append({
                    taskId: task.id,
                    type: "task.failed",
                    actor: agent.id,
                    data: { error: failed.error },
                });
                await this.audit.append({
                    type: "task.failed",
                    actor: agent.id,
                    subject: task.id,
                    data: { error: failed.error, harnessMetadata: result.metadata },
                });
                return failed;
            }

            if (afterRun.review?.required) {
                const awaitingReview = await this.patch(afterRun, {
                    status: "awaiting_review",
                    candidateResult: result.output,
                    result: undefined,
                    error: undefined,
                    review: { ...afterRun.review, status: "pending" },
                });
                await this.memory.put({
                    scope: `task:${task.id}`,
                    key: `candidate_result:attempt:${task.attempt ?? 0}`,
                    value: result.output,
                    tags: ["candidate-result", agent.id],
                });
                await this.taskEvents.append({
                    taskId: task.id,
                    type: "task.awaiting_review",
                    actor: agent.id,
                    data: { requiredCapabilities: awaitingReview.review.requiredCapabilities },
                });
                await this.audit.append({
                    type: "task.awaiting_review",
                    actor: agent.id,
                    subject: task.id,
                    data: { requiredCapabilities: awaitingReview.review.requiredCapabilities },
                });
                return awaitingReview;
            }

            const completed = await this.patch(afterRun, {
                status: "completed",
                result: result.output,
                error: undefined,
            });
            await this.persistFinalResult(completed, agent.id);
            await this.taskEvents.append({
                taskId: task.id,
                type: "task.completed",
                actor: agent.id,
                data: { hasOutput: result.output !== undefined },
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
            await this.taskEvents.append({
                taskId: task.id,
                type: status === "cancelled" ? "task.cancelled" : "task.failed",
                actor: agent.id,
                data: { error: error.message },
            });
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

    async blockTask(task, actor, reason, ruleId) {
        if (task.status === "blocked")
            return task;
        const blocked = await this.patch(task, {
            status: "blocked",
            assignedAgentId: actor === "runtime" ? task.assignedAgentId : actor,
            error: reason,
        });
        await this.taskEvents.append({
            taskId: task.id,
            type: "task.blocked",
            actor,
            data: { reason, ruleId },
        });
        await this.audit.append({
            type: "task.blocked",
            actor,
            subject: task.id,
            data: { reason, ruleId },
        });
        return blocked;
    }

    async persistFinalResult(task, agentId) {
        await this.memory.put({
            scope: `task:${task.id}`,
            key: "result",
            value: task.result,
            tags: ["task-result", agentId],
        });
        await this.memory.put({
            scope: `agent:${agentId}`,
            key: `task:${task.id}:result`,
            value: task.result,
            tags: ["task-result"],
        });
    }

    requireAgent(id) {
        const agent = this.agents.find((candidate) => candidate.id === id);
        if (!agent)
            throw new Error(`agent not found: ${id}`);
        return agent;
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
