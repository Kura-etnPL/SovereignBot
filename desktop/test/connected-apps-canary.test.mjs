import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Governor } from "../vendor/core/src/governor.js";
import { PolicyEngine } from "../vendor/core/src/policy.js";
import { CONNECTED_APP_MANIFEST_SCHEMA, createConnectedAppsService } from "../src/main/connected-apps.js";
import { validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";

const projectA = "project_aaaaaaaaaaaaaaaa";
const projectB = "project_bbbbbbbbbbbbbbbb";
const teamA = "team_aaaaaaaaaaaaaaaa";
const teamB = "team_bbbbbbbbbbbbbbbb";
const alice = "coworker_aaaaaaaaaaaaaaaa";
const bob = "coworker_bbbbbbbbbbbbbbbb";

function fixture(root) {
    const teams = [
        { id: teamA, name: "Alpha Team", state: "active", coworkerIds: [alice] },
        { id: teamB, name: "Beta Team", state: "active", coworkerIds: [bob] },
    ];
    const coworkers = [
        { id: alice, name: "Alice", role: "Builder", state: "active" },
        { id: bob, name: "Bob", role: "Reviewer", state: "active" },
    ];
    const projects = new Map([
        [projectA, { projectId: projectA, state: "active", teamIds: [teamA], coworkerIds: [alice] }],
        [projectB, { projectId: projectB, state: "active", teamIds: [teamB], coworkerIds: [bob] }],
    ]);
    let boundedConnected = false;
    const adapters = {
        "local-bounded": {
            async connect() { boundedConnected = true; return { state: "connected", health: "ready" }; },
            async disconnect() { boundedConnected = false; },
            async health() { return boundedConnected ? { health: "ready" } : { health: "signed-out" }; },
            async invoke({ tool, args }) { return { tool, value: args.value, bounded: true }; },
        },
        "local-unhealthy": { async health() { return { health: "unavailable", reason: "local connector is offline at C:\\private\\connector" }; } },
    };
    const manifests = [
        { schema: CONNECTED_APP_MANIFEST_SCHEMA, version: 1, id: "local-bounded", name: "Local bounded connector", service: "SovereignBot local adapter", description: "Offline bounded echo connector for local verification.", capabilities: ["Return a bounded local value"], tools: ["bounded_echo"], toolGroup: "workspace", connectionMode: "configured", category: "workspace", trustedSource: "Local canary fixture", cost: { mode: "local-only", summary: "No network or metered fee in this local canary." }, approvalSummary: "Governor-controlled local canary; task-bound approval required.", catalogAvailability: "available" },
        { schema: CONNECTED_APP_MANIFEST_SCHEMA, version: 1, id: "local-unhealthy", name: "Local unavailable connector", service: "SovereignBot local adapter", description: "Connector health is unavailable until its trusted service returns.", capabilities: ["Offline probe"], tools: ["bounded_echo"], toolGroup: "workspace", connectionMode: "configured", initialConnection: "connected", category: "workspace", trustedSource: "Local canary fixture", cost: { mode: "local-only", summary: "No network or metered fee in this local canary." }, approvalSummary: "Governor-controlled local canary; task-bound approval required.", catalogAvailability: "available" },
        { schema: CONNECTED_APP_MANIFEST_SCHEMA, version: 1, id: "local-unconnected", name: "Unconnected catalog app", service: "SovereignBot catalog", description: "Catalog-only app requiring a trusted connection flow.", capabilities: ["Future governed action"], tools: ["bounded_echo"], toolGroup: "workspace", connectionMode: "configured", category: "other", trustedSource: "Local canary fixture", cost: { mode: "not-configured", summary: "No fee is incurred because this app is not configured." }, approvalSummary: "Governor-controlled; task-bound approval required.", catalogAvailability: "available" },
    ];
    const audit = [];
    const governor = new Governor(new PolicyEngine({ rules: [{ id: "allow-bounded-app", effect: "allow", match: { category: "connected-app", operation: "invoke", intent: "bounded-echo" } }] }), { append: async (entry) => audit.push(entry) });
    const bridgeCalls = [];
    const appBridge = {
        async invoke(input) {
            bridgeCalls.push({ appId: input.appId, projectId: input.projectId, tool: input.tool });
            const decision = await governor.authorize({ category: "connected-app", operation: "invoke", target: `app:${input.appId}`, agentId: input.coworkerId, taskId: input.taskId, intent: "bounded-echo" });
            if (!decision.allowed) throw new Error("Governor denied connected app action");
            return adapters[input.appId].invoke(input);
        },
    };
    const connectedApps = createConnectedAppsService({
        dataDir: root, teamService: { list() { return { teams }; } }, coworkerStore: { list() { return { coworkers }; }, get(id) { const entry = coworkers.find((item) => item.id === id); if (!entry) throw new Error("unknown coworker"); return entry; } },
        manifests, adapters, getProjectScope: (id) => projects.get(id), invokeTrusted: (input) => appBridge.invoke(input),
    });
    return { connectedApps, audit, bridgeCalls, adapters, projects, manifests };
}

test("Connected Apps production canary covers catalog, Project scope, lifecycle, projections, and Governor bridge", async () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-connected-apps-canary-"));
    try {
        const { connectedApps, audit, bridgeCalls, adapters, projects, manifests } = fixture(root);
        const catalog = connectedApps.list({ limit: 10 });
        assert.equal(catalog.apps.length, 5);
        assert.equal(connectedApps.list({ query: "local", limit: 10 }).apps.length, 3);
        assert.ok(catalog.apps.every((app) => app.capabilities.length && app.approval.mode === "governed"));
        assert.equal(JSON.stringify(catalog).includes("C:\\private"), false);
        assert.equal(JSON.stringify(catalog.apps).match(/(?:token|cookie|session|transport|endpoint|schema|rawPath|workspacePath)/i), null);
        assert.equal(connectedApps.list({ projectId: projectA }).apps.find((app) => app.id === "local-bounded").assignedTeamIds.length, 0);
        assert.equal(catalog.apps.find((app) => app.id === "local-bounded").installationState, "configured");
        assert.equal(catalog.apps.find((app) => app.id === "local-bounded").cost.metered, false);
        assert.equal(connectedApps.list({ category: "workspace", status: "configured", limit: 10 }).apps.some((app) => app.id === "local-bounded"), true);
        assert.equal(connectedApps.review({ appId: "local-bounded", projectId: projectA }).review.capabilities[0], "Return a bounded local value");

        const connected = await connectedApps.connect({ appId: "local-bounded", projectId: projectA });
        assert.equal(connected.connectionState, "connected");
        assert.equal((await connectedApps.health({ appId: "local-bounded", projectId: projectA })).health.state, "ready");
        connectedApps.setAssignment({ appId: "local-bounded", projectId: projectA, teamId: teamA, enabled: true });
        connectedApps.setAssignment({ appId: "local-bounded", projectId: projectA, coworkerId: alice, enabled: true });
        assert.throws(() => connectedApps.setAssignment({ appId: "local-bounded", projectId: projectB, teamId: teamA, enabled: true }), /outside Project scope/);
        assert.throws(() => connectedApps.setAssignment({ appId: "local-bounded", projectId: projectA, coworkerId: bob, enabled: true }), /outside Project scope/);

        const result = await connectedApps.invoke({ appId: "local-bounded", projectId: projectA, coworkerId: alice, taskId: "task_cccccccccccccccc", tool: "bounded_echo", args: { value: "hello" } });
        assert.deepEqual(result, { tool: "bounded_echo", value: "hello", bounded: true });
        assert.deepEqual(bridgeCalls, [{ appId: "local-bounded", projectId: projectA, tool: "bounded_echo" }]);
        assert.ok(audit.some((entry) => entry.type === "action.allowed"));
        await assert.rejects(() => connectedApps.invoke({ appId: "local-bounded", projectId: projectB, coworkerId: alice, taskId: "task_cccccccccccccccc", tool: "bounded_echo", args: { value: "cross-scope" } }), /Project scope|assigned/);
        await assert.rejects(() => connectedApps.invoke({ appId: "local-bounded", projectId: projectA, coworkerId: bob, taskId: "task_cccccccccccccccc", tool: "bounded_echo", args: { value: "non-roster" } }), /Project scope|assigned/);
        await assert.rejects(() => connectedApps.invoke({ appId: "local-bounded", projectId: projectA, coworkerId: alice, taskId: "task_cccccccccccccccc", tool: "bounded_echo", args: { token: "forged" } }), /forbidden authority/);
        await connectedApps.disconnect({ appId: "local-bounded", projectId: projectA });
        assert.equal(connectedApps.list({ projectId: projectA }).apps.find((app) => app.id === "local-bounded").assignedTeamIds.length, 0);
        await assert.rejects(() => connectedApps.invoke({ appId: "local-bounded", projectId: projectA, coworkerId: alice, taskId: "task_cccccccccccccccc", tool: "bounded_echo", args: { value: "disconnected" } }), /Project scope|disconnected or unhealthy/);
        await connectedApps.connect({ appId: "local-bounded", projectId: projectA });
        connectedApps.setAssignment({ appId: "local-bounded", projectId: projectA, coworkerId: alice, enabled: true });
        await connectedApps.disable({ appId: "local-bounded", projectId: projectA });
        assert.equal(connectedApps.list({ projectId: projectA }).apps.find((app) => app.id === "local-bounded").connectionState, "disabled");
        assert.deepEqual(connectedApps.assignedToolsForCoworker(alice, projectA), { tools: [], appIds: [], approvalProfiles: [] });
        await assert.rejects(() => connectedApps.invoke({ appId: "local-bounded", projectId: projectA, coworkerId: alice, taskId: "task_cccccccccccccccc", tool: "bounded_echo", args: { value: "disabled" } }), /disconnected or unhealthy/);
        const restarted = createConnectedAppsService({ dataDir: root, teamService: { list() { return { teams }; } }, coworkerStore: { list() { return { coworkers }; }, get(id) { const entry = coworkers.find((item) => item.id === id); if (!entry) throw new Error("unknown coworker"); return entry; } }, manifests, adapters, getProjectScope: (id) => projects.get(id), invokeTrusted: (input) => appBridge.invoke(input) });
        assert.equal(restarted.list({ projectId: projectA }).apps.find((app) => app.id === "local-bounded").connectionState, "disabled");
        assert.equal(restarted.list({ projectId: projectA }).apps.find((app) => app.id === "local-bounded").assignedCoworkerIds.includes(alice), true);

        await connectedApps.connect({ appId: "local-unhealthy", projectId: projectA });
        const unhealthy = await connectedApps.health({ appId: "local-unhealthy", projectId: projectA });
        assert.equal(unhealthy.health.state, "unavailable");
        connectedApps.setAssignment({ appId: "local-unhealthy", projectId: projectA, teamId: teamA, enabled: true });
        await assert.rejects(() => connectedApps.invoke({ appId: "local-unhealthy", projectId: projectA, coworkerId: alice, taskId: "task_cccccccccccccccc", tool: "bounded_echo", args: { value: "unhealthy" } }), /disconnected or unhealthy/);
        assert.equal(adapters["local-unhealthy"].invoke, undefined);
        assert.deepEqual(validateV3IpcRequest("connectedApps:list", { projectId: projectA, query: "local", limit: 10 }), { projectId: projectA, query: "local", limit: 10 });
        assert.throws(() => validateV3IpcRequest("connectedApps:connect", { appId: "local-bounded", url: "https://example.invalid" }), /unexpected request field/);
        assert.deepEqual(validateV3IpcRequest("connectedApps:search", { category: "workspace", status: "configured" }), { category: "workspace", status: "configured" });
        assert.throws(() => createConnectedAppsService({ dataDir: root, teamService: { list() { return { teams }; } }, coworkerStore: { list() { return { coworkers }; } }, manifests: [{ ...manifests[0], version: 99 }] }), /schema or version/);
        assert.throws(() => createConnectedAppsService({ dataDir: root, teamService: { list() { return { teams }; } }, coworkerStore: { list() { return { coworkers }; } }, manifests: [{ ...manifests[0], cwd: "C:\\private" }] }), /unexpected field/);
        assert.throws(() => createConnectedAppsService({ dataDir: root, teamService: { list() { return { teams }; } }, coworkerStore: { list() { return { coworkers }; } }, manifests: [{ ...manifests[0], description: "x".repeat(65_000) }] }), /too large/);
        assert.throws(() => createConnectedAppsService({ dataDir: root, teamService: { list() { return { teams }; } }, coworkerStore: { list() { return { coworkers }; } }, manifests: [{ ...manifests[0], authority: "Admin" }] }), /unexpected field/);
        let meteredConnected = false;
        const metered = createConnectedAppsService({
            dataDir: join(root, "metered"),
            teamService: { list() { return { teams: [] }; } },
            coworkerStore: { list() { return { coworkers: [] }; } },
            manifests: [{ ...manifests[0], id: "local-metered", cost: { mode: "metered", summary: "A fee applies per approved call." } }],
            adapters: { "local-metered": { async connect() { meteredConnected = true; return { state: "connected", health: "ready" }; }, async disconnect() { meteredConnected = false; } } },
        });
        assert.equal((await metered.connect({ appId: "local-metered" })).connectionState, "attention");
        assert.equal(meteredConnected, false);
        assert.equal((await metered.connect({ appId: "local-metered", approveMetered: true })).connectionState, "connected");
    } finally { rmSync(root, { recursive: true, force: true }); }
});
