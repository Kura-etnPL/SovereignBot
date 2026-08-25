import { randomBytes } from "node:crypto";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

// Goal Controller: turns one natural-language goal into a governed, recoverable run.
//
// Pipeline per goal (background pump, serialized so the orchestrator never sees two
// concurrent pumps):
//   planning     -> supervisor owns a Core plan; a planning task proposes a DAG. The
//                   proposal is UNTRUSTED DATA: it is strictly validated below and never
//                   interpreted as instructions. Unparseable proposals fall back to a
//                   single deterministic step carrying the raw goal.
//   executing    -> steps are delegated as Core tasks with dependency edges; the Core
//                   policy engine and audit trail govern every harness run.
//   synthesizing -> aggregatePlan produces the outcome; an honest final answer is written
//                   into the durable conversation whether the run succeeded or not.

const GOALS_SCHEMA = "sovereignbot.desktop.goals.v1";
export const MAX_GOAL_TEXT = 8000;
export const MAX_STEPS = 12;
const MAX_MESSAGES = 200;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

const PLANNER_INSTRUCTION =
    "Propose a short execution plan for the goal below. Reply with JSON only: " +
    '{"title":string,"steps":[{"title":string,"capability":string?,dependsOn":[number indices of earlier steps]?}]}. ' +
    "At most 12 steps.";

export function makeGoalId() {
    return `goal_${randomBytes(8).toString("hex")}`;
}

function slice(text, max) {
    const value = String(text ?? "").replace(/\s+/g, " ").trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function boundedText(value, max) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

// Strict validator for untrusted planner output. Returns null unless the raw output is an
// object that carries a usable steps array; anything else falls back deterministically.
export function parseProposal(rawResult) {
    const candidate = rawResult && typeof rawResult === "object" && !Array.isArray(rawResult)
        ? (Array.isArray(rawResult.steps) ? rawResult : Array.isArray(rawResult.proposal?.steps) ? rawResult.proposal : undefined)
        : undefined;
    if (!candidate)
        return undefined;
    const rawSteps = candidate.steps.filter((step) => step && typeof step === "object" && !Array.isArray(step));
    if (!rawSteps.length)
        return undefined;

    const steps = [];
    for (const raw of rawSteps.slice(0, MAX_STEPS)) {
        const title = boundedText(raw.title, 200);
        if (!title)
            continue;
        const index = steps.length;
        let dependsOn = [];
        if (Array.isArray(raw.dependsOn)) {
            dependsOn = [...new Set(raw.dependsOn
                .map((value) => Number(value))
                .filter((value) => Number.isInteger(value) && value >= 0 && value < index))];
            if (dependsOn.length > index)
                dependsOn = dependsOn.slice(0, index);
        }
        const capability = typeof raw.capability === "string" && /^[a-z][\w:-]{0,59}$/i.test(raw.capability.trim())
            ? raw.capability.trim()
            : undefined;
        steps.push({ title, capability, dependsOn });
    }
    if (!steps.length)
        return undefined;
    return { title: boundedText(candidate.title, 120) ?? "execution plan", steps };
}

export function createGoalController({ runtime, services, supervisorAgentId, readiness, persistPath, onTerminal, now = () => new Date().toISOString(), makeId = makeGoalId }) {
    if (!runtime?.orchestrator)
        throw new Error("goal controller requires a core runtime");
    if (!services?.workspacePath || !services?.defaultWorkspacePath)
        throw new Error("goal controller requires desktop workspace services");
    if (!supervisorAgentId)
        throw new Error("goal controller requires a supervisor agent id");
    if (readiness && typeof readiness !== "function")
        throw new Error("goal controller readiness must be a function");

    const orchestrator = runtime.orchestrator;
    const workerAgents = (runtime.config.agents ?? []).filter((agent) => agent.id !== supervisorAgentId);
    const workerHasCapability = (capability) => workerAgents.some((agent) => (agent.capabilities ?? []).includes(capability));

    const state = loadJsonState(persistPath, null);
    const goals = state?.schema === GOALS_SCHEMA && Array.isArray(state.goals)
        ? state.goals.filter((goal) => goal && Array.isArray(goal.taskIds) && goal.conversation)
        : [];
    // Goals interrupted by shutdown are marked failed honestly; their Core tasks are
    // recovered by the orchestrator's own durable execution, not re-run silently here.
    for (const goal of goals) {
        if (!TERMINAL_STATUSES.has(goal.status)) {
            goal.status = "failed";
            goal.error = goal.error ?? "interrupted by application shutdown";
            goal.updatedAt = now();
        }
    }

    function save() {
        saveJsonState(persistPath, { schema: GOALS_SCHEMA, goals });
    }

    function appendMessage(goal, kind, text, role = "system") {
        goal.conversation.messages.push({ at: now(), role, kind, text: String(text).slice(0, 4000) });
        if (goal.conversation.messages.length > MAX_MESSAGES)
            goal.conversation.messages.splice(0, goal.conversation.messages.length - MAX_MESSAGES);
    }

    function setStatus(goal, status) {
        goal.status = status;
        goal.updatedAt = now();
        appendMessage(goal, "status", `goal status: ${status}`);
    }

    // Fired once per terminal transition so the main process can raise a desktop
    // notification; listener errors must never disturb the pump.
    function notifyTerminal(goal) {
        if (!TERMINAL_STATUSES.has(goal.status) || typeof onTerminal !== "function")
            return;
        try {
            onTerminal({
                id: goal.id,
                status: goal.status,
                textPreview: slice(goal.text, 160),
                finalAnswer: goal.finalAnswer,
                error: goal.error,
            });
        }
        catch {
        }
    }

    // One background pump at a time across all goals; queued goals wait their turn.
    let pumpChain = Promise.resolve();
    let activePump = undefined;

    // Thrown at phase checkpoints when the operator cancelled the goal while the pump
    // was awaiting the orchestrator; the pump must stop quietly, never overwrite the
    // operator's terminal decision with its own.
    class PumpCancelled extends Error {}

    async function runPump(goalId) {
        const goal = goals.find((entry) => entry.id === goalId);
        if (!goal || TERMINAL_STATUSES.has(goal.status))
            return;
        const checkpoint = () => {
            if (goal.status === "cancelled")
                throw new PumpCancelled();
        };

        try {
            checkpoint();
            setStatus(goal, "planning");
            const plan = await orchestrator.createPlan({
                title: `goal: ${slice(goal.text, 80)}`,
                ownerAgentId: supervisorAgentId,
                input: { goal: goal.text },
            });
            goal.planId = plan.id;

            const planningTask = await orchestrator.delegate(plan.id, {
                title: `propose plan: ${slice(goal.text, 60)}`,
                requiredCapabilities: ["planning"],
                // The proposal step is exactly the kind of supervised work the supervisor
                // role exists for; Core requires this explicit opt-in to run it there.
                allowSupervisorExecution: true,
                input: { instruction: PLANNER_INSTRUCTION, goal: goal.text },
            }, supervisorAgentId);
            goal.taskIds.push(planningTask.id);
            checkpoint();
            await orchestrator.runUntilIdle();
            checkpoint();

            const finishedPlan = (await orchestrator.listTasks()).find((task) => task.id === planningTask.id);
            if (finishedPlan?.status !== "completed")
                throw new Error(`planning task did not complete (${finishedPlan?.status ?? "unknown"})`);

            const proposal = parseProposal(finishedPlan.result) ?? {
                title: "single-step fallback",
                steps: [{ title: slice(goal.text, 180), dependsOn: [] }],
            };
            if (parseProposal(finishedPlan.result))
                appendMessage(goal, "plan", `accepted validated proposal "${proposal.title}" with ${proposal.steps.length} step(s)`);
            else
                appendMessage(goal, "plan", `planner output was not a valid proposal; using single-step fallback ("${proposal.title}")`);
            save();
            checkpoint();

            setStatus(goal, "executing");
            const stepIds = [];
            for (const [index, step] of proposal.steps.entries()) {
                checkpoint();
                const requiredCapabilities = step.capability && workerHasCapability(step.capability) ? [step.capability] : [];
                const task = await orchestrator.delegate(plan.id, {
                    title: `step ${index + 1}: ${step.title}`,
                    requiredCapabilities,
                    dependencyIds: step.dependsOn.map((dependency) => stepIds[dependency]).filter(Boolean),
                }, supervisorAgentId);
                stepIds.push(task.id);
                goal.taskIds.push(task.id);
            }
            checkpoint();
            await orchestrator.runUntilIdle();
            checkpoint();

            const mine = new Set(goal.taskIds);
            const related = (await orchestrator.listTasks()).filter((task) => mine.has(task.id));
            const stalled = related.find((task) => !TERMINAL_STATUSES.has(task.status) && task.status !== "awaiting_review");
            if (stalled)
                throw new Error(`delegated task stalled in status ${stalled.status} (no capable agent?)`);

            setStatus(goal, "synthesizing");
            checkpoint();
            const aggregate = await orchestrator.aggregatePlan(plan.id, supervisorAgentId);
            const details = (aggregate.result?.tasks ?? [])
                .map((task) => `- ${task.title}: ${task.status}${task.error ? ` (${task.error})` : ""}`)
                .join("\n");
            const succeeded = aggregate.result?.outcome === "success" && aggregate.status === "completed";
            goal.finalAnswer = succeeded
                ? `Goal completed.\n${details}`
                : `Goal did not fully complete (outcome: ${aggregate.result?.outcome ?? aggregate.status}).\n${details}`;
            appendMessage(goal, "answer", goal.finalAnswer);
            setStatus(goal, succeeded ? "completed" : "failed");
            if (!succeeded)
                goal.error = "one or more delegated steps failed";
            notifyTerminal(goal);
        }
        catch (error) {
            if (error instanceof PumpCancelled) {
                // The operator's cancel() already recorded the terminal state and message.
                save();
                return;
            }
            goal.error = String(error?.message ?? error).slice(0, 500);
            appendMessage(goal, "answer", `Goal failed: ${goal.error}`);
            setStatus(goal, "failed");
            notifyTerminal(goal);
        }
        finally {
            save();
        }
    }

    function schedule(goalId) {
        const run = pumpChain.then(() => runPump(goalId));
        pumpChain = run.catch(() => {});
        activePump = run;
        return run;
    }

    return {
        async submitGoal({ text, workspaceId }) {
            const value = typeof text === "string" ? text.trim() : "";
            if (!value)
                throw new Error("goal text is required");
            if (value.length > MAX_GOAL_TEXT)
                throw new Error(`goal text exceeds ${MAX_GOAL_TEXT} characters`);
            // Normal production mode refuses to run goals without a real provider roster;
            // Echo is only reachable through explicit Demo Mode. The refusal is loud and
            // actionable — never a silent downgrade.
            if (readiness) {
                const status = readiness();
                if (!status?.allowed)
                    throw new Error(status?.reason ?? "Connect at least one AI provider to run goals.");
            }
            const workspacePath = workspaceId !== undefined
                ? services.workspacePath(workspaceId)
                : services.defaultWorkspacePath();
            if (!workspacePath)
                throw new Error(workspaceId !== undefined
                    ? `unknown workspace id: ${workspaceId}`
                    : "no workspace registered yet");

            const goal = {
                id: makeId(),
                createdAt: now(),
                updatedAt: now(),
                status: "planning",
                text: value,
                workspacePath,
                planId: undefined,
                taskIds: [],
                error: undefined,
                finalAnswer: undefined,
                conversation: { id: `conv_${randomBytes(8).toString("hex")}`, messages: [] },
            };
            appendMessage(goal, "goal", value, "user");
            goals.push(goal);
            save();
            schedule(goal.id);
            return this.getGoal(goal.id);
        },

        async cancel(goalId) {
            const goal = goals.find((entry) => entry.id === String(goalId));
            if (!goal)
                throw new Error(`unknown goal id: ${goalId}`);
            if (TERMINAL_STATUSES.has(goal.status))
                return this.getGoal(goal.id);
            for (const taskId of goal.taskIds) {
                try {
                    await orchestrator.cancel(taskId, { reason: `goal ${goal.id} cancelled` });
                }
                catch {
                    // Task already terminal; cancellation is best-effort per task.
                }
            }
            appendMessage(goal, "answer", "Goal cancelled by operator.");
            setStatus(goal, "cancelled");
            save();
            notifyTerminal(goal);
            return this.getGoal(goal.id);
        },

        getGoal(goalId) {
            const goal = goals.find((entry) => entry.id === String(goalId));
            if (!goal)
                throw new Error(`unknown goal id: ${goalId}`);
            return {
                id: goal.id,
                status: goal.status,
                createdAt: goal.createdAt,
                updatedAt: goal.updatedAt,
                textPreview: slice(goal.text, 160),
                workspacePath: goal.workspacePath,
                error: goal.error,
                finalAnswer: goal.finalAnswer,
            };
        },

        listGoals() {
            return {
                schema: GOALS_SCHEMA,
                goals: goals.map((goal) => ({
                    id: goal.id,
                    status: goal.status,
                    createdAt: goal.createdAt,
                    updatedAt: goal.updatedAt,
                    textPreview: slice(goal.text, 160),
                })),
            };
        },

        getConversation(goalId) {
            const goal = goals.find((entry) => entry.id === String(goalId));
            if (!goal)
                throw new Error(`unknown goal id: ${goalId}`);
            return {
                goalId: goal.id,
                conversationId: goal.conversation.id,
                messages: structuredClone(goal.conversation.messages.slice(-MAX_MESSAGES)),
            };
        },

        async flush() {
            await (activePump ?? Promise.resolve());
        },
    };
}
