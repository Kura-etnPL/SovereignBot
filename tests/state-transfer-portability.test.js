import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    createStateBackup,
    inspectStateBackup,
    restoreStateBackup,
    STATE_BACKUP_FORMAT,
} from "../src/state-transfer.js";
import {
    cloneConfig,
    seedState,
    sha256,
    writeJson,
} from "./state-transfer-fixtures.js";

test("full-computer backup preserves legitimate nested temp-like workspace/profile filenames", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-temp-names-"));
    try {
        const { config, dataDir } = await seedState(root);
        const workspaceRel = "computers/d29ya2Vy/workspace/report.tmp-user-note.txt";
        const profileRel = "computers/d29ya2Vy/profile/cache.old-user-copy";
        await writeFile(join(dataDir, ...workspaceRel.split("/")), "WORKSPACE_TEMP_NAME_CONTENT\n", "utf8");
        await writeFile(join(dataDir, ...profileRel.split("/")), "PROFILE_TEMP_NAME_CONTENT\n", "utf8");

        const backup = join(root, "backup");
        await createStateBackup(config, backup, { includeComputerState: true });
        const manifest = await inspectStateBackup(backup);
        assert.ok(manifest.files.some((entry) => entry.path === workspaceRel));
        assert.ok(manifest.files.some((entry) => entry.path === profileRel));

        const restored = join(root, "restored");
        await restoreStateBackup(cloneConfig(config, restored), backup);
        assert.equal(await readFile(join(restored, ...workspaceRel.split("/")), "utf8"), "WORKSPACE_TEMP_NAME_CONTENT\n");
        assert.equal(await readFile(join(restored, ...profileRel.split("/")), "utf8"), "PROFILE_TEMP_NAME_CONTENT\n");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("restore rejects case-insensitive portable path collisions before reading payload files", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-case-collision-"));
    try {
        const backup = join(root, "backup");
        await mkdir(backup, { recursive: true });
        const emptyHash = sha256(Buffer.alloc(0));
        await writeJson(join(backup, "manifest.json"), {
            format: STATE_BACKUP_FORMAT,
            formatVersion: 1,
            createdAt: new Date().toISOString(),
            sourceVersion: "0.4.0-dev-test",
            mode: "full-computer",
            sensitiveComputerState: true,
            offlineConsistencyRequired: true,
            files: [
                { path: "computers/worker/workspace/Report.txt", size: 0, sha256: emptyHash, mode: 0o600 },
                { path: "computers/worker/workspace/report.txt", size: 0, sha256: emptyHash, mode: 0o600 },
            ],
        });
        await assert.rejects(
            () => restoreStateBackup({ dataDir: join(root, "target") }, backup),
            /collide on a case-insensitive portable filesystem/,
        );
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("core backup refuses unknown top-level state instead of silently omitting future durable files", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-unknown-top-"));
    try {
        const { config, dataDir } = await seedState(root, { withComputers: false });
        await writeJson(join(dataDir, "future-durable-state.json"), { version: 99, important: true });
        await assert.rejects(
            () => createStateBackup(config, join(root, "backup")),
            /unsupported state path: future-durable-state\.json/,
        );
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("restore rejects undeclared bundle-root material", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-root-extra-"));
    try {
        const { config } = await seedState(join(root, "source"), { withComputers: false });
        const backup = join(root, "backup");
        await createStateBackup(config, backup);
        await writeFile(join(backup, "surprise.txt"), "UNDECLARED\n", "utf8");
        await assert.rejects(
            () => restoreStateBackup(cloneConfig(config, join(root, "target")), backup),
            /undeclared top-level files/,
        );
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
