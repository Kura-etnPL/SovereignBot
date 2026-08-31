import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConversationStore } from "../src/main/conversation-store.js";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createDesktopServices } from "../src/main/services.js";
import { TEAM_PACK_EXPORT_SCHEMA, TEAM_PLAYBOOK_EXPORT_SCHEMA, createTeamService } from "../src/main/team-service.js";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "sovereign-team-"));
    const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
    const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
    const services = createDesktopServices({ dataDir: root, dialog: {} });
    const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
    return { root, coworkers, conversations, services, teams };
}

test("Software Team installation is idempotent and keeps workspace paths out of public state", () => {
    const { root, coworkers, conversations, services, teams } = fixture();
    try {
        const first = teams.installPack("software-team");
        assert.equal(first.installed, true);
        assert.equal(first.team.name, "Software Team");
        assert.deepEqual(first.team.coworkers.map((entry) => entry.name), ["Chief of Staff", "Coding Lead", "Reviewer"]);
        assert.equal(first.team.channels[0].name, "Project Channel");
        assert.equal(first.team.sharedWorkspaceLabel, "Software Team project");
        assert.equal(first.team.privateWorkspaceLabel, "Private workspace");
        assert.equal(JSON.stringify(first.team).includes("managed-workspaces"), false);
        assert.equal(Object.hasOwn(services.listWorkspaces().workspaces[0], "path"), false);

        const second = teams.installPack("software-team");
        assert.equal(second.installed, false);
        assert.equal(second.team.id, first.team.id);
        assert.equal(teams.list().teams.length, 1);
        assert.equal(coworkers.list().coworkers.length, 3);
        assert.equal(conversations.list().conversations.length, 1);

        const channel = first.team.channels[0];
        const conversation = conversations.get(channel.conversationId);
        assert.equal(conversation.leadCoworkerId, first.team.coworkerIds[0]);
        const userMessage = conversations.postUserMessage(conversation.id, { text: "Deliver a small fix." });
        teams.onMessageQueued({ conversation: conversations.get(conversation.id), message: userMessage });
        assert.equal(teams.status(first.team.id).currentOwnerId, first.team.coworkerIds[0]);
        const chiefHandoff = teams.nextHandoff({ conversation: conversations.get(conversation.id), coworkerId: first.team.coworkerIds[0], source: userMessage });
        assert.equal(chiefHandoff, first.team.coworkerIds[1]);
        assert.equal(teams.nextHandoff({ conversation: conversations.get(conversation.id), coworkerId: first.team.coworkerIds[0], source: userMessage }), chiefHandoff);
        assert.equal(teams.nextHandoff({ conversation: conversations.get(conversation.id), coworkerId: first.team.coworkerIds[1] }), first.team.coworkerIds[2]);
        assert.equal(teams.nextHandoff({ conversation: conversations.get(conversation.id), coworkerId: first.team.coworkerIds[2] }), first.team.coworkerIds[0]);
        assert.equal(teams.nextHandoff({ conversation: conversations.get(conversation.id), coworkerId: first.team.coworkerIds[0] }), undefined);
        assert.equal(teams.status(first.team.id).stage, "complete");

        const disk = JSON.parse(readFileSync(join(root, "desktop-state", "teams.json"), "utf8"));
        assert.equal(JSON.stringify(disk).includes("path"), false);
        assert.equal(JSON.stringify(disk).includes("providerAccountId"), false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("declarative secondary Team Packs reuse the governed team path", () => {
    const { root, coworkers, conversations, teams } = fixture();
    try {
        assert.deepEqual(teams.list().packs.map((entry) => entry.id), [
            "software-team",
            "research-team",
            "content-team",
            "operations-team",
        ]);
        const installed = teams.installPack("research-team");
        assert.equal(installed.installed, true);
        assert.equal(installed.team.name, "Research Team");
        assert.equal(installed.team.sharedWorkspaceLabel, "Research Team project");
        assert.deepEqual(installed.team.coworkers.map((entry) => entry.name), ["Chief of Staff", "Research Lead", "Reviewer"]);
        assert.equal(installed.team.channels[0].name, "Research Room");
        assert.equal(installed.team.playbooks[0].name, "Research Brief");
        assert.deepEqual(installed.team.playbooks[0].steps, ["chief", "specialist", "reviewer", "chief"]);
        assert.equal(installed.team.flow.stage, "complete");
        assert.equal(JSON.stringify(installed.team).includes("managed-workspaces"), false);

        const userMessage = conversations.postUserMessage(installed.team.channels[0].conversationId, { text: "Investigate this bounded question." });
        teams.onMessageQueued({ conversation: conversations.get(installed.team.channels[0].conversationId), message: userMessage });
        assert.equal(teams.nextHandoff({ conversation: conversations.get(installed.team.channels[0].conversationId), coworkerId: installed.team.coworkerIds[0], source: userMessage }), installed.team.coworkerIds[1]);
        assert.equal(coworkers.list().coworkers.length, 3);
        assert.equal(JSON.stringify(teams.list()).includes("providerAccountId"), false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("ordinary teams create a Project Channel and route the next user turn to the current owner", () => {
    const { root, coworkers, conversations, teams } = fixture();
    try {
        const chief = coworkers.create({ name: "Chief", role: "Coordinate work" });
        const coder = coworkers.create({ name: "Coder", role: "Build software" });
        const reviewer = coworkers.create({ name: "Reviewer", role: "Review software" });
        conversations.setTeamRouteResolver((conversation) => teams.currentOwnerForConversation(conversation.id));

        const created = teams.createTeam({ title: "Product Team", coworkerIds: [chief.id, coder.id, reviewer.id] });
        assert.equal(created.created, true);
        assert.equal(created.team.packId, "custom-team");
        assert.equal(created.team.channels[0].name, "Project Channel");
        assert.equal(created.team.sharedWorkspaceLabel, "Product Team project");

        const first = conversations.postUserMessage(created.conversation.id, { text: "Ship the bounded change." });
        assert.deepEqual(Object.keys(first.delivery), [chief.id]);
        teams.onMessageQueued({ conversation: conversations.get(created.conversation.id), message: first });
        assert.equal(teams.currentOwnerForConversation(created.conversation.id), chief.id);

        const handoff = teams.nextHandoff({
            conversation: conversations.get(created.conversation.id),
            coworkerId: chief.id,
            source: first,
            requestedCoworkerIds: [reviewer.id],
        });
        assert.equal(handoff, reviewer.id);
        assert.equal(teams.currentOwnerForConversation(created.conversation.id), reviewer.id);

        const followup = conversations.postUserMessage(created.conversation.id, { text: "Review the result." });
        assert.deepEqual(Object.keys(followup.delivery), [reviewer.id]);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("Team Pack export/import carries only reusable product declarations", () => {
    const { root, conversations, teams } = fixture();
    try {
        const installed = teams.installPack("software-team");
        const exported = teams.exportPack(installed.team.id);
        assert.equal(exported.schema, TEAM_PACK_EXPORT_SCHEMA);
        assert.equal(exported.name, "Software Team");
        assert.deepEqual(exported.channels.map((entry) => entry.name), ["Project Channel"]);
        const serialized = JSON.stringify(exported);
        assert.equal(serialized.includes("providerAccountId"), false);
        assert.equal(serialized.includes("workspaceId"), false);
        assert.equal(serialized.includes("conversationId"), false);
        assert.equal(serialized.includes("managed-workspaces"), false);
        assert.equal(serialized.includes("path"), false);

        const imported = teams.importPack(exported);
        assert.equal(imported.imported, true);
        assert.equal(imported.installed, true);
        assert.equal(imported.team.name, "Software Team");
        assert.notEqual(imported.team.id, installed.team.id);
        assert.equal(imported.team.channels[0].name, "Project Channel");
        assert.equal(teams.importPack(exported).installed, false);
        assert.equal(conversations.list().conversations.length, 2);

        assert.throws(() => teams.importPack({ ...exported, coworkers: exported.coworkers.map((entry, index) => index ? entry : { ...entry, providerAccountId: "account" }) }), /field is not allowed/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
  }
});

test("Playbook export/import is bounded and idempotent", () => {
    const { root, teams } = fixture();
    try {
        const installed = teams.installPack("software-team");
        const exported = teams.exportPlaybook(installed.team.id, "software-delivery");
        assert.equal(exported.schema, TEAM_PLAYBOOK_EXPORT_SCHEMA);
        assert.deepEqual(exported.steps, ["chief", "coding-lead", "reviewer", "chief"]);
        const serialized = JSON.stringify(exported);
        assert.equal(serialized.includes("workspace"), false);
        assert.equal(serialized.includes("session"), false);
        assert.equal(serialized.includes("capability"), false);

        const imported = teams.importPlaybook(installed.team.id, {
            ...exported,
            id: "review-method",
            name: "Review Method",
            steps: ["chief", "reviewer"],
        });
        assert.equal(imported.imported, true);
        assert.equal(imported.team.playbooks.some((playbook) => playbook.id === "review-method"), true);
        assert.equal(teams.importPlaybook(installed.team.id, {
            ...exported,
            id: "review-method",
            name: "Review Method",
            steps: ["chief", "reviewer"],
        }).imported, false);
        assert.throws(
            () => teams.importPlaybook(installed.team.id, { ...exported, id: "bad", workspacePath: "E:/private" }),
            /field is not allowed/,
        );
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
