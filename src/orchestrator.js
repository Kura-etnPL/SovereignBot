import { createHarness, harnessTarget } from "./harness.js";
import { createId } from "./id.js";

const TERMINAL = new Set(["completed", "failed", "blocked", "cancelled"]);
const ACTIVE_WORK = new Set(["queued", "accepted", "running", "awaiting_review", "changes_requested"]);
const PROGRESS_STATUSES = new Set(["accepted", "running"]);

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
            if (task.parentTaskId)
                edges.push({ type: "parent", from: task.parentTaskId, to: task.id });
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
        if (!PROGRESS_STATUSES.has(task.status))
            throw new Error(`task ${task.id} cannot report progress from status ${task.status}`);
        const actor = actorAgentId ?? task.ownerAgentId ?? task.assignedAgentId;
        if (!actor)
            throw new Error(`task ${task.id} has no worker identity for progress`);
        this.requireAgent(actor);
        const owner = task.ownerAgentId ?? task.assignedAgentId;
        if (owner !== actor)
            throw new Error(`agent ${actor} does not own task ${task.id}`);
        if (progress.percent !== undefined && (progress.percent < 0 || progress.percent > 100))
            throw new Error("progress.percent must be between 0 and 100");

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
            return { task: await this.requireTask(taskId), event: appended.event, duplicate: true };

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
        const retryable = ["failed", "blocked", "cancelled", "changes_requested"];
        if (!retryable.includes(task.status))
            throw new Error(`task ${task.id} cannot be retried from status ${task.status}`);

        const now = new Date().toISOString();
        const review = task.review ? { ...task.review, status: "pending" } : undefined;
        const transition = await this.transition(task.id, retryable, {
            status: "queued",
            attempt: (task.attempt ?? 0) + 1,
            lastRetryAt: now,
            error: undefined,
            result: undefined,
            candidateResult: undefined,
            review,
        });
        if (!transition.changed)
            return transition.task;

        await this.taskEvents.append({
            taskId: task.id,
            type: "task.retried",
            actor: "user",
            data: {
                attempt: transition.task.attempt,
                assignedAgentId: transition.task.assignedAgentId,
                hasHarnessState: Boolean(transition.task.harnessState),
            },
        });
        await this.audit.append({
            type: "task.retried",
            actor: "user",
            subject: task.id,
            data: {
                attempt: transition.task.attempt,
                assignedAgentId: transition.task.assignedAgentId,
                hasHarnessState: Boolean(transition.task.harnessState),
            },
        });
        return transition.task;
    }

    async cancel(taskId, options = {}) {
        const targets = [await this.requireTask(taskId)];
        if (options.cascade !== false)
            targets.push(...(await this.tasks.descendants(taskId)));

        let rootResult = targets[0];
        for (const snapshot of targets) {
            this.#controllers.get(snapshot.id)?.abort();
            const transition = await this.transition(
                snapshot.id,
                ["active", "queued", "accepted", "running", "awaiting_review", "changes_requested"],
                { status: "cancelled", error: options.reason ?? "cancelled by user" },
            );
            if (snapshot.id === taskId)
                rootResult = transition.task;
            if (!transition.changed)
                continue;

            await this.taskEvents.append({
                taskId: snapshot.id,
                type: "task.cancelled",
                actor: options.actor ?? "user",
                eventId: snapshot.id === taskId ? options.eventId : undefined,
                data: { cascaded: snapshot.id !== taskId, rootTaskId: taskId },
            });
            await this.audit.append({
                type: "task.cancelled",
                actor: options.actor ?? "user",
                subject: snapshot.id,
                data: { cascaded: snapshot.id !== taskId, rootTaskId: taskId },
            });
        }
        return rootResult;
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
        if (task.review.independent !== false && reviewer.id === task.assignedAgentId)
            throw new Error("independent review cannot be performed by the executing worker");
        const required = task.review.requiredCapabilities ?? ["review"];
        if (!required.every((capability) => reviewer.capabilities.includes(capability)))
            throw new Error(`reviewer ${reviewer.id} lacks required capabilities: ${required.join(", ")}`);
        if (!["approve", "changes_requested"].includes(reviewInput.decision))
            throw new Error("review decision must be approve or changes_requested");

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
            const transition = await this.transition(task.id, ["awaiting_review"], {
                status: "changes_requested",
                review: {
                    ...task.review,
                    status: "changes_requested",
                    reviewerAgentId: reviewer.id,
                    history,
                    latest: reviewRecord,
                },
            });
            if (!transition.changed)
                return transition.task;
            await this.audit.append({
                type: "review.changes_requested",
                actor: reviewer.id,
                subject: task.id,
                data: { notes: reviewInput.notes },
            });
            return transition.task;
        }

        const transition = await this.transition(task.id, ["awaiting_review"], {
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
        if (!transition.changed)
            return transition.task;
        await this.persistFinalResult(
            transition.task,
            transition.task.assignedAgentId ?? transition.task.ownerAgentId ?? "runtime",
        );
        await this.audit.append({
            type: "task.completed",
            actor: reviewer.id,
            subject: task.id,
            data: { reviewed: true, reviewerAgentId: reviewer.id },
        });
        return transition.task;
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
        const transition = await this.transition(plan.id, ["active"], {
            status: allSucceeded ? "completed" : "failed",
            result,
            error: allSucceeded ? undefined : "one or more delegated tasks did not complete successfully",
        });
        if (!transition.changed)
            return transition.task;
        const type = allSucceeded ? "plan.completed" : "plan.failed";
        await this.taskEvents.append({ taskId: plan.id, type, actor, data: result });
        await this.audit.append({
            type,
            actor,
            subject: plan.id,
            data: { statusCounts: result.statusCounts },
        });
        return transition.task;
    }

    async runNext() {
        const allTasks = await this.tasks.list();
        for (const queued of allTasks.filter((task) => task.status === "queued" && task.kind !== "plan")) {
            const dependencyState = this.dependencyState(queued, allTasks);
            if (dependencyState.blockedReason)
                return this.blockTask(queued, "runtime", dependencyState.blockedReason);
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
            return this.runTask(queued, this.sortAgents(available)[0]);
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
            if (["failed", "blocked", "cancelled"].includes(dependency.status))
                return { ready: false, blockedReason: `dependency ${dependencyId} ended as ${dependency.status}` };
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

        const acceptance = await this.transition(task.id, ["queued"], {
            status: "accepted",
            assignedAgentId: agent.id,
            ownerAgentId: agent.id,
        });
        if (!acceptance.changed)
            return acceptance.task;
        await this.taskEvents.append({
            taskId: task.id,
            type: "task.accepted",
            actor: agent.id,
            data: { supervisorAgentId: acceptance.task.supervisorAgentId },
        });

        this.#busy.set(agent.id, (this.#busy.get(agent.id) ?? 0) + 1);
        const controller = new AbortController();
        this.#controllers.set(task.id, controller);
        const running = await this.transition(task.id, ["accepted"], { status: "running" });
        if (!running.changed) {
            this.#busy.set(agent.id, Math.max(0, (this.#busy.get(agent.id) ?? 1) - 1));
            this.#controllers.delete(task.id);
            return running.task;
        }
        await this.taskEvents.append({
            taskId: task.id,
            type: "task.started",
            actor: agent.id,
            data: { attempt: running.task.attempt ?? 0 },
        });
        await this.audit.append({
            type: "task.started",
            actor: agent.id,
            subject: task.id,
            data: { title: running.task.title, resumed: Boolean(running.task.harnessState?.sessionId) },
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
                const failure = await this.transition(task.id, ["running"], {
                    status: "failed",
                    error: result.error ?? "harness failed",
                });
                if (!failure.changed)
                    return failure.task;
                await this.taskEvents.append({
                    taskId: task.id,
                    type: "task.failed",
                    actor: agent.id,
                    data: { error: failure.task.error },
                });
                await this.audit.append({
                    type: "task.failed",
                    actor: agent.id,
                    subject: task.id,
                    data: { error: failure.task.error, harnessMetadata: result.metadata },
                });
                return failure.task;
            }

            if (afterRun.review?.required) {
                const reviewTransition = await this.transition(task.id, ["running"], {
                    status: "awaiting_review",
                    candidateResult: result.output,
                    result: undefined,
                    error: undefined,
                    review: { ...afterRun.review, status: "pending" },
                });
                if (!reviewTransition.changed)
                    return reviewTransition.task;
                await this.memory.put({
                    scope: `task:${task.id}`,
                    key: `candidate_result:attempt:${reviewTransition.task.attempt ?? 0}`,
                    value: result.output,
                    tags: ["candidate-result", agent.id],
                });
                await this.taskEvents.append({
                    taskId: task.id,
                    type: "task.awaiting_review",
                    actor: agent.id,
                    data: { requiredCapabilities: reviewTransition.task.review.requiredCapabilities },
                });
                await this.audit.append({
                    type: "task.awaiting_review",
                    actor: agent.id,
                    subject: task.id,
                    data: { requiredCapabilities: reviewTransition.task.review.requiredCapabilities },
                });
                return reviewTransition.task;
            }

            const completion = await this.transition(task.id, ["running"], {
                status: "completed",
                result: result.output,
                error: undefined,
            });
            if (!completion.changed)
                return completion.task;
            await this.persistFinalResult(completion.task, agent.id);
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
            return completion.task;
        }
        catch (error) {
            const desiredStatus = controller.signal.aborted ? "cancelled" : "failed";
            const transition = await this.transition(task.id, ["running", "accepted"], {
                status: desiredStatus,
                error: error.message,
            });
            if (!transition.changed)
                return transition.task;
            await this.taskEvents.append({
                taskId: task.id,
                type: desiredStatus === "cancelled" ? "task.cancelled" : "task.failed",
                actor: agent.id,
                data: { error: error.message },
            });
            await this.audit.append({
                type: desiredStatus === "cancelled" ? "task.cancelled" : "task.failed",
                actor: agent.id,
                subject: task.id,
                data: { error: error.message },
            });
            return transition.task;
        }
        finally {
            this.#busy.set(agent.id, Math.max(0, (this.#busy.get(agent.id) ?? 1) - 1));
            this.#controllers.delete(task.id);
        }
    }

    async blockTask(task, actor, reason, ruleId) {
        const transition = await this.transition(task.id, ["queued", "accepted", "running"], {
            status: "blocked",
            assignedAgentId: actor === "runtime" ? task.assignedAgentId : actor,
            error: reason,
        });
        if (!transition.changed)
            return transition.task;
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
        return transition.task;
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
        return this.tasks.update(task.id, (current) => ({
            ...current,
            ...patch,
            updatedAt: new Date().toISOString(),
        }));
    }

    async transition(taskId, allowedStatuses, patch) {
        let changed = false;
        const task = await this.tasks.update(taskId, (current) => {
            if (!allowedStatuses.includes(current.status))
                return current;
            changed = true;
            return {
                ...current,
                ...patch,
                updatedAt: new Date().toISOString(),
            };
        });
        return { task, changed };
    }
}
