import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { inspectCrashRecovery } from "../src/crash-recovery.js";
import { createRuntime } from "../src/runtime.js";

const UUID = "22222222-2222-4222-8222-222222222222";

function config(dataDir) {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [{ id: "echo", name: "Echo", role: "worker", capabilities: ["demo"], harness: { kind: "echo" } }],
        policy: { rules: [{ id: "allow", effect: "allow", match: { category: "harness" } }] },
    };
}

async function write(path, value) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value, "utf8");
}

test("recovery report never echoes attacker-controlled unknown filenames or policy transaction kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-recovery-redaction-"));
    let runtime;
    try {
        const dataDir = join(root, "data");
        const runtimeConfig = config(dataDir);
        runtime = await createRuntime(runtimeConfig);
        await runtime.close();
        runtime = undefined;

        const filenameSecret = "UNKNOWN_FILENAME_SECRET_4b1e";
        const transactionKindSecret = "POLICY_KIND_SECRET_715c";
        await write(join(dataDir, `mystery.tmp-${filenameSecret}`), "unknown scratch\n");
        await write(join(dataDir, "tool-bridges", `${filenameSecret}.txt`), "unknown bridge entry\n");
        await write(join(dataDir, "policy-versions", "transaction.json"), `${JSON.stringify({
            schemaVersion: 1,
            kind: transactionKindSecret,
        })}\n`);
        await write(join(dataDir, `tasks.json.tmp-123-${UUID}`), "recognized scratch\n");

        const report = await inspectCrashRecovery(runtimeConfig);
        const serialized = JSON.stringify(report);
        assert.equal(serialized.includes(filenameSecret), false);
        assert.equal(serialized.includes(transactionKindSecret), false);
        assert.equal(report.policyTransaction.kind, "unknown");
        assert.ok(report.blockingUnrecoverable.some((entry) => entry.path === "[unknown-temp-like]"));
        assert.ok(report.blockingUnrecoverable.some((entry) => entry.path === "tool-bridges/[unknown]"));
        assert.ok(report.recoverable.some((entry) => entry.path === `tasks.json.tmp-123-${UUID}`));
    }
    finally {
        await runtime?.close();
        await rm(root, { recursive: true, force: true });
    }
});
