import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ui = readFileSync(new URL("../ui/jobs-ui.js", import.meta.url), "utf8");
const gate = readFileSync(new URL("../src/main/verify-p51-routine-history.js", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");

test("P51 Routine History Retry binds pending and feedback to routineId plus runId", () => {
  for (const expression of [
    /const routineHistoryActionState = new Map\(\)/,
    /function routineRunState\(routineId, runId\)/,
    /function routineHistoryPending\(routineId\)/,
    /function retryRoutineRun\(routineId, runId\)/,
    /routineHistoryActionState\.get\(routineId\)/,
    /data-routine-history-retry/,
    /routineRunFeedback/,
    /window\.sovereignbot\.routines\.retry\(\{ routineId, runId \}\)/,
    /routineDetailRequest/,
    /request !== routineDetailRequest/,
    /routineActionPending\.has\(routine\.id\) \|\| routineHistoryPending\(routine\.id\)/,
  ]) assert.match(ui, expression);
  assert.doesNotMatch(ui, /retry\.addEventListener\("click", async \(\) => \{ await window\.sovereignbot\.routines\.retry/);
  assert.doesNotMatch(ui, /window\.\s*(?:prompt|confirm)\s*\(/);
});

test("P51 hidden gate covers injected failure, duplicate suppression, isolation, and final Job state", () => {
  for (const expression of [
    /Injected P51 history retry failure/,
    /button\?\.click\(\); button\?\.click\(\)/,
    /same Routine lifecycle controls lock while a history retry is pending/,
    /another Routine has no cross-routine retry feedback or lock/,
    /injected History Retry failure is visible, single-call, and retryable/,
    /successful retry refreshes History and reaches a completed Job/,
    /routineId === failures\.routineId && runId === failures\.runId/,
    /counts\.retry === 1/,
    /counts\.retry === 2/,
    /jobs\.flush\(\)/,
    /routine_\[a-f0-9\]\{16\}/,
    /run_\[a-f0-9\]\{16\}/,
    /native dialogs absent/,
  ]) assert.match(gate, expression);
  assert.match(packageJson, /"verify:p51-routine-history"\s*:\s*"node scripts\/verify-p51-routine-history\.mjs"/);
});
