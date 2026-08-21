import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dryRunPolicy, validatePolicyDraft } from "../src/policy-dry-run.js";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

const draft = {
    repeatWindowMs: 180_000,
    rules: [
        {
            id: "deny-loop",
            effect: "deny",
            match: { category: "harness", operation: "run", repeatAtLeast: 3 },
        },
        {
            id: "allow-echo",
            effect: "allow",
            match: { category: "harness", operation: "run", targetGlob: "echo" },
        },
    ],
};

const action = {
    category: "harness",
    operation: "run",
    target: "echo",
    agentId: "worker",
    taskId: "simulated-task",
};

test("policy draft validation rejects ambiguous or unsupported rule shapes", () => {
    assert.throws(
        () => validatePolicyDraft({ rules: [], typoField: true }),
        /policy draft contains unsupported field: typoField/,
    );
    assert.throws(
        () => validatePolicyDraft({ rules: [{ id: "x", effect: "allow", priority: 1 }] }),
        /rules\[0\] contains unsupported field: priority/,
    );
    assert.throws(
        () => validatePolicyDraft({ rules: [{ id: "x", effect: "maybe" }] }),
        /effect must be allow or deny/,
    );
    assert.throws(
        () => validatePolicyDraft({ rules: [{ id: "x", effect: "allow", match: { magic: "yes" } }] }),
        /unsupported field: magic/,
    );
    assert.throws(
        () => validatePolicyDraft({ rules: [{ id: "x", effect: "allow" }, { id: "x", effect: "deny" }] }),
        /duplicate policy rule id/,
    );
    assert.throws(
        () => validatePolicyDraft({ rules: [{ id: "x", effect: "deny", match: { repeatAtLeast: 0 } }] }),
        /positive integer/,
    );
});

test("dry-run explains deny precedence, thresholds, fail-closed and hard safety without echoing arbitrary secrets", () => {
    const allowed = dryRunPolicy({ policy: draft, action, repeatCount: 2 });
    assert.equal(allowed.decision.allowed, true);
    assert.equal(allowed.decision.ruleId, "allow-echo");
    assert.equal(allowed.explanation[0].ruleId, "deny-loop");
    assert.deepEqual(allowed.explanation[0].failedConditions, ["repeatAtLeast"]);

    const denied = dryRunPolicy({ policy: draft, action, repeatCount: 3 });
    assert.equal(denied.decision.allowed, false);
    assert.equal(denied.decision.ruleId, "deny-loop");

    const failClosed = dryRunPolicy({
        policy: { rules: [] },
        action: { category: "computer", operation: "navigate" },
        repeatCount: 1,
    });
    assert.equal(failClosed.decision.allowed, false);
    assert.equal(failClosed.decision.ruleId, undefined);
    assert.equal(failClosed.explanation.at(-1).stage, "default");

    const secret = "TOP-SECRET-DO-NOT-ECHO";
    const hard = dryRunPolicy({
        policy: draft,
        action: {
            category: "computer",
            operation: "navigate",
            hardDeny: `unsafe because ${secret}`,
            password: secret,
            metadata: { bearerToken: secret },
        },
        repeatCount: 1,
    });
    assert.equal(hard.decision.ruleId, "__safety__");
    assert.equal(hard.decision.hardSafety, true);
    assert.equal(JSON.stringify(hard).includes(secret), false);
});

test("operator policy dry-run cannot mutate live policy, repeat state or audit", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-policy-dry-run-"));
    const runtime = await createRuntime({
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
        policy: structuredClone(draft),
    });

    await runtime.orchestrator.submit({ title: "prime repeat store", requiredCapabilities: ["demo"] });
    const ran = await runtime.orchestrator.runNext();
    assert.equal(ran.status, "completed");

    const repeatPath = join(dataDir, "repeat-state.json");
    const repeatBefore = await readFile(repeatPath, "utf8");
    const auditBefore = await runtime.audit.readAll();
    const policyBefore = JSON.stringify(runtime.config.policy);

    const session = await runtime.operatorSessions.issue({ ttlMs: 60_000 });
    const server = await startServer(runtime);
    const auth = {
        authorization: `Bearer ${session.token}`,
        origin: server.url,
        "content-type": "application/json",
    };
    try {
        const snapshotResponse = await fetch(`${server.url}/operator/policy`, {
            headers: { authorization: `Bearer ${session.token}` },
        });
        assert.equal(snapshotResponse.status, 200);
        const snapshot = await snapshotResponse.json();
        assert.deepEqual(snapshot.active, draft);
        assert.equal(snapshot.editable, false);

        const validateResponse = await fetch(`${server.url}/operator/policy/validate`, {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ policy: snapshot.active }),
        });
        assert.equal(validateResponse.status, 200);
        const validation = await validateResponse.json();
        assert.equal(validation.ok, true);
        assert.equal(validation.ruleCount, 2);

        const dryRunResponse = await fetch(`${server.url}/operator/policy/dry-run`, {
            method: "POST",
            headers: auth,
            body: JSON.stringify({ policy: snapshot.active, action, repeatCount: 3 }),
        });
        assert.equal(dryRunResponse.status, 200);
        const result = await dryRunResponse.json();
        assert.equal(result.decision.allowed, false);
        assert.equal(result.decision.ruleId, "deny-loop");

        const crossOrigin = await fetch(`${server.url}/operator/policy/dry-run`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${session.token}`,
                origin: "https://evil.example",
                "content-type": "application/json",
            },
            body: JSON.stringify({ policy: snapshot.active, action, repeatCount: 3 }),
        });
        assert.equal(crossOrigin.status, 403);

        assert.equal(await readFile(repeatPath, "utf8"), repeatBefore);
        assert.equal((await runtime.audit.readAll()).length, auditBefore.length);
        assert.equal(JSON.stringify(runtime.config.policy), policyBefore);
    }
    finally {
        await server.close();
        await runtime.close();
    }
});
