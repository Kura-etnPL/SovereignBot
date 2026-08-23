import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
    applyCrashRecovery,
    CRASH_RECOVERY_QUARANTINE_FORMAT,
    inspectCrashRecovery,
} from "../src/crash-recovery.js";
import { createRuntime } from "../src/runtime.js";
import { preflightRuntimeStartup } from "../src/startup-preflight.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const BRIDGE = `bridge_${UUID}`;
const CAPABILITY_SECRET = "RECOVERY_BRIDGE_CAPABILITY_SECRET_91af";
const TEMP_SECRET = "RECOVERY_TEMP_SECRET_13dc";
const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function baseConfig(dataDir) {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [{ id: "echo", name: "Echo", role: "worker", capabilities: ["demo"], harness: { kind: "echo" } }],
        policy: {
            repeatWindowMs: 180000,
            repeatMaxActiveFingerprints: 10000,
            rules: [{ id: "allow", effect: "allow", match: { category: "harness" } }],
        },
    };
}

async function write(path, content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
}

async function writeJson(path, value) {
    await write(path, `${JSON.stringify(value, null, 2)}\n`);
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

async function snapshot(root, relativeRoot = "") {
    const result = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error))) {
        const absolute = join(root, entry.name);
        const rel = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
        if (entry.isDirectory())
            result.push(...await snapshot(absolute, rel));
        else if (entry.isFile())
            result.push([rel, (await readFile(absolute)).toString("base64")]);
        else
            result.push([rel, "special"]);
    }
    return result.sort(([a], [b]) => a.localeCompare(b));
}

async function initialized(root) {
    const dataDir = join(root, "data");
    const config = baseConfig(dataDir);
    const runtime = await createRuntime(config);
    await runtime.close();
    return { dataDir, config };
}

async function seedRecognizedArtifacts(dataDir) {
    const paths = [
        `tasks.json.tmp-123-${UUID}`,
        `repeat-state.json.tmp-124-${UUID}`,
        `policy-versions/active.json.tmp-125-${UUID}`,
        `computers/state.json.tmp-126-${UUID}`,
        `tool-bridges/${BRIDGE}.bootstrap.json`,
        `tool-bridges/${BRIDGE}.claude-mcp.json`,
    ];
    await write(join(dataDir, paths[0]), `${TEMP_SECRET}-tasks\n`);
    await write(join(dataDir, paths[1]), `${TEMP_SECRET}-repeat\n`);
    await write(join(dataDir, paths[2]), `${TEMP_SECRET}-policy\n`);
    await write(join(dataDir, paths[3]), `${TEMP_SECRET}-computer\n`);
    await writeJson(join(dataDir, paths[4]), {
        protocol: "sovereignbot.governed-bridge.v1",
        brokerUrl: "http://127.0.0.1:1",
        capability: CAPABILITY_SECRET,
    });
    await writeJson(join(dataDir, paths[5]), {
        mcpServers: { sovereignbot: { command: process.execPath, args: [CAPABILITY_SECRET] } },
    });
    return paths;
}

test("recovery dry-run detects only exact audited artifacts, never nested workspace temp-like names, and never leaks contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-recovery-inspect-"));
    try {
        const { dataDir, config } = await initialized(root);
        const paths = await seedRecognizedArtifacts(dataDir);
        const workspace = join(dataDir, "computers", Buffer.from("echo").toString("base64url"), "workspace", `report.tmp-777-${UUID}`);
        await write(workspace, "LEGITIMATE_WORKSPACE_TEMP_LIKE_DATA\n");
        const before = await snapshot(dataDir);

        const report = await inspectCrashRecovery(config);
        assert.equal(report.recoverable.length, paths.length);
        assert.deepEqual(report.recoverable.map((entry) => entry.path).sort(), [...paths].sort());
        assert.equal(report.blockingUnrecoverable.length, 0);
        assert.equal(report.activeWork.length, 0);
        assert.equal(report.canAttemptApply, true);
        const serialized = JSON.stringify(report);
        assert.equal(serialized.includes(CAPABILITY_SECRET), false);
        assert.equal(serialized.includes(TEMP_SECRET), false);
        assert.equal(serialized.includes("LEGITIMATE_WORKSPACE_TEMP_LIKE_DATA"), false);
        assert.equal(report.recoverable.some((entry) => entry.path.includes("workspace")), false);
        assert.deepEqual(await snapshot(dataDir), before, "dry-run must not mutate state");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("apply moves exact stale artifacts into a private quarantine and cleaned state passes startup preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-recovery-apply-"));
    let runtime;
    try {
        const { dataDir, config } = await initialized(root);
        const paths = await seedRecognizedArtifacts(dataDir);
        const result = await applyCrashRecovery(config);
        assert.equal(result.applied, true);
        assert.equal(result.moved.length, paths.length);
        assert.equal(result.quarantine.startsWith(dataDir), false);
        await preflightRuntimeStartup(config);
        for (const path of paths) {
            assert.equal(await exists(join(dataDir, ...path.split("/"))), false, path);
            assert.equal(await exists(join(result.quarantine, ...path.split("/"))), true, path);
        }
        const manifest = JSON.parse(await readFile(join(result.quarantine, "manifest.json"), "utf8"));
        assert.equal(manifest.format, CRASH_RECOVERY_QUARANTINE_FORMAT);
        assert.equal(manifest.files.length, paths.length);
        const manifestText = JSON.stringify(manifest);
        assert.equal(manifestText.includes(CAPABILITY_SECRET), false);
        assert.equal(manifestText.includes(TEMP_SECRET), false);

        runtime = await createRuntime(config);
        await runtime.close();
        runtime = undefined;
        assert.equal(await exists(result.quarantine), true, "startup must not auto-delete recovery evidence");
    }
    finally {
        await runtime?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("unknown bridge entries and unrecognized root scratch fail closed without moving recognized files", async () => {
    for (const mode of ["bridge", "scratch"]) {
        const root = await mkdtemp(join(tmpdir(), "sovereign-recovery-unknown-"));
        try {
            const { dataDir, config } = await initialized(root);
            const paths = await seedRecognizedArtifacts(dataDir);
            if (mode === "bridge")
                await write(join(dataDir, "tool-bridges", "mystery.txt"), "UNKNOWN\n");
            else
                await write(join(dataDir, `mystery.tmp-999-${UUID}`), "UNKNOWN\n");
            const report = await inspectCrashRecovery(config);
            assert.ok(report.blockingUnrecoverable.length >= 1);
            assert.equal(report.canAttemptApply, false);
            const before = await snapshot(dataDir);
            await assert.rejects(() => applyCrashRecovery(config), /blocking unrecognized\/unsafe state/);
            assert.deepEqual(await snapshot(dataDir), before);
            for (const path of paths)
                assert.equal(await exists(join(dataDir, ...path.split("/"))), true);
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    }
});

test("accepted or running durable work blocks apply and malformed task ids are not echoed", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-recovery-active-"));
    try {
        const { dataDir, config } = await initialized(root);
        await seedRecognizedArtifacts(dataDir);
        const secretId = "TASK_ID_SECRET_SHOULD_NOT_LEAK";
        await writeJson(join(dataDir, "tasks.json"), [{
            id: secretId,
            kind: "work",
            title: "private",
            status: "running",
        }]);
        const report = await inspectCrashRecovery(config);
        assert.equal(report.canAttemptApply, false);
        assert.deepEqual(report.activeWork, [{ id: "unknown", status: "running" }]);
        assert.equal(JSON.stringify(report).includes(secretId), false);
        const before = await snapshot(dataDir);
        await assert.rejects(() => applyCrashRecovery(config), /accepted\/running durable tasks are present/);
        assert.deepEqual(await snapshot(dataDir), before);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("injected move failure rolls already moved artifacts back", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-recovery-move-rollback-"));
    try {
        const { dataDir, config } = await initialized(root);
        await write(join(dataDir, `tasks.json.tmp-123-${UUID}`), `${TEMP_SECRET}-one\n`);
        await write(join(dataDir, `repeat-state.json.tmp-124-${UUID}`), `${TEMP_SECRET}-two\n`);
        const before = await snapshot(dataDir);
        let moves = 0;
        const renameFn = async (from, to) => {
            moves += 1;
            if (moves === 2) {
                const error = new Error("injected recovery move failure");
                error.code = "EIO";
                throw error;
            }
            return rename(from, to);
        };
        await assert.rejects(() => applyCrashRecovery(config, { renameFn }), /injected recovery move failure/);
        assert.deepEqual(await snapshot(dataDir), before);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("unrelated hard state failure after quarantine causes full artifact rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-recovery-preflight-rollback-"));
    try {
        const { dataDir, config } = await initialized(root);
        const temp = join(dataDir, `tasks.json.tmp-123-${UUID}`);
        await write(temp, `${TEMP_SECRET}\n`);
        await writeJson(join(dataDir, "repeat-state.json"), { version: 1, entries: { broken: [1] } });
        const before = await snapshot(dataDir);
        await assert.rejects(() => applyCrashRecovery(config), /startup preflight failed: repeat-state\.json/);
        assert.deepEqual(await snapshot(dataDir), before);
        assert.equal(await exists(temp), true);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("policy transaction marker is reported but never selected or removed; uncommitted marker makes apply roll scratch back", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-recovery-policy-marker-"));
    let runtime;
    try {
        const dataDir = join(root, "data");
        const config = baseConfig(dataDir);
        runtime = await createRuntime(config);
        const previous = runtime.policyManager.current();
        const target = await runtime.policyVersions.createVersion({ rules: [] }, { parentVersionId: previous.id });
        await runtime.policyVersions.beginActivation({
            fromVersionId: previous.id,
            toVersionId: target.id,
            toHash: target.hash,
        });
        await runtime.close();
        runtime = undefined;
        const marker = join(dataDir, "policy-versions", "transaction.json");
        const markerBefore = await readFile(marker, "utf8");
        const temp = join(dataDir, `tasks.json.tmp-123-${UUID}`);
        await write(temp, `${TEMP_SECRET}\n`);

        const report = await inspectCrashRecovery(config);
        assert.equal(report.policyTransaction.present, true);
        assert.equal(report.recoverable.some((entry) => entry.path === "policy-versions/transaction.json"), false);
        await assert.rejects(() => applyCrashRecovery(config), /startup preflight failed: policy activation recovery/);
        assert.equal(await readFile(marker, "utf8"), markerBefore);
        assert.equal(await exists(temp), true, "scratch must roll back when policy marker remains unrecoverable");
    }
    finally {
        await runtime?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("quarantine inside dataDir is refused before any artifact move", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-recovery-output-"));
    try {
        const { dataDir, config } = await initialized(root);
        await write(join(dataDir, `tasks.json.tmp-123-${UUID}`), `${TEMP_SECRET}\n`);
        const before = await snapshot(dataDir);
        await assert.rejects(
            () => applyCrashRecovery(config, { quarantine: join(dataDir, "quarantine") }),
            /quarantine must be outside dataDir/,
        );
        assert.deepEqual(await snapshot(dataDir), before);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("CLI recover is read-only by default, does not leak capability content, and --apply runs before runtime construction", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-recovery-cli-"));
    try {
        const { dataDir, config } = await initialized(root);
        const configPath = join(root, "config.json");
        await writeJson(configPath, config);
        const paths = await seedRecognizedArtifacts(dataDir);
        const before = await snapshot(dataDir);

        const dry = spawnSync(process.execPath, [CLI_PATH, "recover", "--config", configPath], {
            encoding: "utf8",
            shell: false,
            timeout: 20_000,
        });
        assert.equal(dry.status, 0, dry.stderr || dry.stdout);
        assert.equal(dry.stdout.includes(CAPABILITY_SECRET), false);
        assert.equal(dry.stdout.includes(TEMP_SECRET), false);
        assert.deepEqual(await snapshot(dataDir), before);

        const quarantine = join(root, "explicit-quarantine");
        const apply = spawnSync(process.execPath, [CLI_PATH, "recover", "--apply", "--quarantine", quarantine, "--config", configPath], {
            encoding: "utf8",
            shell: false,
            timeout: 20_000,
        });
        assert.equal(apply.status, 0, apply.stderr || apply.stdout);
        assert.match(apply.stderr, /offline operation/i);
        assert.equal(apply.stdout.includes(CAPABILITY_SECRET), false);
        assert.equal(apply.stdout.includes(TEMP_SECRET), false);
        for (const path of paths)
            assert.equal(await exists(join(quarantine, ...path.split("/"))), true, path);
        await preflightRuntimeStartup(config);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
