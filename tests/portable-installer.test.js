import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildRelease } from "../scripts/build-release.mjs";
import { assertNodeVersion, installPortable, validateManifest } from "../install/portable-install.mjs";

function runInstalledHelp(installDir) {
    if (process.platform === "win32") {
        const launcher = join(installDir, "bin", "sovereignbot.cmd");
        return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${launcher}" --help`], {
            encoding: "utf8",
            windowsHide: true,
        });
    }
    return spawnSync(join(installDir, "bin", "sovereignbot"), ["--help"], { encoding: "utf8" });
}

async function buildFixture(prefix) {
    const root = await mkdtemp(join(tmpdir(), prefix));
    const outDir = join(root, "dist");
    const built = await buildRelease({ outDir });
    return { root, outDir, built, manifestPath: join(outDir, "release-manifest.json") };
}

test("portable release build is deterministic and contains only declared product payload", async () => {
    const first = await buildFixture("sovereign-release-a-");
    const second = await buildFixture("sovereign-release-b-");
    try {
        const archiveA = await readFile(join(first.outDir, first.built.archiveName));
        const archiveB = await readFile(join(second.outDir, second.built.archiveName));
        assert.equal(first.built.archiveHash, second.built.archiveHash);
        assert.deepEqual(archiveA, archiveB);

        const paths = first.built.manifest.files.map((file) => file.path);
        assert.ok(paths.includes("src/cli.js"));
        assert.ok(paths.includes("sidecars/webdriver/server.js"));
        assert.ok(paths.includes("ui/index.html"));
        assert.ok(paths.includes("docs/roadmap.md"));
        assert.ok(paths.some((path) => path.startsWith("examples/")));
        assert.equal(paths.some((path) => path.startsWith("tests/")), false);
        assert.equal(paths.some((path) => path.startsWith(".git/")), false);
        assert.equal(paths.some((path) => path.startsWith(".sovereignbot/")), false);
        assert.deepEqual(
            first.built.manifest.installers.map((entry) => entry.file).sort(),
            ["install.ps1", "install.sh", "portable-install.mjs"],
        );
    }
    finally {
        await rm(first.root, { recursive: true, force: true });
        await rm(second.root, { recursive: true, force: true });
    }
});

test("portable installer verifies a local release, runs the launcher, and preserves unrelated files on reinstall", async () => {
    const fixture = await buildFixture("sovereign-install-ok-");
    const installDir = join(fixture.root, "installed");
    const keepPath = join(installDir, "keep-user-file.txt");
    try {
        await writeFile(keepPath, "keep me", { encoding: "utf8", flag: "wx" }).catch(async (error) => {
            if (error.code !== "ENOENT") throw error;
        });
        // Parent does not exist yet on the first write attempt; create it by performing the install.
        const first = await installPortable({ installDir, manifestSource: fixture.manifestPath });
        await writeFile(keepPath, "keep me", "utf8");
        assert.equal(first.version, fixture.built.manifest.version);
        const help = runInstalledHelp(installDir);
        assert.equal(help.status, 0, help.stderr || help.stdout);
        assert.match(help.stdout, /SovereignBot/);

        const second = await installPortable({ installDir, manifestSource: fixture.manifestPath });
        assert.equal(second.version, first.version);
        assert.equal(await readFile(keepPath, "utf8"), "keep me");
        const installedManifest = JSON.parse(await readFile(join(installDir, "install-manifest.json"), "utf8"));
        assert.equal(installedManifest.archive.sha256, fixture.built.archiveHash);
        assert.equal(installedManifest.installedFrom, "local-manifest");
    }
    finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

test("corrupted archive is refused before an existing app is replaced", async () => {
    const fixture = await buildFixture("sovereign-install-corrupt-");
    const installDir = join(fixture.root, "installed");
    try {
        await installPortable({ installDir, manifestSource: fixture.manifestPath });
        const marker = join(installDir, "app", "existing-marker.txt");
        await writeFile(marker, "old install survives", "utf8");

        const archivePath = join(fixture.outDir, fixture.built.archiveName);
        const bytes = await readFile(archivePath);
        bytes[Math.floor(bytes.length / 2)] ^= 0xff;
        await writeFile(archivePath, bytes);

        await assert.rejects(
            () => installPortable({ installDir, manifestSource: fixture.manifestPath }),
            /SHA-256 mismatch/,
        );
        assert.equal(await readFile(marker, "utf8"), "old install survives");
    }
    finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

test("failed upgrade after app swap restores the previous app", async () => {
    const fixture = await buildFixture("sovereign-install-rollback-");
    const installDir = join(fixture.root, "installed");
    try {
        await installPortable({ installDir, manifestSource: fixture.manifestPath });
        const marker = join(installDir, "app", "old-marker.txt");
        await writeFile(marker, "rollback target", "utf8");

        const binDir = join(installDir, "bin");
        await rm(binDir, { recursive: true, force: true });
        await writeFile(binDir, "block launcher directory", "utf8");

        await assert.rejects(
            () => installPortable({ installDir, manifestSource: fixture.manifestPath }),
            /EEXIST|ENOTDIR|not a directory/i,
        );
        assert.equal(await readFile(marker, "utf8"), "rollback target");
    }
    finally {
        await rm(fixture.root, { recursive: true, force: true });
    }
});

test("installer rejects invalid Node versions and unsafe manifest paths", () => {
    assert.throws(() => assertNodeVersion(22, "21.9.0"), /requires Node\.js 22\+/);
    assert.doesNotThrow(() => assertNodeVersion(22, "22.0.0"));
    assert.throws(
        () => validateManifest({
            schemaVersion: 1,
            name: "sovereignbot",
            version: "0.4.0",
            node: { minimumMajor: 22 },
            archive: { file: "../evil.tar.gz", format: "tar.gz", root: "sovereignbot", sha256: "a".repeat(64), bytes: 1 },
            files: [{ path: "src/cli.js", sha256: "b".repeat(64), bytes: 1 }],
        }),
        /clean relative path|file name/,
    );
});
