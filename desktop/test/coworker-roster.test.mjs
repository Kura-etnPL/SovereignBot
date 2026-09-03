import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const html = read("../ui/index.html");
const app = read("../ui/app.js");
const css = read("../ui/style.css");

test("large Coworker roster exposes bounded search, filters, counts, and progressive disclosure", () => {
    for (const id of ["coworker-search", "coworker-status-filter", "coworker-roster-summary", "coworker-show-more", "coworker-empty"]) assert.match(html, new RegExp(`id="${id}"`), id);
    for (const expression of [/coworkerRoster/, /toLocaleLowerCase\(\)/, /priority = \{ attention: 0, working: 1, available: 2, active: 3, paused: 4 \}/, /const renderLimit = roster\.expanded \? filtered\.length : 14/, /selectedCoworkerId/, /new Map\(\)/, /coworker-show-more/, /coworker-status-filter/]) assert.match(app, expression);
    assert.match(css, /\.coworker-roster-controls/);
    assert.match(css, /\.sidebar-more/);
    assert.match(app, /item\.dataset\.coworkerId = coworker\.id/);
});

test("conversation refresh requests Team activity only for a known Team summary", () => {
    const start = app.indexOf("async function refreshConversation(");
    const end = app.indexOf("\nasync function loadOlderMessages", start);
    const refresh = app.slice(start, end);
    assert.match(refresh, /const conversationSummary = conversationById\(id\)/);
    assert.match(refresh, /conversationSummary\?\.kind === "team"/);
    assert.match(refresh, /Promise\.resolve\(\{ events: \[\] \}\)/);
    assert.match(refresh, /window\.sovereignbot\.teams\.activity\(\{ conversationId: id, limit: 24 \}\)/);
    assert.match(refresh, /Promise\.all\(\[/);
});
