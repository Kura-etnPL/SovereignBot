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
import { createExternalControllerStore } from "../src/main/external-controller-store.js";
import { createSecureChannelPair, createSecureExternalControlClient, attachSecureExternalControlServer } from "../vendor/core/src/worker-secure-transport.js";
import { createWorkerTrustStore } from "../vendor/core/src/worker-trust-store.js";

function fixture({ root: providedRoot, controllerRegistry } = {}) {
    const root = providedRoot ?? mkdtempSync(join(tmpdir(), "sovereign-external-team-"));
    const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
    const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
    const services = createDesktopServices({ dataDir: root, dialog: {} });
    const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
    const installed = teams.installPack("software-team").team;
    const audit = new AuditLog(join(root, "audit.jsonl"));
    const artifact = { id: "artifact_0000000000000001", title: "Release note", fileName: "release-note.md", mimeType: "text/markdown", size: 128, createdAt: "2026-09-01T00:00:00.000Z", conversationId: installed.channels[0].conversationId };
    const artifactStore = { get: (id) => { if (id !== artifact.id) throw new Error("unknown artifact"); return artifact; }, list: () => ({ artifacts: [artifact] }) };
    let routineController = {
        list: () => ({ routines: [{ id: "routine_0000000000000001", name: "Daily review", enabled: true, coworkerId: installed.coworkerIds[0], skillId: "skill_0000000000000001", schedule: { type: "daily", time: "09:00" }, lastStatus: "completed" }] }),
        runNow: (routineId) => ({ routineId, job: { id: "job_0000000000000001", status: "queued" } }),
    };
    let jobs = {
        attentionJobs: () => ({ jobs: [{ id: "job_0000000000000001", title: "Review needed", status: "needs_attention", priority: "normal", ownerCoworkerId: installed.coworkerIds[0], conversationId: installed.channels[0].conversationId, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }] }),
    };
    const blocked = new Set();
    const cancellations = [];
    const attentionRequests = [];
    let outcomeSequence = 0;
    const api = createExternalTeamControlApi({
        dataDir: root,
        teamService: teams,
        coworkerStore: coworkers,
        conversationStore: conversations,
        dispatchMessage: () => [],
        skillStore: {
            list: () => ({ skills: [{ id: "skill_0000000000000001", name: "Release review", description: "Review bounded releases.", state: "active", assignedCoworkerIds: [], assignedTeamIds: [installed.id] }] }),
        },
        getRoutineController: () => routineController,
        getJobs: () => jobs,
        blockConversation: (conversationId) => blocked.add(conversationId),
        isConversationBlocked: (conversationId) => blocked.has(conversationId),
        cancelConversation: (conversationId, reason) => { cancellations.push({ conversationId, reason }); },
        requestAttention: (request) => { attentionRequests.push(request); },
        controllerRegistry,
        artifactStore,
        audit,
        makeOutcomeId: () => `outcome_${String(++outcomeSequence).padStart(16, "0")}`,
    });
    return { root, teams, coworkers, conversations, installed, api, audit, blocked, cancellations, attentionRequests, setRuntimeControllers: (nextRoutineController, nextJobs) => { routineController = nextRoutineController; jobs = nextJobs; } };
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
        assert.throws(() => api.submitOutcome({
            teamId: installed.id,
            channelId: channel.id,
            text: "different text is ignored for the same request",
            clientRequestId: "release-note-1",
        }), /conflicts with a different request/);

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

test("paired External Control Plane runs the bounded surface over direct and opaque relay channels", async () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-external-control-plane-"));
    const hostTrust = createWorkerTrustStore({ dataDir: join(root, "host-trust"), name: "Sovereign Desktop", platform: "win32" });
    const controllerTrust = createWorkerTrustStore({ dataDir: join(root, "controller-trust"), name: "Offline Controller", platform: "test" });
    const controllerRegistry = createExternalControllerStore({ dataDir: root, trustStore: hostTrust });
    const { api, installed, teams, audit, attentionRequests } = fixture({ root, controllerRegistry });
    const controllerId = controllerTrust.identity().deviceId;
    const hostId = hostTrust.identity().deviceId;
    try {
        const offer = hostTrust.beginPairing({ transport: "lan", trustTtlMs: 60_000 });
        const response = controllerTrust.acceptPairing(offer, offer.code, { transport: "lan", trustTtlMs: 60_000 });
        hostTrust.completePairing(offer, response);
        const grant = controllerRegistry.grant({ deviceId: controllerId, scopes: [
            "teams:read", "coworkers:read", "channels:read", "messages:write", "conversation:read", "outcomes:write", "outcomes:read", "outcomes:cancel", "artifacts:read", "skills:read", "routines:read", "routines:run", "attention:read", "takeover:request",
        ], teamIds: [installed.id], projectIds: [] });
        assert.deepEqual(grant.teamIds, [installed.id]);

        const directPair = createSecureChannelPair({ leftIdentity: hostTrust.identity(), rightIdentity: controllerTrust.identity(), leftTrust: hostTrust.getPeer(controllerId), rightTrust: controllerTrust.getPeer(hostId), transport: "lan", relay: null });
        attachSecureExternalControlServer(directPair.left, { invoke: (operation, input, principal) => api.invoke(operation, input, principal) });
        const direct = createSecureExternalControlClient(directPair.right);
        assert.equal((await direct.listTeams()).teams[0].id, installed.id);
        assert.equal((await direct.listCoworkers()).coworkers.length, 3);
        assert.equal((await direct.listChannels({ teamId: installed.id })).channels.length, 1);
        const channel = installed.channels[0];
        const sent = await direct.sendMessage({ teamId: installed.id, channelId: channel.id, text: "Secure direct message", clientRequestId: "secure-direct-message" });
        const submitted = await direct.submitOutcome({ teamId: installed.id, channelId: channel.id, text: "Secure explicit outcome", artifactIds: ["artifact_0000000000000001"], clientRequestId: "secure-direct-outcome" });
        assert.equal((await direct.getConversation({ teamId: installed.id, channelId: channel.id })).messages.length >= 2, true);
        assert.equal((await direct.listSkills()).skills.length, 1);
        assert.equal((await direct.listRoutines()).routines.length, 1);
        assert.equal((await direct.runRoutineNow({ routineId: "routine_0000000000000001" })).routineId, "routine_0000000000000001");
        assert.equal((await direct.getAttention()).protocol, "sovereignbot.team-control.v1");
        assert.equal((await direct.getStatus({ outcomeId: submitted.id })).id, submitted.id);
        assert.equal((await direct.getArtifacts({ outcomeId: submitted.id })).artifacts[0].id, "artifact_0000000000000001");
        assert.equal((await direct.cancel({ outcomeId: submitted.id })).status, "cancelled");
        assert.equal((await direct.cancel({ outcomeId: submitted.id })).status, "cancelled");
        assert.equal((await direct.requestTakeover({ outcomeId: sent.id, reason: "human review requested" })).status, "needs_attention");

        const relayOffer = hostTrust.beginPairing({ transport: "remote-relay", trustTtlMs: 60_000 });
        const relayResponse = controllerTrust.acceptPairing(relayOffer, relayOffer.code, { transport: "remote-relay", trustTtlMs: 60_000 });
        hostTrust.completePairing(relayOffer, relayResponse);
        const relayPair = createSecureChannelPair({ leftIdentity: hostTrust.identity(), rightIdentity: controllerTrust.identity(), leftTrust: hostTrust.getPeer(controllerId), rightTrust: controllerTrust.getPeer(hostId), transport: "remote-relay" });
        attachSecureExternalControlServer(relayPair.left, { invoke: (operation, input, principal) => api.invoke(operation, input, principal) });
        const relay = createSecureExternalControlClient(relayPair.right);
        assert.equal((await relay.listTeams()).teams[0].id, installed.id);
        assert.equal((await relay.listCoworkers()).coworkers.length, 3);
        assert.equal((await relay.listChannels({ teamId: installed.id })).channels.length, 1);
        assert.equal((await relay.getConversation({ teamId: installed.id, channelId: channel.id })).messages.length >= 2, true);
        assert.equal((await relay.getStatus({ outcomeId: sent.id })).status, "needs_attention");
        assert.deepEqual((await relay.getArtifacts({ outcomeId: sent.id })).artifacts, []);
        assert.equal((await relay.listSkills()).skills.length, 1);
        assert.equal((await relay.listRoutines()).routines.length, 1);
        assert.equal((await relay.getAttention()).jobs.some((job) => job.id === sent.id), true);
        assert.equal(JSON.stringify(relayPair.relay.inspect()).includes("Secure direct message"), false);
        assert.equal(JSON.stringify(relayPair.relay.inspect()).includes("C:\\private"), false);
        assert.equal(attentionRequests.some((entry) => entry.outcomeId === sent.id), true);
        assert.equal((await audit.readAll()).some((entry) => entry.type === "takeover.requested"), true);

        const otherTeam = teams.createTeam({ title: "Other Team", coworkerIds: installed.coworkerIds, leadCoworkerId: installed.coworkerIds[0] }).team;
        await assert.rejects(() => relay.getConversation({ teamId: installed.id, channelId: otherTeam.channels[0].id }), /does not belong|binding denied/);
        await assert.rejects(() => relay.getConversation({ teamId: installed.id, channelId: channel.id, path: "C:\\private\\secret.txt" }), /not allowed/);
        await assert.rejects(() => directPair.right.request({ kind: "control.call", operation: "shell", input: {} }), /not supported/);

        const limitedTrust = createWorkerTrustStore({ dataDir: join(root, "limited-trust"), name: "Read-only Controller", platform: "test" });
        const limitedOffer = hostTrust.beginPairing({ transport: "lan", trustTtlMs: 60_000 });
        const limitedResponse = limitedTrust.acceptPairing(limitedOffer, limitedOffer.code, { transport: "lan", trustTtlMs: 60_000 });
        hostTrust.completePairing(limitedOffer, limitedResponse);
        controllerRegistry.grant({ deviceId: limitedTrust.identity().deviceId, scopes: ["teams:read"], teamIds: [installed.id], projectIds: [] });
        const limitedPair = createSecureChannelPair({ leftIdentity: hostTrust.identity(), rightIdentity: limitedTrust.identity(), leftTrust: hostTrust.getPeer(limitedTrust.identity().deviceId), rightTrust: limitedTrust.getPeer(hostId), transport: "lan", relay: null });
        attachSecureExternalControlServer(limitedPair.left, { invoke: (operation, input, principal) => api.invoke(operation, input, principal) });
        const limited = createSecureExternalControlClient(limitedPair.right);
        assert.equal((await limited.listTeams()).teams.length, 1);
        await assert.rejects(() => limited.submitOutcome({ teamId: installed.id, channelId: channel.id, text: "denied", clientRequestId: "denied" }), /scope denied/);
        const requestLeases = Array.from({ length: 8 }, () => controllerRegistry.beginRequest(controllerId));
        await assert.rejects(() => api.invoke("listTeams", {}, { deviceId: controllerId, transport: "remote-relay" }), /capacity is unavailable/);
        requestLeases.forEach((release) => release());
        let expiryClock = Date.now();
        const shortRegistry = createExternalControllerStore({ dataDir: join(root, "short-registry"), trustStore: hostTrust, now: () => expiryClock });
        shortRegistry.grant({ deviceId: controllerId, scopes: ["teams:read"], teamIds: [installed.id], projectIds: [], expiresAt: new Date(expiryClock + 1_000).toISOString() });
        expiryClock += 2_000;
        assert.throws(() => shortRegistry.authorize(controllerId, "listTeams", { teamId: installed.id }), /trust is expired/);
        controllerRegistry.revoke(controllerId);
        await assert.rejects(() => direct.listTeams(), /trust is revoked|transport mismatch/);
    }
    finally {
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

test("external routine and attention projections follow runtime service replacement", () => {
    const { root, api, setRuntimeControllers } = fixture();
    try {
        setRuntimeControllers({
            list: () => ({ routines: [{ id: "routine_0000000000000001", name: "Replacement routine", enabled: true, coworkerId: "coworker_0000000000000001", skillId: "skill_0000000000000001", schedule: { type: "daily", time: "10:00" }, lastStatus: "queued" }] }),
            runNow: (routineId) => ({ routineId, routine: { id: routineId, name: "Replacement routine", enabled: true }, job: { id: "job_2222222222222222", title: "Replacement job", status: "queued" } }),
        }, {
            attentionJobs: () => ({ jobs: [{ id: "job_3333333333333333", title: "Replacement attention", status: "needs_attention", priority: "high", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }] }),
        });
        assert.equal(api.listRoutines().routines[0].name, "Replacement routine");
        assert.equal(api.runRoutineNow({ routineId: "routine_0000000000000001" }).result.job.id, "job_2222222222222222");
        assert.equal(api.getAttention().jobs[0].id, "job_3333333333333333");
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
