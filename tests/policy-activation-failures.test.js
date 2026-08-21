import assert from "node:assert/strict";
import test from "node:test";
import { PolicyManager } from "../src/policy-manager.js";
import { PolicyEngine } from "../src/policy.js";
import { policyHash } from "../src/policy-version-store.js";

const previousPolicy = {
    rules: [{ id: "allow", effect: "allow", match: { category: "harness" } }],
};
const nextPolicy = {
    rules: [
        { id: "deny-echo", effect: "deny", match: { category: "harness", targetGlob: "echo" } },
        { id: "allow", effect: "allow", match: { category: "harness" } },
    ],
};
const action = { category: "harness", operation: "run", target: "echo" };
const checks = [{ action, expect: { allowed: false, ruleId: "deny-echo" } }];

function version(id, policy, parentVersionId) {
    return {
        schemaVersion: 1,
        id,
        hash: policyHash(policy),
        createdAt: new Date().toISOString(),
        source: "test",
        parentVersionId,
        policy: structuredClone(policy),
    };
}

function harness({ failCreate, failFirstTargetPointer, failAudit, failClearAfterCommit } = {}) {
    const previous = version("policy_00000000-0000-4000-8000-000000000001", previousPolicy);
    const target = version("policy_00000000-0000-4000-8000-000000000002", nextPolicy, previous.id);
    let active = previous;
    let marker;
    let pointerCalls = 0;
    let clearCalls = 0;
    let createCalls = 0;
    const replacements = [];
    const auditRows = [];
    const store = {
        current: () => structuredClone(active),
        listVersions: async () => [structuredClone(previous), structuredClone(target)],
        readVersion: async (id) => structuredClone(id === target.id ? target : previous),
        createVersion: async () => {
            createCalls += 1;
            if (failCreate)
                throw new Error("version write failed");
            return structuredClone(target);
        },
        beginActivation: async ({ fromVersionId, toVersionId, toHash }) => {
            marker = { transactionId: "policytx_test", fromVersionId, toVersionId, toHash };
            return structuredClone(marker);
        },
        setActive: async (candidate) => {
            pointerCalls += 1;
            if (failFirstTargetPointer && pointerCalls === 1)
                throw new Error("active pointer write failed");
            active = structuredClone(candidate);
        },
        clearTransaction: async () => {
            clearCalls += 1;
            if (failClearAfterCommit)
                throw new Error("marker unlink failed");
            marker = undefined;
        },
    };
    const governor = {
        policy: new PolicyEngine(previousPolicy),
        replacePolicy(engine) {
            replacements.push(engine);
            this.policy = engine;
        },
    };
    const audit = {
        async append(row) {
            if (failAudit)
                throw new Error("audit commit failed");
            auditRows.push(row);
            return row;
        },
    };
    const runtimeConfig = { policy: structuredClone(previousPolicy) };
    const manager = new PolicyManager({ store, governor, audit, runtimeConfig });
    return {
        manager,
        store,
        governor,
        auditRows,
        runtimeConfig,
        previous,
        target,
        replacements,
        get marker() { return marker; },
        get pointerCalls() { return pointerCalls; },
        get clearCalls() { return clearCalls; },
        get createCalls() { return createCalls; },
    };
}

test("dry-run expectation mismatch fails before a policy version is created", async () => {
    const t = harness();
    await assert.rejects(
        () => t.manager.apply({
            policy: nextPolicy,
            checks: [{ action, expect: { allowed: true } }],
        }),
        /decision mismatch/,
    );
    assert.equal(t.createCalls, 0);
    assert.equal(t.pointerCalls, 0);
    assert.equal(t.auditRows.length, 0);
    assert.equal(t.store.current().id, t.previous.id);
});

test("applying the identical active policy is a checked no-op without a duplicate version", async () => {
    const t = harness();
    const result = await t.manager.apply({
        policy: previousPolicy,
        checks: [{ action, expect: { allowed: true, ruleId: "allow" } }],
    });
    assert.equal(result.noChange, true);
    assert.equal(result.active.id, t.previous.id);
    assert.equal(t.createCalls, 0);
    assert.equal(t.pointerCalls, 0);
    assert.equal(t.auditRows.length, 0);
});

test("version persistence failure leaves pointer and runtime policy untouched", async () => {
    const t = harness({ failCreate: true });
    await assert.rejects(
        () => t.manager.apply({ policy: nextPolicy, checks }),
        /version write failed/,
    );
    assert.equal(t.store.current().id, t.previous.id);
    assert.deepEqual(t.runtimeConfig.policy, previousPolicy);
    assert.equal(t.replacements.length, 0);
    assert.equal(t.pointerCalls, 0);
    assert.equal(t.auditRows.length, 0);
});

test("active-pointer write failure leaves runtime policy untouched and clears transaction marker", async () => {
    const t = harness({ failFirstTargetPointer: true });
    await assert.rejects(
        () => t.manager.apply({ policy: nextPolicy, checks }),
        /active pointer write failed/,
    );
    assert.equal(t.store.current().id, t.previous.id);
    assert.deepEqual(t.runtimeConfig.policy, previousPolicy);
    assert.equal(t.replacements.length, 0);
    assert.equal(t.marker, undefined);
    assert.equal(t.auditRows.length, 0);
});

test("audit commit failure rolls pointer and runtime engine back before clearing marker", async () => {
    const t = harness({ failAudit: true });
    await assert.rejects(
        () => t.manager.apply({ policy: nextPolicy, checks }),
        /audit commit failed/,
    );
    assert.equal(t.store.current().id, t.previous.id);
    assert.deepEqual(t.runtimeConfig.policy, previousPolicy);
    assert.equal(t.replacements.length, 2);
    const decision = t.governor.policy.decide(action, { repeatCount: 1 });
    assert.equal(decision.allowed, true);
    assert.equal(t.marker, undefined);
});

test("marker cleanup failure after durable audit commit keeps new policy active and locks further mutation", async () => {
    const t = harness({ failClearAfterCommit: true });
    const result = await t.manager.apply({ policy: nextPolicy, checks });
    assert.equal(result.recoveryPending, true);
    assert.equal(t.store.current().id, t.target.id);
    assert.deepEqual(t.runtimeConfig.policy, nextPolicy);
    assert.equal(t.auditRows.length, 1);
    assert.equal(t.auditRows[0].type, "policy.activated");
    assert.equal(t.auditRows[0].data.transactionId, "policytx_test");
    assert.ok(t.marker);
    const decision = t.governor.policy.decide(action, { repeatCount: 1 });
    assert.equal(decision.allowed, false);
    assert.equal(decision.ruleId, "deny-echo");

    await assert.rejects(
        () => t.manager.rollback({ versionId: t.previous.id }),
        /recovery is pending/,
    );
    assert.equal(t.auditRows.length, 1);
    assert.equal(t.store.current().id, t.target.id);
});
