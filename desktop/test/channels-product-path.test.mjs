import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const html = read("../ui/index.html");
const productHubs = read("../ui/product-hubs-ui.js");
const app = read("../ui/app.js");
const main = read("../src/main/index.js");
const gate = read("../src/main/verify-channels-product-path.js");
const runner = read("../scripts/verify-channels-product-path.mjs");
const entry = read("../src/main/verify-channels-product-path-entry.js");

test("Channels product page exposes lifecycle, template, and quick-switch controls", () => {
  for (const id of ["view-channels", "product-channel-filter-page", "product-channel-switch-page", "product-channel-create-page", "product-channel-template-team-page", "product-channel-template-page", "product-channel-template-add-page", "product-channels-page"]) assert.match(html, new RegExp(`id=\\"${id}\\"`), id);
  for (const expression of [/api\.channels\.archive/, /api\.channels\.restore/, /api\.teams\.createChannelFromTemplate/, /product-channel-switch-page/, /includeArchived: true/]) assert.match(productHubs, expression);
  const standaloneChannels = productHubs.slice(productHubs.indexOf("  function channels(items)"), productHubs.indexOf("  function openEditor", productHubs.indexOf("  function channels(items)")));
  for (const expression of [/unread\(conversation\)/, /soft-pill/, /Unread \/ 未读/]) assert.match(standaloneChannels, expression);
  for (const expression of [/team-archive-channel/, /team-restore-channel/, /addChannelFromTemplate/]) assert.match(app, expression);
  assert.match(main, /isArchivedConversation/);
  for (const expression of [/Project Channel/, /neutral conversation before unread fixture/]) assert.match(gate, expression);
  for (const expression of [/const hasFailure/, /gateExit=/, /!hasPass/]) assert.match(runner, expression);
  for (const expression of [/window-all-closed/, /event\.preventDefault\(\)/, /gateFinished/]) assert.match(entry, expression);
});

test("Channels product path has no native prompt or confirm fallback", () => {
  const channelRender = productHubs.slice(productHubs.indexOf("  function renderChannels"), productHubs.indexOf("  function renderSkills"));
  const channelHandlers = productHubs.slice(productHubs.indexOf('$("product-channel-create-page")'), productHubs.indexOf("function bindProductHubs"));
  assert.doesNotMatch(`${channelRender}\n${channelHandlers}`, /window\.(prompt|confirm)\s*\(/);
  assert.doesNotMatch(app.slice(app.indexOf("async function addChannelFromTemplate"), app.indexOf("function setupVoiceInput")), /window\.(prompt|confirm)\s*\(/);
});
