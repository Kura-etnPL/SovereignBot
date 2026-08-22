import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { AuditLog } from "../src/audit.js";
import { policyHash } from "../src/policy-version-store.js";
import {
    createStateBackup,
    exportState,
    inspectStateBackup,
    restoreStateBackup,
    STATE_BACKUP_FORMAT,
} from "../src/state-transfer.js";

const TASK_SECRET = "TASK_SECRET_DO_NOT_EXPORT_70f2";
const MEMORY_SECRET = "MEMORY_SECRET_DO_NOT_EXPORT_51ad";
const AUDIT_SECRET = "AUDIT_SECRET_DO_NOT_EXPORT_4d73";
const COMPUTER_TOKEN = "COMPUTER_TOKEN_SENSITIVE_a81d";
const BROWSER_SECRET = "BROWSER_COOKIE_SENSITIVE_b774";
const WORKSPACE_SECRET = "WORKSPACE_DATA_SENSITIVE_1a93";
const OPERATOR_SESSION_SECRET = "OPERATOR_SESSION_EPHEMERAL_2c04";
const BRIDGE_SECRET = "BRIDGE_CAPABILITY_EPHEMERAL_9f11";
const VERSION_ID = "policy_12345678-1234-4abc-8def-1234567890ab";
const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function policy() {
    return {
        repeatWindowMs: 180000,
        repeatMaxActiveFingerprints: 10000,
        rules: [{
            id: "allow-test",
            effect: "allow",
            match: { category: "harness", operation: "run" },
        }],
    };
}

async function writeJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function exists(path) {
    try {
        await stat(path);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}

async function allFiles(root, relativeRoot = "") {
    if (!await exists(root))
        return [];
    const out = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        const rel = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
        if (entry.isDirectory())
            out.push(...await allFiles(path, rel));
        else
            out.push(rel);
    }
    return out.sort();
}

async function bundleText(root) {
    let text = "";
    for (const rel of await allFiles(root))
        text += await readFile(join(root, ...rel.split("/")), "utf8");
    return text;
}

async function seedState(root, { withComputers = true } = {}) {
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const config = {
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
        policy: policy(),
    };

    await writeJson(join(dataDir, "tasks.json"), [{
        id: "task_1",
        kind: "work",
        title: "backup fixture",
        status: "queued",
        input: { privateValue: TASK_SECRET },
    }]);
    await writeFile(join(dataDir, "task-events.jsonl"), `${JSON.stringify({
        id: "event_1",
        seq: 1,
        at: new Date().toISOString(),
        taskId: "task_1",
        type: "task.created",
        data: { privateValue: TASK_SECRET },
    })}\n`, "utf8");
    await writeFile(join(dataDir, "memory.jsonl"), `${JSON.stringify({
        id: "mem_1",
        at: new Date().toISOString(),
        scope: "task:task_1",
        key: "private",
        value: MEMORY_SECRET,
        tags: [],
    })}\n`, "utf8");
    await writeJson(join(dataDir, "repeat-state.json"), {
        version: 1,
        entries: { ["a".repeat(64)]: [Date.now()] },
    });

    const audit = new AuditLog(join(dataDir, "audit.jsonl"));
    await audit.init();
    await audit.append({
        type: "test.seeded",
        actor: "test",
        subject: "task_1",
        data: { note: AUDIT_SECRET },
    });

    const activePolicy = policy();
    const hash = policyHash(activePolicy);
    const createdAt = new Date().toISOString();
    await writeJson(join(dataDir, "policy-versions", "active.json"), {
        schemaVersion: 1,
        versionId: VERSION_ID,
        hash,
        activatedAt: createdAt,
    });
    await writeJson(join(dataDir, "policy-versions", "versions", `${VERSION_ID}.json`), {
        schemaVersion: 1,
        id: VERSION_ID,
        hash,
        createdAt,
        source: "test",
        label: "fixture",
        policy: activePolicy,
    });

    await writeJson(join(dataDir, "operator-sessions", `${"b".repeat(64)}.json`), {
        version: 1,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        label: OPERATOR_SESSION_SECRET,
    });
    await writeJson(join(dataDir, "tool-bridges", "bridge_1.bootstrap.json"), {
        protocol: "sovereignbot.governed-bridge.v1",
        capability: BRIDGE_SECRET,
    });
    await writeJson(join(dataDir, "tool-bridges", "bridge_1.claude-mcp.json"), {
        mcpServers: { sovereignbot: { args: [BRIDGE_SECRET] } },
    });

    if (withComputers) {
        await mkdir(join(dataDir, "computers", "d29ya2Vy", "profile"), { recursive: true });
        await mkdir(join(dataDir, "computers", "d29ya2Vy", "workspace"), { recursive: true });
        await writeFile(join(dataDir, "computers", "operator-token"), `${COMPUTER_TOKEN}\n`, "utf8");
        await writeFile(join(dataDir, "computers", "d29ya2Vy", "token"), `${COMPUTER_TOKEN}-worker\n`, "utf8");
        await writeFile(join(dataDir, "computers", "d29ya2Vy", "profile", "Cookies"), `${BROWSER_SECRET}\n`, "utf8");
        await writeFile(join(dataDir, "computers", "d29ya2Vy", "workspace", "note.txt"), `${WORKSPACE_SECRET}\n`, "utf8");
        await writeJson(join(dataDir, "computers", "state.json"), { version: 2, agents: {} });
    }

    const configPath = join(root, "config.json");
    await writeJson(configPath, config);
    return { config, configPath, dataDir };
}

function cloneConfig(config, dataDir) {
    return { ...structuredClone(config), dataDir };
}

test("core backup restores durable state while excluding computer and ephemeral authority state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-core-"));
    try {
        const { config, dataDir } = await seedState(root);
        const backup = join(root, "core-backup");
        const result = await createStateBackup(config, backup);
        assert.equal(result.mode, "core");
        assert.equal(result.sensitiveComputerState, false);

        const manifest = await inspectStateBackup(backup);
        assert.equal(manifest.format, STATE_BACKUP_FORMAT);
        assert.equal(manifest.sensitiveComputerState, false);
        assert.equal(manifest.files.some((entry) => entry.path.startsWith("computers/")), false);
        assert.equal(manifest.files.some((entry) => entry.path.startsWith("operator-sessions/")), false);
        assert.equal(manifest.files.some((entry) => entry.path.startsWith("tool-bridges/")), false);

        const text = await bundleText(backup);
        assert.equal(text.includes(COMPUTER_TOKEN), false);
        assert.equal(text.includes(BROWSER_SECRET), false);
        assert.equal(text.includes(WORKSPACE_SECRET), false);
        assert.equal(text.includes(OPERATOR_SESSION_SECRET), false);
        assert.equal(text.includes(BRIDGE_SECRET), false);
        assert.equal(text.includes(TASK_SECRET), true, "recovery backup preserves durable task contents");

        const restoredDir = join(root, "restored-core");
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

test("full-computer backup is explicit, sensitive, restorable, and still excludes ephemeral authority state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-full-"));
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

        const restoredDir = join(root, "restored-full");
        await restoreStateBackup(cloneConfig(config, restoredDir), backup);
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

test("redacted export contains aggregate metadata only and is never accepted by restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-export-"));
    try {
        const { config } = await seedState(root);
        const output = join(root, "redacted-export");
        const result = await exportState(config, output);
        assert.deepEqual(result, { path: output, restorable: false, redacted: true });
        const text = await bundleText(output);
        for (const secret of [TASK_SECRET, MEMORY_SECRET, AUDIT_SECRET, COMPUTER_TOKEN, BROWSER_SECRET, WORKSPACE_SECRET, OPERATOR_SESSION_SECRET, BRIDGE_SECRET])
            assert.equal(text.includes(secret), false, secret);
        const exported = JSON.parse(await readFile(join(output, "export.json"), "utf8"));
        assert.equal(exported.restorable, false);
        assert.equal(exported.tasks.total, 1);
        assert.equal(exported.memory.total, 1);
        assert.equal(exported.audit.integrity, "ok");
        assert.equal(exported.audit.rows, 1);
        assert.equal(exported.repeat.activeFingerprintCount, 1);
        assert.equal(exported.policy.versionId, VERSION_ID);

        const target = cloneConfig(config, join(root, "should-not-restore"));
        await assert.rejects(() => restoreStateBackup(target, output), /format\/version is unsupported/);
        assert.equal(await exists(target.dataDir), false);
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

test("hostile manifest traversal and forbidden authority paths are rejected before destination mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-state-hostile-"));
    try {
        const { config } = await seedState(root, { withComputers: false });
        for (const unsafePath of ["../escape", "/absolute", "operator-sessions/session.json", "tool-bridges/bridge.bootstrap.json"]) {
            const backup = join(root, `hostile-${sha256(Buffer.from(unsafePath)).slice(0, 8)}`);
            await mkdir(join(backup, "files"), { recursive: true });
            await writeJson(join(backup, "manifest.json"), {
                format: STATE_BACKUP_FORMAT,
                formatVersion: 1,
                mode: "core",
                sensitiveComputerState: false,
                files: [{ path: unsafePath, size: 0, sha256: sha256(Buffer.alloc(0)), mode: 0o600 }],
            });
            const destination = join(root, `destination-${sha256(Buffer.from(unsafePath)).slice(0, 8)}`);
            await mkdir(destination);
            await writeFile(join(destination, "marker.txt"), "ORIGINAL\n", "utf8");
            await assert.rejects(
                () => restoreStateBackup(cloneConfig(config, destination), backup, { replace: true }),
                /unsafe path/,
            );
            assert.equal(await readFile(join(destination, "marker.txt"), "utf8"), "ORIGINAL\n");
        }
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("backup fails if captured state or state membership changes before publish", async () => {
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
                await writeJson(join(second.dataDir, "policy-versions", "versions", "policy_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json"), {
                    schemaVersion: 1,
                    id: "policy_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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

test("corrupt policy state with matching backup checksums is rejected before destination replacement", async () => {
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
        const entry = manifest.files.find((item) => item.path === rel);
        entry.size = content.length;
        entry.sha256 = sha256(content);
        await writeJson(manifestPath, manifest);

        const destination = join(root, "destination");
        await mkdir(destination);
        await writeFile(join(destination, "marker.txt"), "ORIGINAL\n", "utf8");
        await assert.rejects(
            () => restoreStateBackup(cloneConfig(source.config, destination), backup, { replace: true }),
            /active policy version is invalid or hash-mismatched/,
        );
        assert.equal(await readFile(join(destination, "marker.txt"), "utf8"), "ORIGINAL\n");
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
        assert.equal(result.status, 0, result.stderr);
        const parsed = JSON.parse(result.stdout);
        assert.equal(parsed.mode, "core");
        assert.equal(await exists(join(dataDir, "computers")), false);
        assert.equal(await exists(join(dataDir, "operator-sessions")), false);
        assert.equal(await exists(join(dataDir, "tool-bridges")), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
