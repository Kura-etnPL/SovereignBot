import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const html = readFileSync(join(root, "ui", "index.html"), "utf8");
const js = readFileSync(join(root, "ui", "app.js"), "utf8");
const css = readFileSync(join(root, "ui", "style.css"), "utf8");

test("V3 desktop shell is coworker-first rather than goal-runner-first", () => {
  for (const required of [
    "Coworkers", "Conversations", "Your AI team", "New conversation", "Live computer",
    "Workspace & artifacts", "Create coworker", "New team conversation",
  ]) assert.match(`${html}\n${js}`, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

  assert.doesNotMatch(html, /What do you want me to do\?/);
  assert.doesNotMatch(html, />Goals</);
  assert.doesNotMatch(html, /AI workers/);
  assert.doesNotMatch(html, /Planner agent|Worker agent|Reviewer agent|Synthesizer agent/);
});

test("V3 shell consumes typed coworker/conversation preload APIs", () => {
  for (const call of [
    "sovereignbot.coworkers.list", "sovereignbot.coworkers.create",
    "sovereignbot.conversations.list", "sovereignbot.conversations.get",
    "sovereignbot.conversations.createDirect", "sovereignbot.conversations.createTeam",
    "sovereignbot.conversations.send",
  ]) assert.ok(js.includes(call), `missing ${call}`);
});

test("renderer keeps model/user content on textContent-only DOM paths", () => {
  assert.doesNotMatch(js, /innerHTML\s*=/);
  assert.doesNotMatch(js, /insertAdjacentHTML/);
  assert.doesNotMatch(js, /document\.write/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'self'/);
});

test("desktop layout has product-grade three-pane primitives with responsive fallback", () => {
  assert.match(css, /grid-template-columns:270px minmax\(0,1fr\) 300px/);
  assert.match(css, /\.sidebar/);
  assert.match(css, /\.chat-view/);
  assert.match(css, /\.detail-panel/);
  assert.match(css, /@media\(max-width:1100px\)/);
});
