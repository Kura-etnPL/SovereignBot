import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computerAgentSetHash } from "../src/computer-migration.js";
import { doctorExitCode, runDoctor } from "../src/doctor.js";
import { createStateBackup } from "../src/state-transfer.js";

const MIGRATION_ID = "computermig_12345678-1234-4abc-8def-1234567890ab";

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
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

async function writeJson(path, value) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function seedCurrentComputerState(root) {
    const dataDir = join(root, "data");
    const computers = join(dataDir, "computers");
    await mkdir(computers, { recursive: true });
    const stateText = `${JSON.stringify({ version: 2, agents: {} }, null, 2)}\n`;
    await writeFile(join(computers, "state.json"), stateText, "utf8");
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
        policy: {
            rules: [{ id: "allow-test", effect: "allow", match: { category: "harness" } }],
        },
    };
    const configPath = join(root, "config.json");
    await writeJson(configPath, config);
    return { config, configPath, dataDir, computers, stateText };
}

function committedMarker(stateText, overrides = {}) {
    return {
        schemaVersion: 1,
        kind: "computer-registry-v1-to-v2",
        migrationId: MIGRATION_ID,
        startedAt: "2026-08-24T00:00:00.000Z",
        sourceStateMissing: false,
        sourceStateSha256: "0".repeat(64),
        targetStateSha256: sha256(Buffer.from(stateText)),
        agentSetSha256: computerAgentSetHash(["worker"]),
        ...overrides,
    };
}

function checkById(report, id) {
    return report.checks.find((entry) => entry.id === id);
}

test("doctor reports valid recoverable computer migration without exposing marker hashes, and fails closed on tamper", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-migration-doctor-"));
    try {
        const { configPath, computers, stateText } = await seedCurrentComputerState(root);
        const markerPath = join(computers, "migration.json");
        const marker = committedMarker(stateText);
        await writeJson(markerPath, marker);

        const recoverable = await runDoctor(configPath);
        const migrationCheck = checkById(recoverable, "computer.migration");
        assert.equal(migrationCheck.status, "warning");
        assert.equal(migrationCheck.details.status, "committed-marker");
        assert.equal(migrationCheck.details.markerPresent, true);
        assert.equal(migrationCheck.details.stagePresent, false);
        assert.equal(doctorExitCode(recoverable), 0);
        const serialized = JSON.stringify(recoverable);
        assert.equal(serialized.includes(marker.targetStateSha256), false);
        assert.equal(serialized.includes(marker.agentSetSha256), false);
        assert.equal(serialized.includes(MIGRATION_ID), false);

        const tamper = "f".repeat(64);
        await writeJson(markerPath, { ...marker, agentSetSha256: tamper });
        const rejected = await runDoctor(configPath);
        assert.equal(checkById(rejected, "computer.migration").status, "error");
        assert.equal(doctorExitCode(rejected), 1);
        assert.equal(JSON.stringify(rejected).includes(tamper), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("core and full backups refuse existing or newly-started computer migration before publishing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-migration-backup-"));
    try {
        const { config, computers, stateText } = await seedCurrentComputerState(root);
        const markerPath = join(computers, "migration.json");
        const marker = committedMarker(stateText);

        const racedOutput = join(root, "raced-backup");
        await assert.rejects(
            () => createStateBackup(config, racedOutput, {
                consistencyHook: async () => writeJson(markerPath, marker),
            }),
            /cannot back up while computer registry migration is required, in progress, or awaiting cleanup/,
        );
        assert.equal(await exists(racedOutput), false);
        assert.equal(await exists(markerPath), true, "backup must never delete migration evidence");

        const coreOutput = join(root, "core-backup");
        await assert.rejects(
            () => createStateBackup(config, coreOutput),
            /cannot back up while computer registry migration is required, in progress, or awaiting cleanup/,
        );
        assert.equal(await exists(coreOutput), false);

        const fullOutput = join(root, "full-backup");
        await assert.rejects(
            () => createStateBackup(config, fullOutput, { includeComputerState: true }),
            /cannot back up while computer registry migration is required, in progress, or awaiting cleanup/,
        );
        assert.equal(await exists(fullOutput), false);

        await unlink(markerPath);
        const cleanOutput = join(root, "clean-backup");
        const clean = await createStateBackup(config, cleanOutput);
        assert.equal(clean.mode, "core");
        assert.equal(await exists(join(cleanOutput, "manifest.json")), true);
        assert.match(await readFile(join(cleanOutput, "manifest.json"), "utf8"), /sovereignbot-state-backup/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
