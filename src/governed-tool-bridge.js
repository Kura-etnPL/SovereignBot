import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createId } from "./id.js";

const MCP_SERVER_PATH = fileURLToPath(new URL("./governed-mcp-server.js", import.meta.url));
const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const GOVERNED_MCP_SERVER_NAME = "sovereignbot";
export const GOVERNED_MCP_TOOLS = [
    "snapshot",
    "navigate",
    "click",
    "type",
    "key",
    "scroll",
    "list_files",
    "read_file",
    "write_file",
    "request_help",
    "request_secret",
];

function token() {
    return randomBytes(32).toString("base64url");
}

function bearer(request) {
    const value = request.headers.authorization;
    return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : "";
}

async function readJson(request) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_BODY_BYTES)
            throw new Error("governed tool request is too large");
        chunks.push(buffer);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function send(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
    });
    response.end(body);
}

function safeError(error) {
    return (error instanceof Error ? error.message : "governed tool failed")
        .replace(/[\r\n]+/g, " ")
        .slice(0, 1400);
}

function hasComputerTools(agent) {
    return Array.isArray(agent.governedTools) && agent.governedTools.includes("computer");
}

function claudeToolNames() {
    return GOVERNED_MCP_TOOLS.map((name) => `mcp__${GOVERNED_MCP_SERVER_NAME}__${name}`);
}

function toml(value) {
    return JSON.stringify(value);
}

export class GovernedToolBridgeManager {
    #dataDir;
    #computer;
    #audit;
    #server;
    #url;
    #leases = new Map();
    #starting;

    constructor({ dataDir, computer, audit }) {
        this.#dataDir = join(dataDir, "tool-bridges");
        this.#computer = computer;
        this.#audit = audit;
    }

    async prepare({ task, agent, signal }) {
        if (!hasComputerTools(agent))
            return undefined;
        if (!["codex", "claude-code"].includes(agent.harness?.kind)) {
            throw new Error(`governed computer tools require a Codex or Claude Code harness, got ${agent.harness?.kind ?? "unknown"}`);
        }
        if (signal?.aborted)
            throw new Error("cannot open governed tool bridge: task is already aborted");
        if (task.status !== "running" || task.assignedAgentId !== agent.id) {
            throw new Error(`cannot open governed tool bridge for task ${task.id}: task is not running under agent ${agent.id}`);
        }

        await this.#ensureServer();
        await mkdir(this.#dataDir, { recursive: true, mode: 0o700 });

        const id = createId("bridge");
        const capability = token();
        const bootstrapPath = join(this.#dataDir, `${id}.bootstrap.json`);
        const claudeConfigPath = join(this.#dataDir, `${id}.claude-mcp.json`);
        const command = process.execPath;
        const args = [MCP_SERVER_PATH, "--bootstrap", bootstrapPath];
        const lease = {
            id,
            capability,
            taskId: task.id,
            agentId: agent.id,
            active: true,
            bootstrapPath,
            claudeConfigPath,
        };
        this.#leases.set(capability, lease);

        try {
            await writeFile(bootstrapPath, `${JSON.stringify({
                protocol: "sovereignbot.governed-bridge.v1",
                brokerUrl: this.#url,
                capability,
            })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });

            await writeFile(claudeConfigPath, `${JSON.stringify({
                mcpServers: {
                    [GOVERNED_MCP_SERVER_NAME]: { command, args },
                },
            }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });

            // Opening authority is itself security-sensitive. If the audit chain cannot record the
            // grant, revoke the capability and remove local bootstrap material before returning.
            await this.#audit.append({
                type: "tool_bridge.opened",
                actor: agent.id,
                subject: task.id,
                data: { bridgeId: id, server: GOVERNED_MCP_SERVER_NAME, tools: ["computer"] },
            });
        }
        catch (error) {
            lease.active = false;
            this.#leases.delete(capability);
            await Promise.allSettled([unlink(bootstrapPath), unlink(claudeConfigPath)]);
            throw error;
        }

        let closed = false;
        let onAbort;
        const close = async (reason = "harness finished") => {
            if (closed)
                return;
            closed = true;
            if (onAbort)
                signal?.removeEventListener("abort", onAbort);

            // Revoke authority first. Cleanup/audit errors after this point must never resurrect the
            // bridge or turn a successfully completed provider task into a failed provider task.
            lease.active = false;
            this.#leases.delete(capability);
            await Promise.allSettled([unlink(bootstrapPath), unlink(claudeConfigPath)]);
            await this.#audit.append({
                type: "tool_bridge.closed",
                actor: agent.id,
                subject: task.id,
                data: { bridgeId: id, reason },
            }).catch(() => undefined);
        };
        onAbort = () => { void close("task aborted"); };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
            await close("task aborted before bridge handoff");
            throw new Error("cannot open governed tool bridge: task was aborted during bridge setup");
        }

        return {
            id,
            serverName: GOVERNED_MCP_SERVER_NAME,
            command,
            args,
            claudeConfigPath,
            toolNames: [...GOVERNED_MCP_TOOLS],
            claudeToolNames: claudeToolNames(),
            codexConfigOverrides: [
                `mcp_servers.${GOVERNED_MCP_SERVER_NAME}.command=${toml(command)}`,
                `mcp_servers.${GOVERNED_MCP_SERVER_NAME}.args=${toml(args)}`,
                `mcp_servers.${GOVERNED_MCP_SERVER_NAME}.required=true`,
                `mcp_servers.${GOVERNED_MCP_SERVER_NAME}.startup_timeout_sec=10`,
                `mcp_servers.${GOVERNED_MCP_SERVER_NAME}.default_tools_approval_mode=\"approve\"`,
            ],
            close,
        };
    }

    async close() {
        const leases = [...this.#leases.values()];
        this.#leases.clear();
        for (const lease of leases) {
            lease.active = false;
            await Promise.allSettled([unlink(lease.bootstrapPath), unlink(lease.claudeConfigPath)]);
        }
        if (this.#server) {
            const server = this.#server;
            this.#server = undefined;
            this.#url = undefined;
            await new Promise((resolve) => server.close(() => resolve()));
        }
    }

    async #ensureServer() {
        if (this.#server)
            return;
        if (!this.#starting)
            this.#starting = this.#startServer().finally(() => { this.#starting = undefined; });
        await this.#starting;
    }

    async #startServer() {
        const server = createServer(async (request, response) => {
            try {
                if (request.method !== "POST" || request.url !== "/invoke") {
                    send(response, 404, { error: "not found" });
                    return;
                }
                const lease = this.#leases.get(bearer(request));
                if (!lease?.active) {
                    send(response, 401, { error: "governed tool capability is invalid or revoked" });
                    return;
                }
                const body = await readJson(request);
                if (!GOVERNED_MCP_TOOLS.includes(body.name)) {
                    send(response, 404, { error: "unknown governed tool" });
                    return;
                }

                // Record the attempt before any governed side effect. If this append fails, fail
                // closed before invoking ComputerGateway so callers never retry an already-executed
                // click/type because only the supplemental bridge audit failed afterward.
                await this.#audit.append({
                    type: "tool_bridge.invoking",
                    actor: lease.agentId,
                    subject: lease.taskId,
                    data: { bridgeId: lease.id, tool: body.name },
                });

                const result = await this.#invoke(lease, body.name, body.arguments ?? {});
                send(response, 200, { ok: true, result });
            }
            catch (error) {
                send(response, 403, { ok: false, error: safeError(error) });
            }
        });
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
            await new Promise((resolve) => server.close(() => resolve()));
            throw new Error("governed tool broker did not receive a loopback port");
        }
        this.#server = server;
        this.#url = `http://127.0.0.1:${address.port}`;
    }

    async #invoke(lease, name, input) {
        const agentId = lease.agentId;
        const taskId = lease.taskId;
        switch (name) {
            case "snapshot":
                return this.#computer.snapshot(agentId, taskId);
            case "navigate":
                return this.#computer.navigate(agentId, taskId, input.url);
            case "click":
                return this.#computer.click(agentId, taskId, { snapshotId: input.snapshotId, ref: input.ref });
            case "type":
                return this.#computer.type(agentId, taskId, { snapshotId: input.snapshotId, ref: input.ref, text: input.text ?? "" });
            case "key":
                return this.#computer.key(agentId, taskId, { snapshotId: input.snapshotId, ref: input.ref, key: input.key });
            case "scroll":
                return this.#computer.scroll(agentId, taskId, { deltaX: input.deltaX, deltaY: input.deltaY });
            case "list_files":
                return this.#computer.listFiles(agentId, taskId, input.path ?? ".");
            case "read_file":
                return {
                    path: input.path,
                    encoding: input.encoding ?? "utf8",
                    content: await this.#computer.readFile(agentId, taskId, { path: input.path, encoding: input.encoding }),
                };
            case "write_file":
                return this.#computer.writeFile(agentId, taskId, { path: input.path, content: input.content ?? "", encoding: input.encoding });
            case "request_help":
                return this.#computer.requestHelp(agentId, taskId, input.reason);
            case "request_secret":
                return this.#computer.requestSecret(agentId, taskId, { snapshotId: input.snapshotId, ref: input.ref, label: input.label });
            default:
                throw new Error(`unknown governed tool: ${name}`);
        }
    }
}

export async function readBridgeBootstrap(path) {
    const raw = await readFile(path, "utf8");
    await unlink(path).catch(() => undefined);
    const value = JSON.parse(raw);
    if (value?.protocol !== "sovereignbot.governed-bridge.v1")
        throw new Error("governed tool bridge bootstrap protocol mismatch");
    if (typeof value.brokerUrl !== "string" || !value.brokerUrl.startsWith("http://127.0.0.1:"))
        throw new Error("governed tool bridge broker must be loopback");
    if (typeof value.capability !== "string" || value.capability.length < 24)
        throw new Error("governed tool bridge capability is invalid");
    return value;
}
