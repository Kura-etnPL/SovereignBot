import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ComputerLifecycleManager } from "../src/computer-lifecycle.js";
import { captureWebDriverFrame } from "../sidecars/webdriver/screenshot.js";

async function withServer(handler, run) {
    const server = createServer(handler);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    try {
        const address = server.address();
        return await run(`http://127.0.0.1:${address.port}`);
    }
    finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test("captureWebDriverFrame reads the standard W3C screenshot endpoint", async () => {
    const png = Buffer.from("fake-png-frame").toString("base64");
    let observed;
    await withServer((request, response) => {
        observed = { method: request.method, url: request.url };
        const body = JSON.stringify({ value: png });
        response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        response.end(body);
    }, async (endpoint) => {
        const frame = await captureWebDriverFrame({ endpoint, sessionId: "session-123" });
        assert.deepEqual(frame, { mimeType: "image/png", data: png });
    });
    assert.deepEqual(observed, { method: "GET", url: "/session/session-123/screenshot" });
});

test("passive lifecycle frame never instantiates or starts a computer", async () => {
    let ensured = 0;
    let forComputerCalls = 0;
    const registry = { async ensure(id) { ensured += 1; return { agentId: id }; } };
    const driverFactory = {
        get() { return undefined; },
        forComputer() { forComputerCalls += 1; throw new Error("must not instantiate"); },
    };
    const lifecycle = new ComputerLifecycleManager({ registry, driverFactory, audit: { append: async () => {} } });
    await assert.rejects(() => lifecycle.frame("agent-one"), /not running/);
    assert.equal(ensured, 1);
    assert.equal(forComputerCalls, 0);
});

test("passive lifecycle frame returns only the existing driver's visual frame", async () => {
    let frameCalls = 0;
    const registry = { async ensure(id) { return { agentId: id }; } };
    const driverFactory = {
        get(id) {
            assert.equal(id, "agent-one");
            return {
                async frame() {
                    frameCalls += 1;
                    return { mimeType: "image/png", data: "ZmFrZQ==", url: "https://example.com/", capturedAt: "2026-08-27T00:00:00.000Z" };
                },
            };
        },
    };
    const lifecycle = new ComputerLifecycleManager({ registry, driverFactory, audit: { append: async () => {} } });
    assert.deepEqual(await lifecycle.frame("agent-one"), {
        agentId: "agent-one",
        mimeType: "image/png",
        data: "ZmFrZQ==",
        url: "https://example.com/",
        capturedAt: "2026-08-27T00:00:00.000Z",
    });
    assert.equal(frameCalls, 1);
});
