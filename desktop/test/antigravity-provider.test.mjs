import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AntigravityProvider, antigravityAccountNamespace, createAntigravityProviderFactory } from "../src/main/antigravity-provider.js";

function fakeDriver({ page = "Antigravity", replies = ["A answer", "A continuation"] } = {}) {
    let text = page, index = 0, url = "https://antigravity.google/task/fake";
    return {
        health: async () => ({ browser: "fake-w3c" }), text: async () => text,
        currentUrl: async () => url,
        snapshot: async () => ({ url, elements: [{ sidecarHandle: "composer", role: "textbox", name: "Task prompt", disabled: false }] }),
        type: async () => {}, key: async () => { text = replies[Math.min(index++, replies.length - 1)]; },
        navigate: async (next) => { url = next; }, close: async () => {},
    };
}

test("Antigravity A/B/C profiles are physically separate and continuity is account scoped", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-antigravity-provider-"));
    const calls = [];
    try {
        const factory = createAntigravityProviderFactory({
            dataDir: root,
            driverFactory: ({ accountNamespace, profileDir, mode }) => {
                calls.push({ accountNamespace, profileDir, mode });
                return fakeDriver({ replies: [`reply-${accountNamespace}`, `follow-${accountNamespace}`] });
            },
        });
        const a = antigravityAccountNamespace("A"), b = antigravityAccountNamespace("B"), c = antigravityAccountNamespace("C");
        const providers = [factory.get(a), factory.get(b), factory.get(c)];
        assert.equal(new Set(providers).size, 3);
        assert.equal(new Set(calls.map((entry) => entry.profileDir)).size, 3);
        assert.equal(calls.every((entry) => entry.mode === "headless"), true);
        const first = await providers[0].start({ instruction: "first", conversation: [] });
        await providers[0].continue({ continuationRef: first.continuationRef, instruction: "second", conversation: [] });
        await assert.rejects(() => providers[1].continue({ continuationRef: first.continuationRef, instruction: "spoof", conversation: [] }), /does not belong/);
        assert.equal(JSON.stringify(readFileSync(join(root, "provider-profiles", "antigravity", a, "provider-state.json"), "utf8")).includes("account-a"), false);
        assert.deepEqual(providers[0].capabilities(), ["chat", "continuation", "cancellation", "account-isolation"]);
        assert.deepEqual(providers[0].models(), ["antigravity"]);
        await factory.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Antigravity never rotates accounts on capacity, and reports sign-in/timeout explicitly", async () => {
    const namespace = antigravityAccountNamespace("A");
    const limited = new AntigravityProvider({ accountNamespace: namespace, driver: fakeDriver({ page: "Capacity limited; try again later" }) });
    assert.equal((await limited.health()).health, "capacity-limited");
    await assert.rejects(() => limited.start({ instruction: "do not send", conversation: [] }), /capacity/i);
    const signedOut = new AntigravityProvider({ accountNamespace: namespace, driver: fakeDriver({ page: "Sign in to continue" }) });
    assert.equal((await signedOut.health()).health, "signed-out");
    await assert.rejects(() => signedOut.start({ instruction: "do not send", conversation: [] }), /Sign in/);
    const timeout = new AntigravityProvider({ accountNamespace: namespace, driver: fakeDriver({ replies: ["Antigravity"] }), timeoutMs: 5, pollMs: 1 });
    await assert.rejects(() => timeout.start({ instruction: "wait", conversation: [] }), /timed out/);
});
