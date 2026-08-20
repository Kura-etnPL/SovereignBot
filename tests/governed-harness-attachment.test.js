import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";

const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const fakeClaude = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

async function missing(path) {
    try {
        await access(path);
        return false;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return true;
        throw error;
    }
}

function baseConfig(dataDir, agent) {
    return {
        dataDir,
        agents: [agent],
        policy: {
            rules: [
                { id: "allow-harness", effect: "allow", match: { category: "harness" } },
                { id: "allow-computer", effect: "allow", match: { category: "computer" } },
            ],
        },
    };
}

test("Codex exec receives governed MCP overrides and bridge files are cleaned", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-codex-bridge-attach-"));
    const capture = join(root, "args.json");
    const runtime = await createRuntime(baseConfig(join(root, "data"), {
        id: "codex-worker",
        name: "Codex Worker",
        role: "worker",
        capabilities: ["coding"],
        governedTools: ["computer"],
        harness: {
            kind: "codex",
            command: process.execPath,
            prefixArgs: [fakeCodex],
            timeoutMs: 5_000,
            env: { SOVEREIGNBOT_CAPTURE_ARGS: capture },
        },
    }));

    try {
        await runtime.orchestrator.submit({ title: "bridge attach", requiredCapabilities: ["coding"] });
        const result = await runtime.orchestrator.runNext();
        assert.equal(result.status, "completed");
        const args = JSON.parse(await readFile(capture, "utf8"));
        const overrides = args
            .map((value, index) => args[index - 1] === "--config" ? value : undefined)
            .filter(Boolean);
        assert.equal(overrides.some((value) => value.startsWith("mcp_servers.sovereignbot.command=")), true);
        assert.equal(overrides.includes("mcp_servers.sovereignbot.required=true"), true);
        assert.equal(overrides.some((value) => value.includes("default_tools_approval_mode")), true);

        const argsOverride = overrides.find((value) => value.startsWith("mcp_servers.sovereignbot.args="));
        assert.ok(argsOverride);
        const mcpArgs = JSON.parse(argsOverride.slice(argsOverride.indexOf("=") + 1));
        const bootstrapIndex = mcpArgs.indexOf("--bootstrap");
        assert.notEqual(bootstrapIndex, -1);
        const bootstrapPath = mcpArgs[bootstrapIndex + 1];
        assert.equal(await missing(bootstrapPath), true);
        assert.equal(args.some((value) => /capability|bearer|authorization/i.test(String(value))), false);
        assert.equal(result.result.text.includes("mcp_servers.sovereignbot"), false);
    }
    finally {
        await runtime.close();
    }
});

test("Claude Code receives governed MCP file/tool allowlist and the file is cleaned", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-claude-bridge-attach-"));
    const capture = join(root, "args.json");
    const runtime = await createRuntime(baseConfig(join(root, "data"), {
        id: "claude-worker",
        name: "Claude Worker",
        role: "worker",
        capabilities: ["coding"],
        governedTools: ["computer"],
        harness: {
            kind: "claude-code",
            command: process.execPath,
            prefixArgs: [fakeClaude],
            timeoutMs: 5_000,
            env: { SOVEREIGNBOT_CAPTURE_ARGS: capture },
        },
    }));

    try {
        await runtime.orchestrator.submit({ title: "bridge attach", requiredCapabilities: ["coding"] });
        const result = await runtime.orchestrator.runNext();
        assert.equal(result.status, "completed");
        const args = JSON.parse(await readFile(capture, "utf8"));
        const configIndex = args.indexOf("--mcp-config");
        assert.notEqual(configIndex, -1);
        const mcpConfigPath = args[configIndex + 1];
        assert.equal(await missing(mcpConfigPath), true);
        const allowedIndex = args.indexOf("--allowedTools");
        assert.notEqual(allowedIndex, -1);
        assert.match(args[allowedIndex + 1], /mcp__sovereignbot__snapshot/);
        assert.match(args[allowedIndex + 1], /mcp__sovereignbot__request_secret/);
        assert.doesNotMatch(args[allowedIndex + 1], /supply_secret/);
        assert.equal(args.some((value) => /capability|bearer|authorization/i.test(String(value))), false);
    }
    finally {
        await runtime.close();
    }
});
