import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../src/runtime.js";
import { startMcpClient, textValue } from "./helpers/mcp-client.mjs";

const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>MCP Browser E2E</title></head>
<body>
<label>User <input id="user" autocomplete="off"></label>
<label>Password <input id="password" type="password" autocomplete="off"></label>
<button id="login">Sign in</button>
<div role="status" id="status">waiting</div>
<script>
document.getElementById('login').addEventListener('click', () => {
  const ok = document.getElementById('user').value === 'alice' && document.getElementById('password').value === 'real-secret';
  document.getElementById('status').textContent = ok ? 'signed-in' : 'denied';
});
</script>
</body></html>`;

async function site() {
    const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(HTML);
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    return {
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}

async function waitFor(runtime, taskId, status) {
    for (let attempt = 0; attempt < 150; attempt += 1) {
        const task = (await runtime.orchestrator.listTasks()).find((candidate) => candidate.id === taskId);
        if (task?.status === status)
            return task;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`task ${taskId} did not reach ${status}`);
}

const fixture = await site();
const root = await mkdtemp(join(tmpdir(), "sovereign-mcp-real-browser-"));
const runtime = await createRuntime({
    dataDir: join(root, "data"),
    computer: {
        allowPrivateHosts: true,
        driver: {
            kind: "webdriver-sidecar",
            browser: "chrome",
            headless: true,
            startupTimeoutMs: 30_000,
            requestTimeoutMs: 15_000,
        },
    },
    agents: [{
        id: "browser-worker",
        name: "Browser Worker",
        role: "worker",
        capabilities: ["browser"],
        harness: {
            kind: "codex",
            command: process.execPath,
            prefixArgs: [fakeCodex],
            timeoutMs: 60_000,
        },
    }],
    policy: {
        rules: [
            { id: "allow-harness", effect: "allow", match: { category: "harness" } },
            { id: "allow-computer", effect: "allow", match: { category: "computer", agentId: "browser-worker" } },
        ],
    },
});

const task = await runtime.orchestrator.submit({
    title: "HANG",
    requiredCapabilities: ["browser"],
    preferredAgentId: "browser-worker",
});
const running = runtime.orchestrator.runNext();
const active = await waitFor(runtime, task.id, "running");
const bridgeAgent = { ...runtime.config.agents[0], governedTools: ["computer"] };
const bridgeController = new AbortController();
const bridge = await runtime.governedToolBridge.prepare({ task: active, agent: bridgeAgent, signal: bridgeController.signal });
const mcp = await startMcpClient(bridge.command, bridge.args);

try {
    const tools = await mcp.tools();
    assert.equal(tools.some((tool) => tool.name === "request_secret"), true);
    assert.equal(tools.some((tool) => tool.name === "supply_secret"), false);

    const navigated = await mcp.call("navigate", { url: fixture.url });
    assert.equal(navigated.isError, undefined);

    const snapshot = textValue(await mcp.call("snapshot"));
    const user = snapshot.elements.find((element) => element.name === "User");
    const password = snapshot.elements.find((element) => element.name === "Password");
    const signIn = snapshot.elements.find((element) => element.name === "Sign in");
    assert.ok(user);
    assert.ok(password);
    assert.ok(signIn);
    assert.equal(/sidecarHandle|webdriver|elementId/i.test(JSON.stringify(snapshot)), false);

    const typed = await mcp.call("type", {
        snapshotId: snapshot.snapshotId,
        ref: user.ref,
        text: "alice",
    });
    assert.equal(typed.isError, undefined);

    const secretRequest = textValue(await mcp.call("request_secret", {
        snapshotId: snapshot.snapshotId,
        ref: password.ref,
        label: "test password",
    }));
    assert.equal(typeof secretRequest.id, "string");
    assert.equal(JSON.stringify(secretRequest).includes("real-secret"), false);
    assert.equal((await runtime.computer.control("browser-worker")).mode, "requested");

    await runtime.computer.supplySecret("browser-worker", "e2e-operator", secretRequest.id, "real-secret");
    assert.equal((await runtime.computer.control("browser-worker")).mode, "agent");

    const clicked = await mcp.call("click", {
        snapshotId: snapshot.snapshotId,
        ref: signIn.ref,
    });
    assert.equal(clicked.isError, undefined);

    const after = textValue(await mcp.call("snapshot"));
    assert.ok(after.elements.some((element) => element.role === "status" && element.name === "signed-in"));

    bridgeController.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const revoked = await mcp.call("snapshot");
    assert.equal(revoked.isError, true);

    const audit = JSON.stringify(await runtime.audit.readAll());
    assert.equal(audit.includes("real-secret"), false);
    process.stdout.write("governed MCP -> Chrome E2E passed\n");
}
finally {
    await mcp.close();
    await bridge.close("e2e cleanup");
    await runtime.orchestrator.cancel(task.id);
    await running;
    await runtime.close();
    await fixture.close();
}
