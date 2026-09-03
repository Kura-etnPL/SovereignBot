import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ui = readFileSync(new URL("../ui/jobs-ui.js", import.meta.url), "utf8");
const verifier = readFileSync(new URL("../src/main/verify-routines.js", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");

test("P47 Routine lifecycle actions use per-card pending state and product feedback", () => {
  for (const expression of [
    /routineActionPending\.add\(routineId\)/,
    /async function toggleRoutineFromCard\(routineId\)/,
    /async function archiveRoutineFromCard\(routineId\)/,
    /function openRoutineRemoveDialog\(routineId\)/,
    /async function confirmRoutineRemoval\(\)/,
    /routine-action-feedback/,
    /routine-action-status/,
  ]) assert.match(ui, expression);
  assert.match(ui, /routine-remove-dialog/);
  assert.match(ui, /permanently removes the Routine/);
  assert.doesNotMatch(ui, /window\.(?:confirm|prompt)\s*\(/);
});

test("P47 gate covers lifecycle transitions, cancellation, retry, and double-click suppression", () => {
  for (const expression of [
    /Routine lifecycle actions use a product dialog instead of window confirm or prompt/,
    /real Routines UI Disable then Enable keeps one card bound and shows success/,
    /real Routines UI Archive then Restore keeps existing recoverable semantics/,
    /Remove cancel leaves the selected Routine unchanged/,
    /Remove confirm permanently removes only the selected Routine with visible success/,
    /injected Enable-state IPC failure is visible and retry succeeds/,
    /injected Remove IPC failure preserves the card and retry removes it/,
    /double-clicking Remove confirmation issues one IPC call/,
  ]) assert.match(verifier, expression);
  assert.match(packageJson, /"verify:p47-routine-lifecycle"\s*:\s*"node scripts\/verify-p30-routine-actions\.mjs"/);
});
