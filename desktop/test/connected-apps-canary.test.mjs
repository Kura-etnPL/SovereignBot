import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Governor } from "../vendor/core/src/governor.js";
import { PolicyEngine } from "../vendor/core/src/policy.js";
import { createConnectedAppsService } from "../src/main/connected-apps.js";
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
        { id: "local-bounded", name: "Local bounded connector", service: "SovereignBot local adapter", description: "Offline bounded echo connector for local verification.", capabilities: ["Return a bounded local value"], tools: ["bounded_echo"], toolGroup: "workspace", connectionMode: "configured" },
        { id: "local-unhealthy", name: "Local unavailable connector", service: "SovereignBot local adapter", description: "Connector health is unavailable until its trusted service returns.", capabilities: ["Offline probe"], tools: ["bounded_echo"], toolGroup: "workspace", connectionMode: "configured", initialConnection: "connected" },
        { id: "local-unconnected", name: "Unconnected catalog app", service: "SovereignBot catalog", description: "Catalog-only app requiring a trusted connection flow.", capabilities: ["Future governed action"], tools: ["bounded_echo"], toolGroup: "workspace", connectionMode: "configured" },
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
    return { connectedApps, audit, bridgeCalls, adapters, projects };
}

test("Connected Apps production canary covers catalog, Project scope, lifecycle, projections, and Governor bridge", async () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-connected-apps-canary-"));
    try {
        const { connectedApps, audit, bridgeCalls, adapters } = fixture(root);
        const catalog = connectedApps.list({ limit: 10 });
        assert.equal(catalog.apps.length, 5);
        assert.equal(connectedApps.list({ query: "local", limit: 10 }).apps.length, 2);
        assert.ok(catalog.apps.every((app) => app.capabilities.length && app.approval.mode === "governed"));
        assert.equal(JSON.stringify(catalog).includes("C:\\private"), false);
        assert.equal(JSON.stringify(catalog.apps).match(/(?:token|cookie|session|transport|endpoint|schema|rawPath|workspacePath)/i), null);
        assert.equal(connectedApps.list({ projectId: projectA }).apps.find((app) => app.id === "local-bounded").assignedTeamIds.length, 0);

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

        await connectedApps.connect({ appId: "local-unhealthy", projectId: projectA });
        const unhealthy = await connectedApps.health({ appId: "local-unhealthy", projectId: projectA });
        assert.equal(unhealthy.health.state, "unavailable");
        connectedApps.setAssignment({ appId: "local-unhealthy", projectId: projectA, teamId: teamA, enabled: true });
        await assert.rejects(() => connectedApps.invoke({ appId: "local-unhealthy", projectId: projectA, coworkerId: alice, taskId: "task_cccccccccccccccc", tool: "bounded_echo", args: { value: "unhealthy" } }), /disconnected or unhealthy/);
        assert.equal(adapters["local-unhealthy"].invoke, undefined);
        assert.deepEqual(validateV3IpcRequest("connectedApps:list", { projectId: projectA, query: "local", limit: 10 }), { projectId: projectA, query: "local", limit: 10 });
        assert.throws(() => validateV3IpcRequest("connectedApps:connect", { appId: "local-bounded", url: "https://example.invalid" }), /unexpected request field/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
