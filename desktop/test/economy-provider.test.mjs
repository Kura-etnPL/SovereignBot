import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEconomyProviderFactory } from "../src/main/economy-provider.js";

function fakeAdapter({ delayMs = 0, ignoreCancel = false } = {}) {
    const calls = [];
    let turn = 0;
    let cancelled = false;
    const run = async (request, kind) => {
        calls.push({ kind, model: request.model, budget: request.budget, usage: request.usage });
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (cancelled && !ignoreCancel) { cancelled = false; throw new Error("cancelled by fake provider"); }
        return { text: `fake economy ${++turn}`, continuationRef: `economy-continuation-${turn}` };
    };
    return {
        calls,
        capabilities: () => ["chat", "continuation", "cancellation"],
        models: () => ["fake-model"],
        health: async () => ({ found: true, health: "ready" }),
        start: (request) => run(request, "start"),
        continue: (request) => run(request, "continue"),
        cancel: async () => { cancelled = true; return { cancelled: true }; },
    };
}

test("Economy adapter uses the common six-method contract and strips model-controlled billing fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-economy-provider-"));
    try {
        const adapter = fakeAdapter();
        const factory = createEconomyProviderFactory({
            dataDir: root,
            config: { providers: [{ id: "fixed-local", mode: "fixed-subscription", model: "fake-model" }] },
            adapterFactory: () => adapter,
        });
        const provider = factory.get("fixed-local");
        assert.deepEqual(provider.capabilities(), ["chat", "continuation", "cancellation"]);
        assert.deepEqual(provider.models(), ["fake-model"]);
        assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(provider)), ["constructor", "capabilities", "models", "health", "start", "continue", "cancel"]);
        const first = await provider.start({ taskId: "task-fixed-1", title: "A", instruction: "first", conversation: [], model: "spoof", budget: 999, usage: 999 });
        assert.match(first.continuationRef, /^economy-continuation-/);
        const second = await provider.continue({ taskId: "task-fixed-2", continuationRef: first.continuationRef, title: "B", instruction: "second", conversation: [] });
        assert.equal(second.text, "fake economy 2");
        assert.deepEqual(adapter.calls.map((entry) => entry.model), ["fake-model", "fake-model"]);
        assert.equal(adapter.calls.some((entry) => entry.budget !== undefined || entry.usage !== undefined), false);
        assert.equal(factory.usageSnapshot().spent, 0);
        await factory.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Metered Economy is disabled by default and never calls its adapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-economy-disabled-"));
    try {
        const adapter = fakeAdapter();
        const factory = createEconomyProviderFactory({
            dataDir: root,
            config: { providers: [{ id: "metered-fake", mode: "metered", model: "fake-model" }] },
            adapterFactory: () => adapter,
        });
        assert.equal(factory.available(), false);
        assert.throws(() => factory.get("metered-fake"), /METERED_DISABLED/);
        assert.equal(adapter.calls.length, 0);
        await factory.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Metered trusted reservation enforces budget and releases on cancellation", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-economy-metered-"));
    try {
        const adapter = fakeAdapter({ delayMs: 30 });
        const factory = createEconomyProviderFactory({
            dataDir: root,
            config: {
                providers: [{ id: "metered-fake", mode: "metered", model: "fake-model" }],
                metered: { enabled: true, budget: 5, perRunCap: 3, totalCap: 5 },
            },
            adapterFactory: () => adapter,
        });
        const provider = factory.get("metered-fake");
        const pending = provider.start({ taskId: "task-metered-cancel", instruction: "cancel me" });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await provider.cancel({ taskId: "task-metered-cancel" });
        await assert.rejects(() => pending, /cancelled/i);
        assert.equal(factory.usageSnapshot().spent, 0);
        assert.equal(factory.usageSnapshot().reserved, 0);
        const first = await provider.start({ taskId: "task-metered-1", instruction: "charge one bounded run" });
        assert.equal(first.text, "fake economy 1");
        assert.equal(factory.usageSnapshot().spent, 3);
        await assert.rejects(() => provider.start({ taskId: "task-metered-2", instruction: "over remaining budget" }), /BUDGET_EXHAUSTED/);
        assert.equal(adapter.calls.length, 2);
        const ledger = JSON.parse(readFileSync(join(root, "desktop-state", "economy-usage.json"), "utf8"));
        assert.equal(ledger.schema, "sovereignbot.desktop.economy-usage.v1");
        assert.equal(JSON.stringify(ledger).includes("budget"), false);
        await factory.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Economy rejects a late result after cancellation", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-economy-late-cancel-"));
    try {
        const adapter = fakeAdapter({ delayMs: 30, ignoreCancel: true });
        const factory = createEconomyProviderFactory({
            dataDir: root,
            config: { providers: [{ id: "fixed-late", mode: "fixed-subscription", model: "fake-model" }] },
            adapterFactory: () => adapter,
        });
        const provider = factory.get("fixed-late");
        const pending = provider.start({ taskId: "task-fixed-late", instruction: "cancel me" });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await provider.cancel({ taskId: "task-fixed-late" });
        await assert.rejects(() => pending, /cancelled/i);
        await factory.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Corrupt Economy ledger fails closed instead of resetting spend", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-economy-corrupt-"));
    try {
        const path = join(root, "desktop-state", "economy-usage.json");
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(join(root, "desktop-state"), { recursive: true });
        writeFileSync(path, "not-json", "utf8");
        assert.throws(() => createEconomyProviderFactory({ dataDir: root, config: { providers: [{ id: "fixed", mode: "fixed-subscription" }] }, adapterFactory: () => fakeAdapter() }), /LEDGER_CORRUPT/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
