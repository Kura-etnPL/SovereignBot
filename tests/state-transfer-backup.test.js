import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { policyHash } from "../src/policy-version-store.js";
import { createStateBackup, inspectStateBackup } from "../src/state-transfer.js";
import {
    BROWSER_SECRET,
    BRIDGE_SECRET,
    CLI_PATH,
    COMPUTER_TOKEN,
    CONFIG_SECRET,
    OPERATOR_SESSION_SECRET,
    TASK_SECRET,
    WORKSPACE_SECRET,
    bundleText,
    exists,
    policy,
    seedState,
    writeJson,
} from "./state-transfer-fixtures.js";

test("default core backup excludes computer and ephemeral authority state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-core-backup-"));
    try {
        const { config } = await seedState(root);
        const backup = join(root, "core-backup");
        const result = await createStateBackup(config, backup);
        assert.equal(result.mode, "core");
        assert.equal(result.sensitiveComputerState, false);

        const manifest = await inspectStateBackup(backup);
        assert.equal(manifest.mode, "core");
        assert.equal(manifest.sensitiveComputerState, false);
        assert.equal(manifest.offlineConsistencyRequired, true);
        assert.equal(manifest.files.some((entry) => entry.path.startsWith("computers/")), false);
        assert.equal(manifest.files.some((entry) => entry.path.startsWith("operator-sessions/")), false);
        assert.equal(manifest.files.some((entry) => entry.path.startsWith("tool-bridges/")), false);

        const text = await bundleText(backup);
        assert.equal(text.includes(COMPUTER_TOKEN), false);
        assert.equal(text.includes(BROWSER_SECRET), false);
        assert.equal(text.includes(WORKSPACE_SECRET), false);
        assert.equal(text.includes(OPERATOR_SESSION_SECRET), false);
        assert.equal(text.includes(BRIDGE_SECRET), false);
        assert.equal(text.includes(CONFIG_SECRET), false, "backup must not derive/copy external config secrets");
        assert.equal(text.includes(TASK_SECRET), true, "recovery backup preserves durable task contents");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("full-computer backup is explicit and still excludes ephemeral authority state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-full-backup-"));
    try {
        const { config } = await seedState(root);
        const backup = join(root, "full-backup");
        await createStateBackup(config, backup, { includeComputerState: true });
        const manifest = await inspectStateBackup(backup);
        assert.equal(manifest.mode, "full-computer");
        assert.equal(manifest.sensitiveComputerState, true);
        assert.ok(manifest.files.some((entry) => entry.path === "computers/operator-token"));
        assert.ok(manifest.files.some((entry) => entry.path.endsWith("/profile/Cookies")));
        assert.equal(manifest.files.some((entry) => entry.path.startsWith("operator-sessions/")), false);
        assert.equal(manifest.files.some((entry) => entry.path.startsWith("tool-bridges/")), false);

        const text = await bundleText(backup);
        assert.ok(text.includes(COMPUTER_TOKEN));
        assert.ok(text.includes(BROWSER_SECRET));
        assert.ok(text.includes(WORKSPACE_SECRET));
        assert.equal(text.includes(OPERATOR_SESSION_SECRET), false);
        assert.equal(text.includes(BRIDGE_SECRET), false);
        assert.equal(text.includes(CONFIG_SECRET), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("backup fails if captured state contents or membership changes before publish", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-consistency-"));
    try {
        const first = await seedState(join(root, "first"));
        const changedOutput = join(root, "changed-output");
        await assert.rejects(() => createStateBackup(first.config, changedOutput, {
            consistencyHook: async () => {
                const tasks = JSON.parse(await readFile(join(first.dataDir, "tasks.json"), "utf8"));
                tasks.push({ id: "task_2", kind: "work", status: "queued" });
                await writeJson(join(first.dataDir, "tasks.json"), tasks);
            },
        }), /state changed while backup was being captured/);
        assert.equal(await exists(changedOutput), false);

        const second = await seedState(join(root, "second"));
        const membershipOutput = join(root, "membership-output");
        await assert.rejects(() => createStateBackup(second.config, membershipOutput, {
            consistencyHook: async () => {
                const id = "policy_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
                await writeJson(join(second.dataDir, "policy-versions", "versions", `${id}.json`), {
                    schemaVersion: 1,
                    id,
                    hash: policyHash(policy()),
                    createdAt: new Date().toISOString(),
                    policy: policy(),
                });
            },
        }), /file membership changed/);
        assert.equal(await exists(membershipOutput), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("backup output inside dataDir is refused and CLI backup does not initialize runtime-only authority stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-cli-"));
    try {
        const { config, configPath, dataDir } = await seedState(root, { withComputers: false });
        await rm(join(dataDir, "operator-sessions"), { recursive: true, force: true });
        await rm(join(dataDir, "tool-bridges"), { recursive: true, force: true });
        assert.equal(await exists(join(dataDir, "computers")), false);
        assert.equal(await exists(join(dataDir, "operator-sessions")), false);
        await assert.rejects(() => createStateBackup(config, join(dataDir, "bad-backup")), /cannot be inside dataDir/);

        const output = join(root, "cli-backup");
        const result = spawnSync(process.execPath, [CLI_PATH, "backup", output, "--config", configPath], {
            encoding: "utf8",
            shell: false,
            timeout: 20_000,
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(await exists(join(dataDir, "computers")), false);
        assert.equal(await exists(join(dataDir, "operator-sessions")), false);
        assert.equal(await exists(join(dataDir, "tool-bridges")), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("full-computer CLI backup emits an explicit credential-sensitivity warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-cli-sensitive-"));
    try {
        const { configPath } = await seedState(root);
        const output = join(root, "cli-full-backup");
        const result = spawnSync(process.execPath, [
            CLI_PATH,
            "backup",
            output,
            "--include-computer-state",
            "--config",
            configPath,
        ], { encoding: "utf8", shell: false, timeout: 20_000 });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stderr, /WARNING:.*browser cookies.*logged-in browser profiles/i);
        assert.equal(result.stderr.includes(COMPUTER_TOKEN), false);
        assert.equal(result.stderr.includes(BROWSER_SECRET), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
