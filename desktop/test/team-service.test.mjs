import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConversationStore } from "../src/main/conversation-store.js";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createDesktopServices } from "../src/main/services.js";
import { createTeamService } from "../src/main/team-service.js";

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
