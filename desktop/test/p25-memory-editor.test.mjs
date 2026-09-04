import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "ui/index.html"), "utf8");
const ui = readFileSync(join(root, "ui/memory-ui.js"), "utf8");

test("P25 Memory editor is a bounded product dialog, not a prompt flow", () => {
  for (const id of ["memory-edit-dialog", "memory-edit-form", "memory-edit-title", "memory-edit-content", "memory-edit-tags", "memory-edit-form-error"]) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const expression of [/openEditDialog/, /saveEdit/, /memory\.update/, /memory-edit-form/]) assert.match(ui, expression);
  assert.doesNotMatch(ui, /window\.prompt\("Edit memory/);
});
