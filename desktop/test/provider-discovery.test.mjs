import assert from "node:assert/strict";
import test from "node:test";
import { findAuthStatusCandidates, probeOnce, describeProvider } from "../src/main/lib/provider-discovery.js";

test("findAuthStatusCandidates extracts only auth+status style subcommands from help text", () => {
    const codexStyle = [
        "Usage: codex [OPTIONS] [PROMPT]",
        "",
        "Commands:",
        "  login              Log in with ChatGPT or an API key",
        "  logout             Log out of the current session",
        "  auth status        Show current authentication status",
        "  apply              Apply a plan",
        "Options:",
        "  --help             Print help",
    ].join("\n");
    assert.deepEqual(findAuthStatusCandidates(codexStyle), ["auth status Show current authentication status"]);

    const claudeStyle = "- status          Show auth status and account info";
    const candidates = findAuthStatusCandidates(claudeStyle);
    assert.equal(candidates.length, 1);
    assert.match(candidates[0], /auth|status/i);

    // Prose without list formatting is ignored entirely.
    assert.deepEqual(findAuthStatusCandidates("To check your login status please run the doctor command."), []);
});

test("probeOnce captures output, redacts secret shapes, and survives hostile commands", async () => {
    const echo = await probeOnce({
        command: process.execPath,
        args: ["-e", 'console.log("token sk-abcdefghijklmnop1234 leaked")'],
    });
    assert.equal(echo.ok, true);
    assert.equal(echo.code, 0);
    assert.equal(echo.stdout.includes("sk-abcdefghijklmnop1234"), false);
    assert.match(echo.stdout, /\[REDACTED\]/);

    const missing = await probeOnce({ command: "definitely-not-a-real-binary-sovereign", args: [] });
    if (!missing.ok)
        assert.match(String(missing.reason), /spawn|ENOENT/i);
    else
        assert.notEqual(missing.code, 0);
});

test("describeProvider reports found/unverified for a real resolver and found:false on failure", async () => {
    const healthy = await describeProvider(
        () => ({ command: process.execPath, source: "test-fixture" }),
        "fixture",
        ["--version"],
    );
    assert.equal(healthy.found, true);
    assert.equal(healthy.source, "test-fixture");
    assert.match(healthy.version, /v\d+\./);
    assert.equal(healthy.auth.state, "unverified"); // node --help has no login/auth commands
    assert.equal(typeof healthy.interactiveLoginAvailable, "boolean");

    const broken = await describeProvider(
        () => {
            throw new Error("resolver exploded");
        },
        "broken",
        ["--version"],
    );
    assert.deepEqual(broken, { provider: "broken", found: false, reason: "resolver exploded" });
});
