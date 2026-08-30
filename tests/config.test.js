import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultWorkerNodeConfig, loadConfig } from "../src/config.js";

async function writeConfig(config) {
    const dir = await mkdtemp(join(tmpdir(), "sovereign-config-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify(config), "utf8");
    return path;
}

function base(agent) {
    return {
        dataDir: ".sovereignbot/data",
        agents: [agent],
        policy: { rules: [] },
    };
}

test("configuration accepts a Codex harness without a machine-specific command", async () => {
    const path = await writeConfig(base({
        id: "codex",
        name: "Codex",
        capabilities: ["coding"],
        harness: { kind: "codex", cwd: "." },
    }));
    const config = await loadConfig(path);
    assert.equal(config.agents[0].harness.kind, "codex");
});

test("configuration accepts a Claude Code harness without a machine-specific command", async () => {
    const path = await writeConfig(base({
        id: "claude",
        name: "Claude Code",
        capabilities: ["coding"],
        harness: { kind: "claude-code", cwd: ".", maxTurns: 12 },
    }));
    const config = await loadConfig(path);
    assert.equal(config.agents[0].harness.kind, "claude-code");
    assert.equal(config.agents[0].harness.maxTurns, 12);
});

test("configuration rejects unsupported harness kinds", async () => {
    const path = await writeConfig(base({
        id: "bad",
        name: "Bad",
        capabilities: [],
        harness: { kind: "mystery" },
    }));
    await assert.rejects(() => loadConfig(path), /unsupported harness kind/);
});

test("command harness requires an explicit executable", async () => {
    const path = await writeConfig(base({
        id: "command",
        name: "Command",
        capabilities: [],
        harness: { kind: "command" },
    }));
    await assert.rejects(() => loadConfig(path), /requires harness.command/);
});

test("Codex prefixArgs require an explicit launcher command", async () => {
    const path = await writeConfig(base({
        id: "codex",
        name: "Codex",
        capabilities: ["coding"],
        harness: { kind: "codex", prefixArgs: ["wrapper.js"] },
    }));
    await assert.rejects(() => loadConfig(path), /prefixArgs.*explicit harness.command/);
});

test("Claude Code prefixArgs require an explicit launcher command", async () => {
    const path = await writeConfig(base({
        id: "claude",
        name: "Claude Code",
        capabilities: ["coding"],
        harness: { kind: "claude-code", prefixArgs: ["wrapper.js"] },
    }));
    await assert.rejects(() => loadConfig(path), /prefixArgs.*explicit harness.command/);
});

test("harness maxTurns must be a positive integer", async () => {
    const path = await writeConfig(base({
        id: "claude",
        name: "Claude Code",
        capabilities: ["coding"],
        harness: { kind: "claude-code", maxTurns: 0 },
    }));
    await assert.rejects(() => loadConfig(path), /maxTurns.*positive integer/);
});

test("production Worker Node defaults require an explicit real provider", () => {
    assert.throws(() => defaultWorkerNodeConfig("data", "workspace"), /requires --provider codex or --provider claude-code/);
    assert.throws(() => defaultWorkerNodeConfig("data", "workspace", "echo"), /Echo is not a production Worker Node harness/);
    for (const provider of ["codex", "claude-code"]) {
        const config = defaultWorkerNodeConfig("data", "workspace", provider);
        assert.equal(config.agents[0].harness.kind, provider);
        assert.equal(config.agents[1].harness.kind, provider);
        assert.ok(config.agents.every((agent) => agent.harness.kind !== "echo"));
    }
});
