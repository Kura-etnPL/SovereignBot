import assert from "node:assert/strict";
import test from "node:test";
import { ChatGPTWebHarness, registerAgentChatGPTWebAdapter } from "../src/chatgpt-web-harness.js";
import { providerContinuityRefs, publicTaskView } from "../src/task-view.js";

test("ChatGPT Web harness strips spoofed private fields and pins continuation to the same agent", async () => {
    const agent = { id: "chatgpt-test", harness: { kind: "chatgpt-web", model: "sol" } };
    const calls = [];
    registerAgentChatGPTWebAdapter(agent, {
        async start(request) { calls.push(request); return { text: "safe answer", continuationRef: "continuation-a" }; },
        async continue(request) { calls.push(request); return { text: "continued", continuationRef: "continuation-a" }; },
        async cancel() {},
        async health() { return { health: "ready" }; },
        capabilities() { return ["chat"]; },
        models() { return ["sol"]; },
    });
    const state = {};
    const harness = new ChatGPTWebHarness(agent);
    const context = (task) => ({ task, agent, signal: new AbortController().signal, updateHarnessState: async (patch) => Object.assign(state, patch) });
    const first = await harness.run(context({ title: "A", input: { instruction: "hello", conversation: [{ sender: "user", text: "hi", conversationId: "spoof" }], conversationId: "product-id", profileDir: "C:\\secret" } }));
    assert.deepEqual(first, { ok: true, output: { text: "safe answer" } });
    assert.deepEqual(state, { kind: "chatgpt-web", continuationRef: "continuation-a" });
    assert.equal(Object.hasOwn(calls[0], "conversationId"), false);
    assert.equal(Object.hasOwn(calls[0], "profileDir"), false);
    assert.equal(calls[0].instruction.includes("conv_secret"), false);
    const resumed = await harness.run(context({ title: "B", harnessState: state, input: { instruction: "continue", conversation: [] } }));
    assert.equal(resumed.output.text, "continued");
    assert.equal(calls[1].continuationRef, "continuation-a");
    const visible = publicTaskView({ id: "task-a", status: "running", harnessState: state, result: { text: "x", continuationRef: "continuation-a" } });
    assert.equal(visible.hasResumableSession, true);
    assert.equal(JSON.stringify(visible).includes("continuation-a"), false);
    assert.deepEqual(providerContinuityRefs([{ harnessState: state }]), new Set(["continuation-a"]));
    registerAgentChatGPTWebAdapter(agent, undefined);
});

test("ChatGPT Web harness rejects adapter private output and never silently downgrades", async () => {
    const agent = { id: "chatgpt-private", harness: { kind: "chatgpt-web", model: "sol" } };
    registerAgentChatGPTWebAdapter(agent, {
        async start() { return { text: "bad", conversationId: "private" }; },
        async continue() { return { text: "bad" }; },
        async cancel() {},
        health() { return {}; },
        capabilities() { return []; },
        models() { return ["sol"]; },
    });
    const result = await new ChatGPTWebHarness(agent).run({ task: { title: "x", input: { instruction: "x" } }, agent, signal: new AbortController().signal });
    assert.equal(result.ok, false);
    assert.match(result.error, /private result field/);
    registerAgentChatGPTWebAdapter(agent, undefined);
});

test("ChatGPT Web abort wins a late provider response and invokes adapter cancellation", async () => {
    const agent = { id: "chatgpt-cancel", harness: { kind: "chatgpt-web", model: "sol" } };
    let cancelled = false;
    registerAgentChatGPTWebAdapter(agent, {
        start: () => new Promise((resolve) => setTimeout(() => resolve({ text: "stale", continuationRef: "late" }), 40)),
        continue: async () => ({ text: "unused" }),
        cancel: async () => { cancelled = true; },
        health() { return {}; },
        capabilities() { return []; },
        models() { return ["sol"]; },
    });
    const controller = new AbortController();
    const pending = new ChatGPTWebHarness(agent).run({ task: { title: "x", input: { instruction: "x" } }, agent, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const result = await pending;
    assert.deepEqual(result, { ok: false, error: "ChatGPT Web task cancelled" });
    assert.equal(cancelled, true);
    registerAgentChatGPTWebAdapter(agent, undefined);
});
