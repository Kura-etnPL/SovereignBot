import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { doctorExitCode, runDoctor } from "../src/doctor.js";
import { createRuntime } from "../src/runtime.js";

async function writeConfig(root, overrides = {}) {
    const dataDir = overrides.dataDir ?? join(root, "data");
    const config = {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: overrides.agents ?? [{ id: "echo", name: "Echo", role: "worker", capabilities: ["demo"], harness: { kind: "echo" } }],
        policy: overrides.policy ?? { rules: [{ id: "allow", effect: "allow", match: { category: "harness" } }] },
        ...(overrides.computer ? { computer: overrides.computer } : {}),
    };
    const path = join(root, "config.json");
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return { path, config };
}

function checkById(report, id) {
    return report.checks.find((item) => item.id === id);
}

test("doctor can assess an uninitialized echo runtime without starting runtime components", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-doctor-clean-"));
    try {
        const { path } = await writeConfig(root);
        const report = await runDoctor(path);
        assert.equal(report.overall, "ok");
        assert.equal(doctorExitCode(report), 0);
        assert.equal(report.passive, true);
        assert.deepEqual(report.guarantees, {
            providerModelPromptsExecuted: false,
            browserStarted: false,
            webdriverStarted: false,
            automaticRepairPerformed: false,
        });
        assert.equal(checkById(report, "runtime.node").status, "ok");
        assert.equal(checkById(report, "runtime.config").status, "ok");
        assert.equal(checkById(report, "runtime.dataDir").status, "ok");
        assert.equal(checkById(report, "security.policyVersion").status, "ok");
        assert.equal(checkById(report, "provider.echo").status, "ok");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("doctor never executes an arbitrary configured Codex launcher to probe auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-doctor-custom-provider-"));
    const marker = join(root, "should-not-run.txt");
    const fake = join(root, "fake-codex.mjs");
    try {
        await writeFile(fake, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); process.exit(0);\n`, "utf8");
        if (process.platform !== "win32")
            await chmod(fake, 0o755);
        const { path } = await writeConfig(root, {
            agents: [{
                id: "codex-custom",
                name: "Codex custom",
                role: "worker",
                capabilities: ["coding"],
                harness: { kind: "codex", command: process.execPath, prefixArgs: [fake] },
            }],
        });
        const report = await runDoctor(path);
        assert.equal(checkById(report, "provider.codex-custom").status, "warning");
        await assert.rejects(() => readFile(marker, "utf8"), /ENOENT/);
        assert.equal(doctorExitCode(report), 0);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("doctor validates configured browser/WebDriver paths without spawning them", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-doctor-browser-"));
    const marker = join(root, "browser-marker.txt");
    const fake = join(root, "fake-driver.mjs");
    try {
        await writeFile(fake, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");\n`, "utf8");
        if (process.platform !== "win32")
            await chmod(fake, 0o755);
        const { path } = await writeConfig(root, {
            computer: {
                allowPrivateHosts: false,
                driver: {
                    kind: "webdriver-sidecar",
                    browser: "chrome",
                    sidecarCommand: process.execPath,
                    webdriverCommand: process.execPath,
                    browserBinary: process.execPath,
                },
            },
        });
        const report = await runDoctor(path);
        assert.equal(checkById(report, "computer.sidecar").status, "ok");
        assert.equal(checkById(report, "computer.webdriver").status, "ok");
        assert.equal(checkById(report, "computer.browser").status, "ok");
        await assert.rejects(() => readFile(marker, "utf8"), /ENOENT/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("doctor reports corrupt audit and unresolved policy transaction without leaking durable secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-doctor-corrupt-"));
    const dataDir = join(root, "data");
    const secret = "DOCTOR-SECRET-MUST-NOT-LEAK";
    const providerSession = "provider-session-private";
    const { path, config } = await writeConfig(root, { dataDir });
    let runtime = await createRuntime(config);
    try {
        const workerToken = (await runtime.computer.agentCredentials("echo")).token;
        const operatorToken = (await runtime.computer.operatorCredentials()).token;
        await runtime.orchestrator.submit({ title: "private task", input: { secret }, requiredCapabilities: ["demo"] });
        const tasks = JSON.parse(await readFile(join(dataDir, "tasks.json"), "utf8"));
        tasks[0].harnessState = { kind: "codex", sessionId: providerSession };
        await writeFile(join(dataDir, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`, "utf8");

        const previous = runtime.policyManager.current();
        const target = await runtime.policyVersions.createVersion({ rules: [] }, { parentVersionId: previous.id });
        await runtime.policyVersions.beginActivation({ fromVersionId: previous.id, toVersionId: target.id, toHash: target.hash });

        await mkdir(join(dataDir, "tool-bridges"), { recursive: true });
        await writeFile(join(dataDir, "tool-bridges", "stale.bootstrap.json"), JSON.stringify({ capability: secret, token: workerToken }), "utf8");
        await runtime.close();
        runtime = undefined;

        const auditPath = join(dataDir, "audit.jsonl");
        const auditRows = (await readFile(auditPath, "utf8")).trimEnd().split(/\r?\n/).map((line) => JSON.parse(line));
        auditRows[0].actor = "tampered";
        await writeFile(auditPath, `${auditRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

        const report = await runDoctor(path);
        assert.equal(report.overall, "error");
        assert.equal(doctorExitCode(report), 1);
        assert.equal(checkById(report, "security.audit").status, "error");
        assert.equal(checkById(report, "security.policyTransaction").status, "error");
        assert.equal(checkById(report, "recovery.staleArtifacts").status, "warning");
        const serialized = JSON.stringify(report);
        assert.equal(serialized.includes(secret), false);
        assert.equal(serialized.includes(providerSession), false);
        assert.equal(serialized.includes(workerToken), false);
        assert.equal(serialized.includes(operatorToken), false);
    }
    finally {
        await runtime?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("doctor CLI JSON mode exits zero for warnings/ok and one for hard config errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-doctor-cli-"));
    try {
        const { path } = await writeConfig(root);
        const cli = join(process.cwd(), "src", "cli.js");
        const good = spawnSync(process.execPath, [cli, "doctor", "--json", "--config", path], { encoding: "utf8", windowsHide: true });
        assert.equal(good.status, 0, good.stderr || good.stdout);
        const report = JSON.parse(good.stdout);
        assert.equal(report.schemaVersion, 1);

        const badPath = join(root, "bad.json");
        await writeFile(badPath, "{ definitely not json", "utf8");
        const bad = spawnSync(process.execPath, [cli, "doctor", "--json", "--config", badPath], { encoding: "utf8", windowsHide: true });
        assert.equal(bad.status, 1);
        assert.equal(JSON.parse(bad.stdout).overall, "error");
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
