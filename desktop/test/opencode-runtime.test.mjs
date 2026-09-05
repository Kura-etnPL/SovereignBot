import test from "node:test";
import assert from "node:assert/strict";
import { createOpenCodeAdapterFactory, resolveOpenCodeCredential } from "../src/main/opencode-runtime.js";

test("OpenCode registration is opt-in and matches exact cost modes", () => {
    const factory = createOpenCodeAdapterFactory({ credentialResolver: () => "fixture" });
    assert.equal(factory({ providerId: "other", mode: "free", model: "big-pickle" }), undefined);
    assert.throws(() => factory({ providerId: "opencode-zen-free", mode: "metered", model: "big-pickle" }), /cost boundary/);
    const go = factory({ providerId: "opencode-go", mode: "fixed-subscription", model: "kimi-k3" });
    assert.throws(() => go.start({ instruction: "no spend" }), { code: "BILLING_CONFIRMATION_REQUIRED" });
});

test("OpenCode preserves distinct credentials and reports missing Zen sign-in", async () => {
    assert.equal(resolveOpenCodeCredential({ kind: "zen" }, { env: { SOVEREIGNBOT_OPENCODE_ZEN_KEY: "zen-fixture", SOVEREIGNBOT_OPENCODE_GO_KEY: "go-fixture" } }), "zen-fixture");
    const free = createOpenCodeAdapterFactory({ credentialResolver: () => undefined })({ providerId: "opencode-zen-free", mode: "free", model: "big-pickle" });
    assert.equal((await free.health()).health, "signed-out");
});
