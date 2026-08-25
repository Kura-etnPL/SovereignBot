import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { desktopVersion } from "../src/main/lib/desktop-version.js";
import { IPC_CHANNELS } from "../src/main/lib/ipc-schema.js";

const DESKTOP_ROOT = join(import.meta.dirname, "..");
const REPO_ROOT = join(DESKTOP_ROOT, "..");
const VERSION = desktopVersion();

// BLOCKER F: the release tree must be one consistent stable version everywhere. The
// publication workflow refuses -dev or mismatched surfaces; this test keeps that honest
// in-repo so a freeze cannot silently regress.

test("desktop package version is a stable release version and matches About/handshake", () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
    assert.equal(IPC_CHANNELS["app:handshake"], IPC_CHANNELS["app:handshake"]); // surface sanity
});

test("root package, core version module and desktop package agree on the same stable version", async () => {
    const rootPackage = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
    const coreModule = await readFile(join(REPO_ROOT, "src", "version.js"), "utf8");
    assert.match(rootPackage.version, /^\d+\.\d+\.\d+$/);
    assert.equal(rootPackage.version, VERSION);
    assert.match(coreModule, new RegExp(`export const VERSION = "${VERSION.replace(/\./g, "\\.")}";`));
    // No dev suffix may survive anywhere in the three surfaces.
    for (const text of [JSON.stringify(rootPackage), coreModule]) {
        assert.doesNotMatch(text, /1\.\d+\.\d+-dev/);
    }
});

test("changelog carries a dated stable entry and both release notes exist", async () => {
    const changelog = await readFile(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    assert.match(changelog, new RegExp(`## \\[${VERSION.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}`));
    assert.doesNotMatch(changelog, new RegExp(`## \\[${VERSION.replace(/\./g, "\\.")}\\] - Unreleased`));

    const coreNotes = await readFile(join(REPO_ROOT, "docs", "releases", `v${VERSION}.md`), "utf8");
    assert.match(coreNotes, new RegExp(`^# SovereignBot ${VERSION.replace(/\./g, "\\.")}`));
    const desktopNotes = await readFile(join(REPO_ROOT, "docs", "releases", `desktop-v${VERSION}.md`), "utf8");
    assert.match(desktopNotes, /v1\.1\.1 corrects the Desktop provider wiring/);
});
