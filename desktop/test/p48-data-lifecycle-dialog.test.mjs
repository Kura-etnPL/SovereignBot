import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const app = read("../ui/app.js");
const gate = read("../src/main/verify-p48-data-lifecycle.js");
const packageJson = JSON.parse(read("../package.json"));
const lifecycleStart = app.indexOf("function ensureDataLifecycleCard()");
const lifecycleEnd = app.indexOf("function ensureUpdateCard()", lifecycleStart);
const lifecycle = app.slice(lifecycleStart, lifecycleEnd);

test("P48 Data Lifecycle uses non-blocking product dialogs with safe renderer boundaries", () => {
  assert.ok(lifecycleStart >= 0 && lifecycleEnd > lifecycleStart);
  for (const id of ["data-lifecycle-restore-dialog", "data-lifecycle-reset-dialog", "data-lifecycle-reset-phrase"]) assert.match(lifecycle, new RegExp(id));
  assert.match(lifecycle, /showModal\?\.\(\)/);
  assert.match(lifecycle, /data-close-dialog/);
  assert.match(lifecycle, /phrase\.value !== "RESET"/);
  assert.match(lifecycle, /dataLifecycle\.prepareReset\(\{\}\)/);
  assert.match(lifecycle, /dataLifecycle\.reset\(\{ confirmation: prepared\.confirmation, backupId: prepared\.backupId \}\)/);
  assert.match(lifecycle, /pending\.add\("reset"\)/);
  assert.match(lifecycle, /pending\.size > 0/);
  assert.doesNotMatch(lifecycle, /window\.(confirm|prompt)\s*\(/);
  assert.doesNotMatch(lifecycle, /innerHTML\s*=/);
  assert.doesNotMatch(lifecycle, /textContent\s*=\s*prepared\.(confirmation|backupId)/);
  assert.match(lifecycle, /safeError\(error/);
});

test("P48 hidden Electron gate covers confirmation, cancellation, duplicate, and failure paths", () => {
  for (const phrase of [
    "Restore cancel closes product dialog without IPC or write",
    "Restore IPC failure stays visible, keeps dialog retryable, and retry succeeds",
    "Clean Reset cancel closes dialog without prepare/reset IPC",
    "Clean Reset wrong phrase is blocked without write",
    "Clean Reset prepare IPC failure is visible, non-destructive, and duplicate-safe",
    "Clean Reset exact RESET uses opaque backend confirmation and refreshes safely",
  ]) assert.match(gate, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(packageJson.scripts["verify:p48-data-lifecycle"], "node scripts/verify-p48-data-lifecycle.mjs");
});
