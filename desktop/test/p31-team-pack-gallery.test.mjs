import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../ui/product-hubs-ui.js", import.meta.url), "utf8");
const verifier = readFileSync(new URL("../src/main/verify-p31-team-pack-gallery.js", import.meta.url), "utf8");
const legacyStart = source.indexOf("function renderPacks(items)");
const legacyEnd = source.indexOf("function renderWorkspaceSwitcher", legacyStart);
const legacy = source.slice(legacyStart, legacyEnd);
const canonicalStart = source.indexOf("async function openPackEditor(item)");
const canonicalEnd = source.indexOf("function packs(items)", canonicalStart);
const canonical = source.slice(canonicalStart, canonicalEnd);

test("P31 legacy Product hubs Team Pack cards delegate edit/export to the canonical page controller", () => {
  assert.notEqual(legacyStart, -1);
  assert.match(legacy, /dataset\.teamPackId/);
  assert.match(legacy, /sovereignbot:open-team-pack-editor/);
  assert.match(legacy, /sovereignbot:export-team-pack/);
  assert.doesNotMatch(legacy, /window\.prompt|navigator\.clipboard|api\.teams\.editPack/);
});

test("P31 event bridge reuses the structured editor and native file exporter", () => {
  assert.match(canonical, /openPackEditor\(item\)/);
  assert.match(canonical, /exportPackToFile\(item\)/);
  assert.match(canonical, /team-pack-editor-dialog/);
  assert.doesNotMatch(canonical, /window\.prompt|navigator\.clipboard/);
  assert.match(source, /api\.teams\.exportPackViaDialog/);
  assert.match(source, /api\.teams\.editPack/);
});

test("P31 dedicated Team Pack entry keeps first-party read-only and custom Duplicate/Edit affordances", () => {
  const page = source.slice(source.indexOf("function packs(items)"), source.indexOf("function channels(items)"));
  assert.match(page, /button\("Duplicate \/ 复制"/);
  assert.match(page, /if \(item\.custom\).*Edit recipe \/ 编辑配方/);
  assert.match(page, /button\("Export \/ 导出", \(\) => exportPackToFile\(item\)/);
});

test("P31 verifier uses bounded native input for the older-gallery Duplicate control", () => {
  assert.match(verifier, /async function clickVisibleElementWithInput\(win, selector, label\)/);
  assert.match(verifier, /console-message/);
  assert.match(verifier, /render-process-gone/);
  assert.match(verifier, /async function probeDuplicateState\(win\)/);
  assert.match(verifier, /errorSummary/);
  assert.match(verifier, /sendInputEvent completed; state probe pending/);
  assert.match(verifier, /scrollIntoView\(\{block:"center",inline:"center"\}\)/);
  assert.match(verifier, /getBoundingClientRect\(\)/);
  assert.match(verifier, /values\.every\(Number\.isFinite\)/);
  assert.match(verifier, /sendInputEvent\(\{ type: "mouseMove"/);
  assert.match(verifier, /sendInputEvent\(\{ type: "mouseDown"/);
  assert.match(verifier, /sendInputEvent\(\{ type: "mouseUp"/);
  assert.match(verifier, /clickVisibleElementWithInput\(win, "#product-packs/);
  assert.doesNotMatch(verifier, /OLD_DUPLICATE_CLICK_EXPRESSION/);
  assert.doesNotMatch(verifier, /invoke\(win, duplicateClickExpression\)/);
});
