import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

async function configPath(computer) {
    const dir = await mkdtemp(join(tmpdir(), "sovereign-computer-config-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
        dataDir: join(dir, "data"),
        computer,
        agents: [{ id: "worker", name: "Worker", harness: { kind: "echo" }, capabilities: [] }],
        policy: { rules: [] },
    }));
    return path;
}

test("configuration accepts the bundled WebDriver sidecar", async () => {
    const path = await configPath({
        allowPrivateHosts: false,
        driver: {
            kind: "webdriver-sidecar",
            browser: "chrome",
            headless: true,
            env: { EXPLICIT_BROWSER_ENV: "enabled" },
        },
    });
    const config = await loadConfig(path);
    assert.equal(config.computer.driver.kind, "webdriver-sidecar");
    assert.equal(config.computer.driver.env.EXPLICIT_BROWSER_ENV, "enabled");
});

test("WebDriver endpoint must remain loopback and credential-free", async () => {
    const remote = await configPath({
        driver: { kind: "webdriver-sidecar", webdriverUrl: "http://192.168.1.10:9515" },
    });
    await assert.rejects(() => loadConfig(remote), /loopback http endpoint/);

    const credentials = await configPath({
        driver: { kind: "webdriver-sidecar", webdriverUrl: "http://user:pass@127.0.0.1:9515" },
    });
    await assert.rejects(() => loadConfig(credentials), /must not contain credentials/);
});

test("computer driver rejects unknown browsers and invalid timeout values", async () => {
    const browser = await configPath({ driver: { kind: "webdriver-sidecar", browser: "safari" } });
    await assert.rejects(() => loadConfig(browser), /unsupported WebDriver browser/);

    const timeout = await configPath({ driver: { kind: "webdriver-sidecar", startupTimeoutMs: 0 } });
    await assert.rejects(() => loadConfig(timeout), /positive integer/);
});

test("sidecar explicit environment must contain only string values", async () => {
    const nonObject = await configPath({ driver: { kind: "webdriver-sidecar", env: ["BAD"] } });
    await assert.rejects(() => loadConfig(nonObject), /object of string values/);

    const nonString = await configPath({ driver: { kind: "webdriver-sidecar", env: { API_MODE: 42 } } });
    await assert.rejects(() => loadConfig(nonString), /object of string values/);

    const invalidKey = await configPath({ driver: { kind: "webdriver-sidecar", env: { "BAD=KEY": "x" } } });
    await assert.rejects(() => loadConfig(invalidKey), /invalid environment variable name/);
});
