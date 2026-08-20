#!/usr/bin/env node
import { createInterface } from "node:readline";
import { readBridgeBootstrap, GOVERNED_MCP_TOOLS } from "./governed-tool-bridge.js";

function valueAfter(args, flag) {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
}

const object = (properties = {}, required = []) => ({
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
});
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });

const TOOLS = [
    {
        name: "snapshot",
        description: "Take a fresh structured snapshot of this worker's governed browser. Returns only safe refs/roles/names, never raw browser handles.",
        inputSchema: object(),
    },
    {
        name: "navigate",
        description: "Navigate the governed browser to an http/https URL. SovereignBot policy and egress rules apply.",
        inputSchema: object({ url: str("Destination URL") }, ["url"]),
    },
    {
        name: "click",
        description: "Click an element from the current structured snapshot.",
        inputSchema: object({ snapshotId: str("Current SovereignBot snapshot id"), ref: str("Element ref from that snapshot") }, ["snapshotId", "ref"]),
    },
    {
        name: "type",
        description: "Type ordinary non-secret text into an element from the current snapshot. Use request_secret for credentials, OTPs, passwords, or other secrets.",
        inputSchema: object({ snapshotId: str("Current snapshot id"), ref: str("Element ref"), text: str("Ordinary non-secret text") }, ["snapshotId", "ref", "text"]),
    },
    {
        name: "key",
        description: "Send a key such as Enter, Tab, Escape or ArrowDown. If ref is supplied it must belong to the supplied current snapshot.",
        inputSchema: object({ snapshotId: str("Current snapshot id when targeting a ref"), ref: str("Optional element ref"), key: str("Key name") }, ["key"]),
    },
    {
        name: "scroll",
        description: "Scroll the current governed page.",
        inputSchema: object({ deltaX: num("Horizontal delta"), deltaY: num("Vertical delta") }),
    },
    {
        name: "list_files",
        description: "List files inside this worker's governed workspace only.",
        inputSchema: object({ path: str("Relative workspace path; defaults to .") }),
    },
    {
        name: "read_file",
        description: "Read a file inside this worker's governed workspace.",
        inputSchema: object({
            path: str("Relative workspace path"),
            encoding: { type: "string", enum: ["utf8", "base64"] },
        }, ["path"]),
    },
    {
        name: "write_file",
        description: "Write a file inside this worker's governed workspace. Policy applies to the path.",
        inputSchema: object({
            path: str("Relative workspace path"),
            content: str("File content"),
            encoding: { type: "string", enum: ["utf8", "base64"] },
        }, ["path", "content"]),
    },
    {
        name: "request_help",
        description: "Pause agent computer actions and ask the human operator to take over.",
        inputSchema: object({ reason: str("Why human control is needed") }, ["reason"]),
    },
    {
        name: "request_secret",
        description: "Request that the human operator enter a secret into a current element. The secret value is never returned to this MCP server or model.",
        inputSchema: object({
            snapshotId: str("Current snapshot id"),
            ref: str("Target element ref"),
            label: str("Human-readable secret label, e.g. account password or 2FA code"),
        }, ["snapshotId", "ref", "label"]),
    },
];

if (TOOLS.some((tool) => !GOVERNED_MCP_TOOLS.includes(tool.name)) || TOOLS.length !== GOVERNED_MCP_TOOLS.length)
    throw new Error("governed MCP tool catalog is out of sync with the broker");

function write(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
    write({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
    write({ jsonrpc: "2.0", id, error: { code, message } });
}

function textContent(value) {
    return [{ type: "text", text: JSON.stringify(value) }];
}

async function main() {
    const args = process.argv.slice(2);
    const bootstrapPath = valueAfter(args, "--bootstrap");
    if (!bootstrapPath)
        throw new Error("governed MCP server requires --bootstrap <path>");
    const bootstrap = await readBridgeBootstrap(bootstrapPath);
    let initialized = false;

    const invoke = async (name, input) => {
        const response = await fetch(`${bootstrap.brokerUrl}/invoke`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${bootstrap.capability}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ name, arguments: input ?? {} }),
        });
        const payload = await response.json().catch(() => ({ ok: false, error: `broker returned ${response.status}` }));
        if (!response.ok || !payload.ok)
            throw new Error(String(payload.error ?? "governed tool refused").slice(0, 1400));
        return payload.result;
    };

    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
        if (!line.trim())
            continue;
        let request;
        try {
            request = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") {
            if (request?.id !== undefined)
                error(request.id, -32600, "invalid request");
            continue;
        }

        if (request.method === "initialize") {
            initialized = true;
            result(request.id, {
                protocolVersion: typeof request.params?.protocolVersion === "string"
                    ? request.params.protocolVersion
                    : "2025-06-18",
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "sovereignbot-governed-tools", version: "0.3.0" },
            });
            continue;
        }
        if (request.method === "notifications/initialized" || request.method === "notifications/cancelled")
            continue;
        if (request.method === "ping") {
            result(request.id, {});
            continue;
        }
        if (!initialized) {
            if (request.id !== undefined)
                error(request.id, -32002, "server not initialized");
            continue;
        }
        if (request.method === "tools/list") {
            result(request.id, { tools: TOOLS });
            continue;
        }
        if (request.method === "tools/call") {
            const name = request.params?.name;
            if (!GOVERNED_MCP_TOOLS.includes(name)) {
                result(request.id, { isError: true, content: [{ type: "text", text: "unknown governed tool" }] });
                continue;
            }
            try {
                const value = await invoke(name, request.params?.arguments ?? {});
                result(request.id, { content: textContent(value), structuredContent: value });
            }
            catch (toolError) {
                result(request.id, {
                    isError: true,
                    content: [{ type: "text", text: toolError.message.replace(/[\r\n]+/g, " ").slice(0, 1400) }],
                });
            }
            continue;
        }
        if (request.id !== undefined)
            error(request.id, -32601, "method not found");
    }
}

main().catch((fatal) => {
    process.stderr.write(`SovereignBot governed MCP server failed: ${fatal.message}\n`);
    process.exitCode = 1;
});
