import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const RELEASE_DATE = "2026-08-24";

test("stable release version is synchronized across package, CLI, health, changelog, and notes", async () => {
    const packageJson = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(packageJson.version, "1.0.0");
    assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);

    const help = spawnSync(process.execPath, [CLI_PATH, "--help"], {
        encoding: "utf8",
        windowsHide: true,
    });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, new RegExp(`SovereignBot ${packageJson.version.replaceAll(".", "\\.")}`));
    assert.equal(help.stdout.includes("0.4-dev"), false);

    const changelog = await readFile(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    assert.ok(changelog.includes(`## [${packageJson.version}] - ${RELEASE_DATE}`));
    assert.equal(changelog.includes(`## [${packageJson.version}] - Unreleased`), false);

    const notes = await readFile(join(REPO_ROOT, "docs", "releases", `v${packageJson.version}.md`), "utf8");
    assert.match(notes, new RegExp(`^# SovereignBot ${packageJson.version.replaceAll(".", "\\.")}\\r?\\n`));

    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-release-version-"));
    let runtime;
    let server;
    try {
        runtime = await createRuntime({
            dataDir,
            bindHost: "127.0.0.1",
            port: 0,
            agents: [{
                id: "echo",
                name: "Echo",
                role: "worker",
                capabilities: ["demo"],
                harness: { kind: "echo" },
            }],
            policy: {
                rules: [{ id: "allow", effect: "allow", match: { category: "harness" } }],
            },
        });
        server = await startServer(runtime);
        const response = await fetch(`${server.url}/health`);
        assert.equal(response.status, 200);
        const health = await response.json();
        assert.equal(health.version, packageJson.version);
        assert.equal(String(health.version).includes("dev"), false);
    }
    finally {
        await server?.close();
        await runtime?.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});
