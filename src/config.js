import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const DEFAULT_CONFIG_PATH = ".sovereignbot/config.json";
const SUPPORTED_HARNESSES = new Set(["echo", "command", "codex", "claude-code"]);
const SUPPORTED_COMPUTER_DRIVERS = new Set(["webdriver-sidecar"]);
const SUPPORTED_BROWSERS = new Set(["chrome", "edge", "firefox"]);

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

function positiveInteger(value, name) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0))
        throw new Error(`${name} must be a positive integer`);
}

function stringArray(value, name) {
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string")))
        throw new Error(`${name} must be an array of strings`);
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
    stringArray(driver.webdriverArgs, "config.computer.driver.webdriverArgs");
    stringArray(driver.sidecarArgs, "config.computer.driver.sidecarArgs");
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
    }
    if (!config.policy || !Array.isArray(config.policy.rules)) {
        throw new Error("config.policy.rules is required; SovereignBot fails closed without policy");
    }
    return config;
}
