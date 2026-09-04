import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../../src/runtime.js";
import { buildPolicyRules, buildProviderRoster } from "../src/main/provider-roster.js";
import { createEconomyProviderFactory } from "../src/main/economy-provider.js";
import { validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createConversationStore } from "../src/main/conversation-store.js";
import { createCoworkerDispatcher } from "../src/main/coworker-dispatcher.js";

function fakeAdapter() {
    let turn = 0;
    return {
        capabilities: () => ["chat", "continuation", "cancellation"],
        models: () => ["fake-model"],
        health: async () => ({ found: true, health: "ready" }),
        start: async () => ({ text: `canary economy ${++turn}`, continuationRef: `canary-ref-${turn}` }),
        continue: async () => ({ text: `canary economy ${++turn}`, continuationRef: `canary-ref-${turn}` }),
        cancel: async () => ({ cancelled: true }),
    };
}

test("Economy production-boundary canary crosses adapter, Governor runtime, continuity, and IPC schema without network", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sb-economy-canary-"));
    const factory = createEconomyProviderFactory({ dataDir, config: { providers: [{ id: "fixed-fake", mode: "fixed-subscription", model: "fake-model" }] }, adapterFactory: () => fakeAdapter() });
    const coworker = { id: "coworker_eeeeeeeeeeeeeeee", name: "Economy Canary", role: "worker", state: "active", modelBinding: { profile: "economy", provider: "economy" } };
    const roster = buildProviderRoster({
        discovery: { codex: { found: true, auth: { state: "signed-in" } }, claude: { found: true, auth: { state: "signed-in" } }, economy: { found: true, health: "ready", auth: { state: "configured" } } },
        settings: {},
        coworkers: [coworker],
        economyProviderId: "fixed-fake",
    });
    const agent = roster.agents.find((entry) => entry.id === "coworker-agent-eeeeeeeeeeeeeeee");
    assert.equal(agent.harness.kind, "economy");
    assert.equal(agent.harness.providerId, "fixed-fake");
    const planner = { id: "planner", name: "Planner", role: "supervisor", capabilities: ["planning"], harness: { kind: "echo" } };
    const runtime = await createRuntime({
        dataDir,
        agents: [planner, agent],
        policy: { repeatWindowMs: 180000, repeatMaxActiveFingerprints: 1000, rules: buildPolicyRules([planner, agent]) },
    }, { economyAdapterResolver: () => factory.get("fixed-fake") });
    try {
        const plan = await runtime.orchestrator.createPlan({ title: "economy canary", ownerAgentId: planner.id, input: {} });
        const trusted = { kind: "local", workspaceId: "ws-economy", cwd: dataDir };
        const first = await runtime.orchestrator.delegateTrusted(plan.id, { title: "first", requiredCapabilities: ["general"], preferredAgentId: agent.id, input: { instruction: "first" } }, trusted, planner.id);
        await runtime.orchestrator.runUntilIdle();
        const storedFirst = (await runtime.orchestrator.listTasks()).find((entry) => entry.id === first.id);
        assert.equal(storedFirst.status, "completed");
        assert.equal(storedFirst.result.text, "canary economy 1");
        assert.equal(storedFirst.harnessState.kind, "economy");
        const second = await runtime.orchestrator.delegateTrusted(plan.id, { title: "second", requiredCapabilities: ["general"], preferredAgentId: agent.id, harnessState: storedFirst.harnessState, input: { instruction: "second" } }, trusted, planner.id);
        await runtime.orchestrator.runUntilIdle();
        const storedSecond = (await runtime.orchestrator.listTasks()).find((entry) => entry.id === second.id);
        assert.equal(storedSecond.status, "completed");
        assert.equal(storedSecond.result.text, "canary economy 2");
        assert.deepEqual(validateV3IpcRequest("coworker:create", { coworker: { name: "Economy", role: "Bounded", modelBinding: { profile: "economy", provider: "economy" } } }).coworker.modelBinding, { profile: "economy", provider: "economy" });
        assert.throws(() => validateV3IpcRequest("coworker:create", { coworker: { name: "Bad", role: "Budget", modelBinding: { profile: "economy", provider: "economy", budget: 999 } } }), /unexpected request field|budget/);
    } finally {
        await runtime.close();
        await factory.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});

test("Economy canary crosses the real Coworker dispatcher and IPC boundary with no fallback", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sb-economy-dispatch-"));
    const stateDir = join(dataDir, "desktop-state");
    const coworkerId = "coworker_ffffffffffffffff";
    const coworkers = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json"), makeId: () => coworkerId });
    coworkers.create({ name: "Economy Dispatcher", role: "bounded Economy work", state: "active", modelBinding: { profile: "economy", provider: "economy" } });
    const roster = buildProviderRoster({
        discovery: { codex: { found: false }, claude: { found: false }, economy: { found: true, health: "ready", auth: { state: "configured" } } },
        settings: {},
        coworkers: coworkers.listInternal().coworkers,
        economyProviderId: "fixed-fake",
    });
    const planner = { id: "planner", name: "Planner", role: "supervisor", capabilities: ["planning"], harness: { kind: "echo" } };
    const dispatchRoster = { ...roster, roles: { planner: planner.id } };
    const factory = createEconomyProviderFactory({ dataDir, config: { providers: [{ id: "fixed-fake", mode: "fixed-subscription", model: "fake-model" }] }, adapterFactory: () => fakeAdapter() });
    const runtime = await createRuntime({ dataDir, agents: [planner, ...roster.agents], policy: { repeatWindowMs: 180000, rules: buildPolicyRules([planner, ...roster.agents]) } }, { economyAdapterResolver: () => factory.get("fixed-fake") });
    try {
        assert.deepEqual(validateV3IpcRequest("coworker:create", { coworker: { name: "Economy", role: "Bounded", modelBinding: { profile: "economy", provider: "economy" } } }).coworker.modelBinding, { profile: "economy", provider: "economy" });
        const conversations = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore: coworkers });
        const direct = conversations.createDirect(coworkerId);
        const dispatcher = createCoworkerDispatcher({ dataDir, runtime, roster: () => dispatchRoster, coworkerStore: coworkers, conversationStore: conversations, services: { workspacePath: () => undefined } });
        const message = conversations.postUserMessage(direct.id, { text: "Use only the configured fixed Economy lane", clientMessageId: "economy-dispatch" });
        dispatcher.dispatchMessage(direct.id, message.id);
        await dispatcher.flush();
        const view = conversations.get(direct.id);
        assert.equal(view.messages.at(-1).text, "canary economy 1");
        assert.equal(view.messages[0].delivery[coworkerId].status, "delivered");
        assert.equal(JSON.stringify(view).includes("budget"), false);
        assert.equal(dispatchRoster.coworkerBindings[coworkerId].provider, "economy");
        assert.equal(factory.usageSnapshot().spent, 0);
    } finally { await runtime.close(); await factory.close(); await rm(dataDir, { recursive: true, force: true }); }
});
