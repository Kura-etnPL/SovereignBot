import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUpdateService, UPDATE_METADATA_SCHEMA, validateUpdateMetadata, verifyUpdateArtifact } from "../src/main/update-service.js";

async function fixture(channel = "preview", version = "4.0.1") {
    const root = await mkdtemp(join(tmpdir(), "sovereign-update-"));
    const feed = join(root, "feed"); await mkdir(feed);
    const content = Buffer.from("local signed-boundary fixture");
    const sha256 = createHash("sha256").update(content).digest("hex");
    await writeFile(join(feed, "SovereignBot-update.nupkg"), content);
    await writeFile(join(feed, "update.json"), JSON.stringify({ schema: UPDATE_METADATA_SCHEMA, version, channel, minCurrentVersion: "4.0.0", requiresBackup: true, artifact: { name: "SovereignBot-update.nupkg", path: "SovereignBot-update.nupkg", size: content.length, sha256 }, signature: { status: channel === "stable" ? "signed" : "unsigned", verified: channel === "stable" } }));
    return { root, feed };
}

test("local update metadata rejects downgrade, channel mismatch, bad hash, and unsigned stable", async () => {
    const { root, feed } = await fixture("preview", "3.9.9");
    try {
        const metadata = JSON.parse(await (await import("node:fs/promises")).readFile(join(feed, "update.json"), "utf8"));
        assert.throws(() => validateUpdateMetadata(metadata, { currentVersion: "4.0.0", channel: "preview", feedRoot: feed }), /downgrade/);
        metadata.version = "4.0.1"; metadata.channel = "stable";
        assert.throws(() => validateUpdateMetadata(metadata, { currentVersion: "4.0.0", channel: "preview", feedRoot: feed }), /channel mismatch/);
        metadata.channel = "preview"; metadata.artifact.sha256 = "0".repeat(64);
        await assert.rejects(() => verifyUpdateArtifact(metadata, feed), /hash or size mismatch/);
        metadata.artifact.sha256 = createHash("sha256").update("local signed-boundary fixture").digest("hex"); metadata.channel = "stable"; metadata.signature = { status: "unsigned", verified: false };
        assert.throws(() => validateUpdateMetadata(metadata, { currentVersion: "4.0.0", channel: "stable", feedRoot: feed }), /unsigned/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("preview update checks, creates the P6 pre-update backup, verifies, and only applies explicitly", async () => {
    const { root, feed } = await fixture();
    const dataDir = join(root, "data");
    const calls = [];
    try {
        const updates = createUpdateService({ dataDir, currentVersion: "4.0.0", getChannel: () => "preview", feedRoot: feed, dataLifecycle: { backup: async (value) => { calls.push(value); return { id: "pre-update-test" }; } }, updateExecutor: async (value) => { calls.push({ apply: value }); return { requested: true }; } });
        const checked = await updates.check();
        assert.equal(checked.available.version, "4.0.1");
        assert.equal(checked.available.artifact.sha256.length, 64);
        assert.equal(checked.staged, null);
        const staged = await updates.stage();
        assert.equal(staged.staged.backupId, "pre-update-test");
        assert.equal(calls.length, 1);
        const applied = await updates.apply();
        assert.equal(applied.restartRequired, true);
        assert.equal(calls.length, 2);
    } finally { await rm(root, { recursive: true, force: true }); }
});
