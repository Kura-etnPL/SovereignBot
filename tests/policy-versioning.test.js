import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";

function baseConfig(dataDir, policy) {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [{
            id: "worker",
            name: "Worker",
            role: "worker",
            capabilities: ["demo"],
            harness: { kind: "echo" },
        }],
        policy,
    };
}

const allowPolicy = {
    repeatWindowMs: 180_000,
    repeatMaxActiveFingerprints: 10_000,
    rules: [{ id: "allow-harness", effect: "allow", match: { category: "harness" } }],
};

const denyEchoPolicy = {
    repeatWindowMs: 180_000,
    repeatMaxActiveFingerprints: 10_000,
    rules: [
        { id: "deny-echo", effect: "deny", match: { category: "harness", operation: "run", targetGlob: "echo" } },
        { id: "allow-harness", effect: "allow", match: { category: "harness" } },
    ],
};

const echoAction = { category: "harness", operation: "run", target: "echo", agentId: "worker", taskId: "test-task" };

function denyCheck() {
    return [{
        action: echoAction,
        repeatCount: 1,
        expect: { allowed: false, ruleId: "deny-echo" },
    }];
}

function allowCheck() {
    return [{
        action: echoAction,
        repeatCount: 1,
        expect: { allowed: true, ruleId: "allow-harness" },
    }];
}

test("first runtime bootstraps config policy once and later config edits cannot silently replace active policy", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-policy-bootstrap-"));
    let first;
    let second;
    try {
        first = await createRuntime(baseConfig(dataDir, allowPolicy));
        assert.equal(first.policyBootstrapped, true);
        const firstSnapshot = await first.policyManager.snapshot();
        assert.equal(firstSnapshot.versions.length, 1);
        assert.equal(firstSnapshot.active.rules[0].id, "allow-harness");
        const activeId = firstSnapshot.version.id;
        await first.close();
        first = undefined;

        second = await createRuntime(baseConfig(dataDir, { rules: [] }));
        assert.equal(second.policyBootstrapped, false);
        const secondSnapshot = await second.policyManager.snapshot();
        assert.equal(secondSnapshot.version.id, activeId);
        assert.deepEqual(second.config.policy, allowPolicy);
    }
    finally {
        await first?.close();
        await second?.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});

test("policy apply is dry-run checked, changes future decisions, and survives restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-policy-apply-"));
    let runtime;
    let restarted;
    try {
        runtime = await createRuntime(baseConfig(dataDir, allowPolicy));
        await assert.rejects(
            () => runtime.policyManager.apply({ policy: denyEchoPolicy, checks: [] }),
            /requires at least one dry-run check/,
        );
        const applied = await runtime.policyManager.apply({
            policy: denyEchoPolicy,
            checks: denyCheck(),
            actor: "operator-console",
            label: "deny echo test",
        });
        assert.equal(applied.active.active, true);
        const denied = await runtime.orchestrator.governor.authorize(echoAction);
        assert.equal(denied.allowed, false);
        assert.equal(denied.ruleId, "deny-echo");
        const appliedId = applied.active.id;
        await runtime.close();
        runtime = undefined;

        restarted = await createRuntime(baseConfig(dataDir, allowPolicy));
        const snapshot = await restarted.policyManager.snapshot();
        assert.equal(snapshot.version.id, appliedId);
        assert.equal(snapshot.active.rules[0].id, "deny-echo");
    }
    finally {
        await runtime?.close();
        await restarted?.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});

test("rollback activates a verified historical version and persists across restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-policy-rollback-"));
    let runtime;
    let restarted;
    try {
        runtime = await createRuntime(baseConfig(dataDir, allowPolicy));
        const initial = runtime.policyManager.current();
        await runtime.policyManager.apply({ policy: denyEchoPolicy, checks: denyCheck() });
        const rolled = await runtime.policyManager.rollback({ versionId: initial.id, actor: "operator-console" });
        assert.equal(rolled.active.id, initial.id);
        const allowed = await runtime.orchestrator.governor.authorize(echoAction);
        assert.equal(allowed.allowed, true);
        assert.equal(allowed.ruleId, "allow-harness");
        await runtime.close();
        runtime = undefined;

        restarted = await createRuntime(baseConfig(dataDir, denyEchoPolicy));
        assert.equal(restarted.policyManager.current().id, initial.id);
        assert.equal(restarted.config.policy.rules[0].id, "allow-harness");
    }
    finally {
        await runtime?.close();
        await restarted?.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});

test("live activation refuses repeat-store safety parameter changes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-policy-repeat-settings-"));
    const runtime = await createRuntime(baseConfig(dataDir, allowPolicy));
    try {
        await assert.rejects(
            () => runtime.policyManager.apply({
                policy: { ...allowPolicy, repeatWindowMs: 5_000 },
                checks: allowCheck(),
            }),
            /restart-only safety settings/,
        );
        assert.deepEqual(runtime.config.policy, allowPolicy);
    }
    finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});

test("missing active pointer or corrupted active version fails closed instead of falling back to config", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-policy-corrupt-"));
    let runtime = await createRuntime(baseConfig(dataDir, allowPolicy));
    const active = runtime.policyManager.current();
    await runtime.close();
    runtime = undefined;
    try {
        const activePath = join(dataDir, "policy-versions", "active.json");
        await unlink(activePath);
        await assert.rejects(
            () => createRuntime(baseConfig(dataDir, allowPolicy)),
            /active\.json is missing/,
        );

        await writeFile(activePath, `${JSON.stringify({
            schemaVersion: 1,
            versionId: active.id,
            hash: active.hash,
            activatedAt: new Date().toISOString(),
        }, null, 2)}\n`, "utf8");
        const versionPath = join(dataDir, "policy-versions", "versions", `${active.id}.json`);
        const version = JSON.parse(await readFile(versionPath, "utf8"));
        version.policy.rules = [];
        await writeFile(versionPath, `${JSON.stringify(version, null, 2)}\n`, "utf8");
        await assert.rejects(
            () => createRuntime(baseConfig(dataDir, allowPolicy)),
            /hash mismatch/,
        );
    }
    finally {
        await rm(dataDir, { recursive: true, force: true });
    }
});

test("uncommitted activation marker blocks restart, while an audited committed marker is reconciled", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-policy-marker-"));
    let runtime = await createRuntime(baseConfig(dataDir, allowPolicy));
    try {
        const previous = runtime.policyManager.current();
        const target = await runtime.policyVersions.createVersion(denyEchoPolicy, {
            source: "test-crash",
            parentVersionId: previous.id,
        });
        const tx = await runtime.policyVersions.beginActivation({
            fromVersionId: previous.id,
            toVersionId: target.id,
            toHash: target.hash,
        });
        await runtime.policyVersions.setActive(target);
        await runtime.close();
        runtime = undefined;

        await assert.rejects(
            () => createRuntime(baseConfig(dataDir, allowPolicy)),
            /incomplete policy activation/,
        );

        // Simulate the crash window after the durable audit commit but before transaction marker cleanup.
        const auditPath = join(dataDir, "audit.jsonl");
        // Re-open a runtime is intentionally impossible while the marker is uncommitted, so append the
        // exact commit record using the existing hash-chained audit implementation through a temporary
        // recovery runtime is not available. Instead remove the marker and reconstruct the setup cleanly
        // below to exercise the committed reconciliation path independently.
        await unlink(join(dataDir, "policy-versions", "transaction.json"));
        runtime = await createRuntime(baseConfig(dataDir, allowPolicy));
        const committedPrevious = runtime.policyManager.current();
        const committedTarget = await runtime.policyVersions.createVersion(denyEchoPolicy, {
            source: "test-committed-crash",
            parentVersionId: committedPrevious.id,
        });
        const committedTx = await runtime.policyVersions.beginActivation({
            fromVersionId: committedPrevious.id,
            toVersionId: committedTarget.id,
            toHash: committedTarget.hash,
        });
        await runtime.policyVersions.setActive(committedTarget);
        await runtime.audit.append({
            type: "policy.activated",
            actor: "operator-console",
            subject: committedTarget.id,
            data: {
                transactionId: committedTx.transactionId,
                fromVersionId: committedPrevious.id,
                toVersionId: committedTarget.id,
                hash: committedTarget.hash,
            },
        });
        await runtime.close();
        runtime = undefined;

        const recovered = await createRuntime(baseConfig(dataDir, allowPolicy));
        try {
            assert.equal(recovered.policyManager.current().id, committedTarget.id);
            await assert.rejects(
                () => readFile(join(dataDir, "policy-versions", "transaction.json"), "utf8"),
                /ENOENT/,
            );
        }
        finally {
            await recovered.close();
        }
        void tx;
        void auditPath;
    }
    finally {
        await runtime?.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});

test("concurrent apply requests serialize and form an ordered parent chain", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-policy-concurrent-"));
    const runtime = await createRuntime(baseConfig(dataDir, allowPolicy));
    try {
        const initial = runtime.policyManager.current();
        const denyAll = {
            ...allowPolicy,
            rules: [{ id: "deny-all", effect: "deny", match: { category: "harness" } }],
        };
        const denyAllCheck = [{
            action: echoAction,
            expect: { allowed: false, ruleId: "deny-all" },
        }];
        const [first, second] = await Promise.all([
            runtime.policyManager.apply({ policy: denyEchoPolicy, checks: denyCheck(), label: "first" }),
            runtime.policyManager.apply({ policy: denyAll, checks: denyAllCheck, label: "second" }),
        ]);
        assert.equal(first.previousVersionId, initial.id);
        assert.equal(second.previousVersionId, first.active.id);
        assert.equal(runtime.policyManager.current().id, second.active.id);
    }
    finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});
