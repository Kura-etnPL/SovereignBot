import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("system appearance and palette stay compatible without overwriting the preferred palette", () => {
    const values = new Map();
    let light = true;
    const document = { body: { dataset: {} }, readyState: "loading", addEventListener() {}, getElementById() { return null; } };
    const window = { matchMedia: () => ({ matches: light }) };
    const localStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
    runInNewContext(readFileSync(new URL("../ui/palette-engine.js", import.meta.url), "utf8"), { window, document, localStorage });
    const palette = window.SovereignPalette;
    palette.set("cyberpunk", false);
    const saved = [...values];
    palette.syncTheme("system");
    assert.equal(document.body.dataset.theme, "system");
    assert.equal(palette.get().mode, "light");
    assert.deepEqual([...values], saved);
    light = false;
    palette.syncTheme("system");
    assert.equal(palette.get().id, "cyberpunk");
    palette.syncTheme("light");
    assert.equal(document.body.dataset.theme, "light");
    assert.equal(palette.get().mode, "light");
});
