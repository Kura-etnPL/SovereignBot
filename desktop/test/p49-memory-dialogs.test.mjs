import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const memory = readFileSync(new URL("../ui/memory-ui.js", import.meta.url), "utf8");

test("P49 Memory edit/delete uses shared product dialogs across library and Conversation Details", () => {
  for (const id of ["memory-edit-dialog", "memory-delete-dialog", "memory-delete-form", "memory-delete-scope", "memory-delete-summary", "memory-delete-form-error", "memory-delete-confirm"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(app, /sovereignbotMemoryUi\?\.openEditDialog/);
  assert.match(app, /sovereignbotMemoryUi\?\.openDeleteDialog/);
  assert.match(app, /memoryDetailsRequest/);
  assert.doesNotMatch(app.slice(app.indexOf("async function renderMemorySection"), app.indexOf("function renderCoworkerConnectedApps")), /window\.(prompt|confirm)\s*\(/);
  assert.doesNotMatch(memory, /window\.(prompt|confirm)\s*\(/);
});

test("P49 Memory actions are duplicate-safe, retryable, scoped, and refresh both surfaces", () => {
  for (const expression of [
    /const pendingMemoryActions = new Set\(\)/,
    /pendingMemoryActions\.add\(current\.key\)/,
    /memory-delete-form-error/,
    /current\.onSaved\?\.\(updated\)/,
    /current\.onDeleted\?\.\(\)/,
    /await refresh\(\)/,
    /scope: current\.scope, ownerId: current\.ownerId, memoryId: current\.id/,
    /content\)\.replace\(\/\\s\+\/g, " "\)\.trim\(\)\.slice\(0, 240\)/,
  ]) assert.match(memory, expression);
  assert.match(app, /requestId !== state\.memoryDetailsRequest/);
  assert.match(app, /button\.disabled = true/);
  assert.match(app, /actionStatus\.textContent/);
  assert.doesNotMatch(memory, /workspacePath|providerToken|credential|sessionId|rawPath/);
});
