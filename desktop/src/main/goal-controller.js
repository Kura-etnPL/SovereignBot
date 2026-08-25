import { randomBytes } from "node:crypto";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

// Goal Controller v2 (Desktop v1.1.1, BLOCKER B/C): turns one natural-language goal into
// a governed, recoverable run driven by REAL provider agents.
//
// Pipeline per goal (background pump, serialized so the orchestrator never sees two
// concurrent pumps):
//   planning      -> a planning task on the planner identity proposes an UNTRUSTED plan.
//                    The proposal is strictly validated; invalid output triggers bounded
//                    repair rounds (still through the planner provider) and then an HONEST
//                    failure. There is no single-step Echo fallback in normal mode.
//   executing     -> steps are delegated as Core tasks with real instructions, capability
//                    requirements validated against the live roster, and dependency edges;
//                    every launch runs inside the operator's trusted workspace via the
//                    internal delegateTrusted execution context.
//   reviewing     -> reviewRequired steps get an independent reviewer task whose strict
//                    JSON decision drives orchestrator.reviewTask(); changes_requested
//                    retries the same worker session, bounded.
//   synthesizing  -> a synthesis task on the synthesizer identity produces the final
//                    answer from public results only. Failures stay honest.
//
// Demo Mode is the ONLY place Echo runs: it takes an explicit trusted quick path (one
// deterministic step), clearly labeled in the conversation.

const GOALS_SCHEMA = "sovereignbot.desktop.goals.v2";
export const MAX_GOAL_TEXT = 8000;
export const MAX_STEPS = 12;
const MAX_MESSAGES = 200;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const PLANNER_ATTEMPTS = 3;
const MAX_REVIEW_CYCLES = 3;

export const PLANNER_INSTRUCTION =
    "You are the planner of a governed multi-agent runtime. Propose an execution plan for the " +
    "user goal below. Reply with JSON ONLY (no prose, no code fences): " +
    '{"title":string,"synthesis":true,"steps":[{"key":string,"title":string,"instructions":string,' +
    '"capability":"research"|"coding"|"general"|"review","dependsOn":[earlier step keys],"reviewRequired":boolean}]}. ' +
    `At most ${MAX_STEPS} steps. Every step needs concrete instructions. Dependencies may only point to EARLIER steps.`;

function repairInstruction(errors, previousProposal) {
    return (
        "Your previous plan proposal was REJECTED by the strict validator. Fix ALL reported problems and reply " +
        "with corrected JSON ONLY using the same schema.\nValidation errors:\n- " +
        errors.join("\n- ") +
        "\nPrevious proposal (for reference only):\n" +
        String(previousProposal).slice(0, 4000)
    );
}

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

// Provider harness results reach Core task.result as { text, ... } (session ids already
// stripped by the provider result boundary). Extract the embedded proposal JSON.
export function extractProposalJson(rawResult) {
    let candidate = rawResult;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        if (typeof candidate.text === "string")
            candidate = candidate.text;
        else
            return undefined;
    }
    if (typeof candidate !== "string")
        return undefined;
    let text = candidate.trim();
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced)
        text = fenced[1].trim();
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}

// Authority-bearing key names that must never appear anywhere in an untrusted proposal.
const FORBIDDEN_PROPOSAL_KEYS = new Set([
    "cwd", "workspacepath", "workspaceid", "command", "executable", "args", "prefixargs",
    "prefixarguments", "env", "environment", "policy", "token", "secret", "bearer",
    "bearertoken", "apikey", "sessionid", "harnessstate", "actorid", "owneragentid",
    "assignedagentid", "preferredagentid", "allowprivatehosts", "browser",
]);

function findForbiddenKey(value, path = "$") {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    for (const [key, child] of Object.entries(value)) {
        const squeezed = key.replaceAll(/[-_\s]/g, "").toLowerCase();
        const here = `${path}.${key}`;
        if (FORBIDDEN_PROPOSAL_KEYS.has(squeezed))
            return here;
        const nested = findForbiddenKey(child, here);
        if (nested)
            return nested;
    }
    return undefined;
}

// Strict validator for untrusted planner output: reject-with-errors, never silently drop.
export function validateProposal(candidate, capabilities) {
    const errors = [];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return { ok: false, errors: ["proposal must be a JSON object"] };
    }
    const forbidden = findForbiddenKey(candidate);
    if (forbidden)
        return { ok: false, errors: [`authority-bearing field is not allowed in a proposal: ${forbidden}`] };

    if (candidate.synthesis === false)
        errors.push("plan must declare \"synthesis\": true");
    const title = boundedText(candidate.title, 120);

    if (!Array.isArray(candidate.steps) || !candidate.steps.length) {
        errors.push("steps must be a non-empty array");
        return { ok: false, errors };
    }
    if (candidate.steps.length > MAX_STEPS)
        errors.push(`plan exceeds ${MAX_STEPS} steps`);

    const seenKeys = new Set();
    const stepKeys = [];
    const steps = [];
    for (const [index, raw] of candidate.steps.entries()) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            errors.push(`step ${index + 1} must be an object`);
            continue;
        }
        const stepForbidden = findForbiddenKey(raw, `$step${index + 1}`);
        if (stepForbidden) {
            errors.push(`authority-bearing field is not allowed in step ${index + 1}: ${stepForbidden}`);
            continue;
        }
        const title = boundedText(raw.title, 200);
        if (!title) {
            errors.push(`step ${index + 1} is missing a title`);
            continue;
        }
        const instructions = boundedText(raw.instructions, 4000);
        if (!instructions) {
            errors.push(`step ${index + 1} ("${slice(title, 40)}") is missing concrete instructions`);
            continue;
        }
        const key = typeof raw.key === "string" && /^[a-z][\w-]{0,39}$/i.test(raw.key.trim())
            ? raw.key.trim().toLowerCase()
            : undefined;
        if (!key) {
            errors.push(`step ${index + 1} needs a short identifier "key"`);
            continue;
        }
        if (seenKeys.has(key)) {
            errors.push(`duplicate step key: ${key}`);
            continue;
        }
        seenKeys.add(key);
        let capability;
        if (raw.capability !== undefined) {
            if (typeof raw.capability !== "string" || !/^[a-z][\w:-]{0,59}$/i.test(raw.capability.trim())) {
                errors.push(`step "${key}" has a malformed capability`);
                continue;
            }
            capability = raw.capability.trim().toLowerCase();
            if (capability !== "general" && !capabilities.has(capability)) {
                errors.push(`step "${key}" requests unknown capability "${capability}" (available: ${[...capabilities].sort().join(", ")})`);
                continue;
            }
            if (capability === "planning" || capability === "review") {
                // Planning belongs to the supervisor; review is driven by the reviewer pass.
                errors.push(`step "${key}" cannot request the reserved capability "${capability}"`);
                continue;
            }
        }
        let dependsOn = [];
        if (raw.dependsOn !== undefined) {
            if (!Array.isArray(raw.dependsOn)) {
                errors.push(`step "${key}" dependsOn must be an array of earlier step keys`);
                continue;
            }
            dependsOn = [...new Set(raw.dependsOn.map((value) => String(value).trim().toLowerCase()))];
        }
        steps.push({
            key,
            title,
            instructions,
            capability,
            dependsOn,
            reviewRequired: raw.reviewRequired === true,
        });
        stepKeys.push(key);
    }

    for (const step of steps) {
        for (const dependency of step.dependsOn) {
            if (!stepKeys.includes(dependency)) {
                errors.push(`step "${step.key}" depends on unknown or later step "${dependency}"`);
                continue;
            }
            if (stepKeys.indexOf(dependency) >= stepKeys.indexOf(step.key))
                errors.push(`step "${step.key}" dependency "${dependency}" must reference an earlier step`);
        }
    }

    if (errors.length || !steps.length)
        return { ok: false, errors };
    return {
        ok: true,
        proposal: { ...(title ? { title } : {}), synthesis: true, steps },
    };
}

export function createGoalController({
    runtime,
    services,
    supervisorAgentId,
    readiness,
    roster,
    persistPath,
    onTerminal,
    now = () => new Date().toISOString(),
    makeId = makeGoalId,
}) {
    if (!runtime?.orchestrator)
        throw new Error("goal controller requires a core runtime");
    if (!services?.workspacePath || !services?.defaultWorkspacePath)
        throw new Error("goal controller requires desktop workspace services");
    if (!supervisorAgentId)
        throw new Error("goal controller requires a supervisor agent id");
    if (readiness && typeof readiness !== "function")
        throw new Error("goal controller readiness must be a function");
    if (typeof roster !== "function")
        throw new Error("goal controller requires a roster reader");

    const orchestrator = runtime.orchestrator;

    function rosterSnapshot() {
        const snapshot = roster();
        if (!snapshot?.ready || snapshot.mode === "demo")
            throw new Error(snapshot?.mode === "demo"
                ? "demo roster"
                : "no ready AI provider roster");
        return snapshot;
    }

    function workerCapabilitySet() {
        const snapshot = rosterSnapshot();
        const set = new Set(["general"]);
        for (const agent of snapshot.agents ?? []) {
            if (agent.id === snapshot.roles.planner)
                continue;
            for (const capability of agent.capabilities ?? [])
                set.add(capability);
        }
        set.delete("planning");
        set.delete("review");
        return set;
    }

    function phaseAgentName(role) {
        const snapshot = roster();
        const id = snapshot.roles?.[role];
        const agent = (snapshot.agents ?? []).find((entry) => entry.id === id);
        return agent ? `${agent.name} (${id})` : id;
    }

    const state = loadJsonState(persistPath, null);
    const goals = state?.schema === GOALS_SCHEMA && Array.isArray(state.goals)
        ? state.goals.filter((goal) => goal && Array.isArray(goal.taskIds) && goal.conversation)
        : state?.schema === "sovereignbot.desktop.goals.v1" && Array.isArray(state.goals)
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

    let pumpChain = Promise.resolve();
    let activePump = undefined;

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
            const snapshot = rosterSnapshot();
            const demo = snapshot.mode === "demo";
            goal.mode = snapshot.mode;
            goal.rolesUsed = { ...snapshot.roles };
            setStatus(goal, "planning");
            appendMessage(goal, "phase", `Planning — ${phaseAgentName("planner")}`, "agent");

            const plan = await orchestrator.createPlan({
                title: `goal: ${slice(goal.text, 80)}`,
                ownerAgentId: supervisorAgentId,
                input: { goal: goal.text },
            });
            goal.planId = plan.id;
            const workspacePath = goal.workspacePath;
            const workspaceId = goal.workspaceId;
            const context = { workspaceId, cwd: workspacePath };

            let proposal;
            let proposalErrors = [];
            if (demo) {
                // Explicit Demo Mode quick path (trusted code, clearly labeled): one
                // deterministic step so wiring can be checked without any provider.
                appendMessage(goal, "plan", "DEMO mode: running a single deterministic wiring step (no real AI provider).");
                proposal = {
                    title: "demo wiring step",
                    steps: [{ key: "demo-step", title: slice(goal.text, 180), instructions: goal.text, capability: "demo", dependsOn: [] }],
                };
            }
            else {
                let previousRaw = "";
                for (let attempt = 0; attempt < PLANNER_ATTEMPTS && !proposal; attempt += 1) {
                    checkpoint();
                    const planningTask = await orchestrator.delegateTrusted(plan.id, {
                        title: attempt === 0 ? `propose plan: ${slice(goal.text, 60)}` : `repair plan proposal (attempt ${attempt + 1})`,
                        requiredCapabilities: ["planning"],
                        allowSupervisorExecution: true,
                        input: attempt === 0
                            ? { instruction: PLANNER_INSTRUCTION, goal: goal.text }
                            : { instruction: repairInstruction(proposalErrors, previousRaw), goal: goal.text },
                    }, context, supervisorAgentId);
                    goal.taskIds.push(planningTask.id);
                    await orchestrator.runUntilIdle();
                    checkpoint();

                    const finished = (await orchestrator.listTasks()).find((task) => task.id === planningTask.id);
                    if (finished?.status !== "completed")
                        throw new Error(`planning task did not complete (${finished?.status ?? "unknown"})`);

                    previousRaw = typeof finished.result?.text === "string" ? finished.result.text : JSON.stringify(finished.result ?? "");
                    const parsed = validateProposal(extractProposalJson(finished.result), workerCapabilitySet());
                    if (parsed.ok) {
                        proposal = parsed.proposal;
                        appendMessage(goal, "plan", `accepted validated proposal "${proposal.title ?? "execution plan"}" with ${proposal.steps.length} step(s)`);
                    }
                    else {
                        proposalErrors = parsed.errors;
                        if (attempt < PLANNER_ATTEMPTS - 1)
                            appendMessage(goal, "plan", `planner proposal rejected (${parsed.errors.length} problem(s)); asking the planner to repair`);
                    }
                }
                if (!proposal)
                    throw new Error("planner produced no valid proposal after repair attempts; refusing to run unvalidated work");
            }
            save();
            checkpoint();

            // ---- executing ----
            setStatus(goal, "executing");
            // Steps are delegated in dependency waves so each task's input can carry the
            // public results of its completed dependencies; intra-wave steps stay parallel.
            const stepIds = new Map();
            const publicResults = new Map();
            const pending = [...(proposal.steps ?? [])];
            while (pending.length) {
                checkpoint();
                const ready = pending.filter((step) => step.dependsOn.every((key) => stepIds.has(key)));
                if (!ready.length)
                    throw new Error("plan contains unsatisfiable dependencies");
                for (const [index, step] of ready.entries()) {
                    const requiredCapabilities = step.capability ? [step.capability] : ["general"];
                    const dependencyResults = step.dependsOn
                        .map((key) => publicResults.get(key))
                        .filter(Boolean)
                        .map((record) => ({ stepKey: record.stepKey, status: record.status, text: record.text }));
                    const task = await orchestrator.delegateTrusted(plan.id, {
                        title: `step ${proposal.steps.indexOf(step) + 1}: ${step.title}`,
                        requiredCapabilities,
                        dependencyIds: step.dependsOn.map((key) => stepIds.get(key)).filter(Boolean),
                        ...(step.reviewRequired ? { review: { required: true } } : {}),
                        input: {
                            instruction: step.instructions,
                            userGoal: goal.text,
                            stepKey: step.key,
                            workspaceId,
                            ...(dependencyResults.length ? { dependencyResults } : {}),
                        },
                    }, context, supervisorAgentId);
                    stepIds.set(step.key, task.id);
                    goal.taskIds.push(task.id);
                    void index;
                }
                checkpoint();
                await orchestrator.runUntilIdle();
                checkpoint();
                for (const step of ready) {
                    const taskId = stepIds.get(step.key);
                    const finished = (await orchestrator.listTasks()).find((task) => task.id === taskId);
                    publicResults.set(step.key, {
                        stepKey: step.key,
                        status: finished?.status ?? "unknown",
                        text: typeof finished?.result?.text === "string" ? finished.result.text : undefined,
                        error: finished?.error,
                    });
                }
                for (const step of ready)
                    pending.splice(pending.indexOf(step), 1);
            }
            checkpoint();
            await runWorkWithReviews({ goal, plan, context, checkpoint });
            checkpoint();

            // ---- synthesizing ----
            const related = (await orchestrator.listTasks()).filter((task) => goal.taskIds.includes(task.id));
            const workTasks = related.filter((task) => {
                const caps = task.requiredCapabilities ?? [];
                return !caps.includes("planning") && !caps.includes("review") && !caps.includes("synthesis");
            });
            const allSucceeded = workTasks.every((task) => task.status === "completed");

            setStatus(goal, "synthesizing");
            appendMessage(goal, "phase", `Synthesis — ${phaseAgentName("synthesizer")}`, "agent");
            checkpoint();

            let finalAnswer;
            if (demo) {
                finalAnswer = allSucceeded
                    ? `Demo run completed (no real AI provider involved).\n${workTasks.map((task) => `- ${task.title}: ${task.status}`).join("\n")}`
                    : `Demo run did not fully complete.\n${workTasks.map((task) => `- ${task.title}: ${task.status}${task.error ? ` (${task.error})` : ""}`).join("\n")}`;
            }
            else {
                const synthesisTask = await orchestrator.delegateTrusted(plan.id, {
                    title: `synthesize result for: ${slice(goal.text, 60)}`,
                    requiredCapabilities: ["synthesis"],
                    input: {
                        originalGoal: goal.text,
                        planTitle: proposal.title ?? "execution plan",
                        steps: workTasks.map((task) => ({
                            title: task.title,
                            status: task.status,
                            error: task.error,
                            resultText: typeof task.result?.text === "string" ? task.result.text.slice(0, 2000) : undefined,
                            ...(task.review?.latest ? { reviewDecision: task.review.latest.decision, reviewNotes: task.review.latest.notes } : {}),
                        })),
                        outcome: allSucceeded ? "success" : "partial_failure",
                    },
                }, context, supervisorAgentId);
                goal.taskIds.push(synthesisTask.id);
                await orchestrator.runUntilIdle();
                checkpoint();

                const finishedSynth = (await orchestrator.listTasks()).find((task) => task.id === synthesisTask.id);
                if (finishedSynth?.status !== "completed" || typeof finishedSynth.result?.text !== "string" || !finishedSynth.result.text.trim())
                    throw new Error("synthesis failed; the honest work summary is available in the activity log");
                finalAnswer = finishedSynth.result.text.trim();
                if (!allSucceeded)
                    finalAnswer += `\n\n(Note: some delegated steps did not complete successfully — see statuses above.)`;
            }

            // The durable plan record closes only after every delegated work — including
            // the synthesis pass itself — has finished.
            await orchestrator.aggregatePlan(plan.id, supervisorAgentId);

            goal.finalAnswer = finalAnswer;
            appendMessage(goal, "answer", goal.finalAnswer);
            setStatus(goal, allSucceeded ? "completed" : "failed");
            if (!allSucceeded)
                goal.error = "one or more delegated steps failed";
            notifyTerminal(goal);
        }
        catch (error) {
            if (error instanceof PumpCancelled) {
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

    // Drives independent reviews for every awaiting_review work task until they are all
    // resolved or the cycle budget is exhausted.
    async function runWorkWithReviews({ goal, plan, context, checkpoint }) {
        const reviewCycles = new Map();

        for (;;) {
            checkpoint();
            await orchestrator.runUntilIdle();
            checkpoint();

            const related = (await orchestrator.listTasks()).filter((task) => goal.taskIds.includes(task.id));
            const awaiting = related.filter((task) => task.status === "awaiting_review");
            if (!awaiting.length) {
                const active = related.find((task) => ["queued", "accepted", "running"].includes(task.status));
                if (active)
                    continue; // retry pass still in flight
                return related;
            }

            const snapshot = rosterSnapshot();
            for (const task of awaiting) {
                const cycles = (reviewCycles.get(task.id) ?? 0) + 1;
                if (cycles > MAX_REVIEW_CYCLES)
                    throw new Error(`review did not converge for "${task.title}" after ${MAX_REVIEW_CYCLES} cycles`);
                reviewCycles.set(task.id, cycles);

                appendMessage(goal, "phase", `Review — ${phaseAgentName("reviewer")} (cycle ${cycles})`, "agent");
                const reviewTask = await orchestrator.delegateTrusted(plan.id, {
                    title: `review: ${slice(task.title, 80)}`,
                    requiredCapabilities: ["review"],
                    input: {
                        userGoal: goal.text,
                        stepTitle: task.title,
                        instruction: task.input?.instruction,
                        candidateResult: typeof task.candidateResult?.text === "string"
                            ? task.candidateResult.text.slice(0, 4000)
                            : JSON.stringify(task.candidateResult ?? {}).slice(0, 4000),
                        ...(task.attempt ? { attempt: task.attempt } : {}),
                        ...(task.review?.latest?.notes ? { previousReviewNotes: task.review.latest.notes } : {}),
                    },
                }, context, supervisorAgentId);
                goal.taskIds.push(reviewTask.id);
                checkpoint();
                await orchestrator.runUntilIdle();
                checkpoint();

                const finishedReview = (await orchestrator.listTasks()).find((entry) => entry.id === reviewTask.id);
                if (finishedReview?.status !== "completed")
                    throw new Error(`reviewer task did not complete (${finishedReview?.status ?? "unknown"})`);
                const decisionInput = parseReviewDecision(finishedReview.result);
                if (!decisionInput)
                    throw new Error("reviewer output was not a valid {decision, notes} object; refusing to guess");

                await orchestrator.reviewTask(task.id, decisionInput, snapshot.roles.reviewer);
                appendMessage(goal, "review", decisionInput.decision === "approve"
                    ? `approved: ${slice(decisionInput.notes ?? "", 300)}`
                    : `changes_requested: ${slice(decisionInput.notes ?? "", 300)}`);

                if (decisionInput.decision === "changes_requested") {
                    await orchestrator.retry(task.id);
                }
            }
        }
    }

    function parseReviewDecision(rawResult) {
        const parsed = extractProposalJson(rawResult);
        if (!parsed || typeof parsed.decision !== "string")
            return undefined;
        if (!["approve", "changes_requested"].includes(parsed.decision))
            return undefined;
        return { decision: parsed.decision, notes: boundedText(parsed.notes, 2000) };
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
            if (readiness) {
                const status = readiness();
                if (!status?.allowed)
                    throw new Error(status?.reason ?? "Connect at least one AI provider to run goals.");
            }
            const resolvedWorkspaceId = workspaceId !== undefined ? workspaceId : services.defaultWorkspaceId?.();
            const workspacePath = workspaceId !== undefined
                ? services.workspacePath(workspaceId)
                : services.defaultWorkspacePath();
            if (!workspacePath)
                throw new Error(resolvedWorkspaceId !== undefined
                    ? `unknown workspace id: ${resolvedWorkspaceId}`
                    : "no workspace registered yet");

            const goal = {
                id: makeId(),
                createdAt: now(),
                updatedAt: now(),
                status: "planning",
                mode: readiness ? undefined : "provider",
                text: value,
                workspaceId: resolvedWorkspaceId,
                workspacePath,
                planId: undefined,
                taskIds: [],
                rolesUsed: {},
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
                mode: goal.mode,
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
                    mode: goal.mode,
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
