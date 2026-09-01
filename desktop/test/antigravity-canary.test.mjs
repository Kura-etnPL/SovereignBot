import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../vendor/core/src/runtime.js";
import { buildPolicyRules } from "../src/main/provider-roster.js";
import { AntigravityProvider, antigravityAccountNamespace } from "../src/main/antigravity-provider.js";
import { buildProviderRoster, coworkerAgentId, coworkerCapability } from "../src/main/provider-roster.js";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createConversationStore } from "../src/main/conversation-store.js";
import { createCoworkerDispatcher } from "../src/main/coworker-dispatcher.js";
import { validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";

function browser(reply) {
    let text = "Antigravity", url = "https://antigravity.google/task/fake";
    return { health: async () => ({ browser: "fake-w3c" }), text: async () => text, currentUrl: async () => url,
        snapshot: async () => ({ url, elements: [{ role: "textbox", name: "Task prompt", disabled: false }] }), type: async () => {},
        key: async () => { text = reply; }, navigate: async (next) => { url = next; }, close: async () => {} };
}

test("Antigravity production-boundary canary: Core runtime uses isolated fake W3C accounts without rotation", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sb-antigravity-canary-"));
    const a = antigravityAccountNamespace("A"), b = antigravityAccountNamespace("B"), c = antigravityAccountNamespace("C");
    const calls = [];
    const adapters = new Map([[a, new AntigravityProvider({ accountNamespace: a, driver: browser("answer-a") })], [b, new AntigravityProvider({ accountNamespace: b, driver: browser("answer-b") })], [c, new AntigravityProvider({ accountNamespace: c, driver: browser("answer-c") })]]);
    const agents = [a, b, c].map((accountNamespace, index) => ({ id: `anti-${index}`, name: `Anti ${index}`, role: "worker", capabilities: ["general"], harness: { kind: "antigravity", model: "antigravity", accountNamespace } }));
    const planner = { id: "planner", name: "Planner", role: "supervisor", capabilities: ["planning"], harness: { kind: "echo" } };
    const runtime = await createRuntime({ dataDir, agents: [planner, ...agents], policy: { repeatWindowMs: 180000, rules: buildPolicyRules([planner, ...agents]) } }, {
        antigravityAdapterResolver: (agent) => { calls.push(agent.harness.accountNamespace); return adapters.get(agent.harness.accountNamespace); },
    });
    try {
        const plan = await runtime.orchestrator.createPlan({ title: "canary", ownerAgentId: planner.id, input: {} });
        const task = await runtime.orchestrator.delegateTrusted(plan.id, { title: "A task", input: { instruction: "respond" }, preferredAgentId: "anti-0", requiredCapabilities: ["general"] }, { kind: "local", workspaceId: "ws-anti", cwd: dataDir }, planner.id);
        await runtime.orchestrator.runUntilIdle();
        const finished = (await runtime.orchestrator.listTasks()).find((entry) => entry.id === task.id);
        assert.equal(finished.status, "completed");
        assert.equal(finished.harnessState.kind, "antigravity");
        assert.deepEqual(new Set(calls), new Set([a, b, c]));
        assert.equal(JSON.stringify(finished).includes("provider-account-"), false);
        assert.equal(JSON.stringify(finished).includes("answer-a"), true);
        assert.equal(JSON.stringify(runtime.config.agents).includes("account-a"), false);
        assert.equal(new Set([a, b, c]).size, 3);
    } finally { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("Antigravity canary crosses the real Coworker dispatcher and IPC validation boundary", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sb-antigravity-dispatch-"));
    const account = antigravityAccountNamespace("B");
    const coworkerId = "coworker_bbbbbbbbbbbbbbbb";
    const stateDir = join(dataDir, "desktop-state");
    const store = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json"), makeId: () => coworkerId });
    store.create({ name: "Antigravity B", role: "worker", state: "active", modelBinding: { profile: "custom", provider: "antigravity", model: "antigravity", providerAccountId: "account-b" } });
    const roster = buildProviderRoster({ discovery: { codex: { found: false }, claude: { found: false }, antigravity: { found: true, auth: { state: "signed-in" } } }, settings: {}, coworkers: store.listInternal().coworkers });
    const dispatchRoster = { ...roster, roles: { planner: "planner" } };
    const planner = { id: "planner", name: "Planner", role: "supervisor", capabilities: ["planning"], harness: { kind: "echo" } };
    const adapter = new AntigravityProvider({ accountNamespace: account, driver: browser("dispatcher-answer") });
    const runtime = await createRuntime({ dataDir, agents: [planner, ...roster.agents], policy: { repeatWindowMs: 180000, rules: buildPolicyRules([planner, ...roster.agents]) } }, { antigravityAdapterResolver: () => adapter });
    try {
        assert.deepEqual(validateV3IpcRequest("provider:setCoworkerAccount", { coworkerId, provider: "antigravity", accountSlot: "B" }), { coworkerId, provider: "antigravity", accountSlot: "B" });
        const conversations = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore: store });
        const direct = conversations.createDirect(coworkerId);
        const dispatcher = createCoworkerDispatcher({ dataDir, runtime, roster: () => dispatchRoster, coworkerStore: store, conversationStore: conversations, services: { workspacePath: () => undefined } });
        const message = conversations.postUserMessage(direct.id, { text: "Use the pinned account lane", clientMessageId: "anti-b" });
        dispatcher.dispatchMessage(direct.id, message.id);
        await dispatcher.flush();
        const view = conversations.get(direct.id);
        assert.equal(view.messages.at(-1).text, "dispatcher-answer");
        assert.equal(view.messages[0].delivery[coworkerId].status, "delivered");
        assert.equal(JSON.stringify(view).includes("providerAccountId"), false);
        assert.equal(JSON.stringify(view).includes("provider-account-"), false);
        assert.equal(roster.coworkerBindings[coworkerId].accountNamespace !== undefined, true);
        assert.equal(roster.coworkerBindings[coworkerId].provider, "antigravity");
        assert.equal(coworkerAgentId(coworkerId), roster.coworkerBindings[coworkerId].agentId);
        assert.equal(coworkerCapability(coworkerId), roster.agents[0].capabilities[1]);
    } finally { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); }
});
