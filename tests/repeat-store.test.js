import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { Governor } from "../src/governor.js";
import { PolicyEngine } from "../src/policy.js";
import { RepeatStore } from "../src/repeat-store.js";

const action = {
    agentId: "worker",
    category: "computer",
    operation: "navigate",
    target: "https://example.test/private?token=VERY-SENSITIVE-TARGET",
    taskId: "task-1",
};

async function dir(prefix) {
    return mkdtemp(join(tmpdir(), prefix));
}

test("repeat count survives runtime/store restart and persists no raw target", async () => {
    const dataDir = await dir("sovereign-repeat-restart-");
    let now = 10_000;
    const first = new RepeatStore(dataDir, { windowMs: 60_000, now: () => now });
    await first.init();
    assert.equal(await first.observe(action), 1);
    assert.equal(await first.observe(action), 2);

    const second = new RepeatStore(dataDir, { windowMs: 60_000, now: () => now });
    await second.init();
    assert.equal(await second.observe(action), 3);

    const raw = await readFile(join(dataDir, "repeat-state.json"), "utf8");
    assert.equal(raw.includes("VERY-SENSITIVE-TARGET"), false);
    assert.equal(raw.includes("example.test"), false);
    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed.entries);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^[0-9a-f]{64}$/);
});

test("expired attempts are pruned before the next count", async () => {
    const dataDir = await dir("sovereign-repeat-expiry-");
    let now = 1_000;
    const store = new RepeatStore(dataDir, { windowMs: 100, now: () => now });
    await store.init();
    assert.equal(await store.observe(action), 1);
    now += 50;
    assert.equal(await store.observe(action), 2);
    now += 101;
    assert.equal(await store.observe(action), 1);
});

test("concurrent identical observations receive monotonic unique counts", async () => {
    const dataDir = await dir("sovereign-repeat-concurrent-");
    const store = new RepeatStore(dataDir, { windowMs: 60_000, now: () => 5_000 });
    await store.init();
    const counts = await Promise.all(Array.from({ length: 8 }, () => store.observe(action)));
    assert.deepEqual([...counts].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("active fingerprint bound fails closed without evicting active safety state", async () => {
    const dataDir = await dir("sovereign-repeat-bound-");
    const store = new RepeatStore(dataDir, {
        windowMs: 60_000,
        maxActiveFingerprints: 1,
        now: () => 5_000,
    });
    await store.init();
    assert.equal(await store.observe(action), 1);
    await assert.rejects(
        () => store.observe({ ...action, target: "https://different.example/" }),
        /max active fingerprints/,
    );
    assert.equal(await store.observe(action), 2);
});

test("governor fails closed when durable repeat persistence fails", async () => {
    const policy = new PolicyEngine({
        rules: [{ id: "allow", effect: "allow", match: { category: "computer" } }],
    });
    const audited = [];
    const governor = new Governor(policy, { append: async (row) => audited.push(row) }, {
        observe: async () => { throw new Error("disk unavailable"); },
    });
    const decision = await governor.authorize(action);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /repeat safety evaluation failed: disk unavailable/);
    assert.equal(audited.at(-1).type, "action.denied");
});

test("durable count preserves repeatAtLeast threshold semantics", async () => {
    const dataDir = await dir("sovereign-repeat-policy-");
    const store = new RepeatStore(dataDir, { windowMs: 60_000, now: () => 9_000 });
    await store.init();
    const policy = new PolicyEngine({
        rules: [
            { id: "stop-three", effect: "deny", match: { category: "computer", repeatAtLeast: 3 } },
            { id: "allow", effect: "allow", match: { category: "computer" } },
        ],
    });
    const audit = { append: async () => {} };
    const governor = new Governor(policy, audit, store);
    assert.equal((await governor.authorize(action)).allowed, true);
    assert.equal((await governor.authorize(action)).allowed, true);
    const third = await governor.authorize(action);
    assert.equal(third.allowed, false);
    assert.equal(third.ruleId, "stop-three");
    assert.equal(third.repeatCount, 3);
});

test("config validates repeat window and active fingerprint bound", async () => {
    const dataDir = await dir("sovereign-repeat-config-");
    const path = join(dataDir, "config.json");
    const base = {
        dataDir: join(dataDir, "data"),
        agents: [{ id: "worker", name: "Worker", capabilities: [], harness: { kind: "echo" } }],
        policy: { rules: [] },
    };

    await writeFile(path, JSON.stringify({ ...base, policy: { rules: [], repeatWindowMs: 0 } }));
    await assert.rejects(() => loadConfig(path), /repeatWindowMs must be a positive integer/);

    await writeFile(path, JSON.stringify({ ...base, policy: { rules: [], repeatMaxActiveFingerprints: -1 } }));
    await assert.rejects(() => loadConfig(path), /repeatMaxActiveFingerprints must be a positive integer/);
});
