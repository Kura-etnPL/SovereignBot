import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportState, restoreStateBackup } from "../src/state-transfer.js";
import {
    AUDIT_SECRET,
    BROWSER_SECRET,
    BRIDGE_SECRET,
    COMPUTER_TOKEN,
    CONFIG_SECRET,
    MEMORY_SECRET,
    OPERATOR_SESSION_SECRET,
    TASK_SECRET,
    WORKSPACE_SECRET,
    VERSION_ID,
    bundleText,
    cloneConfig,
    exists,
    seedState,
    writeJson,
} from "./state-transfer-fixtures.js";

test("redacted export contains aggregate metadata only and is never restorable", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-export-"));
    try {
        const { config } = await seedState(root);
        const output = join(root, "redacted-export");
        const result = await exportState(config, output);
        assert.deepEqual(result, { path: output, restorable: false, redacted: true });
        const text = await bundleText(output);
        for (const secret of [
            TASK_SECRET,
            MEMORY_SECRET,
            AUDIT_SECRET,
            CONFIG_SECRET,
            COMPUTER_TOKEN,
            BROWSER_SECRET,
            WORKSPACE_SECRET,
            OPERATOR_SESSION_SECRET,
            BRIDGE_SECRET,
        ]) {
            assert.equal(text.includes(secret), false, secret);
        }
        const exported = JSON.parse(await readFile(join(output, "export.json"), "utf8"));
        assert.equal(exported.restorable, false);
        assert.equal(exported.tasks.total, 1);
        assert.equal(exported.tasks.byStatus.queued, 1);
        assert.equal(exported.tasks.byKind.work, 1);
        assert.equal(exported.memory.total, 1);
        assert.equal(exported.memory.byScopeClass.task, 1);
        assert.equal(exported.audit.integrity, "ok");
        assert.equal(exported.audit.rows, 1);
        assert.equal(exported.repeat.activeFingerprintCount, 1);
        assert.equal(exported.policy.versionId, VERSION_ID);
        assert.equal(Object.hasOwn(exported.audit, "byType"), false, "audit event names are not exported as attacker-controlled keys");

        const target = cloneConfig(config, join(root, "should-not-restore"));
        await assert.rejects(() => restoreStateBackup(target, output), /format\/version is unsupported/);
        assert.equal(await exists(target.dataDir), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("export maps attacker-controlled task and memory grouping values to unknown instead of leaking them", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-export-keys-"));
    try {
        const { config, dataDir } = await seedState(root, { withComputers: false });
        const keySecret = "GROUPING_KEY_SECRET_88af";
        const tasks = JSON.parse(await readFile(join(dataDir, "tasks.json"), "utf8"));
        tasks[0].status = keySecret;
        tasks[0].kind = keySecret;
        await writeJson(join(dataDir, "tasks.json"), tasks);
        await writeFile(join(dataDir, "memory.jsonl"), `${JSON.stringify({
            id: "mem_attacker",
            at: new Date().toISOString(),
            scope: keySecret,
            key: "also-private",
            value: "never-export-this",
            tags: [],
        })}\n`, "utf8");

        const output = join(root, "export");
        await exportState(config, output);
        const text = await bundleText(output);
        assert.equal(text.includes(keySecret), false);
        assert.equal(text.includes("never-export-this"), false);
        const exported = JSON.parse(await readFile(join(output, "export.json"), "utf8"));
        assert.equal(exported.tasks.byStatus.unknown, 1);
        assert.equal(exported.tasks.byKind.unknown, 1);
        assert.equal(exported.memory.byScopeClass.unknown, 1);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
