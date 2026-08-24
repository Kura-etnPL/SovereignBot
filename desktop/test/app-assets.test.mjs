import assert from "node:assert/strict";
import test from "node:test";
import { APP_ASSETS, isAllowedExternalUrl, isAppUrl, resolveAppAsset } from "../src/main/lib/app-assets.js";

test("app protocol resolves exactly the allowlisted assets", () => {
    for (const pathname of Object.keys(APP_ASSETS)) {
        const resolved = resolveAppAsset(`sovereignbot://app${pathname === "/" ? "/" : pathname}`);
        assert.equal(resolved.ok, true, pathname);
        assert.equal(typeof resolved.file, "string");
        assert.match(resolved.type, /^(text|image)\//);
    }
});

test("app protocol rejects traversal, encoding tricks, foreign hosts, and query strings", () => {
    const hostile = [
        "sovereignbot://app/../package.json",
        "sovereignbot://app/%2e%2e/package.json",
        "sovereignbot://app/..%2fpackage.json",
        "sovereignbot://app/app.js?x=1",
        "sovereignbot://app/app.js#frag",
        "sovereignbot://evil/app.js",
        "sovereignbot://app/unknown.js",
        "sovereignbot://app//etc/passwd",
        "https://evil.example/app.js",
        "not a url",
        `sovereignbot://app/app\0.js`,
    ];
    for (const url of hostile)
        assert.equal(resolveAppAsset(url).ok, false, url);
});

test("isAppUrl accepts only the app scheme+host", () => {
    assert.equal(isAppUrl("sovereignbot://app/"), true);
    assert.equal(isAppUrl("sovereignbot://app/index.html"), true);
    assert.equal(isAppUrl("sovereignbot://evil/"), false);
    assert.equal(isAppUrl("https://example.com/"), false);
    assert.equal(isAppUrl(""), false);
});

test("external links allow only reviewed https GitHub project URLs", () => {
    assert.equal(isAllowedExternalUrl("https://github.com/Kura-etnPL/SovereignBot/releases"), true);
    assert.equal(isAllowedExternalUrl("http://github.com/Kura-etnPL/SovereignBot/releases"), false);
    assert.equal(isAllowedExternalUrl("https://evil.example/Kura-etnPL/SovereignBot"), false);
    assert.equal(isAllowedExternalUrl("https://github.com/Kura-etnPL/SovereignBot@evil#"), false);
    assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
});
