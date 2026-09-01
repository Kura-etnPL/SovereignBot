import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConversationStore } from "../src/main/conversation-store.js";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createDesktopServices } from "../src/main/services.js";
import { COLLABORATION_SCHEMA, createTeamService } from "../src/main/team-service.js";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "sovereign-collaboration-"));
    const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
    const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
    const services = createDesktopServices({ dataDir: root, dialog: {} });
    const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
    return { root, coworkers, conversations, teams };
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
        assert.equal(started.events[0].kind, "run.started");
        assert.match(started.events[0].runId, /^run_[a-f0-9]{16}$/);
        assert.match(started.events[0].requestId, /^request_[a-f0-9]{16}$/);
        assert.match(started.events[0].operationId, /^operation_[a-f0-9]{16}$/);

        const claim = teams.claimStage({ conversationId: created.conversation.id, ownerId: chief.id, messageId: first.id });
        const duplicate = teams.claimStage({ conversationId: created.conversation.id, ownerId: chief.id, messageId: first.id });
        assert.equal(duplicate.eventId, claim.eventId);
        assert.throws(() => teams.claimStage({ conversationId: created.conversation.id, ownerId: coder.id, messageId: first.id }), /already claimed/);
        assert.equal(teams.get(created.team.id).flow.currentOwnerId, chief.id);

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
        const blocked = teams.nextHandoff({ conversation: conversations.get(created.conversation.id), coworkerId: chief.id, source: first, requestedCoworkerIds: [coder.id], targetReady: false, expectedTargetCoworkerId: coder.id });
        assert.equal(blocked, undefined);
        const flow = teams.get(created.team.id).flow;
        assert.equal(flow.currentOwnerId, chief.id);
        assert.equal(flow.status, "needs-attention");
        assert.equal(flow.activity[0].kind, "handoff.blocked");
        assert.equal(flow.activity[0].targetCoworkerId, coder.id);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});

test("stop and restart create distinct runs and do not wake the stopped run", () => {
    const { root, coworkers, conversations, teams } = fixture();
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
        assert.ok(events.some((event) => event.kind === "run.stopped" && event.runId === firstRun));
        assert.ok(events.some((event) => event.kind === "run.started" && event.runId === secondFlow.runId));
    }
    finally { rmSync(root, { recursive: true, force: true }); }
});
