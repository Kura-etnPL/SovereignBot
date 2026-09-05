import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { readChatGPTPage } from "../sidecars/webdriver/chatgpt-page.js";

test("ChatGPT projection recognizes localized site checks without reading conversation text", () => {
    for (const [title, challenge] of [["请稍候…", true], ["Just a moment...", true], ["ChatGPT", false]]) {
        const page = runInNewContext(`(${readChatGPTPage.toString()})()`, {
            location: { protocol: "https:", hostname: "chatgpt.com", href: "https://chatgpt.com/" },
            document: { title, querySelectorAll: () => [] },
        });
        assert.equal(page.challenge, challenge);
        assert.equal(page.authenticated, false);
    }
});
