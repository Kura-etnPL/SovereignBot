import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatGPTWebProvider } from "../src/main/chatgpt-web-provider.js";
import { accountIsolationNamespace } from "../src/main/provider-account.js";

function fakeDriver({ page = "ChatGPT", replies = ["Sol answer", "Sol continuation"] } = {}) {
    let text = page;
    let index = 0;
    let url = "https://chatgpt.com/c/fake";
    return {
        health: async () => ({ browser: "fake-w3c" }),
        text: async () => text,
        currentUrl: async () => url,
        snapshot: async () => ({ url, elements: [{ sidecarHandle: "composer", role: "textbox", name: "Message ChatGPT", disabled: false }] }),
        type: async () => {},
        key: async () => { text = replies[Math.min(index++, replies.length - 1)]; },
        navigate: async (next) => { url = next; },
        close: async () => {},
    };
}

test("ChatGPT Web provider exposes only safe capabilities/models and keeps continuity account-scoped", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-chatgpt-web-"));
    try {
        const accountA = accountIsolationNamespace("chatgpt-web", "account-a");
        const accountB = accountIsolationNamespace("chatgpt-web", "account-b");
        const providerA = new ChatGPTWebProvider({ accountNamespace: accountA, profileDir: join(root, accountA), driver: fakeDriver() });
        const providerB = new ChatGPTWebProvider({ accountNamespace: accountB, profileDir: join(root, accountB), driver: fakeDriver() });
        assert.deepEqual(providerA.capabilities(), ["chat", "continuation", "cancellation"]);
        assert.deepEqual(providerA.models(), ["sol"]);
        assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(providerA)).filter((key) => key !== "constructor"), ["capabilities", "models", "health", "start", "continue", "cancel"]);
        const first = await providerA.start({ instruction: "first", conversation: [] });
        assert.equal(typeof first.continuationRef, "string");
        assert.equal(JSON.stringify(first).includes("fake"), false);
        await assert.rejects(() => providerB.continue({ continuationRef: first.continuationRef, instruction: "spoof", conversation: [] }), /does not belong/);
        const second = await providerA.continue({ continuationRef: first.continuationRef, instruction: "second", conversation: [] });
        assert.equal(typeof second.continuationRef, "string");
        assert.equal(await providerA.health().then((result) => result.health), "ready");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("ChatGPT Web health classifies sign-in and rate-limit pages without exposing browser state", async () => {
    const namespace = accountIsolationNamespace("chatgpt-web", "account");
    const signedOut = new ChatGPTWebProvider({ accountNamespace: namespace, driver: fakeDriver({ page: "Log in to continue" }) });
    const limited = new ChatGPTWebProvider({ accountNamespace: namespace, driver: fakeDriver({ page: "Too many requests; try again later" }) });
    assert.deepEqual((await signedOut.health()).auth, { state: "signed-out" });
    assert.equal((await signedOut.health()).health, "signed-out");
    assert.equal((await limited.health()).health, "capacity-limited");
    await assert.rejects(() => signedOut.start({ instruction: "do not send", conversation: [] }), /Sign in/);
});

test("ChatGPT Web response timeout is explicit and cannot publish an empty or stale answer", async () => {
    const namespace = accountIsolationNamespace("chatgpt-web", "timeout");
    const driver = fakeDriver({ replies: ["ChatGPT"] });
    const provider = new ChatGPTWebProvider({ accountNamespace: namespace, driver, timeoutMs: 5, pollMs: 1 });
    await assert.rejects(() => provider.start({ instruction: "wait", conversation: [] }), /timed out/);
});
