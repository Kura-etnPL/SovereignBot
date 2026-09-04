import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConversationStore } from "../src/main/conversation-store.js";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createDesktopServices } from "../src/main/services.js";
import { CHANNEL_TEMPLATES, TEAM_PACK_EXPORT_SCHEMA, TEAM_PLAYBOOK_EXPORT_SCHEMA, createTeamService } from "../src/main/team-service.js";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "sovereign-team-"));
    const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
    const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
    const services = createDesktopServices({ dataDir: root, dialog: {} });
    const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
    teams.setRuntimeHandoffPreflight(({ conversationId, targetCoworkerId, workspaceId }) => ({
        targetCoworkerId,
        agentId: "test-agent",
        workspaceId: workspaceId ?? teams.workspaceIdForConversation(conversationId),
    }));
    return { root, coworkers, conversations, services, teams };
}

function commitHandoff(teams, args) {
    const target = teams.previewHandoff(args);
    if (!target) return teams.nextHandoff(args);
    const context = teams.collaborationContextForConversation(args.conversation.id);
    const runtimeProof = teams.authorizeHandoffTarget({
        conversationId: args.conversation.id,
        sourceCoworkerId: args.coworkerId,
        targetCoworkerId: target,
        expectedVersion: context.version,
        expectedRunId: context.runId,
        expectedRequestId: context.requestId,
        expectedOperationId: context.operationId,
        expectedOperationToken: context.operationToken,
    });
    return teams.nextHandoff({
        ...args,
        runtimeProof,
        expectedTargetCoworkerId: target,
        expectedVersion: context.version,
        expectedRunId: context.runId,
        expectedRequestId: context.requestId,
        expectedOperationId: context.operationId,
        expectedOperationToken: context.operationToken,
    });
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
        const chiefHandoff = commitHandoff(teams, { conversation: conversations.get(conversation.id), coworkerId: first.team.coworkerIds[0], source: userMessage });
        assert.equal(chiefHandoff, first.team.coworkerIds[1]);
        assert.equal(teams.status(first.team.id).routingDecision.targetCoworkerId, first.team.coworkerIds[1]);
        assert.equal(teams.status(first.team.id).routingDecision.handoffType, "delegate");
        assert.equal(commitHandoff(teams, { conversation: conversations.get(conversation.id), coworkerId: first.team.coworkerIds[0], source: userMessage }), chiefHandoff);
        assert.equal(commitHandoff(teams, { conversation: conversations.get(conversation.id), coworkerId: first.team.coworkerIds[1], source: { id: "message-coding", senderId: first.team.coworkerIds[0], text: "Implement the requested software change." } }), first.team.coworkerIds[2]);
        assert.equal(commitHandoff(teams, { conversation: conversations.get(conversation.id), coworkerId: first.team.coworkerIds[2], source: { id: "message-review", senderId: first.team.coworkerIds[1], text: "Review the implementation." } }), first.team.coworkerIds[0]);
        assert.equal(commitHandoff(teams, { conversation: conversations.get(conversation.id), coworkerId: first.team.coworkerIds[0], source: { id: "message-synthesis", senderId: first.team.coworkerIds[2], text: "Synthesize the reviewed result." } }), undefined);
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
            "product-team",
            "revenue-team",
            "support-team",
        ]);
        assert.deepEqual(teams.list().packs.map((entry) => entry.category), [
            "Software",
            "Research",
            "Content",
            "Operations",
            "Product",
            "Sales",
            "Support",
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
        assert.equal(commitHandoff(teams, { conversation: conversations.get(installed.team.channels[0].conversationId), coworkerId: installed.team.coworkerIds[0], source: userMessage }), installed.team.coworkerIds[1]);
        assert.equal(coworkers.list().coworkers.length, 3);
        assert.equal(JSON.stringify(teams.list()).includes("providerAccountId"), false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("first-party Product, Revenue, and Support packs stay advisory and use the governed team path", () => {
    const { root, teams } = fixture();
    try {
        for (const [packId, name, channelName, playbookName] of [
            ["product-team", "Product Discovery Team", "Product Discovery", "Product Discovery"],
            ["revenue-team", "Revenue Planning Team", "Revenue Planning", "Revenue Planning"],
            ["support-team", "Customer Support Team", "Support Triage", "Support Triage"],
        ]) {
            const result = teams.installPack(packId);
            assert.equal(result.installed, true);
            assert.equal(result.team.name, name);
            assert.equal(result.team.channels[0].name, channelName);
            assert.equal(result.team.playbooks[0].name, playbookName);
            assert.equal(result.team.coworkers.length, 3);
            assert.equal(result.team.channels[0].coworkerIds.length, 3);
            assert.equal(JSON.stringify(result.team).match(/capabilit|governedTools|credential|session|workspacePath|token/gi), null);
        }
        assert.equal(teams.list().teams.length, 3);
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

        const handoff = commitHandoff(teams, {
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
        const recipe = teams.exportPackRecipe(imported.team.packId);
        assert.equal(recipe.id, imported.team.packId);
        assert.equal(teams.list().packs.find((pack) => pack.id === imported.team.packId).custom, true);
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
        const semantic = teams.importPlaybook(installed.team.id, {
            ...exported,
            id: "semantic-method",
            name: "Semantic Method",
            stages: [{ id: "draft", name: "Draft", instructions: "Prepare the bounded draft.", expectedOutput: "Draft", recommendedCoworkerRole: "Author", recommendedSkillIds: ["skill_writing"] }],
            reviewPoints: [{ id: "review", name: "Review", instructions: "Current owner reviews before proceeding.", recommendedCoworkerRole: "Reviewer" }],
            expectedOutput: "Approved result",
            recommendedCoworkerRoles: ["Author", "Reviewer"],
            recommendedSkillIds: ["skill_writing"],
        });
        assert.equal(semantic.playbook.stages[0].name, "Draft");
        assert.deepEqual(teams.exportPlaybook(installed.team.id, "semantic-method").reviewPoints, [{ id: "review", name: "Review", instructions: "Current owner reviews before proceeding.", recommendedCoworkerRole: "Reviewer" }]);
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
        assert.throws(
            () => teams.importPlaybook(installed.team.id, { ...exported, id: "bad-authority", stages: [{ id: "draft", name: "Draft", instructions: "Draft", capabilityGrant: "computer" }] }),
            /field is not allowed/,
        );
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("Playbook Library edits update the assigned team's reusable procedure", () => {
    const { root, teams } = fixture();
    try {
        const installed = teams.installPack("software-team");
        const updated = teams.updatePlaybook(installed.team.id, "software-delivery", {
            name: "Software Delivery v2",
            description: "",
            steps: ["chief", "coding-lead", "reviewer", "chief"],
            stages: [{ id: "ship", name: "Ship", instructions: "Prepare the bounded change." }],
            expectedOutput: "Released change",
        });
        assert.equal(updated.playbook.name, "Software Delivery v2");
        assert.equal(updated.playbook.description, "");
        const current = teams.get(installed.team.id);
        assert.equal(current.playbooks[0].name, "Software Delivery v2");
        assert.equal(current.playbooks[0].description, "");
        assert.deepEqual(current.playbooks[0].steps, ["chief", "coding-lead", "reviewer", "chief"]);
        assert.equal(current.playbooks[0].stages[0].id, "ship");
        assert.equal(current.playbooks[0].expectedOutput, "Released change");
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("channel templates create governed team channels idempotently", () => {
    const { root, conversations, teams } = fixture();
    try {
        const installed = teams.installPack("software-team");
        assert.deepEqual(CHANNEL_TEMPLATES.map((template) => template.id), ["work", "personal", "project"]);
        const created = teams.createChannelFromTemplate(installed.team.id, "work");
        assert.equal(created.created, true);
        assert.equal(created.channel.kind, "work");
        assert.equal(created.channel.templateId, "work");
        assert.equal(created.channel.workspaceId, installed.team.sharedWorkspaceId);
        assert.equal(created.team.channels.length, 2);
        assert.equal(conversations.list().conversations.length, 2);
        assert.equal(JSON.stringify(created.team).includes("path"), false);

        const existingProject = teams.createChannelFromTemplate(installed.team.id, "project");
        assert.equal(existingProject.created, false);
        assert.equal(existingProject.channel.name, "Project Channel");

        const repeated = teams.createChannelFromTemplate(installed.team.id, "work");
        assert.equal(repeated.created, false);
        assert.equal(repeated.channel.id, created.channel.id);
        assert.equal(teams.get(installed.team.id).channels.length, 2);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("custom channels support bounded editing and fail-closed archive/restore", () => {
    const { root, teams } = fixture();
    try {
        const installed = teams.installPack("software-team");
        const created = teams.createChannel({
            teamId: installed.team.id,
            name: "Launch Room",
            kind: "work",
            instructions: "Coordinate the bounded launch.",
        });
        assert.equal(created.created, true);
        assert.equal(created.channel.kind, "work");
        assert.equal(created.channel.workspaceId, installed.team.sharedWorkspaceId);
        assert.equal(created.channel.archived, false);
        const updated = teams.updateChannel(created.channel.id, {
            name: "Launch Review",
            instructions: "Review the bounded launch outcome.",
        });
        assert.equal(updated.channel.name, "Launch Review");
        assert.equal(updated.channel.conversationId, created.channel.conversationId);
        assert.equal(teams.listChannels({ teamId: installed.team.id }).channels.some((entry) => entry.id === created.channel.id), true);
        const archived = teams.archiveChannel(created.channel.id);
        assert.equal(archived.channel.archived, true);
        assert.equal(teams.listChannels({ teamId: installed.team.id }).channels.some((entry) => entry.id === created.channel.id), false);
        assert.equal(teams.listChannels({ teamId: installed.team.id, includeArchived: true }).channels.some((entry) => entry.archived), true);
        assert.throws(() => teams.archiveChannel(installed.team.channels[0].id), /at least one active channel/);
        const restored = teams.restoreChannel(created.channel.id);
        assert.equal(restored.channel.archived, false);
        assert.throws(() => teams.createChannel({ teamId: installed.team.id, name: "Leak", workspaceId: "E:/private" }), /workspaceId must be an identifier/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
