import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const app = read("../ui/app.js");
const gate = read("../src/main/verify-update-apply-dialog.js");
const entry = read("../src/main/verify-update-apply-dialog-entry.js");
const runner = read("../scripts/verify-update-apply-dialog.mjs");
const start = app.indexOf("function ensureUpdateCard()");
const end = app.indexOf("async function refreshSettingsData()", start);
const updateCard = app.slice(start, end);

test("Update Apply uses a product dialog and the existing typed apply contract", () => {
  assert.ok(start >= 0 && end > start);
  for (const id of ["update-apply-dialog", "update-apply-form", "update-apply-summary", "update-apply-error", "update-apply-confirm", "update-apply-cancel"]) assert.match(updateCard, new RegExp(id));
  assert.match(updateCard, /window\.sovereignbot\.updates\.apply\(\{\}\)/);
  assert.match(updateCard, /event\.preventDefault\(\)/);
  assert.match(updateCard, /if \(applyPending\) return/);
  assert.match(updateCard, /restart required/);
  assert.doesNotMatch(updateCard, /window\.(confirm|prompt)\s*\(/);
});

test("Update Apply failure remains visible and retryable", () => {
  assert.match(updateCard, /setApplyError\(safeError\(error/);
  assert.match(updateCard, /staged update remains available to retry/);
  assert.match(updateCard, /applyConfirm\.disabled = applyPending/);
  assert.match(updateCard, /applyCancel\.disabled = applyPending/);
});

test("Update Apply gate keeps the app alive until evidence is written and fails closed", () => {
  assert.match(gate, /writeFile\(join\(evidenceDir, "verify-update-apply-dialog\.json"\)/);
  assert.doesNotMatch(gate, /app\?\.exit\?\.\(0\)/);
  for (const expression of [/window-all-closed/, /event\.preventDefault\(\)/, /gateFinished/]) assert.match(entry, expression);
  for (const expression of [/const hasFailure/, /gateExit=/, /!hasPass/]) assert.match(runner, expression);
});
