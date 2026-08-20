import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
export const DEFAULT_CONFIG_PATH = ".sovereignbot/config.json";
export function defaultConfig(dataDir = ".sovereignbot/data") {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 7341,
        agents: [
            {
                id: "local-echo",
                name: "Local Echo",
                role: "worker",
                capabilities: ["demo"],
                harness: { kind: "echo" },
            },
        ],
        policy: {
            repeatWindowMs: 180000,
            rules: [
                {
                    id: "deny-runaway-loop",
                    effect: "deny",
                    description: "stop an identical harness action after ten attempts in the repeat window",
                    match: { category: "harness", operation: "run", repeatAtLeast: 10 },
                },
                {
                    id: "allow-local-echo",
                    effect: "allow",
                    description: "allow the built-in local echo harness",
                    match: { category: "harness", operation: "run", targetGlob: "echo" },
                },
            ],
        },
    };
}
export async function writeDefaultConfig(path = DEFAULT_CONFIG_PATH) {
    const absolute = resolve(path);
    await mkdir(dirname(absolute), { recursive: true });
    try {
        await readFile(absolute, "utf8");
        throw new Error(`config already exists: ${absolute}`);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    await writeFile(absolute, `${JSON.stringify(defaultConfig(), null, 2)}\n`, "utf8");
    return absolute;
}
export async function loadConfig(path = DEFAULT_CONFIG_PATH) {
    const absolute = resolve(path);
    const config = JSON.parse(await readFile(absolute, "utf8"));
    if (!config.dataDir)
        throw new Error("config.dataDir is required");
    if (!Array.isArray(config.agents) || config.agents.length === 0) {
        throw new Error("config.agents must contain at least one agent");
    }
    const ids = new Set();
    for (const agent of config.agents) {
        if (!agent.id || !agent.name)
            throw new Error("every agent needs id and name");
        if (ids.has(agent.id))
            throw new Error(`duplicate agent id: ${agent.id}`);
        ids.add(agent.id);
    }
    if (!config.policy || !Array.isArray(config.policy.rules)) {
        throw new Error("config.policy.rules is required; SovereignBot fails closed without policy");
    }
    return config;
}
