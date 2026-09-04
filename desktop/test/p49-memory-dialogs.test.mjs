import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
const memory = readFileSync(new URL("../ui/memory-ui.js", import.meta.url), "utf8");
const gate = readFileSync(new URL("../src/main/verify-p49-memory-dialogs.js", import.meta.url), "utf8");

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

test("P49 hidden gate writes evidence before window teardown and exits nonzero on failure", () => {
  assert.match(gate, /process\.stdout\.write\(`\$\{line\}/);
  assert.match(gate, /process\.stdout\.write\(`\$\{exitCode \? "FAIL" : "PASS"\}/);
  assert.match(gate, /if \(exitCode\) \{ app\.exit\(1\);/);
  const evidenceWrite = gate.indexOf("verify-p49-memory-dialogs.json");
  const exitDecision = gate.indexOf("app.exit(1)");
  const teardown = gate.indexOf("win\?\.destroy");
  assert.ok(evidenceWrite >= 0 && exitDecision > evidenceWrite && teardown > exitDecision, "evidence and exit decision must precede BrowserWindow teardown");
  for (const expression of [
    /"data:status": \(\) => \(\{ backups: \[\] \}\)/,
    /"data:listBackups": \(\) => \(\{ backups: \[\] \}\)/,
    /"skill:list": \(\) => \(\{ skills: \[\] \}\)/,
    /"eventTrigger:list": \(\) => \(\{ triggers: \[\] \}\)/,
    /"notification:list": \(\) => \(\{ notifications: \[\] \}\)/,
    /"conversation:createTeam":/,
    /"conversation:acknowledge": \(\) => \(\{ ok: true \}\)/,
    /"team:activity": \(\) => \(\{ events: \[\] \}\)/,
  ]) assert.match(gate, expression);
  assert.match(gate, /waitForRenderer\(win,/);
  assert.match(gate, /#view-memory:not\(\.hidden\)/);
  assert.match(gate, /target main Memory row/);
  assert.match(gate, /rows\.find\(\(entry\)=>entry\.textContent\.includes\("P49 Memory"\)/);
  assert.doesNotMatch(gate, /const card=document\.querySelector\("#memory-list \.memory-row"\)/);
  assert.match(gate, /Details Memory row/);
  assert.match(gate, /targetCoworker.*state === "active"/s);
  assert.match(gate, /!editFailure\.disabled && failures\.editCalls === 1/);
  assert.match(gate, /!deleteFailure\.disabled && failures\.deleteCalls === 1/);
  assert.match(gate, /editCalls === 2/);
  assert.match(gate, /deleteCalls === 2/);
});
