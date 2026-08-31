import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const DEFAULT_CONFIG_PATH = ".sovereignbot/config.json";
const SUPPORTED_HARNESSES = new Set(["echo", "command", "codex", "claude-code"]);
const WORKER_NODE_PROVIDERS = new Set(["codex", "claude-code"]);
const SUPPORTED_COMPUTER_DRIVERS = new Set(["webdriver-sidecar"]);
const SUPPORTED_BROWSERS = new Set(["chrome", "edge", "firefox"]);
const SUPPORTED_GOVERNED_TOOLS = new Set(["computer", "workspace"]);

export function defaultConfig(dataDir = ".sovereignbot/data") {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 7341,
        computer: {
            allowPrivateHosts: false,
        },
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
            repeatMaxActiveFingerprints: 10000,
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

export function defaultWorkerNodeConfig(dataDir = ".sovereignbot/worker-node-data", workspacePath = process.cwd(), provider) {
    if (!WORKER_NODE_PROVIDERS.has(provider))
        throw new Error("worker-node init requires --provider codex or --provider claude-code; Echo is not a production Worker Node harness");
    const providerHarness = { kind: provider };
    return {
        dataDir,
        name: "Sovereign Worker",
        bindHost: "127.0.0.1",
        port: 7342,
        supervisorAgentId: "worker-node-supervisor",
        workerAgentId: "worker-node-worker",
        workspaces: [{ id: "ws_main", name: "Main workspace", path: workspacePath }],
        agents: [
            {
                id: "worker-node-supervisor",
                name: "Worker Node Supervisor",
                role: "supervisor",
                capabilities: ["planning"],
                harness: { ...providerHarness },
            },
            {
                id: "worker-node-worker",
                name: "Worker Node Worker",
                role: "worker",
                capabilities: ["general", "coding", "research"],
                harness: { ...providerHarness },
            },
        ],
        policy: {
            repeatWindowMs: 180000,
            repeatMaxActiveFingerprints: 10000,
            rules: [
                {
                    id: "deny-runaway-loop",
                    effect: "deny",
                    description: "stop an identical harness action after ten attempts in the repeat window",
                    match: { category: "harness", operation: "run", repeatAtLeast: 10 },
                },
                {
                    id: "allow-worker-node-worker",
                    effect: "allow",
                    description: "allow the configured Worker Node worker harness",
                    match: { category: "harness", operation: "run", agentId: "worker-node-worker" },
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

function positiveInteger(value, name) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0))
        throw new Error(`${name} must be a positive integer`);
}

function stringArray(value, name) {
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string")))
        throw new Error(`${name} must be an array of strings`);
}

function stringMap(value, name) {
    if (value === undefined)
        return;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${name} must be an object of string values`);
    for (const [key, entry] of Object.entries(value)) {
        if (!key || typeof entry !== "string")
            throw new Error(`${name} must be an object of string values`);
        if (key.includes("\0") || key.includes("="))
            throw new Error(`${name} contains an invalid environment variable name: ${key}`);
    }
}

function optionalString(value, name) {
    if (value !== undefined && (typeof value !== "string" || !value.trim()))
        throw new Error(`${name} must be a non-empty string`);
}

function validateComputer(computer) {
    if (computer === undefined)
        return;
    if (!computer || typeof computer !== "object" || Array.isArray(computer))
        throw new Error("config.computer must be an object");
    if (computer.allowPrivateHosts !== undefined && typeof computer.allowPrivateHosts !== "boolean")
        throw new Error("config.computer.allowPrivateHosts must be a boolean");
    if (computer.driver === undefined)
        return;
    if (!computer.driver || typeof computer.driver !== "object" || Array.isArray(computer.driver))
        throw new Error("config.computer.driver must be an object");
    const driver = computer.driver;
    if (!SUPPORTED_COMPUTER_DRIVERS.has(driver.kind))
        throw new Error(`unsupported computer driver kind: ${driver.kind}`);
    if (driver.browser !== undefined && !SUPPORTED_BROWSERS.has(driver.browser))
        throw new Error(`unsupported WebDriver browser: ${driver.browser}`);
    if (driver.headless !== undefined && typeof driver.headless !== "boolean")
        throw new Error("config.computer.driver.headless must be a boolean");
    optionalString(driver.browserBinary, "config.computer.driver.browserBinary");
    optionalString(driver.webdriverCommand, "config.computer.driver.webdriverCommand");
    optionalString(driver.sidecarCommand, "config.computer.driver.sidecarCommand");
    optionalString(driver.cwd, "config.computer.driver.cwd");
    stringArray(driver.webdriverArgs, "config.computer.driver.webdriverArgs");
    stringArray(driver.sidecarArgs, "config.computer.driver.sidecarArgs");
    stringMap(driver.env, "config.computer.driver.env");
    positiveInteger(driver.startupTimeoutMs, "config.computer.driver.startupTimeoutMs");
    positiveInteger(driver.requestTimeoutMs, "config.computer.driver.requestTimeoutMs");

    if (driver.webdriverUrl !== undefined) {
        let parsed;
        try {
            parsed = new URL(driver.webdriverUrl);
        }
        catch {
            throw new Error("config.computer.driver.webdriverUrl must be a valid URL");
        }
        const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
            throw new Error("config.computer.driver.webdriverUrl must be a loopback http endpoint");
        }
        if (parsed.username || parsed.password)
            throw new Error("config.computer.driver.webdriverUrl must not contain credentials");
    }
}

function validateGovernedTools(agent) {
    if (agent.governedTools === undefined)
        return;
    if (!Array.isArray(agent.governedTools) || agent.governedTools.some((tool) => typeof tool !== "string"))
        throw new Error(`agent ${agent.id} governedTools must be an array of strings`);
    const unique = new Set(agent.governedTools);
    if (unique.size !== agent.governedTools.length)
        throw new Error(`agent ${agent.id} governedTools contains duplicates`);
    for (const tool of unique) {
        if (!SUPPORTED_GOVERNED_TOOLS.has(tool))
            throw new Error(`agent ${agent.id} uses unsupported governed tool: ${tool}`);
    }
    if (unique.size && !["codex", "claude-code"].includes(agent.harness.kind)) {
        throw new Error(`agent ${agent.id} governedTools require a codex or claude-code harness`);
    }
}

export async function loadConfig(path = DEFAULT_CONFIG_PATH) {
    const absolute = resolve(path);
    const config = JSON.parse(await readFile(absolute, "utf8"));
    if (!config.dataDir)
        throw new Error("config.dataDir is required");
    validateComputer(config.computer);
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

        if (!agent.harness?.kind)
            throw new Error(`agent ${agent.id} needs harness.kind`);
        if (!SUPPORTED_HARNESSES.has(agent.harness.kind)) {
            throw new Error(`agent ${agent.id} uses unsupported harness kind: ${agent.harness.kind}`);
        }
        if (agent.harness.kind === "command" && !agent.harness.command) {
            throw new Error(`command harness for agent ${agent.id} requires harness.command`);
        }
        if (["codex", "claude-code"].includes(agent.harness.kind) && agent.harness.prefixArgs?.length && !agent.harness.command) {
            throw new Error(`${agent.harness.kind} harness prefixArgs for agent ${agent.id} require an explicit harness.command`);
        }
        if (agent.harness.maxTurns !== undefined && (!Number.isInteger(agent.harness.maxTurns) || agent.harness.maxTurns <= 0)) {
            throw new Error(`harness.maxTurns for agent ${agent.id} must be a positive integer`);
        }
        validateGovernedTools(agent);
    }
    if (!config.policy || !Array.isArray(config.policy.rules)) {
        throw new Error("config.policy.rules is required; SovereignBot fails closed without policy");
    }
    positiveInteger(config.policy.repeatWindowMs, "config.policy.repeatWindowMs");
    positiveInteger(config.policy.repeatMaxActiveFingerprints, "config.policy.repeatMaxActiveFingerprints");
    return config;
}
