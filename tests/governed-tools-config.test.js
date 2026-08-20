import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

async function pathFor(agent) {
    const dir = await mkdtemp(join(tmpdir(), "sovereign-governed-tools-config-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
        dataDir: join(dir, "data"),
        agents: [agent],
        policy: { rules: [] },
    }), "utf8");
    return path;
}

test("governed computer tools are accepted for Codex and Claude Code", async () => {
    for (const kind of ["codex", "claude-code"]) {
        const path = await pathFor({
            id: `${kind}-worker`,
            name: kind,
            capabilities: ["browser"],
            governedTools: ["computer"],
            harness: { kind, command: process.execPath },
        });
        const config = await loadConfig(path);
        assert.deepEqual(config.agents[0].governedTools, ["computer"]);
    }
});

test("governed tools reject unsupported harnesses, tool names and duplicates", async () => {
    const echo = await pathFor({
        id: "echo",
        name: "echo",
        capabilities: [],
        governedTools: ["computer"],
        harness: { kind: "echo" },
    });
    await assert.rejects(() => loadConfig(echo), /require a codex or claude-code harness/);

    const unknown = await pathFor({
        id: "codex",
        name: "codex",
        capabilities: [],
        governedTools: ["raw-webdriver"],
        harness: { kind: "codex", command: process.execPath },
    });
    await assert.rejects(() => loadConfig(unknown), /unsupported governed tool/);

    const duplicate = await pathFor({
        id: "claude",
        name: "claude",
        capabilities: [],
        governedTools: ["computer", "computer"],
        harness: { kind: "claude-code", command: process.execPath },
    });
    await assert.rejects(() => loadConfig(duplicate), /contains duplicates/);
});
