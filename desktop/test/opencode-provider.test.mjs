import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    OPENCODE_ENDPOINTS, OPENCODE_ZEN_FREE_MODELS, OPENCODE_GO_CHAT_MODELS,
    createOpenCodeProviderAdapter,
} from "../src/main/opencode-provider.js";
import { createEconomyProviderFactory } from "../src/main/economy-provider.js";

const json = (value) => new Response(JSON.stringify({ ...value, choices: value.choices?.map(choice => ({ finish_reason: "stop", ...choice })) }), { status: 200 });

test("Zen free adapter pins endpoint/model and has no paid fallback", async () => {
    const calls = [];
    const adapter = createOpenCodeProviderAdapter({ kind: "zen", model: "big-pickle", credentialResolver: () => "secret-token", transport: async (url, options) => { calls.push({ url, options }); return json({ choices: [{ message: { content: "hello" } }] }); } });
    const result = await adapter.start({ taskId: "task-1", instruction: "hi" });
    assert.equal(calls[0].url, OPENCODE_ENDPOINTS.zen);
    assert.equal(JSON.parse(calls[0].options.body).model, "big-pickle");
    assert.equal(result.text, "hello");
    assert.deepEqual(adapter.models(), OPENCODE_ZEN_FREE_MODELS);
    assert.throws(() => createOpenCodeProviderAdapter({ kind: "zen", model: "gpt-5.6-luna", credentialResolver: () => "x" }), /MODEL_NOT_ALLOWED/);
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
});

test("Go adapter uses only the documented chat-completions endpoint", async () => {
    let call;
    const adapter = createOpenCodeProviderAdapter({ kind: "go", model: "kimi-k3", credentialResolver: () => "go-secret", transport: async (url, options) => { call = { url, options }; return json({ choices: [{ message: { content: "go reply" } }] }); } });
    const first = await adapter.start({ taskId: "go-1", instruction: "one" });
    const second = await adapter.continue({ taskId: "go-1", continuationRef: first.continuationRef, instruction: "two" });
    assert.equal(call.url, OPENCODE_ENDPOINTS.go);
    assert.equal(JSON.parse(call.options.body).model, "kimi-k3");
    assert.equal(second.text, "go reply");
    assert.deepEqual(adapter.models(), OPENCODE_GO_CHAT_MODELS);
});

test("continuations are isolated and cancellation aborts the active transport", async () => {
    let seenSignal;
    const adapter = createOpenCodeProviderAdapter({ kind: "zen", model: "big-pickle", credentialResolver: () => "x", transport: async (_url, options) => {
        seenSignal = options.signal;
        await new Promise((resolve, reject) => { options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
        return json({ choices: [{ message: { content: "never" } }] });
    }, timeoutMs: 5_000 });
    const pending = adapter.start({ taskId: "cancel-me", instruction: "wait" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await adapter.cancel({ taskId: "cancel-me" });
    await assert.rejects(pending, /CANCELLED|UPSTREAM/);
    assert.equal(seenSignal.aborted, true);
    await assert.rejects(() => adapter.continue({ continuationRef: "other-adapter-ref", instruction: "no" }), /INVALID_CONTINUATION/);
});

test("economy factory passes bounded conversation sender/text into the adapter contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-economy-"));
    try {
        let body;
        const adapter = createOpenCodeProviderAdapter({ kind: "zen", model: "big-pickle", credentialResolver: () => "secret", transport: async (_url, options) => { body = JSON.parse(options.body); return json({ choices: [{ message: { content: "ok" } }] }); } });
        const factory = createEconomyProviderFactory({ dataDir: root, config: { providers: [{ id: "opencode", model: "big-pickle" }] }, adapterFactory: () => adapter });
        const result = await factory.get("opencode").start({ taskId: "economy-task", instruction: "next", conversation: [{ sender: "user", text: "context" }] });
        assert.equal(result.text, "ok");
        assert.deepEqual(body.messages.map((entry) => entry.content), ["context", "next"]);
        await factory.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("incomplete responses and credential failures never leak or publish success", async () => {
    for (const finish_reason of ["length", "tool_calls", null]) {
        const adapter = createOpenCodeProviderAdapter({ model: "big-pickle", credentialResolver: () => "secret", transport: async () => json({ choices: [{ finish_reason, message: { content: "partial" } }] }) });
        await assert.rejects(adapter.start({ instruction: "test" }), { code: "INCOMPLETE_RESPONSE" });
    }
    const adapter = createOpenCodeProviderAdapter({ model: "big-pickle", credentialResolver: () => { throw new Error("secret-token"); } });
    await assert.rejects(adapter.start({ instruction: "test" }), error => error.code === "SIGNED_OUT" && !error.message.includes("secret-token"));
    await adapter.close();
    await assert.rejects(adapter.start({ instruction: "test" }), { code: "UNAVAILABLE" });
});
