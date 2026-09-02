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
        assert.equal(started.events[0].kind, "working");
        assert.equal(started.events[0].label, "Working");
        assert.equal(Object.keys(started.events[0]).some((key) => /(?:event|run|request|operation|token|protocol)/i.test(key)), false);

        const claim = teams.claimStage({ conversationId: created.conversation.id, ownerId: chief.id, messageId: first.id });
        const duplicate = teams.claimStage({ conversationId: created.conversation.id, ownerId: chief.id, messageId: first.id });
        assert.deepEqual(duplicate, claim);
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
            reason: "The next teammate request_0000000000000001 is not ready at C:\\private\\workspace.",
            ...context,
            expectedVersion: context.version,
            idempotencyKey: `handoff.blocked:${first.id}`,
        });
        const flow = teams.get(created.team.id).flow;
        assert.equal(teams.collaborationContextForConversation(created.conversation.id).ownerId, chief.id);
        assert.equal(flow.status, "needs-attention");
        assert.equal(flow.activity[0].kind, "attention");
        assert.equal(flow.activity[0].targetCoworker, coworkers.get(coder.id).name);
        assert.doesNotMatch(JSON.stringify(flow.activity), /request_0000000000000001|C:\\\\private/);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test("directed collaboration selects any active teammate, wakes only that teammate, and survives restart", () => {
    const { root, coworkers, conversations, teams, services } = fixture();
    try {
        const chief = coworkers.create({ name: "Chief", role: "Coordinate work" });
        const researcher = coworkers.create({ name: "Research Specialist", role: "Research" });
        const builder = coworkers.create({ name: "Build Specialist", role: "Build" });
        const reviewer = coworkers.create({ name: "Quality Specialist", role: "Review" });
        const outside = coworkers.create({ name: "Outside", role: "Other" });
        const created = teams.createTeam({ title: "Directed collaboration", coworkerIds: [chief.id, researcher.id, builder.id, reviewer.id] });
        teams.setRuntimeHandoffPreflight(({ conversationId, targetCoworkerId, workspaceId }) => ({ targetCoworkerId, agentId: `agent-${targetCoworkerId}`, workspaceId: workspaceId ?? teams.workspaceIdForConversation(conversationId) }));
        const first = conversations.postUserMessage(created.conversation.id, { text: "Start the bounded delivery." });
        teams.onMessageQueued({ conversation: conversations.get(created.conversation.id), message: first });

        const requested = teams.requestCollaboration({
            conversationId: created.conversation.id,
            targetCoworkerId: builder.id,
            handoffType: "handoff",
            boundedTask: "Inspect the implementation and report the smallest safe change.",
            reason: "The build specialist owns this bounded slice.",
        });
        const flow = teams.get(created.team.id).flow;
        assert.equal(requested.targetCoworkerId, builder.id);
        assert.equal(flow.currentOwnerId, builder.id);
        assert.equal(flow.activeProtocol.kind, "handoff");
        assert.equal(flow.activeProtocol.targetCoworkerId, builder.id);
        assert.equal(flow.activeProtocol.boundedTask, "Inspect the implementation and report the smallest safe change.");
        assert.equal(requested.message.senderId, chief.id);
        assert.deepEqual(requested.message.mentions, [builder.id]);
        assert.deepEqual(Object.keys(requested.message.delivery), [builder.id]);
        assert.equal(requested.message.delivery[builder.id].status, "pending");
        const activity = teams.activity({ conversationId: created.conversation.id }).events;
        assert.equal(activity[0].label, "Handoff requested");
        assert.equal(activity[0].targetCoworker, "Build Specialist");
        assert.equal(Object.keys(activity[0]).some((key) => /(?:event|run|request|operation|token|protocol|workspace|agent)/i.test(key)), false);
        assert.throws(() => teams.requestCollaboration({ conversationId: created.conversation.id, targetCoworkerId: reviewer.id, handoffType: "review", boundedTask: "Review again", reason: "Duplicate request" }), /already active/);
        assert.throws(() => teams.requestCollaboration({ conversationId: created.conversation.id, targetCoworkerId: builder.id, handoffType: "handoff", boundedTask: "Return", reason: "Self" }), /differ/);
        assert.throws(() => teams.requestCollaboration({ conversationId: created.conversation.id, targetCoworkerId: outside.id, handoffType: "handoff", boundedTask: "Outside", reason: "Not rostered" }), /team member/);

        const restartedConversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
        const restartedTeams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: restartedConversations, services });
        const restarted = restartedTeams.get(created.team.id).flow;
        assert.equal(restarted.currentOwnerId, builder.id);
        assert.equal(restarted.activeProtocol.targetCoworkerId, builder.id);
        assert.equal(restarted.activeProtocol.boundedTask, "Inspect the implementation and report the smallest safe change.");
        assert.equal(restartedConversations.get(created.conversation.id).messages.at(-1).delivery[builder.id].status, "pending");
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test("directed review can follow a handoff and return ownership to the source teammate", () => {
    const { root, coworkers, conversations, teams } = fixture();
    try {
        const chief = coworkers.create({ name: "Chief", role: "Coordinate" });
        const builder = coworkers.create({ name: "Builder", role: "Build" });
        const reviewer = coworkers.create({ name: "Quality", role: "Review" });
        const created = teams.createTeam({ title: "Review path", coworkerIds: [chief.id, builder.id, reviewer.id] });
        teams.setRuntimeHandoffPreflight(({ conversationId, targetCoworkerId, workspaceId }) => ({ targetCoworkerId, agentId: `agent-${targetCoworkerId}`, workspaceId: workspaceId ?? teams.workspaceIdForConversation(conversationId) }));
        const first = conversations.postUserMessage(created.conversation.id, { text: "Start the review path." });
        teams.onMessageQueued({ conversation: conversations.get(created.conversation.id), message: first });

        const handoff = teams.requestCollaboration({ conversationId: created.conversation.id, targetCoworkerId: builder.id, handoffType: "handoff", boundedTask: "Build the bounded change.", reason: "Builder owns implementation." });
        let context = teams.collaborationContextForConversation(created.conversation.id);
        teams.acceptProtocol({ conversationId: created.conversation.id, targetCoworkerId: builder.id, proofId: teams.pendingProtocolProof(created.conversation.id).proofId, messageId: handoff.message.id, ...context, expectedVersion: context.version });
        context = teams.collaborationContextForConversation(created.conversation.id);
        teams.claimStage({ conversationId: created.conversation.id, ownerId: builder.id, messageId: handoff.message.id, ...context, expectedVersion: context.version });
        context = teams.collaborationContextForConversation(created.conversation.id);
        teams.submitProtocolResult({ conversationId: created.conversation.id, coworkerId: builder.id, messageId: handoff.message.id, ...context, expectedVersion: context.version });

        const review = teams.requestCollaboration({ conversationId: created.conversation.id, targetCoworkerId: reviewer.id, handoffType: "review", boundedTask: "Review the bounded change.", reason: "Quality needs to validate the result." });
        assert.equal(teams.get(created.team.id).flow.currentOwnerId, reviewer.id);
        assert.equal(teams.get(created.team.id).flow.activeProtocol.kind, "review");
        assert.deepEqual(Object.keys(review.message.delivery), [reviewer.id]);
        context = teams.collaborationContextForConversation(created.conversation.id);
        teams.acceptProtocol({ conversationId: created.conversation.id, targetCoworkerId: reviewer.id, proofId: teams.pendingProtocolProof(created.conversation.id).proofId, messageId: review.message.id, ...context, expectedVersion: context.version });
        context = teams.collaborationContextForConversation(created.conversation.id);
        teams.claimStage({ conversationId: created.conversation.id, ownerId: reviewer.id, messageId: review.message.id, ...context, expectedVersion: context.version });
        context = teams.collaborationContextForConversation(created.conversation.id);
        teams.submitProtocolResult({ conversationId: created.conversation.id, coworkerId: reviewer.id, messageId: review.message.id, ...context, expectedVersion: context.version });
        context = teams.collaborationContextForConversation(created.conversation.id);
        teams.recordReviewDecision({ conversationId: created.conversation.id, coworkerId: reviewer.id, messageId: review.message.id, decision: "approved", ...context, expectedVersion: context.version });

        const returned = teams.requestCollaboration({ conversationId: created.conversation.id, targetCoworkerId: builder.id, handoffType: "handoff", boundedTask: "Continue from the approved review.", reason: "Return ownership to the implementation teammate." });
        assert.equal(returned.message.senderId, reviewer.id);
        assert.equal(teams.get(created.team.id).flow.currentOwnerId, builder.id);
        assert.equal(teams.get(created.team.id).flow.activeProtocol.kind, "handoff");
        assert.equal(teams.activity({ conversationId: created.conversation.id }).events.filter((entry) => entry.label === "Review requested").length, 1);
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
        const firstRun = teams.collaborationContextForConversation(created.conversation.id).runId;
        teams.stopRun(created.conversation.id, "user stopped");
        assert.equal(teams.get(created.team.id).flow.status, "stopped");
        const second = conversations.postUserMessage(created.conversation.id, { text: "Redirect and try again." });
        teams.onMessageQueued({ conversation: conversations.get(created.conversation.id), message: second });
        const secondFlow = teams.get(created.team.id).flow;
        const secondContext = teams.collaborationContextForConversation(created.conversation.id);
        assert.notEqual(secondContext.runId, firstRun);
        assert.equal(secondFlow.status, "active");
        const activeContext = teams.collaborationContextForConversation(created.conversation.id);
        assert.throws(() => teams.stopRun(created.conversation.id, "stale stop", { ...activeContext, expectedVersion: activeContext.version - 1 }), /stale/);
        assert.throws(() => teams.recordCollaborationEvent({ conversationId: created.conversation.id, type: "run.redirected", status: "redirected", actorId: "user", ...activeContext, expectedVersion: activeContext.version - 1, idempotencyKey: "stale-redirect" }), /stale/);
        assert.equal(teams.get(created.team.id).flow.status, "active");
        const events = teams.activity({ conversationId: created.conversation.id }).events;
        assert.ok(events.some((event) => event.label === "Attention"));
        assert.ok(events.some((event) => event.label === "Working"));
        const reloadedConversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
        const reloadedTeams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: reloadedConversations, services });
        const reloadedFlow = reloadedTeams.get(created.team.id).flow;
        assert.equal(reloadedTeams.collaborationContextForConversation(created.conversation.id).runId, secondContext.runId);
        assert.equal(reloadedTeams.activity({ conversationId: created.conversation.id }).events.length, events.length);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test("managed handoff hard-fails when the trusted runtime preflight provider is missing", () => {
    const { root, coworkers, conversations, teams } = fixture();
    try {
        const chief = coworkers.create({ name: "Chief", role: "Coordinate work" });
        const researcher = coworkers.create({ name: "Researcher", role: "Research" });
        const created = teams.createTeam({ title: "No proof", coworkerIds: [chief.id, researcher.id] });
        const first = conversations.postUserMessage(created.conversation.id, { text: "Do not launch without proof." });
        teams.onMessageQueued({ conversation: conversations.get(created.conversation.id), message: first });
        assert.throws(() => teams.nextHandoff({ conversation: conversations.get(created.conversation.id), coworkerId: chief.id, source: first, requestedCoworkerIds: [researcher.id], expectedTargetCoworkerId: researcher.id }), /preflight/);
        assert.equal(teams.get(created.team.id).flow.currentOwnerId, chief.id);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

function controlledRuntime(roster, responses, onAudit = async () => {}, onPreflight = async () => {}) {
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
            async preflightTrustedTask(taskId) {
                const task = tasks.find((entry) => entry.id === taskId);
                if (!task) throw new Error("missing task " + taskId);
                const decision = await onPreflight(structuredClone(task));
                if (decision?.allowed === false) return { allowed: false, reason: decision.reason ?? "test preflight denied", task: structuredClone(task) };
                return { allowed: true, agentId: task.preferredAgentId, task: structuredClone(task) };
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
            `Coder completed the bounded implementation.\nSOVEREIGN_HANDOFFS: ["${chief.id}"]\nSOVEREIGN_REVIEW: "approved"`,
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

test("stop during review suppresses the stale decision and candidate publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-review-race-"));
    try {
        const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
        const chief = coworkers.create({ name: "Chief", role: "Coordinate work" });
        const researcher = coworkers.create({ name: "Researcher", role: "Research" });
        const reviewer = coworkers.create({ name: "Reviewer", role: "Review" });
        const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
        const services = createDesktopServices({ dataDir: root, dialog: {} });
        const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
        conversations.setTeamRouteResolver((conversation) => teams.currentOwnerForConversation(conversation.id));
        const created = teams.createTeam({ title: "Review race", coworkerIds: [chief.id, researcher.id, reviewer.id] });
        const workspace = services.workspacePath(teams.workspaceIdForConversation(created.conversation.id));
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, "review.md"), "review output", "utf8");
        const roster = buildProviderRoster({ discovery: { codex: { found: true, auth: { state: "signed-in" } }, claude: { found: true, auth: { state: "signed-in" } }, }, settings: {}, coworkers: coworkers.list().coworkers });
        let dispatcher;
        const runtime = controlledRuntime(roster, [
            "Chief delegates.\nSOVEREIGN_HANDOFFS: [\"" + researcher.id + "\"]",
            "Research is ready.\nSOVEREIGN_HANDOFFS: [\"" + reviewer.id + "\"]",
            "Review was approved.\nSOVEREIGN_ARTIFACTS: [{\"path\":\"review.md\",\"title\":\"Review\"}]\nSOVEREIGN_REVIEW: \"approved\"",
        ], async (entry) => {
            if (entry.type === "coworker.artifact_ingested") await dispatcher.stopConversation(created.conversation.id, "redirected during review");
        });
        teams.setRuntimeHandoffPreflight(({ conversationId, targetCoworkerId, workspaceId }) => ({ targetCoworkerId, agentId: coworkerAgentId(targetCoworkerId), workspaceId: workspaceId ?? teams.workspaceIdForConversation(conversationId) }));
        const artifacts = createArtifactStore({ dataDir: root });
        dispatcher = createCoworkerDispatcher({ dataDir: root, runtime, roster: () => roster, coworkerStore: coworkers, conversationStore: conversations, artifactStore: artifacts, services, teamFlow: teams });
        const first = conversations.postUserMessage(created.conversation.id, { text: "Stop if ownership changes during review." });
        dispatcher.dispatchMessage(created.conversation.id, first.id);
        for (let attempt = 0; attempt < 8; attempt += 1) await dispatcher.flush();
        assert.equal(artifacts.list().artifacts.length, 0);
        assert.equal(conversations.get(created.conversation.id).messages.some((message) => message.senderId === reviewer.id), false);
        assert.equal(teams.get(created.team.id).flow.status, "stopped");
        const activity = teams.activity({ conversationId: created.conversation.id }).events;
        assert.equal(activity.some((event) => event.label === "Approved"), false);
        assert.equal(activity.some((event) => event.label === "Completed"), false);
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

test("protocol Governor denial blocks the pending handoff without launching the target", async () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-protocol-governor-deny-"));
    try {
        const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
        const chief = coworkers.create({ name: "Chief", role: "Coordinate work" });
        const researcher = coworkers.create({ name: "Researcher", role: "Research" });
        const reviewer = coworkers.create({ name: "Reviewer", role: "Review" });
        const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
        const services = createDesktopServices({ dataDir: root, dialog: {} });
        const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
        conversations.setTeamRouteResolver((conversation) => teams.currentOwnerForConversation(conversation.id));
        const created = teams.createTeam({ title: "Governor gate", coworkerIds: [chief.id, researcher.id, reviewer.id] });
        const roster = buildProviderRoster({ discovery: { codex: { found: true, auth: { state: "signed-in" } }, claude: { found: true, auth: { state: "signed-in" } }, }, settings: {}, coworkers: coworkers.list().coworkers });
        const researcherAgentId = coworkerAgentId(researcher.id);
        const runtime = controlledRuntime(roster, ["Chief delegates.\nSOVEREIGN_HANDOFFS: [\"" + researcher.id + "\"]"], async () => {}, async (task) => task.preferredAgentId === researcherAgentId ? { allowed: false, reason: "Governor denied the trusted launch" } : undefined);
        teams.setRuntimeHandoffPreflight(({ conversationId, targetCoworkerId, workspaceId }) => ({ targetCoworkerId, agentId: coworkerAgentId(targetCoworkerId), workspaceId: workspaceId ?? teams.workspaceIdForConversation(conversationId) }));
        const dispatcher = createCoworkerDispatcher({ dataDir: root, runtime, roster: () => roster, coworkerStore: coworkers, conversationStore: conversations, artifactStore: createArtifactStore({ dataDir: root }), services, teamFlow: teams });
        const first = conversations.postUserMessage(created.conversation.id, { text: "Do not launch without the trusted Governor decision." });
        dispatcher.dispatchMessage(created.conversation.id, first.id);
        for (let attempt = 0; attempt < 4; attempt += 1) await dispatcher.flush();
        const flow = teams.get(created.team.id).flow;
        assert.equal(runtime.tasks.length, 2);
        assert.equal(runtime.tasks[1].status, "cancelled");
        assert.equal(flow.status, "needs-attention");
        assert.equal(flow.activeProtocol.state, "blocked");
        assert.equal(conversations.get(created.conversation.id).messages.some((message) => message.senderId === researcher.id), false);
        assert.ok(teams.activity({ conversationId: created.conversation.id }).events.some((event) => event.label === "Attention"));
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test("protocol runs directed review, one bounded revision, and publishes only the approved artifact lineage", async () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-protocol-review-"));
    try {
        const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
        const chief = coworkers.create({ name: "Chief", role: "Coordinate work" });
        const researcher = coworkers.create({ name: "Researcher", role: "Research" });
        const reviewer = coworkers.create({ name: "Reviewer", role: "Review" });
        const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
        const services = createDesktopServices({ dataDir: root, dialog: {} });
        const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
        conversations.setTeamRouteResolver((conversation) => teams.currentOwnerForConversation(conversation.id));
        const created = teams.createTeam({ title: "Protocol review", coworkerIds: [chief.id, researcher.id, reviewer.id] });
        const workspace = services.workspacePath(teams.workspaceIdForConversation(created.conversation.id));
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, "draft.md"), "draft", "utf8");
        writeFileSync(join(workspace, "revision.md"), "approved revision", "utf8");
        const roster = buildProviderRoster({ discovery: { codex: { found: true, auth: { state: "signed-in" } }, claude: { found: true, auth: { state: "signed-in" } } }, settings: {}, coworkers: coworkers.list().coworkers });
        const runtime = controlledRuntime(roster, [
            `Chief scoped the question.\nSOVEREIGN_HANDOFFS: ["${researcher.id}"]`,
            `Research draft.\nSOVEREIGN_ARTIFACTS: [{"path":"draft.md","title":"Draft"}]\nSOVEREIGN_HANDOFFS: ["${reviewer.id}"]`,
            `Review needs a correction.\nSOVEREIGN_REVIEW: "changes-requested"`,
            `Research revision.\nSOVEREIGN_ARTIFACTS: [{"path":"revision.md","title":"Revision"}]\nSOVEREIGN_HANDOFFS: ["${reviewer.id}"]`,
            `Review accepts the revision.\nSOVEREIGN_REVIEW: "approved"`,
            "Chief synthesized the approved result.",
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
        const first = conversations.postUserMessage(created.conversation.id, { text: "Research and review this bounded change." });
        dispatcher.dispatchMessage(created.conversation.id, first.id);
        for (let attempt = 0; attempt < 8; attempt += 1) await dispatcher.flush();
        const activity = teams.activity({ conversationId: created.conversation.id }).events;
        const view = conversations.get(created.conversation.id);
        assert.equal(runtime.tasks.length, 6);
        assert.equal(preflightCalls, 5);
        assert.equal(teams.get(created.team.id).flow.status, "available");
        assert.equal(teams.get(created.team.id).flow.activeProtocol, undefined);
        assert.equal(artifacts.list().artifacts.length, 1);
        assert.ok(activity.some((event) => event.label === "Changes requested" && event.revision === 0));
        assert.ok(activity.some((event) => event.label === "Approved" && event.revision === 1));
        assert.ok(activity.some((event) => event.label === "Completed"));
        assert.equal(view.messages.filter((message) => message.senderId !== "user").length, 6);
        const persisted = JSON.parse(readFileSync(join(root, "desktop-state", "artifacts.json"), "utf8"));
        assert.equal(persisted.artifacts.filter((entry) => entry.published !== false).length, 1);
        assert.equal(persisted.artifacts.filter((entry) => entry.published !== false)[0].protocolLineage.revision, 1);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test("protocol ACK and result are idempotent and reject stale lineage", () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-protocol-cas-"));
    try {
        const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
        const chief = coworkers.create({ name: "Chief", role: "Coordinate" });
        const researcher = coworkers.create({ name: "Researcher", role: "Research" });
        const reviewer = coworkers.create({ name: "Reviewer", role: "Review" });
        const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
        const services = createDesktopServices({ dataDir: root, dialog: {} });
        const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
        teams.setRuntimeHandoffPreflight(({ conversationId, targetCoworkerId, workspaceId }) => ({ targetCoworkerId, agentId: "test-agent", workspaceId: workspaceId ?? teams.workspaceIdForConversation(conversationId) }));
        const created = teams.createTeam({ title: "Protocol CAS", coworkerIds: [chief.id, researcher.id, reviewer.id] });
        const conversation = conversations.get(created.conversation.id);
        const first = conversations.postUserMessage(created.conversation.id, { text: "Start the protocol." });
        teams.onMessageQueued({ conversation: conversations.get(created.conversation.id), message: first });
        let context = teams.collaborationContextForConversation(created.conversation.id);
        const proof = teams.authorizeHandoffTarget({ conversationId: created.conversation.id, sourceCoworkerId: chief.id, targetCoworkerId: researcher.id, ...context, expectedVersion: context.version });
        teams.nextHandoff({ conversation, coworkerId: chief.id, source: first, requestedCoworkerIds: [researcher.id], expectedTargetCoworkerId: researcher.id, runtimeProof: proof, ...context, expectedVersion: context.version });
        context = teams.collaborationContextForConversation(created.conversation.id);
        const reloadedConversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
        const reloadedTeams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: reloadedConversations, services });
        assert.equal(reloadedTeams.get(created.team.id).flow.activeProtocol.state, "requested");
        assert.equal(reloadedTeams.pendingProtocolProof(created.conversation.id), undefined);
        const pendingProof = teams.pendingProtocolProof(created.conversation.id);
        assert.equal(teams.get(created.team.id).flow.activeProtocol.state, "requested");
        assert.throws(() => teams.acceptProtocol({ conversationId: created.conversation.id, targetCoworkerId: researcher.id, proofId: pendingProof.proofId, ...context, expectedVersion: context.version - 1 }), /stale/);
        const accepted = teams.acceptProtocol({ conversationId: created.conversation.id, targetCoworkerId: researcher.id, proofId: pendingProof.proofId, ...context, expectedVersion: context.version, idempotencyKey: "protocol-ack-once" });
        const duplicateAccepted = teams.acceptProtocol({ conversationId: created.conversation.id, targetCoworkerId: researcher.id, proofId: pendingProof.proofId, ...context, expectedVersion: context.version, idempotencyKey: "protocol-ack-once" });
        assert.deepEqual(duplicateAccepted, accepted);
        context = teams.collaborationContextForConversation(created.conversation.id);
        teams.claimStage({ conversationId: created.conversation.id, ownerId: researcher.id, messageId: first.id, ...context, expectedVersion: context.version });
        context = teams.collaborationContextForConversation(created.conversation.id);
        assert.throws(() => teams.submitProtocolResult({ conversationId: created.conversation.id, coworkerId: researcher.id, messageId: first.id, ...context, expectedVersion: context.version - 1 }), /stale/);
        const submitted = teams.submitProtocolResult({ conversationId: created.conversation.id, coworkerId: researcher.id, messageId: first.id, ...context, expectedVersion: context.version, idempotencyKey: "protocol-result-once" });
        const duplicateSubmitted = teams.submitProtocolResult({ conversationId: created.conversation.id, coworkerId: researcher.id, messageId: first.id, ...context, expectedVersion: context.version, idempotencyKey: "protocol-result-once" });
        assert.deepEqual(duplicateSubmitted, submitted);
        assert.equal(teams.activity({ conversationId: created.conversation.id }).events.filter((event) => event.label === "Submitted").length, 1);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test("protocol revision cap enters attention without launching another worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-protocol-limit-"));
    try {
        const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
        const chief = coworkers.create({ name: "Chief", role: "Coordinate" });
        const researcher = coworkers.create({ name: "Researcher", role: "Research" });
        const reviewer = coworkers.create({ name: "Reviewer", role: "Review" });
        const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
        const services = createDesktopServices({ dataDir: root, dialog: {} });
        const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
        conversations.setTeamRouteResolver((conversation) => teams.currentOwnerForConversation(conversation.id));
        const created = teams.createTeam({ title: "Revision limit", coworkerIds: [chief.id, researcher.id, reviewer.id] });
        const roster = buildProviderRoster({ discovery: { codex: { found: true, auth: { state: "signed-in" } }, claude: { found: true, auth: { state: "signed-in" } } }, settings: {}, coworkers: coworkers.list().coworkers });
        const runtime = controlledRuntime(roster, [
            `Chief delegates.\nSOVEREIGN_HANDOFFS: ["${researcher.id}"]`,
            `Research pass one.\nSOVEREIGN_HANDOFFS: ["${reviewer.id}"]`,
            `Review changes one.\nSOVEREIGN_REVIEW: "changes-requested"`,
            `Research pass two.\nSOVEREIGN_HANDOFFS: ["${reviewer.id}"]`,
            `Review changes two.\nSOVEREIGN_REVIEW: "changes-requested"`,
            `Research pass three.\nSOVEREIGN_HANDOFFS: ["${reviewer.id}"]`,
            `Review changes three.\nSOVEREIGN_REVIEW: "changes-requested"`,
        ]);
        teams.setRuntimeHandoffPreflight(({ conversationId, targetCoworkerId, workspaceId }) => ({ targetCoworkerId, agentId: coworkerAgentId(targetCoworkerId), workspaceId: workspaceId ?? teams.workspaceIdForConversation(conversationId) }));
        const dispatcher = createCoworkerDispatcher({ dataDir: root, runtime, roster: () => roster, coworkerStore: coworkers, conversationStore: conversations, services, teamFlow: teams });
        const first = conversations.postUserMessage(created.conversation.id, { text: "Bound the revision loop." });
        dispatcher.dispatchMessage(created.conversation.id, first.id);
        for (let attempt = 0; attempt < 10; attempt += 1) await dispatcher.flush();
        const flow = teams.get(created.team.id).flow;
        assert.equal(runtime.tasks.length, 7);
        assert.equal(flow.status, "needs-attention");
        assert.equal(flow.activeProtocol.state, "blocked");
        assert.ok(teams.activity({ conversationId: created.conversation.id }).events.some((event) => event.kind === "attention" && event.label === "Attention"));
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test("controlled fanout runs independent children, required review, and original-owner join", async () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-fanout-v1-"));
    try {
        const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
        const chief = coworkers.create({ name: "Chief", role: "Own the outcome" });
        const research = coworkers.create({ name: "Research", role: "Research the bounded question" });
        const coder = coworkers.create({ name: "Coder", role: "Implement the bounded change" });
        const reviewer = coworkers.create({ name: "Reviewer", role: "Review independent results" });
        const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
        const services = createDesktopServices({ dataDir: root, dialog: {} });
        const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
        conversations.setTeamRouteResolver((conversation) => teams.currentOwnerForConversation(conversation.id));
        const created = teams.createTeam({ title: "Parallel delivery", coworkerIds: [chief.id, research.id, coder.id, reviewer.id] });
        const roster = buildProviderRoster({ discovery: { codex: { found: true, auth: { state: "signed-in" } }, claude: { found: true, auth: { state: "signed-in" } } }, settings: {}, coworkers: coworkers.list().coworkers });
        const fanout = `SOVEREIGN_FANOUT: ${JSON.stringify({ reviewerCoworkerId: reviewer.id, children: [
            { key: "research", coworkerId: research.id, task: "Find the bounded failure and report evidence." },
            { key: "implement", coworkerId: coder.id, task: "Implement the bounded fix in the isolated root." },
        ] })}`;
        const runtime = controlledRuntime(roster, [
            `Chief scoped parallel work.\n${fanout}`,
            "Research completed independently.",
            "Coder completed independently.",
            'Review approved.\nSOVEREIGN_REVIEW: "approved"',
            "Chief joined the approved specialist results.",
        ]);
        teams.setRuntimeHandoffPreflight(({ conversationId, targetCoworkerId, workspaceId }) => ({ targetCoworkerId, agentId: coworkerAgentId(targetCoworkerId), workspaceId: workspaceId ?? teams.workspaceIdForConversation(conversationId) }));
        const dispatcher = createCoworkerDispatcher({ dataDir: root, runtime, roster: () => roster, coworkerStore: coworkers, conversationStore: conversations, artifactStore: createArtifactStore({ dataDir: root }), services, teamFlow: teams });
        const first = conversations.postUserMessage(created.conversation.id, { text: "Investigate and implement these independent parts, then join them." });
        dispatcher.dispatchMessage(created.conversation.id, first.id);
        for (let attempt = 0; attempt < 10; attempt += 1) await dispatcher.flush();
        const view = conversations.get(created.conversation.id);
        const flow = teams.get(created.team.id).flow;
        assert.equal(runtime.tasks.length, 5, JSON.stringify({ tasks: runtime.tasks.map((task) => ({ mode: task.input?.fanoutMode, status: task.status, title: task.title })), flow: teams.get(created.team.id).flow, messages: conversations.get(created.conversation.id).messages.map((message) => ({ senderId: message.senderId, mentions: message.mentions, delivery: message.delivery, text: message.text.slice(0, 80) })) }));
        assert.equal(runtime.tasks.filter((task) => task.input?.fanoutMode === "child").length, 2);
        assert.equal(new Set(runtime.tasks.filter((task) => task.input?.fanoutMode === "child").map((task) => task.executionContext.cwd)).size, 2);
        assert.equal(runtime.tasks.filter((task) => task.input?.fanoutMode === "review").length, 1);
        assert.equal(runtime.tasks.filter((task) => task.input?.fanoutMode === "join").length, 1);
        assert.equal(flow.status, "available", JSON.stringify({ flow, messages: view.messages.map((message) => ({ senderId: message.senderId, mentions: message.mentions, delivery: message.delivery, text: message.text.slice(0, 100) })) }));
        assert.equal(flow.activeFanout, undefined);
        assert.equal(view.messages.filter((message) => message.senderId !== "user").length, 7);
        assert.ok(teams.activity({ conversationId: created.conversation.id }).events.some((event) => event.label === "Parallel work"));
        assert.ok(teams.activity({ conversationId: created.conversation.id }).events.some((event) => event.label === "Approved"), JSON.stringify(teams.activity({ conversationId: created.conversation.id }).events));
        assert.ok(teams.activity({ conversationId: created.conversation.id }).events.some((event) => event.label === "Completed"));
        assert.doesNotMatch(JSON.stringify(flow), /(?:request_|operation_|workspaceKey|task_)/i);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});
