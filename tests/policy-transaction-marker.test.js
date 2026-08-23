import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";

const allowPolicy = {
    rules: [{ id: "allow", effect: "allow", match: { category: "harness" } }],
};
const denyPolicy = {
    rules: [{ id: "deny", effect: "deny", match: { category: "harness" } }],
};

function config(dataDir) {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [{ id: "worker", name: "Worker", role: "worker", capabilities: [], harness: { kind: "echo" } }],
        policy: allowPolicy,
    };
}

test("policy transaction marker is create-once and cannot be overwritten", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-policy-marker-create-"));
    const runtime = await createRuntime(config(dataDir));
    try {
        const previous = runtime.policyManager.current();
        const target = await runtime.policyVersions.createVersion(denyPolicy, {
            source: "marker-test",
            parentVersionId: previous.id,
        });
        const first = await runtime.policyVersions.beginActivation({
            fromVersionId: previous.id,
            toVersionId: target.id,
            toHash: target.hash,
        });
        await assert.rejects(
            () => runtime.policyVersions.beginActivation({
                fromVersionId: previous.id,
                toVersionId: target.id,
                toHash: target.hash,
            }),
            /already exists/,
        );
        const marker = JSON.parse(await readFile(join(dataDir, "policy-versions", "transaction.json"), "utf8"));
        assert.equal(marker.transactionId, first.transactionId);
        await runtime.policyVersions.clearTransaction();
    }
    finally {
        await runtime.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});

test("policy crash recovery refuses to trust a matching commit record when audit integrity is broken", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-policy-audit-integrity-"));
    let runtime = await createRuntime(config(dataDir));
    try {
        const previous = runtime.policyManager.current();
        const target = await runtime.policyVersions.createVersion(denyPolicy, {
            source: "audit-integrity-test",
            parentVersionId: previous.id,
        });
        const tx = await runtime.policyVersions.beginActivation({
            fromVersionId: previous.id,
            toVersionId: target.id,
            toHash: target.hash,
        });
        await runtime.policyVersions.setActive(target);
        await runtime.audit.append({
            type: "policy.activated",
            actor: "operator-console",
            subject: target.id,
            data: {
                transactionId: tx.transactionId,
                fromVersionId: previous.id,
                toVersionId: target.id,
                hash: target.hash,
            },
        });
        await runtime.close();
        runtime = undefined;

        const auditPath = join(dataDir, "audit.jsonl");
        const rows = (await readFile(auditPath, "utf8")).trimEnd().split(/\r?\n/).map((line) => JSON.parse(line));
        assert.ok(rows.length >= 1);
        rows[0].actor = "tampered-actor";
        await writeFile(auditPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

        await assert.rejects(
            () => createRuntime(config(dataDir)),
            /audit integrity failed|audit hash chain is invalid/,
        );
        assert.ok(await readFile(join(dataDir, "policy-versions", "transaction.json"), "utf8"));
    }
    finally {
        await runtime?.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});
