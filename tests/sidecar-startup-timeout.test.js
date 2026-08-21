import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SidecarComputerDriver } from "../src/sidecar-computer-driver.js";

async function delayedWebDriver(delayMs) {
    const server = createServer(async (request, response) => {
        const send = (status, value) => {
            const body = JSON.stringify({ value });
            response.writeHead(status, {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
            });
            response.end(body);
        };

        if (request.method === "GET" && request.url === "/status") {
            send(200, { ready: true });
            return;
        }
        if (request.method === "POST" && request.url === "/session") {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            send(200, { sessionId: "slow-session", capabilities: { browserName: "fake" } });
            return;
        }
        if (request.method === "DELETE" && request.url === "/session/slow-session") {
            send(200, null);
            return;
        }
        send(404, { error: "unknown command", message: request.url });
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

test("browser session startup may use startupTimeoutMs even when requestTimeoutMs is shorter", async () => {
    const webdriver = await delayedWebDriver(180);
    const root = await mkdtemp(join(tmpdir(), "sovereign-startup-timeout-"));
    const driver = new SidecarComputerDriver({
        agentId: "slow-browser-worker",
        profileDir: join(root, "profile"),
        workspaceDir: join(root, "workspace"),
    }, {
        browser: "chrome",
        webdriverUrl: webdriver.url,
        allowPrivateHosts: true,
        headless: true,
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 40,
    });

    try {
        const health = await driver.health();
        assert.equal(health.ok, true);
        assert.equal(health.sessionActive, true);
    }
    finally {
        await driver.close();
        await webdriver.close();
    }
});
