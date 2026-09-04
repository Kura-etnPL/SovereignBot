import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");

test("Settings keeps the existing Advanced gate and canonical IDs", () => {
  assert.match(html, /<details class="settings-card span-2 advanced-card">/);
  assert.doesNotMatch(html, /<details[^>]+advanced-card[^>]+open/);
  for (const id of ["provider-cards", "workspace-manager-list", "advanced-roster", "setting-language", "provision-driver"]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must remain addressable`);
  }
  assert.match(app, /const alreadyGrouped = cards\.length > 0 && cards\.every\(\(card\) => advanced\.contains\(card\)\)/);
  assert.match(app, /settings\.advancedDesc/);
});
