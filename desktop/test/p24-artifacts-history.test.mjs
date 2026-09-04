import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "ui/index.html"), "utf8");
const ui = readFileSync(join(root, "ui/product-hubs-ui.js"), "utf8");
const service = readFileSync(join(root, "src/main/product-surface-service.js"), "utf8");
const store = readFileSync(join(root, "src/main/artifact-store.js"), "utf8");

test("P24 Artifacts page has an in-product bounded preview and exact focus path", () => {
    for (const id of ["artifact-preview-dialog", "artifact-preview-title", "artifact-preview-meta", "artifact-preview-status", "artifact-preview-body", "artifact-hub-filter-page", "artifact-hub-type-page"]) assert.match(html, new RegExp(`id="${id}"`), id);
    for (const expression of [/openArtifactPreview/, /Readable text preview/, /not previewable/, /artifact-focused/, /sovereignbot:open-artifact-preview/, /pendingArtifactId/, /artifacts\.get/]) assert.match(ui, expression);
    assert.doesNotMatch(ui, /api\.artifacts\.preview\([^\n]+window\.alert/);
    assert.doesNotMatch(ui, /storageRelativePath|sourceRelativePath|workspacePath/);
});

test("P24 preserves canonical ArtifactStore and allowlisted Computer History projection", () => {
    assert.match(service, /artifactStore\.history/);
    for (const expression of [/restoreAsNewVersion\(id\)/, /reviseFromPickedFile\(\{ artifactId, sourcePath \}\)/, /managedPath\(id\)/]) assert.match(store, expression);
    for (const expression of [/artifacts\.history/, /artifacts\.restoreAsNewVersion/, /artifacts\.reviseViaDialog/]) assert.match(ui, expression);
    assert.match(service, /const activity = data\.activity \?\? data\.operation \?\? data\.action/);
    assert.match(service, /safeHistoryText\(activity\)/);
    assert.match(service, /secret\|credential\|auth\|login\|session\|webdriver\|continuity/);
    assert.doesNotMatch(service, /result\.push\(\{[^}]+(?:storageRelativePath|sourceRelativePath|rawPath|coordinates)/s);
});
