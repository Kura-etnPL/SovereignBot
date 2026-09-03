import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
const ui = readFileSync(new URL("../ui/jobs-ui.js", import.meta.url), "utf8");
const gate = readFileSync(new URL("../src/main/verify-p50-job-actions.js", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");

test("P50 Work and Job Details use shared per-job action state and visible feedback", () => {
  for (const expression of [
    /const jobActionState = new Map\(\)/,
    /function runJobAction\(jobId, action, invoke/,
    /state\.pending\.has\(action\)/,
    /function jobActionPending\(jobId\)/,
    /button\.disabled = jobActionPending\(job\.id\)/,
    /jobFeedback/,
    /job-detail-feedback/,
    /job-detail-approve.*runJobAction/s,
    /job-detail-dismiss.*runJobAction/s,
    /job-detail-pause.*runJobAction/s,
    /job-detail-resume.*runJobAction/s,
    /jobDetailRequest/,
  ]) assert.match(ui, expression);
  for (const id of ["job-detail-feedback", "job-detail-approve", "job-detail-dismiss", "job-detail-pause", "job-detail-resume"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(ui, /meta\.textContent = `\$\{job\.ownerCoworkerId\}/);
  assert.doesNotMatch(ui, /job\.executionTarget\.nodeId/);
});

test("P50 Work and Job Details use safe public identity projections", () => {
  for (const expression of [
    /async function refreshPublicLabels\(\)/,
    /function ownerLabel\(job\)/,
    /function workspaceLabel\(job\)/,
    /Worker Node:/,
    /Worker workspace:/,
    /Assigned Coworker \/ 已分配同事/,
    /Trusted workspace \/ 受信工作区/,
    /Dismiss attention \/ 消退关注/,
    /safePublicText\(job\.error/,
  ]) assert.match(ui, expression);
  assert.match(ui, /safePublicText\(error\?\.message/);
  assert.doesNotMatch(ui, /job\.ownerCoworkerId\s*\}\s*·/);
  assert.doesNotMatch(ui, /job\.workspaceId\s*\}\s*·/);
});

test("P50 hidden gate covers card/detail actions, retry counts, isolation, and deterministic evidence", () => {
  for (const expression of [
    /Work cards use human-readable owner\/workspace\/Worker labels without opaque IDs/,
    /Work Retry failure is visible, retryable, single-call, and isolated to its Job/,
    /Work Dismiss clearly clears Attention without affecting another Job/,
    /Job Details Approve uses the shared pending action path/,
    /Job Details Pause is available only for a legal working state/,
    /Job Details Resume is available only for a legal waiting state/,
    /Job Details Dismiss clears Attention with scoped feedback/,
    /const workerNodeId = "worker_[0-9a-f]{16}"/,
    /executionTarget: \{ kind: "worker-node", nodeId: workerNodeId, workspaceId: workspace\.id \}/,
    /workerCard/,
    /document\.getElementById\("job-detail-dialog"\)\?\.close\(\)/,
    /textContent===\$\{JSON\.stringify\(title\)\}/,
    /classList\.contains\("hidden"\)/,
    /counts\.approve === 1/,
    /counts\.approve === 2/,
    /counts\.dismiss === 2/,
    /P50 evidence write failed/,
    /app\.exit\(1\)/,
    /app\.exit\(0\)/,
  ]) assert.match(gate, expression);
  assert.match(packageJson, /"verify:p50-job-actions"\s*:\s*"node scripts\/verify-p50-job-actions\.mjs"/);
  const evidenceWrite = gate.indexOf("verify-p50-job-actions.json");
  const exit = gate.indexOf("app.exit(1)");
  const teardown = gate.indexOf("win?.destroy");
  assert.ok(evidenceWrite >= 0 && exit > evidenceWrite && teardown > exit, "P50 evidence must precede explicit exit and teardown");
});
