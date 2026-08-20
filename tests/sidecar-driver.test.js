import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SidecarComputerDriver } from "../src/sidecar-computer-driver.js";
import { isUnsafeAddress, resolveEgressTarget } from "../sidecars/webdriver/egress-proxy.js";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

async function fakeWebDriver() {
    const calls = [];
    let sessionCounter = 0;
    const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request)
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? JSON.parse(raw) : {};
        calls.push({ method: request.method, url: request.url, body });

        const send = (status, value) => {
            const payload = JSON.stringify({ value });
            response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
            response.end(payload);
        };

        if (request.method === "GET" && request.url === "/status") {
            send(200, { ready: true });
            return;
        }
        if (request.method === "POST" && request.url === "/session") {
            sessionCounter += 1;
            send(200, { sessionId: `session-${sessionCounter}`, capabilities: { browserName: "fake" } });
            return;
        }
        if (request.method === "DELETE" && /^\/session\/[^/]+$/.test(request.url)) {
            send(200, null);
            return;
        }
        if (request.method === "GET" && /\/url$/.test(request.url)) {
            send(200, "https://example.test/app");
            return;
        }
        if (request.method === "POST" && /\/url$/.test(request.url)) {
            send(200, null);
            return;
        }
        if (request.method === "POST" && /\/execute\/sync$/.test(request.url)) {
            send(200, {
                url: "https://example.test/app",
                title: "Fixture",
                elements: [
                    {
                        element: { [ELEMENT_KEY]: "webdriver-element-1" },
                        role: "button",
                        name: "Continue",
                        type: "button",
                        disabled: false,
                    },
                    {
                        element: { [ELEMENT_KEY]: "webdriver-element-2" },
                        role: "textbox",
                        name: "Password",
                        type: "password",
                        disabled: false,
                    },
                ],
            });
            return;
        }
        if (request.method === "POST" && /\/element\/webdriver-element-1\/click$/.test(request.url)) {
            send(200, null);
            return;
        }
        if (request.method === "POST" && /\/element\/webdriver-element-2\/value$/.test(request.url)) {
            if (body.text === "TOP-SECRET-VALUE") {
                send(500, { error: "invalid element state", message: `do not echo ${body.text}` });
                return;
            }
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
        calls,
        close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

async function driverFor(webdriverUrl) {
    const root = await mkdtemp(join(tmpdir(), "sovereign-sidecar-driver-"));
    return new SidecarComputerDriver({
        agentId: "worker",
        profileDir: join(root, "profile"),
        workspaceDir: join(root, "workspace"),
    }, {
        browser: "chrome",
        webdriverUrl,
        allowPrivateHosts: true,
        startupTimeoutMs: 10_000,
        requestTimeoutMs: 5_000,
        headless: true,
    });
}

test("process sidecar speaks authenticated structured WebDriver protocol", async () => {
    const fixture = await fakeWebDriver();
    const driver = await driverFor(fixture.url);
    try {
        const health = await driver.health();
        assert.equal(health.ok, true);
        assert.equal(health.protocol, "sovereignbot.sidecar.v1");

        const snapshot = await driver.snapshot();
        assert.equal(snapshot.url, "https://example.test/app");
        assert.equal(snapshot.elements.length, 2);
        assert.equal(snapshot.elements[0].name, "Continue");
        assert.equal(typeof snapshot.elements[0].sidecarHandle, "string");
        assert.equal(typeof snapshot.elements[0].sidecarLease, "string");

        await driver.click({ element: snapshot.elements[0] });
        assert.equal(fixture.calls.some((call) => /webdriver-element-1\/click$/.test(call.url)), true);

        await driver.type({ element: snapshot.elements[1], text: "hello" });
        const typed = fixture.calls.find((call) => /webdriver-element-2\/value$/.test(call.url) && call.body.text === "hello");
        assert.ok(typed);

        await assert.rejects(
            () => driver.typeSecret({ element: snapshot.elements[1], text: "TOP-SECRET-VALUE" }),
            (error) => !error.message.includes("TOP-SECRET-VALUE") && /secret input failed/.test(error.message),
        );

        await driver.reset();
        await assert.rejects(
            () => driver.click({ element: snapshot.elements[0] }),
            /browser lease changed/,
        );
        const next = await driver.snapshot();
        assert.notEqual(next.elements[0].sidecarLease, snapshot.elements[0].sidecarLease);
    }
    finally {
        await driver.close();
        await fixture.close();
    }
});

test("egress address classifier blocks private, loopback, multicast and metadata", async () => {
    assert.equal(isUnsafeAddress("127.0.0.1"), true);
    assert.equal(isUnsafeAddress("10.1.2.3"), true);
    assert.equal(isUnsafeAddress("192.168.1.2"), true);
    assert.equal(isUnsafeAddress("::1"), true);
    assert.equal(isUnsafeAddress("fc00::1"), true);
    assert.equal(isUnsafeAddress("224.0.0.1"), true);
    assert.equal(isUnsafeAddress("8.8.8.8"), false);

    await assert.rejects(() => resolveEgressTarget("127.0.0.1"), /blocked/);
    const privateAllowed = await resolveEgressTarget("127.0.0.1", { allowPrivateHosts: true });
    assert.equal(privateAllowed.address, "127.0.0.1");
    await assert.rejects(
        () => resolveEgressTarget("169.254.169.254", { allowPrivateHosts: true }),
        /metadata/,
    );
});
