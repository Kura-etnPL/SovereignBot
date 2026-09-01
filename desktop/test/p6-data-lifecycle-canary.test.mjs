import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDesktopDataLifecycle, DESKTOP_LIFECYCLE_SCHEMA } from "../src/main/data-lifecycle.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sovereignbot-p6-"));
  await mkdir(join(root, "desktop-state"), { recursive: true });
  await mkdir(join(root, "computers"), { recursive: true });
  await mkdir(join(root, "artifacts", "artifact_0123456789abcdef"), { recursive: true });
  await writeFile(join(root, "tasks.json"), "[]\n");
  await writeFile(join(root, "desktop-state", "settings.json"), JSON.stringify({ schema: "sovereignbot.desktop.settings.v1", theme: "dark", providerToken: "must-not-export" }));
  await writeFile(join(root, "desktop-state", "workspaces.json"), JSON.stringify({ schema: "sovereignbot.desktop.workspaces.v1", workspaces: [{ id: "workspace_1", path: join(root, "private-workspace") }] }));
  await writeFile(join(root, "desktop-state", "artifacts.json"), JSON.stringify({ schema: "sovereignbot.desktop.artifacts.v1", artifacts: [{ id: "artifact_0123456789abcdef", title: "note", fileName: "note.txt", mimeType: "text/plain", size: 11, sha256: "0000000000000000000000000000000000000000000000000000000000000000", storageRelativePath: "artifact_0123456789abcdef/note.txt", createdAt: new Date().toISOString() }] }));
  await writeFile(join(root, "artifacts", "artifact_0123456789abcdef", "note.txt"), "hello world");
  await writeFile(join(root, "computers", "state.json"), JSON.stringify({ version: 2, agents: {} }));
  await writeFile(join(root, "desktop-state", "worker-node-credentials.json"), "private-credential");
  return root;
}

test("P6 migrates V3 state idempotently, backs up, exports redacted artifact data, and restores product state", async () => {
  const root = await fixture();
  try {
    const lifecycle = createDesktopDataLifecycle({ dataDir: root });
    const first = await lifecycle.migrate();
    assert.equal(first.migrated, true);
    assert.equal((await lifecycle.migrate()).migrated, false);
    const marker = JSON.parse(await readFile(join(root, "desktop-state", "lifecycle.json"), "utf8"));
    assert.equal(marker.schema, DESKTOP_LIFECYCLE_SCHEMA);
    const backup = await lifecycle.backup({ id: "canary-backup" });
    assert.equal(backup.id, "canary-backup");
    await writeFile(join(root, "desktop-state", "settings.json"), JSON.stringify({ schema: "sovereignbot.desktop.settings.v1", theme: "light" }));
    const restored = await lifecycle.restoreBackup({ id: backup.id });
    assert.equal(restored.restored, true);
    assert.equal(JSON.parse(await readFile(join(root, "desktop-state", "settings.json"), "utf8")).theme, "dark");
    assert.equal(await readFile(join(root, "desktop-state", "worker-node-credentials.json"), "utf8"), "private-credential");
    const exported = await lifecycle.exportData({ id: "canary-export" });
    assert.equal(exported.restorable, false);
    const exportJson = await readFile(join(`${root}.exports`, "canary-export", "files", "metadata", "desktop-state.json"), "utf8");
    assert.equal(exportJson.includes("must-not-export"), false);
    assert.equal(exportJson.includes(root), false);
    assert.equal(await readFile(join(`${root}.exports`, "canary-export", "files", "artifacts", "artifact_0123456789abcdef", "note.txt"), "utf8"), "hello world");
  } finally { await rm(root, { recursive: true, force: true }); await rm(`${root}.backups`, { recursive: true, force: true }); await rm(`${root}.exports`, { recursive: true, force: true }); }
});

test("P6 clean reset requires confirmation, preserves protected state, and removes only product state", async () => {
  const root = await fixture();
  try {
    const lifecycle = createDesktopDataLifecycle({ dataDir: root });
    await lifecycle.migrate();
    await assert.rejects(() => lifecycle.cleanReset({ confirmation: "nope", backupId: "missing" }), /fresh confirmed backup/);
    const prepared = await lifecycle.prepareReset();
    const result = await lifecycle.cleanReset(prepared);
    assert.equal(result.reset, true);
    assert.equal((await lstat(join(root, "desktop-state", "settings.json")).catch(() => undefined)), undefined);
    assert.equal(await readFile(join(root, "computers", "state.json"), "utf8"), JSON.stringify({ version: 2, agents: {} }));
    assert.equal(await readFile(join(root, "desktop-state", "worker-node-credentials.json"), "utf8"), "private-credential");
  } finally { await rm(root, { recursive: true, force: true }); await rm(`${root}.backups`, { recursive: true, force: true }); }
});

test("P6 rejects a tampered backup hash", async () => {
  const root = await fixture();
  try {
    const lifecycle = createDesktopDataLifecycle({ dataDir: root });
    const backup = await lifecycle.backup({ id: "tamper-backup" });
    await writeFile(join(`${root}.backups`, backup.id, "files", "desktop-state", "settings.json"), "tampered");
    await assert.rejects(() => lifecycle.inspectBackup(backup.id), /hash mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(`${root}.backups`, { recursive: true, force: true }); }
});

test("P6 rejects injected authority and traversal paths in a backup manifest", async () => {
  const root = await fixture();
  try {
    const lifecycle = createDesktopDataLifecycle({ dataDir: root });
    const backup = await lifecycle.backup({ id: "manifest-backup" });
    const manifestPath = join(`${root}.backups`, backup.id, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files.push({ path: "desktop-state/worker-node-credentials.json", size: 0, sha256: "0".repeat(64) });
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(() => lifecycle.inspectBackup(backup.id), /unsupported state path/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(`${root}.backups`, { recursive: true, force: true }); }
});

test("P6 migration commit failure leaves V3 marker unchanged and records Attention", async () => {
  const root = await fixture();
  try {
    const lifecycle = createDesktopDataLifecycle({ dataDir: root, migrationHook: async () => { throw new Error("injected migration failure"); } });
    await assert.rejects(() => lifecycle.migrate(), /injected migration failure/);
    assert.equal(await lstat(join(root, "desktop-state", "lifecycle.json")).catch(() => undefined), undefined);
    const attention = JSON.parse(await readFile(join(root, "desktop-state", "attention.json"), "utf8"));
    assert.equal(attention.reason, "migration-failed");
  } finally { await rm(root, { recursive: true, force: true }); await rm(`${root}.backups`, { recursive: true, force: true }); }
});
