import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { doctorExitCode, runDoctor } from "../src/doctor.js";

async function writeConfig(root, overrides = {}) {
    const dataDir = overrides.dataDir ?? join(root, "data");
    const config = {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: overrides.agents ?? [{
            id: "echo",
            name: "Echo",
            role: "worker",
            capabilities: ["demo"],
            harness: { kind: "echo" },
        }],
        policy: overrides.policy ?? {
            rules: [{ id: "allow", effect: "allow", match: { category: "harness" } }],
        },
        ...(overrides.computer ? { computer: overrides.computer } : {}),
    };
    const path = join(root, "config.json");
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return { path, config, dataDir };
}

function checkById(report, id) {
    return report.checks.find((item) => item.id === id);
}

test("doctor rejects invalid policy version ids before filesystem interpolation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-doctor-policy-id-"));
    try {
        const { path, dataDir } = await writeConfig(root);
        const policyRoot = join(dataDir, "policy-versions");
        await mkdir(join(policyRoot, "versions"), { recursive: true });
        await writeFile(join(policyRoot, "active.json"), `${JSON.stringify({
            schemaVersion: 1,
            versionId: "../../outside-doctor-state",
            hash: "a".repeat(64),
            activatedAt: new Date().toISOString(),
        })}\n`, "utf8");

        const report = await runDoctor(path);
        assert.equal(report.overall, "error");
        assert.equal(doctorExitCode(report), 1);
        assert.equal(checkById(report, "security.policyVersion").status, "error");
        assert.match(checkById(report, "security.policyVersion").summary, /invalid versionId/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("missing provider CLI is warning while optional and error when durable work pins it", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-doctor-provider-required-"));
    try {
        const missingCommand = `definitely-missing-codex-${process.pid}`;
        const agent = {
            id: "codex-worker",
            name: "Codex worker",
            role: "worker",
            capabilities: ["coding"],
            harness: { kind: "codex", command: missingCommand },
        };
        const { path, dataDir } = await writeConfig(root, { agents: [agent] });

        const optional = await runDoctor(path);
        assert.equal(checkById(optional, "provider.codex-worker").status, "warning");
        assert.equal(checkById(optional, "provider.codex-worker").details.requiredNow, false);
        assert.equal(doctorExitCode(optional), 0);

        await mkdir(dataDir, { recursive: true });
        await writeFile(join(dataDir, "tasks.json"), `${JSON.stringify([{
            id: "task_pinned",
            kind: "work",
            title: "resume me",
            status: "queued",
            preferredAgentId: "codex-worker",
            requiredCapabilities: ["coding"],
        }], null, 2)}\n`, "utf8");

        const required = await runDoctor(path);
        assert.equal(checkById(required, "provider.codex-worker").status, "error");
        assert.equal(checkById(required, "provider.codex-worker").details.requiredNow, true);
        assert.equal(doctorExitCode(required), 1);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("doctor resolves a PATH-based command harness without executing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-doctor-path-command-"));
    try {
        const agent = {
            id: "path-worker",
            name: "PATH worker",
            role: "worker",
            capabilities: ["demo"],
            harness: { kind: "command", command: "node" },
        };
        const { path } = await writeConfig(root, { agents: [agent] });
        const report = await runDoctor(path);
        const provider = checkById(report, "provider.path-worker");
        assert.equal(provider.status, "ok");
        assert.match(provider.details.executable.toLowerCase(), /node(?:\.exe)?$/);
        assert.equal(doctorExitCode(report), 0);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("doctor does not mutate an existing empty runtime data directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-doctor-readonly-"));
    try {
        const { path, dataDir } = await writeConfig(root);
        await mkdir(dataDir, { recursive: true });
        const before = await readdir(dataDir);
        assert.deepEqual(before, []);

        const report = await runDoctor(path);
        assert.equal(report.passive, true);
        assert.equal(doctorExitCode(report), 0);
        assert.deepEqual(await readdir(dataDir), before);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("doctor reports an unsafe computer storage root without initializing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-doctor-computer-root-"));
    try {
        const { path, dataDir } = await writeConfig(root);
        await mkdir(dataDir, { recursive: true });
        await writeFile(join(dataDir, "computers"), "not-a-directory\n", "utf8");

        const report = await runDoctor(path);
        assert.equal(checkById(report, "computer.storage").status, "error");
        assert.equal(doctorExitCode(report), 1);
        assert.equal(await readFile(join(dataDir, "computers"), "utf8"), "not-a-directory\n");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("doctor keeps the structured JSON shape even when config parsing fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-doctor-schema-"));
    try {
        const path = join(root, "bad.json");
        await writeFile(path, "{ invalid json", "utf8");
        const report = await runDoctor(path);
        assert.equal(report.schemaVersion, 1);
        assert.equal(report.overall, "error");
        assert.equal(report.passive, true);
        assert.deepEqual(report.guarantees, {
            providerModelPromptsExecuted: false,
            browserStarted: false,
            webdriverStarted: false,
            automaticRepairPerformed: false,
        });
        assert.equal(Array.isArray(report.checks), true);
        assert.equal(checkById(report, "runtime.config").status, "error");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
