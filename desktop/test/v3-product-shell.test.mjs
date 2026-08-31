import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const html = read("../ui/index.html");
const app = read("../ui/app.js");
const css = read("../ui/style.css");

test("V3 default shell is coworker-first rather than Goal/Control-Center-first", () => {
    assert.match(html, /SOVEREIGN COWORKER OS/);
    assert.match(html, /id="coworker-list"/);
    assert.match(html, /id="team-list"/);
    assert.match(html, /id="conversation-messages"/);
    assert.match(html, /id="composer-form"/);
    assert.match(html, /id="voice-input"/);
    assert.match(html, /id="details-panel"/);
    assert.doesNotMatch(html, /id="goal-form"/);
    assert.doesNotMatch(html, />Run goal</);
    assert.doesNotMatch(html, />Planner</);
    assert.doesNotMatch(html, />Worker</);
    assert.doesNotMatch(html, />Synthesizer</);
});

test("V3 renderer consumes typed coworker/conversation APIs and never uses HTML injection", () => {
    for (const expression of [
        /sovereignbot\.coworkers\.list/,
        /sovereignbot\.coworkers\.create/,
        /sovereignbot\.conversations\.createDirect/,
        /sovereignbot\.conversations\.createTeam/,
        /sovereignbot\.conversations\.send/,
        /sovereignbot\.conversations\.get/,
    ]) assert.match(app, expression);
    assert.doesNotMatch(app, /innerHTML\s*=/);
    assert.doesNotMatch(app, /insertAdjacentHTML/);
    assert.doesNotMatch(app, /eval\s*\(/);
    assert.doesNotMatch(app, /new Function/);
});

test("V3 conversation UX supports durable polling, team mentions, details and provider readiness", () => {
    assert.match(app, /setTimeout\(\(\) => refreshConversation\(false\), 850\)/);
    assert.match(app, /@everyone/);
    assert.match(app, /state\.mentionIds/);
    assert.match(app, /pendingUserRecipients/);
    assert.match(app, /coworkerBindings/);
    assert.match(html, /id="conversation-presence"/);
    assert.match(html, /id="mention-row"/);
    assert.match(html, /id="provider-cards"/);
    assert.match(app, /SpeechRecognition/);
    assert.match(app, /speechSynthesis/);
});

test("V3 shell carries a coherent responsive design system rather than legacy admin panels", () => {
    for (const token of ["--sidebar", "--details", "--panel", "--text", "--good", "--warn"]) assert.ok(css.includes(token), token);
    assert.match(css, /\.app-shell/);
    assert.match(css, /\.conversation-view/);
    assert.match(css, /\.chat-messages/);
    assert.match(css, /\.composer-shell/);
    assert.match(css, /\.details-panel/);
    assert.match(css, /\.settings-grid/);
    assert.match(css, /@media \(max-width: 980px\)/);
});
