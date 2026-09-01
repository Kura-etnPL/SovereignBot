import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../../src/runtime.js";
import { buildPolicyRules } from "../src/main/provider-roster.js";
import { ChatGPTWebProvider } from "../src/main/chatgpt-web-provider.js";
import { accountIsolationNamespace } from "../src/main/provider-account.js";

function fakeBrowser() {
    let text = "ChatGPT";
    let turn = 0;
    let url = "https://chatgpt.com/c/fake";
    return {
        health: async () => ({ browser: "fake-w3c" }),
        text: async () => text,
        currentUrl: async () => url,
        snapshot: async () => ({ url, elements: [{ sidecarHandle: "composer", role: "textbox", name: "Message ChatGPT", disabled: false }] }),
        type: async () => {},
        key: async () => { text = `fake Sol answer ${++turn}`; },
        navigate: async (next) => { url = next; },
        close: async () => {},
    };
}

test("production Core runtime canary routes ChatGPT Web / Sol through the W3C-shaped adapter boundary", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sb-chatgpt-canary-"));
    const namespace = accountIsolationNamespace("chatgpt-web", "canary-account");
    const agent = { id: "chatgpt-coworker", name: "ChatGPT Web / Sol", role: "worker", capabilities: ["general"], harness: { kind: "chatgpt-web", model: "sol", accountNamespace: namespace } };
    const adapter = new ChatGPTWebProvider({ accountNamespace: namespace, profileDir: join(dataDir, "provider-profile"), driver: fakeBrowser() });
    const runtime = await createRuntime({
        dataDir,
        agents: [
            { id: "planner", name: "Planner", role: "supervisor", capabilities: ["planning"], harness: { kind: "echo" } },
            agent,
        ],
        policy: { repeatWindowMs: 180000, repeatMaxActiveFingerprints: 1000, rules: buildPolicyRules([agent, { id: "planner", role: "supervisor", harness: { kind: "echo" } }]) },
    }, { chatgptWebAdapterResolver: () => adapter });
    try {
        const plan = await runtime.orchestrator.createPlan({ title: "canary", ownerAgentId: "planner", input: {} });
        const trustedContext = { kind: "local", workspaceId: "ws-canary", cwd: dataDir };
        const first = await runtime.orchestrator.delegateTrusted(plan.id, { title: "A", requiredCapabilities: ["general"], preferredAgentId: agent.id, input: { instruction: "first" } }, trustedContext, "planner");
        await runtime.orchestrator.runUntilIdle();
        const storedFirst = (await runtime.orchestrator.listTasks()).find((task) => task.id === first.id);
        assert.equal(storedFirst.status, "completed");
        assert.equal(storedFirst.result.text, "fake Sol answer 1");
        assert.equal(storedFirst.harnessState.kind, "chatgpt-web");
        assert.match(storedFirst.harnessState.continuationRef, /^continuation-/);
        const second = await runtime.orchestrator.delegateTrusted(plan.id, { title: "B", requiredCapabilities: ["general"], preferredAgentId: agent.id, harnessState: storedFirst.harnessState, input: { instruction: "second" } }, trustedContext, "planner");
        await runtime.orchestrator.runUntilIdle();
        const storedSecond = (await runtime.orchestrator.listTasks()).find((task) => task.id === second.id);
        assert.equal(storedSecond.status, "completed");
        assert.equal(storedSecond.result.text, "fake Sol answer 2");
        assert.equal(storedSecond.assignedAgentId, agent.id);
    } finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});
