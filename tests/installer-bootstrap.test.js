import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildRelease } from "../scripts/build-release.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function runWrapper({ installDir, manifest, core }) {
    if (process.platform === "win32") {
        return spawnSync("pwsh", [
            "-NoProfile",
            "-File",
            join(repoRoot, "install", "install.ps1"),
            "-InstallDir", installDir,
            "-Manifest", manifest,
            "-InstallerCore", core,
        ], { encoding: "utf8", windowsHide: true });
    }
    return spawnSync("sh", [
        join(repoRoot, "install", "install.sh"),
        "--install-dir", installDir,
        "--manifest", manifest,
        "--installer-core", core,
    ], { encoding: "utf8" });
}

test("bootstrap wrapper verifies portable installer core hash before executing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-bootstrap-tamper-"));
    const outDir = join(root, "dist");
    const installDir = join(root, "installed");
    try {
        await buildRelease({ outDir });
        const manifest = join(outDir, "release-manifest.json");
        const core = join(outDir, "portable-install.mjs");
        await appendFile(core, "\n// tampered after manifest\n", "utf8");

        const result = runWrapper({ installDir, manifest, core });
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}\n${result.stderr}`, /SHA-256 mismatch/i);
        await assert.rejects(() => readFile(join(installDir, "app", "package.json")), /ENOENT/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
