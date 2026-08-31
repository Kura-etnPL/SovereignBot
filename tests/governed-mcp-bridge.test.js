import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMemoryComputerDriverFactory } from "../src/computer-driver.js";
import { createRuntime } from "../src/runtime.js";
import { startMcpClient, textValue } from "./helpers/mcp-client.mjs";

const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

function config(dataDir) {
    return {
        dataDir,
        agents: [
            {
                id: "worker-a",
                name: "Worker A",
                role: "worker",
                capabilities: ["browser"],
                harness: {
                    kind: "codex",
                    command: process.execPath,
                    prefixArgs: [fakeCodex],
                    timeoutMs: 20_000,
                },
            },
            {
                id: "worker-b",
                name: "Worker B",
                role: "worker",
                capabilities: ["browser"],
                harness: { kind: "echo", delayMs: 20_000 },
            },
        ],
        policy: {
            rules: [
                { id: "allow-harness", effect: "allow", match: { category: "harness" } },
                { id: "allow-computer", effect: "allow", match: { category: "computer" } },
            ],
        },
    };
}

async function waitFor(runtime, id, status) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const task = (await runtime.orchestrator.listTasks()).find((candidate) => candidate.id === id);
        if (task?.status === status)
            return task;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`task ${id} did not reach ${status}`);
}

test("governed MCP bridge binds tools to one running worker task and revokes cleanly", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-mcp-bridge-"));
    const factory = createMemoryComputerDriverFactory();
    const runtime = await createRuntime(config(dataDir), { computerDriverFactory: factory });
    const task = await runtime.orchestrator.submit({
        title: "HANG",
        requiredCapabilities: ["browser"],
        preferredAgentId: "worker-a",
    });
    const running = runtime.orchestrator.runNext();
    const active = await waitFor(runtime, task.id, "running");

    const record = (await runtime.computerRegistry.list()).find((entry) => entry.agentId === "worker-a");
    const driver = factory.forComputer(record);
    driver.setPage("https://example.test/app", [
        { ref: "go", backendRef: "private-go", role: "button", name: "Continue" },
        { ref: "email", backendRef: "private-email", role: "textbox", name: "Email" },
        { ref: "password", backendRef: "private-password", role: "textbox", name: "Password", type: "password" },
    ]);

    const bridgeAgent = { ...runtime.config.agents[0], governedTools: ["computer"] };
    const controller = new AbortController();
    const bridge = await runtime.governedToolBridge.prepare({ task: active, agent: bridgeAgent, signal: controller.signal });
    const mcp = await startMcpClient(bridge.command, bridge.args);

    try {
        const tools = await mcp.tools();
        const names = tools.map((tool) => tool.name);
        assert.equal(names.includes("snapshot"), true);
        assert.equal(names.includes("request_secret"), true);
        assert.equal(names.includes("supply_secret"), false);
        const schemas = JSON.stringify(tools.map((tool) => tool.inputSchema));
        assert.equal(/taskId|agentId|authorization|bearer|token/i.test(schemas), false);

        const snapshotResult = await mcp.call("snapshot");
        assert.equal(snapshotResult.isError, undefined);
        const snapshot = textValue(snapshotResult);
        assert.equal(snapshot.url, "https://example.test/app");
        assert.equal(snapshot.elements.some((element) => element.name === "Continue"), true);
        assert.equal(JSON.stringify(snapshot).includes("private-go"), false);
        assert.equal(/backendRef|sidecarHandle|webdriver/i.test(JSON.stringify(snapshot)), false);

        const email = snapshot.elements.find((element) => element.name === "Email");
        const typed = await mcp.call("type", { snapshotId: snapshot.snapshotId, ref: email.ref, text: "alice@example.com" });
        assert.equal(typed.isError, undefined);
        assert.equal(driver.actions().at(-1).operation, "type");
        assert.equal(driver.actions().at(-1).characters, "alice@example.com".length);

        const password = snapshot.elements.find((element) => element.name === "Password");
        const secretRequestResult = await mcp.call("request_secret", {
            snapshotId: snapshot.snapshotId,
            ref: password.ref,
            label: "account password",
        });
        const secretRequest = textValue(secretRequestResult);
        assert.equal(typeof secretRequest.id, "string");
        assert.equal("value" in secretRequest, false);
        assert.equal("text" in secretRequest, false);
        assert.equal((await runtime.computer.control("worker-a")).mode, "requested");

        await runtime.computer.supplySecret("worker-a", "test-operator", secretRequest.id, "SECRET-MCP-VALUE");
        assert.equal(driver.actions().at(-1).operation, "secret");
        assert.equal(driver.actions().at(-1).characters, "SECRET-MCP-VALUE".length);

        await bridge.close("test revoke");
        const revoked = await mcp.call("snapshot");
        assert.equal(revoked.isError, true);
        assert.match(revoked.content[0].text, /invalid|revoked/i);

        const auditText = JSON.stringify(await runtime.audit.readAll());
        assert.equal(auditText.includes("SECRET-MCP-VALUE"), false);
    }
    finally {
        await mcp.close();
        controller.abort();
        await runtime.orchestrator.cancel(task.id);
        await running;
        await runtime.close();
    }
});

test("workspace-only bridge does not advertise or invoke computer tools", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-mcp-workspace-"));
    const runtimeConfig = config(dataDir);
    runtimeConfig.agents[0] = { ...runtimeConfig.agents[0], governedTools: ["workspace"] };
    const runtime = await createRuntime(runtimeConfig);
    const task = await runtime.orchestrator.submit({
        title: "HANG workspace tools",
        requiredCapabilities: ["browser"],
        preferredAgentId: "worker-a",
    });
    const running = runtime.orchestrator.runNext();
    const active = await waitFor(runtime, task.id, "running");
    const controller = new AbortController();
    const bridge = await runtime.governedToolBridge.prepare({ task: active, agent: runtime.config.agents[0], signal: controller.signal });
    const mcp = await startMcpClient(bridge.command, bridge.args);

    try {
        const names = (await mcp.tools()).map((tool) => tool.name);
        assert.deepEqual(names, ["list_files", "read_file", "write_file"]);
        const listed = await mcp.call("list_files", { path: "." });
        assert.equal(listed.isError, undefined);
        const denied = await mcp.call("snapshot");
        assert.equal(denied.isError, true);
        assert.match(denied.content[0].text, /unknown governed tool|refused/i);
    }
    finally {
        await mcp.close();
        controller.abort();
        await runtime.orchestrator.cancel(task.id);
        await running;
        await runtime.close();
    }
});
