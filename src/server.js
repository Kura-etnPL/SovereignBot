import { createServer } from "node:http";
async function readBody(request) {
    const chunks = [];
    for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (!chunks.length)
        return undefined;
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function send(response, status, value) {
    const body = JSON.stringify(value, null, 2);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
    });
    response.end(body);
}
export function startServer(runtime) {
    const host = runtime.config.bindHost ?? "127.0.0.1";
    const port = runtime.config.port ?? 7341;
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
            if (request.method === "GET" && url.pathname === "/health") {
                send(response, 200, { ok: true, name: "SovereignBot", version: "0.1.0" });
                return;
            }
            if (request.method === "GET" && url.pathname === "/agents") {
                send(response, 200, runtime.orchestrator.listAgents());
                return;
            }
            if (request.method === "GET" && url.pathname === "/tasks") {
                send(response, 200, await runtime.orchestrator.listTasks());
                return;
            }
            if (request.method === "POST" && url.pathname === "/tasks") {
                const task = await runtime.orchestrator.submit(await readBody(request));
                send(response, 201, task);
                return;
            }
            if (request.method === "POST" && url.pathname === "/run") {
                const results = await runtime.orchestrator.runUntilIdle();
                send(response, 200, results);
                return;
            }
            if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/cancel")) {
                const id = decodeURIComponent(url.pathname.split("/")[2] ?? "");
                send(response, 200, await runtime.orchestrator.cancel(id));
                return;
            }
            if (request.method === "GET" && url.pathname === "/audit/verify") {
                send(response, 200, await runtime.audit.verify());
                return;
            }
            if (request.method === "GET" && url.pathname === "/memory") {
                const scope = url.searchParams.get("scope") || undefined;
                const query = url.searchParams.get("q") || undefined;
                send(response, 200, await runtime.memory.search({ scope, query, limit: 100 }));
                return;
            }
            send(response, 404, { error: "not found" });
        }
        catch (error) {
            send(response, 400, { error: error.message });
        }
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            resolve({
                url: `http://${host}:${port}`,
                close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
            });
        });
    });
}
