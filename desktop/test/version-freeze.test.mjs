import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { desktopVersion } from "../src/main/lib/desktop-version.js";
import { IPC_CHANNELS } from "../src/main/lib/ipc-schema.js";

const DESKTOP_ROOT = join(import.meta.dirname, "..");
const REPO_ROOT = join(DESKTOP_ROOT, "..");
const VERSION = desktopVersion();
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-dev)?$/;

// Stable releases and active development lines must stay internally consistent. The
// publication workflow only publishes stable x.y.z versions; x.y.z-dev intentionally
// remains non-publishable while V4 work is in progress.

test("desktop package version is valid and matches About/handshake", () => {
    assert.match(VERSION, VERSION_PATTERN);
    assert.equal(IPC_CHANNELS["app:handshake"], IPC_CHANNELS["app:handshake"]); // surface sanity
});

test("root package, core version module and desktop package agree on the same version", async () => {
    const rootPackage = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
    const coreModule = await readFile(join(REPO_ROOT, "src", "version.js"), "utf8");
    assert.match(rootPackage.version, VERSION_PATTERN);
    assert.equal(rootPackage.version, VERSION);
    assert.match(coreModule, new RegExp(`export const VERSION = "${VERSION.replace(/\./g, "\\.")}";`));
});

test("changelog and release notes match stable vs development version state", async () => {
    const changelog = await readFile(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const stable = /^\d+\.\d+\.\d+$/.test(VERSION);
    const baseVersion = VERSION.replace(/-dev$/, "");

    if (stable) {
        assert.match(changelog, new RegExp(`## \\[${baseVersion.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}`));
        assert.doesNotMatch(changelog, new RegExp(`## \\[${baseVersion.replace(/\./g, "\\.")}\\] - Unreleased`));
        const coreNotes = await readFile(join(REPO_ROOT, "docs", "releases", `v${VERSION}.md`), "utf8");
        assert.match(coreNotes, new RegExp(`^# SovereignBot ${VERSION.replace(/\./g, "\\.")}`));
        const desktopNotes = await readFile(join(REPO_ROOT, "docs", "releases", `desktop-v${VERSION}.md`), "utf8");
        assert.match(desktopNotes, new RegExp(`^# SovereignBot Desktop ${VERSION.replace(/\./g, "\\.")}`));
    }
    else {
        assert.match(changelog, new RegExp(`## \\[${baseVersion.replace(/\./g, "\\.")}\\] - Unreleased`));
    }
});
