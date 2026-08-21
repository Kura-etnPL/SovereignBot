import { spawn } from "node:child_process";
import { ClaudeCodeHarness } from "./claude-code-harness.js";
import { CodexHarness } from "./codex-harness.js";

const TOOL_BRIDGE_MANAGERS = new WeakMap();
const HARNESS_ACTIVITY = new Map();

function adjustHarnessActivity(agentId, delta) {
    const next = Math.max(0, (HARNESS_ACTIVITY.get(agentId) ?? 0) + delta);
    if (next === 0)
        HARNESS_ACTIVITY.delete(agentId);
    else
        HARNESS_ACTIVITY.set(agentId, next);
}

export function harnessActivitySnapshot() {
    return new Map(HARNESS_ACTIVITY);
}

export function registerAgentToolBridgeManager(agent, manager) {
    if (manager)
        TOOL_BRIDGE_MANAGERS.set(agent, manager);
    else
        TOOL_BRIDGE_MANAGERS.delete(agent);
}

class EchoHarness {
    delayMs;
    constructor(delayMs = 0) {
        this.delayMs = delayMs;
    }
    async run(context) {
        if (this.delayMs > 0) {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(resolve, this.delayMs);
                context.signal.addEventListener("abort", () => {
                    clearTimeout(timeout);
                    reject(new Error("aborted"));
                }, { once: true });
            });
        }
        return {
            ok: true,
            output: {
                agent: context.agent.id,
                title: context.task.title,
                input: context.task.input,
            },
        };
    }
}

class CommandHarness {
    config;
    constructor(config) {
        this.config = config;
    }
    run(context) {
        return new Promise((resolve) => {
            const controller = new AbortController();
            const onAbort = () => controller.abort();
            context.signal.addEventListener("abort", onAbort, { once: true });
            if (context.signal.aborted)
                controller.abort();
            const timeoutMs = this.config.timeoutMs ?? 15 * 60_000;
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            const child = spawn(this.config.command, this.config.args ?? [], {
                shell: false,
                cwd: this.config.cwd,
                env: this.config.inheritEnv === false
                    ? { ...this.config.env }
                    : { ...process.env, ...this.config.env },
                stdio: ["pipe", "pipe", "pipe"],
                signal: controller.signal,
            });
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk) => (stdout += chunk));
            child.stderr.on("data", (chunk) => (stderr += chunk));
            child.on("error", (error) => {
                clearTimeout(timeout);
                context.signal.removeEventListener("abort", onAbort);
                resolve({ ok: false, error: error.message });
            });
            child.on("close", (code, signal) => {
                clearTimeout(timeout);
                context.signal.removeEventListener("abort", onAbort);
                const trimmed = stdout.trim();
                let output = trimmed;
                if (trimmed) {
                    try {
                        output = JSON.parse(trimmed);
                    }
                    catch {
                    }
                }
                resolve({
                    ok: code === 0,
                    output,
                    error: code === 0 ? undefined : stderr.trim() || `process exited ${code ?? signal}`,
                    metadata: { exitCode: code, signal, stderr: stderr.trim() || undefined },
                });
            });
            child.stdin.end(JSON.stringify({
                protocol: "sovereignbot.harness.v1",
                task: context.task,
                agent: {
                    id: context.agent.id,
                    name: context.agent.name,
                    role: context.agent.role,
                    capabilities: context.agent.capabilities,
                },
            }));
        });
    }
}

class ToolBridgeHarness {
    inner;
    manager;
    agent;

    constructor(inner, manager, agent) {
        this.inner = inner;
        this.manager = manager;
        this.agent = agent;
    }

    async run(context) {
        const bridge = await this.manager.prepare({
            task: context.task,
            agent: this.agent,
            signal: context.signal,
        });
        try {
            return await this.inner.run({ ...context, toolBridge: bridge });
        }
        finally {
            await bridge?.close("harness finished");
        }
    }
}

class MeteredHarness {
    inner;
    agentId;

    constructor(inner, agentId) {
        this.inner = inner;
        this.agentId = agentId;
    }

    async run(context) {
        adjustHarnessActivity(this.agentId, 1);
        try {
            return await this.inner.run(context);
        }
        finally {
            adjustHarnessActivity(this.agentId, -1);
        }
    }
}

export function harnessTarget(harness) {
    if (harness.kind === "command")
        return harness.command;
    if (harness.kind === "codex")
        return harness.command ?? process.env.SOVEREIGNBOT_CODEX_BIN ?? "codex";
    if (harness.kind === "claude-code")
        return harness.command ?? process.env.SOVEREIGNBOT_CLAUDE_BIN ?? "claude";
    return "echo";
}

function createBaseHarness(agent) {
    switch (agent.harness.kind) {
        case "echo":
            return new EchoHarness(agent.harness.delayMs);
        case "command":
            return new CommandHarness(agent.harness);
        case "codex":
            return new CodexHarness(agent.harness);
        case "claude-code":
            return new ClaudeCodeHarness(agent.harness);
        default:
            throw new Error(`unsupported harness kind: ${agent.harness.kind}`);
    }
}

export function createHarness(agent) {
    const base = createBaseHarness(agent);
    const manager = TOOL_BRIDGE_MANAGERS.get(agent);
    const governed = manager ? new ToolBridgeHarness(base, manager, agent) : base;
    return new MeteredHarness(governed, agent.id);
}
