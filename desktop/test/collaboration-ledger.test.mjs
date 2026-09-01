import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConversationStore } from "../src/main/conversation-store.js";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createCoworkerDispatcher } from "../src/main/coworker-dispatcher.js";
import { createArtifactStore } from "../src/main/artifact-store.js";
import { buildProviderRoster, coworkerAgentId, coworkerCapability } from "../src/main/provider-roster.js";
import { createDesktopServices } from "../src/main/services.js";
import { COLLABORATION_SCHEMA, createTeamService } from "../src/main/team-service.js";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "sovereign-collaboration-"));
    const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
    const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
    const services = createDesktopServices({ dataDir: root, dialog: {} });
    const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
    return { root, coworkers, conversations, teams, services };
}

test("collaboration runs and events are durable, correlated, and owner-gated", () => {
    const { root, coworkers, conversations, teams } = fixture();
    try {
        const chief = coworkers.create({ name: "Chief", role: "Coordinate work" });
        const coder = coworkers.create({ name: "Coder", role: "Build software" });
        const reviewer = coworkers.create({ name: "Reviewer", role: "Review software" });
        const created = teams.createTeam({ title: "Delivery", coworkerIds: [chief.id, coder.id, reviewer.id] });
        const first = conversations.postUserMessage(created.conversation.id, { text: "Ship the bounded change." });
        teams.onMessageQueued({ conversation: conversations.get(created.conversation.id), message: first });

        const started = teams.activity({ conversationId: created.conversation.id });
        assert.equal(started.schema, COLLABORATION_SCHEMA);
        assert.equal(started.events[0].kind, "started");
        assert.equal(started.events[0].label, "Work started");
        assert.match(started.events[0].runId, /^run_[a-f0-9]{16}$/);
        assert.match(started.events[0].requestId, /^request_[a-f0-9]{16}$/);
        assert.match(started.events[0].operationId, /^operation_[a-f0-9]{16}$/);

        const claim = teams.claimStage({ conversationId: created.conversation.id, ownerId: chief.id, messageId: first.id });
        const duplicate = teams.claimStage({ conversationId: created.conversation.id, ownerId: chief.id, messageId: first.id });
        assert.equal(duplicate.eventId, claim.eventId);
        assert.throws(() => teams.claimStage({ conversationId: created.conversation.id, ownerId: coder.id, messageId: first.id }), /already claimed/);
        assert.equal(teams.get(created.team.id).flow.currentOwnerId, chief.id);
        const staleContext = teams.collaborationContextForConversation(created.conversation.id);
        teams.recordCollaborationEvent({
            conversationId: created.conversation.id,
            type: "work.completed",
            status: "completed",
            actorId: chief.id,
            ownerId: chief.id,
            messageId: first.id,
            ...staleContext,
            expectedVersion: staleContext.version,
            idempotencyKey: `work.completed:${first.id}`,
        });
        assert.throws(() => teams.claimStage({ conversationId: created.conversation.id, ownerId: chief.id, messageId: first.id, idempotencyKey: "stale-claim", ...staleContext, expectedVersion: staleContext.version }), /stale/);

        const disk = JSON.parse(readFileSync(join(root, "desktop-state", "teams.json"), "utf8"));
        assert.equal(disk.collaboration.schema, COLLABORATION_SCHEMA);
        assert.equal(JSON.stringify(disk).includes("session"), false);
        assert.equal(JSON.stringify(disk).includes("provider"), false);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test("handoff runtime preflight can fail closed without transferring the owner", () => {
    const { root, coworkers, conversations, teams } = fixture();
    try {
        const chief = coworkers.create({ name: "Chief", role: "Coordinate work" });
        const coder = coworkers.create({ name: "Coder", role: "Build software" });
        const reviewer = coworkers.create({ name: "Reviewer", role: "Review software" });
        const created = teams.createTeam({ title: "Delivery", coworkerIds: [chief.id, coder.id, reviewer.id] });
        const first = conversations.postUserMessage(created.conversation.id, { text: "Build the change." });
        teams.onMessageQueued({ conversation: conversations.get(created.conversation.id), message: first });
        const proposed = teams.previewHandoff({ conversation: conversations.get(created.conversation.id), coworkerId: chief.id, source: first, requestedCoworkerIds: [coder.id] });
        assert.equal(proposed, coder.id);
        teams.setRuntimeHandoffPreflight(() => { throw new Error("target binding is unavailable"); });
        const context = teams.collaborationContextForConversation(created.conversation.id);
        assert.throws(() => teams.authorizeHandoffTarget({
            conversationId: created.conversation.id,
            sourceCoworkerId: chief.id,
            targetCoworkerId: coder.id,
            expectedVersion: context.version,
            expectedRunId: context.runId,
            expectedRequestId: context.requestId,
            expectedOperationId: context.operationId,
            expectedOperationToken: context.operationToken,
        }), /preflight|unavailable/);
        teams.recordCollaborationEvent({
            conversationId: created.conversation.id,
            type: "handoff.blocked",
            status: "attention",
            actorId: chief.id,
            ownerId: chief.id,
            targetCoworkerId: coder.id,
            messageId: first.id,
            reason: "The next teammate is not ready to receive this work.",
            ...context,
            expectedVersion: context.version,
            idempotencyKey: `handoff.blocked:${first.id}`,
        });
        const flow = teams.get(created.team.id).flow;
        assert.equal(flow.currentOwnerId, chief.id);
        assert.equal(flow.status, "needs-attention");
        assert.equal(flow.activity[0].kind, "attention");
        assert.equal(flow.activity[0].targetCoworkerId, coder.id);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test("stop and restart create distinct runs and do not wake the stopped run", () => {
    const { root, coworkers, conversations, teams, services } = fixture();
    try {
        const chief = coworkers.create({ name: "Chief", role: "Coordinate work" });
        const coder = coworkers.create({ name: "Coder", role: "Build software" });
        const created = teams.createTeam({ title: "Delivery", coworkerIds: [chief.id, coder.id] });
        const first = conversations.postUserMessage(created.conversation.id, { text: "Start work." });
        teams.onMessageQueued({ conversation: conversations.get(created.conversation.id), message: first });
        const firstRun = teams.get(created.team.id).flow.runId;
        teams.stopRun(created.conversation.id, "user stopped");
        assert.equal(teams.get(created.team.id).flow.status, "stopped");
        const second = conversations.postUserMessage(created.conversation.id, { text: "Redirect and try again." });
        teams.onMessageQueued({ conversation: conversations.get(created.conversation.id), message: second });
        const secondFlow = teams.get(created.team.id).flow;
        assert.notEqual(secondFlow.runId, firstRun);
        assert.equal(secondFlow.status, "active");
        const events = teams.activity({ conversationId: created.conversation.id }).events;
        assert.ok(events.some((event) => event.kind === "stopped" && event.runId === firstRun));
        assert.ok(events.some((event) => event.kind === "started" && event.runId === secondFlow.runId));
        const reloadedConversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
        const reloadedTeams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: reloadedConversations, services });
        const reloadedFlow = reloadedTeams.get(created.team.id).flow;
        assert.equal(reloadedFlow.runId, secondFlow.runId);
        assert.equal(reloadedTeams.activity({ conversationId: created.conversation.id }).events.length, events.length);
        assert.equal(reloadedTeams.collaborationContextForConversation(created.conversation.id).runId, secondFlow.runId);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

function controlledRuntime(roster, responses, onAudit = async () => {}) {
    const tasks = [];
    let sequence = 0;
    const agents = roster.agents;
    return {
        orchestrator: {
            async createPlan(spec) { return { id: `plan_${++sequence}`, ...spec }; },
            async delegateTrusted(planId, spec, executionContext) {
                const task = { id: `task_${++sequence}`, parentTaskId: planId, status: "queued", ...structuredClone(spec), executionContext: structuredClone(executionContext) };
                tasks.push(task);
                return structuredClone(task);
            },
            requireAgent(agentId) { return agents.find((entry) => entry.id === agentId) ?? (() => { throw new Error(`missing agent ${agentId}`); })(); },
            async runUntilIdle() {
                for (const task of tasks.filter((entry) => entry.status === "queued")) {
                    const agent = agents.find((entry) => entry.id === task.preferredAgentId);
                    assert.ok(agent, `missing bound agent ${task.preferredAgentId}`);
                    assert.ok(task.requiredCapabilities.every((capability) => agent.capabilities.includes(capability)));
                    task.assignedAgentId = agent.id;
                    task.status = "completed";
                    task.result = { text: responses.shift() ?? "Completed." };
                }
            },
            async listTasks() { return structuredClone(tasks); },
            async cancel(taskId) {
                const task = tasks.find((entry) => entry.id === taskId);
                if (task) task.status = "cancelled";
                return structuredClone(task);
            },
        },
        audit: { async append(entry) { await onAudit(structuredClone(entry)); } },
        tasks,
    };
}

test("Dispatcher runs a real Chief to Researcher to Coder chain through trusted bindings and workspace proof", async () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-dispatch-ledger-"));
    try {
        const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
        const chief = coworkers.create({ name: "Chief", role: "Coordinate work", providerPreference: "auto" });
        const researcher = coworkers.create({ name: "Researcher", role: "Research the bounded question", providerPreference: "codex" });
        const coder = coworkers.create({ name: "Coder", role: "Implement the bounded change", providerPreference: "codex" });
        const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
        const services = createDesktopServices({ dataDir: root, dialog: {} });
        const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
        conversations.setTeamRouteResolver((conversation) => teams.currentOwnerForConversation(conversation.id));
        const created = teams.createTeam({ title: "Research delivery", coworkerIds: [chief.id, researcher.id, coder.id] });
        const roster = buildProviderRoster({ discovery: { codex: { found: true, auth: { state: "signed-in" } }, claude: { found: true, auth: { state: "signed-in" } } }, settings: {}, coworkers: coworkers.list().coworkers });
        const runtime = controlledRuntime(roster, [
            `Chief scoped the question.\nSOVEREIGN_HANDOFFS: ["${researcher.id}"]`,
            `Research is complete.\nSOVEREIGN_HANDOFFS: ["${coder.id}"]`,
            `Coder completed the bounded implementation.\nSOVEREIGN_HANDOFFS: ["${chief.id}"]`,
            "Chief synthesized the result.",
        ]);
        let preflightCalls = 0;
        teams.setRuntimeHandoffPreflight(({ conversationId, sourceCoworkerId, targetCoworkerId, workspaceId }) => {
            preflightCalls += 1;
            assert.equal(workspaceId, teams.workspaceIdForConversation(conversationId));
            assert.ok(services.workspacePath(workspaceId));
            assert.equal(roster.coworkerBindings[targetCoworkerId]?.agentId, coworkerAgentId(targetCoworkerId));
            assert.notEqual(sourceCoworkerId, targetCoworkerId);
            return { targetCoworkerId, agentId: coworkerAgentId(targetCoworkerId), workspaceId };
        });
        const artifacts = createArtifactStore({ dataDir: root });
        const dispatcher = createCoworkerDispatcher({ dataDir: root, runtime, roster: () => roster, coworkerStore: coworkers, conversationStore: conversations, artifactStore: artifacts, services, teamFlow: teams });
        const first = conversations.postUserMessage(created.conversation.id, { text: "Research and implement this bounded change." });
        dispatcher.dispatchMessage(created.conversation.id, first.id);
        for (let attempt = 0; attempt < 5; attempt += 1) await dispatcher.flush();
        const view = conversations.get(created.conversation.id);
        assert.equal(runtime.tasks.length, 4);
        assert.deepEqual(runtime.tasks.map((task) => task.preferredAgentId), [chief, researcher, coder, chief].map((entry) => coworkerAgentId(entry.id)));
        assert.ok(runtime.tasks.every((task) => task.executionContext.workspaceId === teams.workspaceIdForConversation(created.conversation.id)));
        assert.deepEqual(runtime.tasks.map((task) => task.requiredCapabilities), [chief, researcher, coder, chief].map((entry) => [coworkerCapability(entry.id)]));
        assert.equal(preflightCalls, 3);
        assert.equal(view.messages.filter((message) => message.senderId !== "user").length, 4);
        assert.equal(teams.get(created.team.id).flow.status, "available");
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test("stop during artifact ingestion keeps the old result and artifact unpublished", async () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-dispatch-race-"));
    try {
        const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
        const chief = coworkers.create({ name: "Chief", role: "Coordinate work" });
        const researcher = coworkers.create({ name: "Researcher", role: "Research" });
        const coder = coworkers.create({ name: "Coder", role: "Code" });
        const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
        const services = createDesktopServices({ dataDir: root, dialog: {} });
        const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
        conversations.setTeamRouteResolver((conversation) => teams.currentOwnerForConversation(conversation.id));
        const created = teams.createTeam({ title: "Race delivery", coworkerIds: [chief.id, researcher.id, coder.id] });
        const workspace = services.workspacePath(teams.workspaceIdForConversation(created.conversation.id));
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, "result.md"), "private result", "utf8");
        const roster = buildProviderRoster({ discovery: { codex: { found: true, auth: { state: "signed-in" } }, claude: { found: true, auth: { state: "signed-in" } }, }, settings: {}, coworkers: coworkers.list().coworkers });
        let dispatcher;
        const runtime = controlledRuntime(roster, [`Result candidate.\nSOVEREIGN_ARTIFACTS: [{"path":"result.md","title":"Result"}]`], async (entry) => {
            if (entry.type === "coworker.artifact_ingested") await dispatcher.stopConversation(created.conversation.id, "redirected before publish");
        });
        const artifacts = createArtifactStore({ dataDir: root });
        dispatcher = createCoworkerDispatcher({ dataDir: root, runtime, roster: () => roster, coworkerStore: coworkers, conversationStore: conversations, artifactStore: artifacts, services, teamFlow: teams });
        const first = conversations.postUserMessage(created.conversation.id, { text: "Create the result, but stop if ownership changes." });
        dispatcher.dispatchMessage(created.conversation.id, first.id);
        await dispatcher.flush();
        assert.equal(artifacts.list().artifacts.length, 0);
        assert.equal(conversations.get(created.conversation.id).messages.filter((message) => message.senderId !== "user").length, 0);
        assert.equal(teams.get(created.team.id).flow.status, "stopped");
        assert.equal(teams.activity({ conversationId: created.conversation.id }).events.some((event) => event.kind === "result"), false);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test("Dispatcher does not launch a handoff with an inactive or mismatched target binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-dispatch-proof-"));
    try {
        const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
        const chief = coworkers.create({ name: "Chief", role: "Coordinate work" });
        const researcher = coworkers.create({ name: "Researcher", role: "Research" });
        const coder = coworkers.create({ name: "Coder", role: "Code" });
        const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
        const services = createDesktopServices({ dataDir: root, dialog: {} });
        const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
        const created = teams.createTeam({ title: "Blocked delivery", coworkerIds: [chief.id, researcher.id, coder.id] });
        const roster = buildProviderRoster({ discovery: { codex: { found: true, auth: { state: "signed-in" } }, claude: { found: true, auth: { state: "signed-in" } } }, settings: {}, coworkers: coworkers.list().coworkers });
        roster.coworkerBindings[researcher.id] = { ...roster.coworkerBindings[researcher.id], ready: true, agentId: "coworker-agent-mismatch" };
        const runtime = controlledRuntime(roster, [`Chief attempted a handoff.\nSOVEREIGN_HANDOFFS: ["${researcher.id}"]`]);
        teams.setRuntimeHandoffPreflight(({ targetCoworkerId }) => {
            const binding = roster.coworkerBindings[targetCoworkerId];
            if (!binding?.ready || binding.agentId !== coworkerAgentId(targetCoworkerId)) throw new Error("target binding mismatch");
            return { targetCoworkerId, agentId: binding.agentId, workspaceId: teams.workspaceIdForConversation(created.conversation.id) };
        });
        const dispatcher = createCoworkerDispatcher({ dataDir: root, runtime, roster: () => roster, coworkerStore: coworkers, conversationStore: conversations, services, teamFlow: teams });
        const first = conversations.postUserMessage(created.conversation.id, { text: "Do not launch the unavailable researcher." });
        dispatcher.dispatchMessage(created.conversation.id, first.id);
        await dispatcher.flush();
        assert.equal(runtime.tasks.length, 1);
        assert.equal(conversations.get(created.conversation.id).messages.some((message) => message.senderId === researcher.id), false);
        assert.equal(teams.activity({ conversationId: created.conversation.id }).events.some((event) => event.kind === "attention"), true);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});
