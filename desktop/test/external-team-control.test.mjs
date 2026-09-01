import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditLog } from "../../src/audit.js";
import { createConversationStore } from "../src/main/conversation-store.js";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createExternalTeamControlApi, createExternalTeamControlServer } from "../src/main/external-team-control.js";
import { createProductSurfaceService } from "../src/main/product-surface-service.js";
import { createDesktopServices } from "../src/main/services.js";
import { createTeamService } from "../src/main/team-service.js";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "sovereign-external-team-"));
    const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
    const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
    const services = createDesktopServices({ dataDir: root, dialog: {} });
    const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
    const installed = teams.installPack("software-team").team;
    const audit = new AuditLog(join(root, "audit.jsonl"));
    const blocked = new Set();
    const cancellations = [];
    const api = createExternalTeamControlApi({
        dataDir: root,
        teamService: teams,
        coworkerStore: coworkers,
        conversationStore: conversations,
        dispatchMessage: () => [],
        skillStore: {
            list: () => ({ skills: [{ id: "skill_0000000000000001", name: "Release review", description: "Review bounded releases.", state: "active", assignedCoworkerIds: [], assignedTeamIds: [installed.id] }] }),
        },
        routineController: {
            list: () => ({ routines: [{ id: "routine_0000000000000001", name: "Daily review", enabled: true, coworkerId: installed.coworkerIds[0], skillId: "skill_0000000000000001", schedule: { type: "daily", time: "09:00" }, lastStatus: "completed" }] }),
            runNow: (routineId) => ({ routineId, job: { id: "job_0000000000000001", status: "queued" } }),
        },
        jobs: {
            attentionJobs: () => ({ jobs: [{ id: "job_0000000000000001", title: "Review needed", status: "needs_attention", priority: "normal", ownerCoworkerId: installed.coworkerIds[0], conversationId: installed.channels[0].conversationId, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }] }),
        },
        blockConversation: (conversationId) => blocked.add(conversationId),
        isConversationBlocked: (conversationId) => blocked.has(conversationId),
        cancelConversation: (conversationId, reason) => { cancellations.push({ conversationId, reason }); },
        audit,
        makeOutcomeId: () => "outcome_0000000000000001",
    });
    return { root, teams, coworkers, conversations, installed, api, audit, blocked, cancellations };
}

test("external team control exposes bounded opaque team operations and idempotent outcomes", () => {
    const { root, teams, conversations, installed, api, blocked, cancellations } = fixture();
    try {
        const channel = installed.channels[0];
        const listed = api.listTeams();
        assert.equal(listed.teams[0].name, "Software Team");
        assert.equal(JSON.stringify(listed).includes("managed-workspaces"), false);
        assert.equal(JSON.stringify(api.listCoworkers()).includes("providerAccountId"), false);
        assert.throws(() => api.listChannels({ includeArchived: "true" }), /boolean/);
        assert.throws(() => api.listSkills({ includeArchived: "true" }), /boolean/);

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
        getAudit: () => ({ append: async () => undefined }),
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
            "listTeams", "listCoworkers", "listChannels", "sendMessage", "getConversation", "listSkills", "listRoutines", "runRoutineNow", "getAttention", "submitOutcome",
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

test("external product projections remain bounded and reuse governed channel delivery", async () => {
    const { root, api, teams, coworkers, audit, installed } = fixture();
    try {
        const channel = installed.channels[0];
        const sent = api.sendMessage({
            teamId: installed.id,
            channelId: channel.id,
            coworkerId: installed.coworkerIds[0],
            text: "Inspect the bounded release.",
            clientRequestId: "external-message-1",
        });
        assert.equal(sent.teamId, installed.id);
        assert.equal(api.getConversation({ teamId: installed.id, channelId: channel.id }).messages.at(-1).text, "Inspect the bounded release.");
        assert.equal(api.listSkills().skills[0].name, "Release review");
        assert.equal(api.listRoutines().routines[0].name, "Daily review");
        assert.equal(api.runRoutineNow({ routineId: "routine_0000000000000001" }).result.job.status, "queued");
        assert.equal(api.getAttention().jobs[0].status, "needs_attention");
        const takeover = await api.requestTakeover(sent.id, { reason: "operator needs a human token=secret C:\\private\\takeover.txt" });
        assert.equal(takeover.status, "needs_attention");
        const attention = api.getAttention();
        assert.equal(attention.jobs.some((job) => job.id === sent.id && job.status === "needs_attention"), true);
        assert.equal(JSON.stringify(attention).includes("secret"), false);
        assert.equal(JSON.stringify(attention).includes("C:\\private"), false);
        assert.throws(() => api.getConversation({ teamId: installed.id, channelId: channel.id, path: "E:/private" }), /not allowed/);

        const productSurfaces = createProductSurfaceService({
            dataDir: root,
            teamService: teams,
            coworkerStore: coworkers,
            artifactStore: { list: () => ({ artifacts: [] }) },
            runtime: { audit },
        });
        const history = await productSurfaces.computerHistory();
        const event = history.history.find((entry) => entry.eventType === "takeover.requested");
        assert.deepEqual(event && {
            source: event.source,
            activity: event.activity,
            coworkerId: event.coworkerId,
            status: event.status,
        }, {
            source: "takeover",
            activity: "request takeover",
            coworkerId: installed.coworkerIds[0],
            status: "attention",
        });
        assert.equal(JSON.stringify(history).includes("secret"), false);
        assert.equal(JSON.stringify(history).includes("C:\\private"), false);
        assert.equal(JSON.stringify(history).includes("session"), false);
        const auditRows = await audit.readAll();
        const takeoverRow = auditRows.find((entry) => entry.type === "takeover.requested");
        assert.deepEqual(Object.keys(takeoverRow.data).sort(), ["action", "coworkerId", "status"]);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
