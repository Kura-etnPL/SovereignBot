import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConversationStore } from "../src/main/conversation-store.js";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createExternalTeamControlApi, createExternalTeamControlServer } from "../src/main/external-team-control.js";
import { createDesktopServices } from "../src/main/services.js";
import { createTeamService } from "../src/main/team-service.js";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "sovereign-external-team-"));
    const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
    const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
    const services = createDesktopServices({ dataDir: root, dialog: {} });
    const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
    const installed = teams.installPack("software-team").team;
    const blocked = new Set();
    const cancellations = [];
    const api = createExternalTeamControlApi({
        dataDir: root,
        teamService: teams,
        coworkerStore: coworkers,
        conversationStore: conversations,
        dispatchMessage: () => [],
        blockConversation: (conversationId) => blocked.add(conversationId),
        isConversationBlocked: (conversationId) => blocked.has(conversationId),
        cancelConversation: (conversationId, reason) => { cancellations.push({ conversationId, reason }); },
        makeOutcomeId: () => "outcome_0000000000000001",
    });
    return { root, teams, conversations, installed, api, blocked, cancellations };
}

test("external team control exposes bounded opaque team operations and idempotent outcomes", () => {
    const { root, teams, conversations, installed, api, blocked, cancellations } = fixture();
    try {
        const channel = installed.channels[0];
        const listed = api.listTeams();
        assert.equal(listed.teams[0].name, "Software Team");
        assert.equal(JSON.stringify(listed).includes("managed-workspaces"), false);
        assert.equal(JSON.stringify(api.listCoworkers()).includes("providerAccountId"), false);

        const first = api.submitOutcome({
            teamId: installed.id,
            channelId: channel.id,
            text: "Build the bounded release note.",
            clientRequestId: "release-note-1",
        });
        assert.equal(first.status, "working");
        assert.equal(conversations.get(channel.conversationId).messages.length, 1);
        assert.equal(api.submitOutcome({
            teamId: installed.id,
            channelId: channel.id,
            text: "different text is ignored for the same request",
            clientRequestId: "release-note-1",
        }).id, first.id);

        assert.throws(() => api.submitOutcome({
            teamId: installed.id,
            channelId: channel.id,
            text: "bad",
            token: "must never cross the boundary",
        }), /not allowed/);

        const cancelled = api.cancelOutcome(first.id);
        assert.equal(cancelled.status, "cancelled");
        assert.equal(blocked.has(channel.conversationId), true);
        assert.deepEqual(cancellations, [{ conversationId: channel.conversationId, reason: "external outcome cancelled" }]);
        assert.equal(api.getOutcome(first.id).status, "cancelled");
        assert.throws(() => api.submitOutcome({
            teamId: installed.id,
            channelId: channel.id,
            text: "must not enter a blocked channel",
            clientRequestId: "release-note-2",
        }), /blocked/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("external team control server is loopback-only and requires an operator session", async () => {
    const { root, api } = fixture();
    const server = createExternalTeamControlServer({
        dataDir: root,
        teamService: {
            list: () => ({ teams: [] }),
            getChannel: () => { throw new Error("unused"); },
            listChannels: () => ({ channels: [] }),
        },
        coworkerStore: { list: () => ({ coworkers: [] }) },
        conversationStore: { get: () => { throw new Error("unused"); }, postUserMessage: () => { throw new Error("unused"); } },
        dispatchMessage: () => [],
        authenticate: async (token) => token === "operator-session-test",
    });
    try {
        const address = await server.start();
        const unauthenticated = await fetch("http://127.0.0.1:" + address.port + "/mcp/v1/status");
        assert.equal(unauthenticated.status, 401);
        const authenticated = await fetch("http://127.0.0.1:" + address.port + "/mcp/v1/status", {
            headers: { authorization: "Bearer operator-session-test" },
        });
        assert.equal(authenticated.status, 200);
        assert.equal((await authenticated.json()).protocol, api.protocol);

        const rpc = async (payload) => fetch("http://127.0.0.1:" + address.port + "/mcp/v1", {
            method: "POST",
            headers: {
                authorization: "Bearer operator-session-test",
                "content-type": "application/json",
            },
            body: JSON.stringify(payload),
        });
        const initialized = await rpc({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", clientInfo: { name: "test-client", version: "1" }, capabilities: {} },
        });
        assert.equal(initialized.status, 200);
        assert.equal((await initialized.json()).result.protocolVersion, "2025-06-18");
        const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        assert.equal(tools.status, 200);
        assert.deepEqual((await tools.json()).result.tools.map((entry) => entry.name), [
            "listTeams", "listCoworkers", "listChannels", "submitOutcome",
            "getOutcomeStatus", "getArtifacts", "cancelOutcome", "requestTakeover",
        ]);
        const listedTeams = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "listTeams", arguments: {} } });
        assert.deepEqual((await listedTeams.json()).result.structuredContent.teams, []);
        const forbidden = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "submitOutcome", arguments: { token: "must-not-cross-boundary" } } });
        const forbiddenBody = await forbidden.json();
        assert.equal(forbiddenBody.error.code, -32602);
        assert.match(forbiddenBody.error.message, /not allowed/);
        const initializedNotification = await rpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        assert.equal(initializedNotification.status, 204);
    }
    finally {
        await server.close();
        rmSync(root, { recursive: true, force: true });
    }
});
