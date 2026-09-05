import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatGPTWebProvider, createChatGPTWebProviderFactory } from "../src/main/chatgpt-web-provider.js";
import { accountIsolationNamespace } from "../src/main/provider-account.js";

function fakeDriver({ page = "ChatGPT", replies = ["Sol answer", "Sol continuation"] } = {}) {
    let text = page;
    let index = 0;
    let url = "https://chatgpt.com/c/fake";
    return {
        health: async () => ({ browser: "fake-w3c" }),
        text: async () => text,
        currentUrl: async () => url,
        chatGPTPage: async () => ({ schema: page ? "sovereignbot.chatgpt-page.v1" : "loading", url, authenticated: !page.startsWith("Log in"), challenge: /human|人类/.test(page), capacityLimited: page.startsWith("Too many requests"), chatMode: true, selectedModel: "sol", availableModels: ["sol"], assistantMessages: index && text !== page ? [{ id: `reply-${index}`, text, complete: true }] : [] }),
        snapshot: async () => ({ url, elements: [{ sidecarHandle: "composer", role: "textbox", name: "Message ChatGPT", disabled: false }] }),
        type: async () => {},
        key: async () => { text = replies[Math.min(index++, replies.length - 1)]; url = "https://chatgpt.com/c/fake"; },
        navigate: async (next) => { url = next; },
        close: async () => {},
    };
}

test("ChatGPT Web provider exposes only safe capabilities/models and keeps continuity account-scoped", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-chatgpt-web-"));
    try {
        const accountA = accountIsolationNamespace("chatgpt-web", "account-a");
        const accountB = accountIsolationNamespace("chatgpt-web", "account-b");
        const providerA = new ChatGPTWebProvider({ accountNamespace: accountA, profileDir: join(root, accountA), driver: fakeDriver({ replies: ["first reply", "second reply", "other coworker reply", "original coworker resumed"] }), timeoutMs: 100, pollMs: 1 });
        const providerB = new ChatGPTWebProvider({ accountNamespace: accountB, profileDir: join(root, accountB), driver: fakeDriver() });
        assert.deepEqual(providerA.capabilities(), ["chat", "continuation", "cancellation"]);
        await providerA.health();
        assert.deepEqual(providerA.models(), ["sol"]);
        assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(providerA)).filter((key) => key !== "constructor"), ["capabilities", "models", "health", "start", "continue", "openLogin", "close", "cancel"]);
        const first = await providerA.start({ instruction: "first", conversation: [] });
        assert.equal(typeof first.continuationRef, "string");
        assert.equal(JSON.stringify(first).includes("fake"), false);
        await assert.rejects(() => providerB.continue({ continuationRef: first.continuationRef, instruction: "spoof", conversation: [] }), /does not belong/);
        const second = await providerA.continue({ continuationRef: first.continuationRef, instruction: "second", conversation: [] });
        assert.equal(typeof second.continuationRef, "string");
        await providerA.start({ instruction: "another coworker", conversation: [] });
        await providerA.continue({ continuationRef: first.continuationRef, instruction: "original coworker still resumes", conversation: [] });
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

test("login switches the single account driver and factory closes its owned instance", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-chatgpt-login-"));
    const namespace = accountIsolationNamespace("chatgpt-web", "login");
    const events = [];
    const factory = createChatGPTWebProviderFactory({ dataDir: root, driverFactory: ({ mode }) => {
        events.push(`create:${mode}`);
        return { ...fakeDriver(), close: async () => events.push(`close:${mode}`), navigate: async () => events.push(`navigate:${mode}`) };
    } });
    try {
        factory.get(namespace);
        await factory.openLogin(namespace);
        assert.deepEqual(events, ["create:headless", "close:headless", "create:login", "navigate:login"]);
        await factory.close();
        assert.equal(events.at(-1), "close:login");
        await assert.rejects(factory.get(namespace).start({ instruction: "closed" }), { code: "UNAVAILABLE" });
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("blank, challenge and unrelated pages are never reported ready or sent prompts", async () => {
    const namespace = accountIsolationNamespace("chatgpt-web", "not-ready");
    for (const page of ["", "Verify you are human", "验证您是人类"]) {
        const driver = fakeDriver({ page });
        let sent = false;
        driver.type = async () => { sent = true; };
        const provider = new ChatGPTWebProvider({ accountNamespace: namespace, driver });
        assert.equal((await provider.health()).health, "unavailable");
        await assert.rejects(provider.start({ instruction: "must not send" }), { code: "UNAVAILABLE" });
        assert.equal(sent, false);
    }
    for (const snapshot of [{ url: "about:blank", elements: [] }, { url: "https://chatgpt.com/", elements: [] }]) {
        const driver = fakeDriver();
        driver.snapshot = async () => snapshot;
        const provider = new ChatGPTWebProvider({ accountNamespace: namespace, driver });
        assert.equal((await provider.health()).health, "unavailable");
        await assert.rejects(provider.start({ instruction: "must not send" }), { code: "UNAVAILABLE" });
    }
});

test("cancel rejects active execution and holds the busy lock until it unwinds", async () => {
    const namespace = accountIsolationNamespace("chatgpt-web", "cancel");
    const driver = fakeDriver();
    let entered;
    const typing = new Promise(resolve => { entered = resolve; });
    let release;
    driver.type = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
    const keys = [];
    driver.key = async ({ key }) => { keys.push(key); };
    const provider = new ChatGPTWebProvider({ accountNamespace: namespace, driver });
    const active = provider.start({ instruction: "cancel me" });
    const rejected = assert.rejects(active, { code: "CANCELLED" });
    await typing;
    await provider.cancel();
    await assert.rejects(provider.start({ instruction: "cannot overlap" }), { code: "BUSY" });
    release();
    await rejected;
    assert.deepEqual(keys, ["Escape"]);
});

test("Work and unconfirmed model selection fail before typing", async () => {
    for (const override of [{ chatMode: false }, { selectedModel: "latest" }]) {
        const driver = fakeDriver();
        const page = driver.chatGPTPage;
        driver.chatGPTPage = async () => ({ ...await page(), ...override });
        let typed = false;
        driver.type = async () => { typed = true; };
        const provider = new ChatGPTWebProvider({ accountNamespace: accountIsolationNamespace("chatgpt-web", "mode-boundary"), driver });
        await assert.rejects(provider.start({ instruction: "test", model: "sol" }), /Chat mode|selector/);
        assert.equal(typed, false);
    }
});

test("only a new complete assistant message is returned, never page echo or partial output", async () => {
    const driver = fakeDriver();
    let sent = false;
    let polls = 0;
    const page = driver.chatGPTPage;
    const key = driver.key;
    driver.key = async args => { sent = true; await key(args); };
    driver.text = async () => "ChatGPT sidebar and user prompt echo";
    driver.chatGPTPage = async () => ({ ...await page(), generating: sent && ++polls < 3,
        assistantMessages: sent ? [{ id: "new", text: polls < 3 ? "partial" : "complete answer", complete: polls >= 3 }] : [{ id: "old", text: "stale", complete: true }] });
    const provider = new ChatGPTWebProvider({ accountNamespace: accountIsolationNamespace("chatgpt-web", "assistant-only"), driver, timeoutMs: 100, pollMs: 1 });
    assert.equal((await provider.start({ instruction: "prompt" })).text, "complete answer");
    assert.ok(polls >= 4);
});
