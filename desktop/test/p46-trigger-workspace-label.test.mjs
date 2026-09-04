import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ui = readFileSync(new URL("../ui/triggers-ui.js", import.meta.url), "utf8");
const gate = readFileSync(new URL("../src/main/verify-v44-event-triggers.js", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");

test("P46 Trigger workspace selector uses the safe public workspace projection", () => {
  assert.match(ui, /function workspaceDisplayLabel\(workspace\)/);
  assert.match(ui, /option\.textContent = workspaceDisplayLabel\(workspace\)/);
  assert.doesNotMatch(ui, /option\.textContent = workspace\.path/);
  assert.doesNotMatch(ui, /workspace\?\.path/);
});

test("P46 hidden Electron gate proves two labels, opaque submit payload, and no path leak", () => {
  assert.match(gate, /Trigger workspace selector shows two recognizable public workspace labels/);
  assert.match(gate, /Trigger workspace selector contains no absolute workspace path/);
  assert.match(gate, /Trigger form submits only opaque workspaceId and governed relative fields/);
  assert.match(gate, /triggerCreatePayloads\.push\(structuredClone\(payload\)\)/);
  assert.match(packageJson, /"verify:p46-trigger-workspace-label"\s*:\s*"node scripts\/verify-v44-event-triggers\.mjs"/);
});
