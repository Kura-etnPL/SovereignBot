import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export async function startMcpClient(command, args, options = {}) {
    const child = spawn(command, args, {
        shell: false,
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map();
    let nextId = 1;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-6000); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const reader = (async () => {
        for await (const line of lines) {
            if (!line.trim())
                continue;
            let message;
            try {
                message = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (message.id !== undefined && pending.has(message.id)) {
                const entry = pending.get(message.id);
                pending.delete(message.id);
                if (message.error)
                    entry.reject(new Error(message.error.message ?? "MCP request failed"));
                else
                    entry.resolve(message.result);
            }
        }
        for (const entry of pending.values())
            entry.reject(new Error(`MCP process ended before response: ${stderr}`));
        pending.clear();
    })();

    const request = (method, params) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
    const notify = (method, params) => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`);
    };

    const initialized = await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "sovereignbot-test", version: "1" },
    });
    notify("notifications/initialized", {});

    return {
        child,
        initialized,
        request,
        notify,
        async call(name, args = {}) {
            return request("tools/call", { name, arguments: args });
        },
        async tools() {
            return (await request("tools/list", {})).tools;
        },
        stderr: () => stderr,
        async close() {
            child.stdin.end();
            if (child.exitCode === null) {
                await new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        try { child.kill("SIGKILL"); } catch {}
                        resolve();
                    }, 1500);
                    child.once("exit", () => { clearTimeout(timeout); resolve(); });
                    try { child.kill("SIGTERM"); } catch { clearTimeout(timeout); resolve(); }
                });
            }
            await reader.catch(() => undefined);
        },
    };
}

export function textValue(result) {
    const text = result?.content?.find((item) => item.type === "text")?.text;
    return text === undefined ? undefined : JSON.parse(text);
}
