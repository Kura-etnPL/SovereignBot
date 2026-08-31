import assert from "node:assert/strict";
import test from "node:test";
import {
    modelBindingFromLegacy,
    normalizeModelBinding,
    publicModelBinding,
} from "../src/main/model-binding.js";
import { accountAffinityChanged, accountIsolationNamespace } from "../src/main/provider-account.js";

test("ModelBinding migrates legacy preferences and keeps renderer projection human-level", () => {
    assert.deepEqual(modelBindingFromLegacy("auto"), { profile: "automatic" });
    assert.deepEqual(modelBindingFromLegacy("codex"), { profile: "efficient", provider: "codex", model: "luna" });
    const binding = normalizeModelBinding({
        profile: "custom",
        provider: "antigravity",
        providerAccountId: "account_a",
        model: "model_b",
    });
    assert.deepEqual(publicModelBinding(binding), { profile: "custom" });
    assert.equal(JSON.stringify(publicModelBinding(binding)).includes("account_a"), false);
    assert.equal(JSON.stringify(publicModelBinding(binding)).includes("model_b"), false);
});

test("ModelBinding rejects authority-shaped or unsafe account/model values", () => {
    assert.throws(() => normalizeModelBinding({ profile: "custom", provider: "codex" }), /requires provider and model/);
    assert.throws(() => normalizeModelBinding({ profile: "efficient", providerAccountId: "C:\\private" }), /safe opaque/);
    assert.throws(() => normalizeModelBinding({ profile: "efficient", model: "model/secret" }), /safe opaque/);
});

test("ProviderAccount affinity is one-way and account-specific", () => {
    const first = accountIsolationNamespace("antigravity", "google-account-a");
    const second = accountIsolationNamespace("antigravity", "google-account-b");
    assert.match(first, /^provider-account-[0-9a-f]{32}$/);
    assert.notEqual(first, second);
    assert.equal(first.includes("google-account-a"), false);
    assert.equal(accountAffinityChanged(first, first), false);
    assert.equal(accountAffinityChanged(first, second), true);
});
