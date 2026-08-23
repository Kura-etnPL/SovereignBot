import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStateBackup, restoreStateBackup } from "../src/state-transfer.js";
import {
    BROWSER_SECRET,
    COMPUTER_TOKEN,
    VERSION_ID,
    WORKSPACE_SECRET,
    cloneConfig,
    exists,
    seedState,
    sha256,
    writeJson,
    writeManifestOnly,
} from "./state-transfer-fixtures.js";

test("core backup restores durable state equivalently without authority/computer state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-core-restore-"));
    try {
        const { config, dataDir } = await seedState(root);
        const backup = join(root, "backup");
        await createStateBackup(config, backup);
        const restoredDir = join(root, "restored");
        const restored = await restoreStateBackup(cloneConfig(config, restoredDir), backup);
        assert.equal(restored.mode, "core");
        for (const rel of [
            "tasks.json",
            "task-events.jsonl",
            "memory.jsonl",
            "audit.jsonl",
            "repeat-state.json",
            "policy-versions/active.json",
            `policy-versions/versions/${VERSION_ID}.json`,
        ]) {
            assert.equal(
                await readFile(join(restoredDir, ...rel.split("/")), "utf8"),
                await readFile(join(dataDir, ...rel.split("/")), "utf8"),
                rel,
            );
        }
        assert.equal(await exists(join(restoredDir, "computers")), false);
        assert.equal(await exists(join(restoredDir, "operator-sessions")), false);
        assert.equal(await exists(join(restoredDir, "tool-bridges")), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("explicit full-computer backup restores tokens, workspace, and browser profile continuity", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-full-restore-"));
    try {
        const { config } = await seedState(root);
        const backup = join(root, "backup");
        await createStateBackup(config, backup, { includeComputerState: true });
        const restoredDir = join(root, "restored");
        const restored = await restoreStateBackup(cloneConfig(config, restoredDir), backup);
        assert.equal(restored.mode, "full-computer");
        assert.equal(restored.sensitiveComputerState, true);
        assert.match(await readFile(join(restoredDir, "computers", "operator-token"), "utf8"), /COMPUTER_TOKEN_SENSITIVE/);
        assert.equal(await readFile(join(restoredDir, "computers", "d29ya2Vy", "profile", "Cookies"), "utf8"), `${BROWSER_SECRET}\n`);
        assert.equal(await readFile(join(restoredDir, "computers", "d29ya2Vy", "workspace", "note.txt"), "utf8"), `${WORKSPACE_SECRET}\n`);
        assert.equal(await exists(join(restoredDir, "operator-sessions")), false);
        assert.equal(await exists(join(restoredDir, "tool-bridges")), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("tampered backup is rejected before replacement destination mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-tamper-"));
    try {
        const { config } = await seedState(root);
        const backup = join(root, "backup");
        await createStateBackup(config, backup);
        await writeFile(join(backup, "files", "tasks.json"), "[]\nTAMPERED\n", "utf8");

        const destination = join(root, "destination");
        await mkdir(destination);
        await writeFile(join(destination, "marker.txt"), "ORIGINAL\n", "utf8");
        await assert.rejects(
            () => restoreStateBackup(cloneConfig(config, destination), backup, { replace: true }),
            /integrity check failed/,
        );
        assert.equal(await readFile(join(destination, "marker.txt"), "utf8"), "ORIGINAL\n");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("hostile traversal, authority, Windows device, ADS, and unsupported paths are rejected before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-hostile-"));
    try {
        const { config } = await seedState(root, { withComputers: false });
        const cases = [
            { path: "../escape", mode: "core" },
            { path: "/absolute", mode: "core" },
            { path: "operator-sessions/session.json", mode: "core" },
            { path: "tool-bridges/bridge.bootstrap.json", mode: "core" },
            { path: "evil.txt", mode: "core" },
            { path: "computers/con/token", mode: "full-computer" },
            { path: "computers/worker/profile/Cookies:stream", mode: "full-computer" },
        ];
        for (const item of cases) {
            const backup = join(root, `hostile-${sha256(Buffer.from(`${item.mode}:${item.path}`)).slice(0, 10)}`);
            await writeManifestOnly(backup, item.path, { mode: item.mode });
            const destination = join(root, `destination-${sha256(Buffer.from(item.path)).slice(0, 10)}`);
            await mkdir(destination, { recursive: true });
            await writeFile(join(destination, "marker.txt"), "ORIGINAL\n", "utf8");
            await assert.rejects(
                () => restoreStateBackup(cloneConfig(config, destination), backup, { replace: true }),
                /unsafe path or unsupported state file/,
                item.path,
            );
            assert.equal(await readFile(join(destination, "marker.txt"), "utf8"), "ORIGINAL\n");
        }
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("replacement restore rolls the previous dataDir back when the staged swap fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-rollback-"));
    try {
        const source = await seedState(join(root, "source"));
        const backup = join(root, "backup");
        await createStateBackup(source.config, backup);

        const destination = join(root, "destination");
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "marker.txt"), "ORIGINAL_STATE\n", "utf8");
        let renameCalls = 0;
        const renameFn = async (from, to) => {
            renameCalls += 1;
            if (renameCalls === 2) {
                const error = new Error("injected swap failure");
                error.code = "EIO";
                throw error;
            }
            return rename(from, to);
        };

        await assert.rejects(
            () => restoreStateBackup(cloneConfig(source.config, destination), backup, { replace: true, renameFn }),
            /injected swap failure/,
        );
        assert.equal(await readFile(join(destination, "marker.txt"), "utf8"), "ORIGINAL_STATE\n");
        assert.equal(await exists(join(destination, "tasks.json")), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("corrupt active policy with matching bundle checksum is rejected before replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-policy-corrupt-"));
    try {
        const source = await seedState(join(root, "source"));
        const backup = join(root, "backup");
        await createStateBackup(source.config, backup);
        const manifestPath = join(backup, "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const rel = `policy-versions/versions/${VERSION_ID}.json`;
        const policyPath = join(backup, "files", ...rel.split("/"));
        const version = JSON.parse(await readFile(policyPath, "utf8"));
        version.policy.rules.push({ id: "tampered-rule", effect: "deny", match: { category: "harness" } });
        const content = Buffer.from(`${JSON.stringify(version, null, 2)}\n`);
        await writeFile(policyPath, content);
        const entry = manifest.files.find((candidate) => candidate.path === rel);
        entry.size = content.length;
        entry.sha256 = sha256(content);
        await writeJson(manifestPath, manifest);

        const destination = join(root, "destination");
        await mkdir(destination);
        await writeFile(join(destination, "marker.txt"), "ORIGINAL\n", "utf8");
        await assert.rejects(
            () => restoreStateBackup(cloneConfig(source.config, destination), backup, { replace: true }),
            /policy version hash mismatch|active policy version is invalid or hash-mismatched/,
        );
        assert.equal(await readFile(join(destination, "marker.txt"), "utf8"), "ORIGINAL\n");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("non-empty destination requires explicit replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-no-replace-"));
    try {
        const source = await seedState(join(root, "source"));
        const backup = join(root, "backup");
        await createStateBackup(source.config, backup);
        const destination = join(root, "destination");
        await mkdir(destination);
        await writeFile(join(destination, "marker.txt"), "ORIGINAL\n", "utf8");
        await assert.rejects(
            () => restoreStateBackup(cloneConfig(source.config, destination), backup),
            /not empty.*--replace/,
        );
        assert.equal(await readFile(join(destination, "marker.txt"), "utf8"), "ORIGINAL\n");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("manifest security metadata is mandatory and fail-closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-manifest-security-"));
    try {
        const backup = join(root, "backup");
        await mkdir(backup, { recursive: true });
        await writeJson(join(backup, "manifest.json"), {
            format: "sovereignbot-state-backup",
            formatVersion: 1,
            createdAt: new Date().toISOString(),
            sourceVersion: "test",
            mode: "core",
            sensitiveComputerState: true,
            offlineConsistencyRequired: true,
            files: [],
        });
        await assert.rejects(
            () => restoreStateBackup({ dataDir: join(root, "target") }, backup),
            /security metadata is inconsistent/,
        );
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
