import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOperatorFacade, OPERATOR_ACTORS } from "../src/operator-facade.js";
import { createRuntime } from "../src/runtime.js";

function runtimeConfig(dataDir) {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [
            { id: "echo", name: "Echo", role: "worker", capabilities: ["demo"], harness: { kind: "echo" } },
            { id: "reviewer", name: "Reviewer", role: "reviewer", capabilities: ["review"], harness: { kind: "echo" } },
        ],
        policy: {
            rules: [{ id: "allow", effect: "allow", match: { category: "harness" } }],
        },
    };
}

async function withRuntimeAndFacade(actor, run) {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-operator-facade-"));
    let runtime;
    try {
        runtime = await createRuntime(runtimeConfig(dataDir));
        const facade = createOperatorFacade(runtime, { actor });
        await run(facade, runtime);
    }
    finally {
        await runtime?.close();
        await rm(dataDir, { recursive: true, force: true });
    }
}

test("facade refuses unknown actors at construction", async () => {
    await withRuntimeAndFacade(OPERATOR_ACTORS.desktop, async (_facade, runtime) => {
        assert.throws(() => createOperatorFacade(runtime, { actor: "attacker-chosen" }), /unknown operator actor/);
        assert.throws(() => createOperatorFacade(runtime, { actor: "" }), /unknown operator actor/);
    });
});

test("overview projects public task view and passive computer status without raw continuity", async () => {
    await withRuntimeAndFacade(OPERATOR_ACTORS.desktop, async (facade, runtime) => {
        const submitted = await runtime.orchestrator.submit({ title: "facade overview" });
        await runtime.orchestrator.runUntilIdle();
        const overview = await facade.getOverview();
        assert.equal(Array.isArray(overview.tasks), true);
        assert.equal(Array.isArray(overview.agents), true);
        assert.equal(Array.isArray(overview.computers), true);
        assert.equal(overview.audit.ok, true);
        const view = overview.tasks.find((task) => task.id === submitted.id);
        assert.equal(view.status, "completed");
        assert.equal(Object.hasOwn(view, "harnessState"), false);
    });
});

test("audit and memory reads are clamped projections of durable state", async () => {
    await withRuntimeAndFacade(OPERATOR_ACTORS.desktop, async (facade) => {
        const audit = await facade.getAudit({ limit: 5 });
        assert.ok(JSON.stringify(audit).length > 0);
        const memory = await facade.searchMemory({ query: "nothing-matches-this" });
        assert.deepEqual(memory, []);
        const workers = await facade.getWorkers();
        assert.ok(Array.isArray(workers));
    });
});

test("policy mutations record the facade's fixed actor, not a caller-supplied one", async () => {
    await withRuntimeAndFacade(OPERATOR_ACTORS.desktop, async (facade) => {
        const snapshot = await facade.getPolicy();
        const currentVersionId = snapshot.version?.id;
        assert.ok(currentVersionId, "policy snapshot exposes the active version id");
        const nextPolicy = {
            rules: [{ id: "allow-all-facade-test", effect: "allow", match: { category: "harness" } }],
            repeatWindowMs: 180000,
        };
        const applied = await facade.applyPolicy({
            policy: nextPolicy,
            label: "facade-test",
            checks: [{
                action: { category: "harness", operation: "run", target: "echo" },
                repeatCount: 1,
                expect: { allowed: true, ruleId: "allow-all-facade-test" },
            }],
        });
        assert.ok(applied.active?.id ?? applied.versionId);
        // A spoofed principal in the payload must not influence the recorded actor.
        await facade.rollbackPolicy({ versionId: currentVersionId, actorId: "spoofed" });
        const auditRows = await facade.getAudit({ limit: 500 });
        const mutationActors = JSON.stringify(auditRows);
        assert.equal(mutationActors.includes("spoofed"), false);
        assert.match(mutationActors, /desktop-operator/);

        const validation = await facade.validatePolicy(nextPolicy);
        assert.equal(validation.ok, true);
        const dryRun = await facade.dryRunPolicy({
            policy: nextPolicy,
            action: { category: "harness", operation: "run", target: "echo" },
        });
        assert.equal(dryRun.decision.allowed, true);
    });
});

test("supplySecret failures surface a sanitized error without the plaintext", async () => {
    await withRuntimeAndFacade(OPERATOR_ACTORS.console, async (facade) => {
        await assert.rejects(
            () => facade.supplySecret("missing-agent", "missing-request", "PLAINTEXT-CANARY"),
            (error) => {
                assert.match(error.message, /secret supply failed/);
                assert.equal(error.message.includes("PLAINTEXT-CANARY"), false);
                return true;
            },
        );
    });
});
