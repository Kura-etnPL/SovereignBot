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
        driver: { kind: "webdriver-sidecar", browser: "chrome", headless: true },
    });
    const config = await loadConfig(path);
    assert.equal(config.computer.driver.kind, "webdriver-sidecar");
});

test("WebDriver endpoint must remain loopback", async () => {
    const path = await configPath({
        driver: { kind: "webdriver-sidecar", webdriverUrl: "http://192.168.1.10:9515" },
    });
    await assert.rejects(() => loadConfig(path), /loopback http endpoint/);
});

test("computer driver rejects unknown browsers and invalid timeout values", async () => {
    const browser = await configPath({ driver: { kind: "webdriver-sidecar", browser: "safari" } });
    await assert.rejects(() => loadConfig(browser), /unsupported WebDriver browser/);

    const timeout = await configPath({ driver: { kind: "webdriver-sidecar", startupTimeoutMs: 0 } });
    await assert.rejects(() => loadConfig(timeout), /positive integer/);
});
