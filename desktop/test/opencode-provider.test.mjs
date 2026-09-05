import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("completed continuations persist across restart and remain account/mode isolated", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-continuity-"));
    try {
        const transport = async (_url, options) => json({ choices: [{ message: { content: JSON.parse(options.body).messages.at(-1).content === "next" ? "resumed" : "first" } }] });
        const make = (accountNamespace, kind = "zen", credentialResolver = () => "fixture") => createOpenCodeProviderAdapter({ providerId: kind === "zen" ? "opencode-zen-free" : "opencode-go", kind, model: kind === "zen" ? "big-pickle" : "kimi-k3", accountNamespace, dataDir: root, credentialResolver, transport });
        const first = await make("account-a").start({ taskId: "persist-1", instruction: "first" });
        const fingerprint = createHash("sha256").update("fixture").digest("hex").slice(0, 32);
        const statePath = join(root, "desktop-state", "provider-profiles", "opencode", "opencode-zen-free", "zen", "big-pickle", `account-a-${fingerprint}.json`);
        assert.match(readFileSync(statePath, "utf8"), /sovereignbot\.opencode\.continuations\.v1/);
        const restarted = make("account-a");
        const resumed = await restarted.continue({ taskId: "persist-2", continuationRef: first.continuationRef, instruction: "next" });
        assert.equal(resumed.text, "resumed");
        await assert.rejects(() => make("account-b").continue({ continuationRef: resumed.continuationRef, instruction: "spoof" }), /INVALID_CONTINUATION/);
        await assert.rejects(() => make("account-a", "go").continue({ continuationRef: resumed.continuationRef, instruction: "wrong mode" }), /INVALID_CONTINUATION/);
        let credential = "fixture";
        const switched = make("account-a", "zen", () => credential);
        const beforeSwitch = await switched.continue({ continuationRef: resumed.continuationRef, instruction: "next" });
        credential = "different-account-token";
        await assert.rejects(() => switched.continue({ continuationRef: beforeSwitch.continuationRef, instruction: "switched account" }), /INVALID_CONTINUATION/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("in-memory account switches and overlapping calls cannot mix contexts", async () => {
    let token = "account-a";
    let release;
    let hold = false;
    const adapter = createOpenCodeProviderAdapter({ model: "big-pickle", credentialResolver: () => token, transport: async () => {
        if (hold) await new Promise(resolve => { release = resolve; });
        return json({ choices: [{ message: { content: "done" } }] });
    } });
    const first = await adapter.start({ instruction: "private-a" });
    token = "account-b";
    await assert.rejects(adapter.continue({ continuationRef: first.continuationRef, instruction: "next" }), { code: "INVALID_CONTINUATION" });
    hold = true;
    const pending = adapter.start({ taskId: "one", instruction: "wait" });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(adapter.start({ taskId: "two", instruction: "overlap" }), { code: "BUSY" });
    release();
    await pending;
    await adapter.close();
});

test("cancelled and failed responses do not persist unfinished continuations", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-continuity-failure-"));
    try {
        const path = join(root, "continuation.json");
        const adapter = createOpenCodeProviderAdapter({ model: "big-pickle", continuationPath: path, credentialResolver: () => "fixture", transport: async (_url, options) => {
            await new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        }, timeoutMs: 5_000 });
        const pending = adapter.start({ taskId: "cancelled", instruction: "unfinished" });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await adapter.cancel({ taskId: "cancelled" });
        await assert.rejects(pending);
        assert.throws(() => readFileSync(path, "utf8"));
        const failed = createOpenCodeProviderAdapter({ model: "big-pickle", continuationPath: path, credentialResolver: () => "fixture", transport: async () => json({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }) });
        await assert.rejects(failed.start({ instruction: "partial" }), { code: "INCOMPLETE_RESPONSE" });
        assert.throws(() => readFileSync(path, "utf8"));
    } finally { rmSync(root, { recursive: true, force: true }); }
});
