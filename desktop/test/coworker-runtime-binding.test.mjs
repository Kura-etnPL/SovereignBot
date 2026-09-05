import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createConversationStore } from "../src/main/conversation-store.js";
import { createAttachmentAwareConversationStore } from "../src/main/attachment-integration.js";
import { createSkillAwareConversationStore } from "../src/main/skill-integration.js";
import { createCoworkerDispatcher, classifyCoworkerError } from "../src/main/coworker-dispatcher.js";
import {
    buildProviderRoster,
    coworkerAgentId,
    coworkerCapability,
    validateRoleAssignment,
} from "../src/main/provider-roster.js";

const READY = () => ({ found: true, auth: { state: "signed-in" } });

function makeCoworkers(root) {
    let seq = 0;
    const store = createCoworkerStore({
        persistPath: join(root, "coworkers.json"),
        makeId: () => `coworker_${String(++seq).padStart(16, "0")}`,
    });
    const chief = store.create({ name: "Chief", role: "Coordinate", providerPreference: "auto" });
    const coder = store.create({ name: "Coder", role: "Implement", providerPreference: "codex" });
    return { store, chief, coder };
}

test("provider roster creates one dedicated provider-backed runtime identity per active coworker", () => {
    const root = mkdtempSync(join(tmpdir(), "sb-coworker-roster-"));
    try {
        const { store, chief, coder } = makeCoworkers(root);
        const roster = buildProviderRoster({
            discovery: { codex: READY(), claude: READY() },
            settings: {},
            coworkers: store.list().coworkers,
        });

        assert.equal(roster.coworkerBindings[chief.id].provider, "codex");
        assert.equal(roster.coworkerBindings[coder.id].provider, "codex");
        assert.equal(roster.coworkerBindings[coder.id].agentId, coworkerAgentId(coder.id));

        const coderAgent = roster.agents.find((agent) => agent.id === coworkerAgentId(coder.id));
        assert.ok(coderAgent);
        assert.equal(coderAgent.harness.kind, "codex");
        assert.deepEqual(coderAgent.capabilities, ["general", coworkerCapability(coder.id)]);
        assert.equal(coderAgent.role, "worker");

        // Coworker product identities cannot be inserted into hidden orchestration roles.
        assert.throws(
            () => validateRoleAssignment(roster, { role: "worker", agentId: coderAgent.id }),
            /not compatible/,
        );
        assert.throws(
            () => validateRoleAssignment(roster, { role: "worker", agentId: "claude-planner" }),
            /not compatible/,
        );
        assert.equal(validateRoleAssignment(roster, { role: "worker", agentId: "codex-worker" }).ok, true);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("explicit unavailable coworker provider fails honestly instead of silently switching providers", () => {
    const root = mkdtempSync(join(tmpdir(), "sb-coworker-provider-"));
    try {
        const { store, coder } = makeCoworkers(root);
        const roster = buildProviderRoster({
            discovery: { codex: { found: false }, claude: READY() },
            settings: {},
            coworkers: store.list().coworkers,
        });
        assert.equal(roster.coworkerBindings[coder.id].ready, false);
        assert.match(roster.coworkerBindings[coder.id].reason, /codex.*unavailable/i);
        assert.equal(roster.agents.some((agent) => agent.id === coworkerAgentId(coder.id)), false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

function fakeRuntime(roster) {
    const tasks = [];
    const plans = [];
    const audit = [];
    let id = 0;
    const agents = roster.agents;
    const orchestrator = {
        async createPlan(spec) {
            const plan = { id: `plan_${++id}`, ...spec, kind: "plan", status: "active" };
            plans.push(plan);
            return structuredClone(plan);
        },
        async delegateTrusted(planId, spec, context) {
            const task = {
                id: `task_${++id}`,
                parentTaskId: planId,
                status: "queued",
                ...structuredClone(spec),
                executionContext: structuredClone(context),
            };
            tasks.push(task);
            return structuredClone(task);
        },
        requireAgent(agentId) {
            const agent = agents.find((entry) => entry.id === agentId);
            if (!agent)
                throw new Error(`agent not found: ${agentId}`);
            return agent;
        },
        async patch(task, patch) {
            const target = tasks.find((entry) => entry.id === task.id);
            Object.assign(target, structuredClone(patch));
            return structuredClone(target);
        },
        async runUntilIdle() {
            for (const task of tasks.filter((entry) => entry.status === "queued")) {
                const agent = agents.find((entry) => entry.id === task.preferredAgentId);
                assert.ok(agent, `missing preferred agent ${task.preferredAgentId}`);
                assert.ok(task.requiredCapabilities.every((capability) => agent.capabilities.includes(capability)));
                task.assignedAgentId = agent.id;
                const prior = task.harnessState?.sessionId;
                task.harnessState = {
                    kind: agent.harness.kind,
                    sessionId: prior ?? `session-${agent.id}`,
                };
                task.status = "completed";
                task.result = { text: prior ? `resumed:${task.input.newestMessageId}` : `fresh:${task.input.newestMessageId}` };
            }
        },
        async listTasks() {
            return structuredClone(tasks);
        },
        async cancel(taskId, reason) {
            const task = tasks.find((entry) => entry.id === taskId);
            if (!task) throw new Error(`task not found: ${taskId}`);
            task.status = "cancelled";
            task.error = reason?.reason ?? "cancelled";
            return structuredClone(task);
        },
    };
    return {
        orchestrator,
        audit: { async append(entry) { audit.push(structuredClone(entry)); } },
        _tasks: tasks,
        _plans: plans,
        _audit: audit,
    };
}

test("coworker dispatcher gives each coworker a durable provider lane and resumes its previous provider session", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-coworker-dispatch-"));
    try {
        const { store, coder } = makeCoworkers(root);
        const roster = buildProviderRoster({
            discovery: { codex: READY(), claude: READY() },
            settings: {},
            coworkers: store.list().coworkers,
        });
        const runtime = fakeRuntime(roster);
        const conversations = createConversationStore({
            persistPath: join(root, "conversations.json"),
            coworkerStore: store,
        });
        const direct = conversations.createDirect(coder.id);
        const services = {
            workspacePath() { return undefined; },
        };
        const dispatcher = createCoworkerDispatcher({
            dataDir: root,
            runtime,
            roster: () => roster,
            coworkerStore: store,
            conversationStore: conversations,
            services,
        });

        const first = conversations.postUserMessage(direct.id, { text: "First turn", clientMessageId: "one" });
        dispatcher.dispatchMessage(direct.id, first.id);
        await dispatcher.flush();
        let view = conversations.get(direct.id);
        assert.equal(view.messages.length, 2);
        assert.match(view.messages[1].text, /^fresh:/);
        assert.equal(view.messages[0].delivery[coder.id].status, "delivered");

        const firstTask = runtime._tasks[0];
        assert.equal(firstTask.preferredAgentId, coworkerAgentId(coder.id));
        assert.deepEqual(firstTask.requiredCapabilities, [coworkerCapability(coder.id)]);
        assert.match(firstTask.executionContext.workspaceId, /^coworker:/);
        assert.match(firstTask.executionContext.cwd, /coworker-workspaces/);

        const second = conversations.postUserMessage(direct.id, { text: "Second turn", clientMessageId: "two" });
        dispatcher.dispatchMessage(direct.id, second.id);
        await dispatcher.flush();
        view = conversations.get(direct.id);
        assert.equal(view.messages.length, 4);
        assert.match(view.messages[3].text, /^resumed:/);
        assert.equal(runtime._tasks[1].harnessState.sessionId, runtime._tasks[0].harnessState.sessionId);
        assert.ok(runtime._audit.some((entry) => entry.type === "coworker.continuity_bound" && entry.data.resumed === true));

        const serialized = JSON.stringify(view);
        assert.equal(serialized.includes(runtime._tasks[0].harnessState.sessionId), false, "provider session id must not enter conversation state");
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

for (const interruptedStatus of ["running", "completed"]) test(`dispatcher recovers pending delivery after ${interruptedStatus} execution without replay`, async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-coworker-recovery-"));
    try {
        const { store, coder } = makeCoworkers(root);
        const reviewer = store.create({ name: "Reviewer", role: "Review", providerPreference: "codex" });
        const roster = buildProviderRoster({ discovery: { codex: READY(), claude: READY() }, settings: {}, coworkers: store.list().coworkers });
        const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: store });
        const team = conversations.createTeam({ title: "Recovery", coworkerIds: [coder.id, reviewer.id], leadCoworkerId: coder.id });
        const message = conversations.postUserMessage(team.id, { text: "Interrupted turn", mentions: ["everyone"] });
        const runtime = fakeRuntime(roster);
        runtime._tasks.push({ id: "task_interrupted", status: interruptedStatus, assignedAgentId: coworkerAgentId(coder.id), input: { newestMessageId: message.id } });
        const decorated = createSkillAwareConversationStore(createAttachmentAwareConversationStore(conversations, {}), { decorateConversation: value => value });
        const dispatcher = createCoworkerDispatcher({
            dataDir: root,
            runtime,
            roster: () => roster,
            coworkerStore: store,
            conversationStore: decorated,
            services: { workspacePath() { return undefined; } },
        });

        await dispatcher.flush();
        assert.equal(conversations.get(team.id).messages[0].delivery[coder.id].status, "attention");
        assert.equal(conversations.get(team.id).messages[0].delivery[reviewer.id].status, "pending", "unrelated recipient must remain pending");
        assert.match(conversations.get(team.id).messages[0].delivery[coder.id].detail, /explicitly retry/i);
        assert.equal(runtime._tasks.length, 1, "restart recovery must not create or replay a provider task");
        assert.equal(runtime._tasks[0].status, interruptedStatus === "completed" ? "completed" : "cancelled", "recovery must preserve completed work and terminate stale execution");
        await dispatcher.stopConversation(team.id, "user redirected", "desktop-operator", undefined, { redirected: true });
        assert.equal(conversations.get(team.id).messages[0].delivery[coder.id].status, "redirected", "explicit redirect closes recovered attention");
        assert.equal(conversations.get(team.id).messages[0].delivery[reviewer.id].status, "redirected");
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("coworker dispatcher honors trusted configured workspace bindings", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-coworker-workspace-"));
    try {
        const { store, coder } = makeCoworkers(root);
        const workspace = join(root, "project");
        const { mkdirSync } = await import("node:fs");
        mkdirSync(workspace, { recursive: true });
        store.update(coder.id, { workspaceIds: ["workspace_project"] });
        const roster = buildProviderRoster({
            discovery: { codex: READY(), claude: READY() },
            settings: {},
            coworkers: store.list().coworkers,
        });
        const runtime = fakeRuntime(roster);
        const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: store });
        const direct = conversations.createDirect(coder.id);
        const dispatcher = createCoworkerDispatcher({
            dataDir: root,
            runtime,
            roster: () => roster,
            coworkerStore: store,
            conversationStore: conversations,
            services: { workspacePath(id) { return id === "workspace_project" ? workspace : undefined; } },
        });
        const message = conversations.postUserMessage(direct.id, { text: "Work in the project" });
        dispatcher.dispatchMessage(direct.id, message.id);
        await dispatcher.flush();
        assert.equal(runtime._tasks[0].executionContext.workspaceId, "workspace_project");
        assert.equal(runtime._tasks[0].executionContext.cwd, workspace);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("coworker dispatcher stop cancels active work and closes pending deliveries", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-coworker-stop-"));
    try {
        const { store, coder } = makeCoworkers(root);
        const roster = buildProviderRoster({
            discovery: { codex: READY(), claude: READY() },
            settings: {},
            coworkers: store.list().coworkers,
        });
        const runtime = fakeRuntime(roster);
        let entered;
        const enteredPromise = new Promise((resolve) => { entered = resolve; });
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        runtime.orchestrator.runUntilIdle = async () => {
            entered();
            await gate;
            for (const task of runtime._tasks.filter((entry) => entry.status === "queued")) task.status = "completed";
        };
        const conversations = createConversationStore({
            persistPath: join(root, "conversations.json"),
            coworkerStore: store,
        });
        const direct = conversations.createDirect(coder.id);
        const dispatcher = createCoworkerDispatcher({
            dataDir: root,
            runtime,
            roster: () => roster,
            coworkerStore: store,
            conversationStore: conversations,
            services: { workspacePath() { return undefined; } },
        });

        const message = conversations.postUserMessage(direct.id, { text: "Stop this turn" });
        dispatcher.dispatchMessage(direct.id, message.id);
        await enteredPromise;
        const stopped = await dispatcher.stopConversation(direct.id);
        assert.equal(stopped.requested, 1);
        assert.equal(stopped.cancelled, 1);
        assert.equal(stopped.stoppedDeliveries, 1);
        release();
        await dispatcher.flush();
        const view = conversations.get(direct.id);
        assert.equal(view.messages.length, 1);
        assert.equal(view.messages[0].delivery[coder.id].status, "failed");
        assert.match(view.messages[0].delivery[coder.id].detail, /stopped by the user/i);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("classifyCoworkerError distinguishes transient vs quota vs auth failures", () => {
    const transient502 = classifyCoworkerError("UnexpectedServerResponse(\"HTTP 502: Bad Gateway\")");
    assert.equal(transient502.retryable, true);
    assert.equal(transient502.attention, false);
    assert.equal(transient502.category, "transient_upstream");

    const transientTimeout = classifyCoworkerError("ETIMEDOUT: network connection timed out");
    assert.equal(transientTimeout.retryable, true);

    const quota = classifyCoworkerError("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage");
    assert.equal(quota.retryable, false);
    assert.equal(quota.attention, true);
    assert.equal(quota.category, "quota_exceeded");
    assert.match(quota.humanReason, /quota reached/i);

    const auth = classifyCoworkerError("Codex authentication is unavailable. Run `codex` and sign in with ChatGPT");
    assert.equal(auth.retryable, false);
    assert.equal(auth.attention, true);
    assert.equal(auth.category, "authentication");
    assert.match(auth.humanReason, /authentication required/i);
});

test("coworker dispatcher retries transient error and marks attention on persistent failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-coworker-retry-"));
    try {
        const { store, coder } = makeCoworkers(root);
        const roster = buildProviderRoster({
            discovery: { codex: READY(), claude: READY() },
            settings: {},
            coworkers: store.list().coworkers,
        });
        const runtime = fakeRuntime(roster);
        let retriesCalled = 0;
        runtime.orchestrator.retry = async (taskId) => {
            retriesCalled += 1;
            const task = runtime._tasks.find((t) => t.id === taskId);
            if (task) task.status = "queued";
        };
        runtime.orchestrator.runUntilIdle = async () => {
            for (const task of runtime._tasks.filter((entry) => entry.status === "queued")) {
                task.status = "failed";
                task.error = "UnexpectedServerResponse(\"HTTP 502: Bad Gateway\")";
            }
        };
        const conversations = createConversationStore({
            persistPath: join(root, "conversations.json"),
            coworkerStore: store,
        });
        const direct = conversations.createDirect(coder.id);
        const dispatcher = createCoworkerDispatcher({
            dataDir: root,
            runtime,
            roster: () => roster,
            coworkerStore: store,
            conversationStore: conversations,
            services: { workspacePath() { return undefined; } },
        });

        const message = conversations.postUserMessage(direct.id, { text: "Run work with glitch" });
        dispatcher.dispatchMessage(direct.id, message.id);
        await dispatcher.flush();

        assert.equal(retriesCalled, 2, "dispatcher should have retried up to MAX_COWORKER_RETRIES (2 times)");
        const view = conversations.get(direct.id);
        const delivery = view.messages[0].delivery[coder.id];
        assert.equal(delivery.status, "attention", "should transition to attention rather than hard failed");
        assert.match(delivery.detail, /temporary network\/gateway glitch/i);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

