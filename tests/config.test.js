import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

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
