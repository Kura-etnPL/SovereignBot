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

function taskIdFromPath(pathname) {
    return decodeURIComponent(pathname.split("/")[2] ?? "");
}

export function startServer(runtime) {
    const host = runtime.config.bindHost ?? "127.0.0.1";
    const port = runtime.config.port ?? 7341;
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
            if (request.method === "GET" && url.pathname === "/health") {
                send(response, 200, { ok: true, name: "SovereignBot", version: "0.2.0" });
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
            if (request.method === "POST" && url.pathname === "/plans") {
                const plan = await runtime.orchestrator.createPlan(await readBody(request));
                send(response, 201, plan);
                return;
            }
            if (request.method === "POST" && url.pathname === "/run") {
                const results = await runtime.orchestrator.runUntilIdle();
                send(response, 200, results);
                return;
            }
            if (request.method === "GET" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/graph")) {
                send(response, 200, await runtime.orchestrator.getTaskGraph(taskIdFromPath(url.pathname)));
                return;
            }
            if (request.method === "GET" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/events")) {
                send(response, 200, await runtime.orchestrator.listTaskEvents(taskIdFromPath(url.pathname)));
                return;
            }
            if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/delegate")) {
                const body = await readBody(request);
                const task = await runtime.orchestrator.delegate(
                    taskIdFromPath(url.pathname),
                    body?.task ?? body?.spec ?? {},
                    body?.actorAgentId,
                );
                send(response, 201, task);
                return;
            }
            if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/progress")) {
                const body = await readBody(request);
                const result = await runtime.orchestrator.reportProgress(
                    taskIdFromPath(url.pathname),
                    {
                        eventId: body?.eventId,
                        percent: body?.percent,
                        message: body?.message,
                        data: body?.data,
                    },
                    body?.actorAgentId,
                );
                send(response, 200, result);
                return;
            }
            if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/review")) {
                const body = await readBody(request);
                const task = await runtime.orchestrator.reviewTask(
                    taskIdFromPath(url.pathname),
                    {
                        eventId: body?.eventId,
                        decision: body?.decision,
                        notes: body?.notes,
                    },
                    body?.reviewerAgentId,
                );
                send(response, 200, task);
                return;
            }
            if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/aggregate")) {
                const body = await readBody(request);
                const task = await runtime.orchestrator.aggregatePlan(
                    taskIdFromPath(url.pathname),
                    body?.actorAgentId,
                );
                send(response, 200, task);
                return;
            }
            if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/retry")) {
                send(response, 200, await runtime.orchestrator.retry(taskIdFromPath(url.pathname)));
                return;
            }
            if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/cancel")) {
                const body = await readBody(request);
                send(
                    response,
                    200,
                    await runtime.orchestrator.cancel(taskIdFromPath(url.pathname), {
                        actor: body?.actorAgentId ?? body?.actor,
                        eventId: body?.eventId,
                        reason: body?.reason,
                        cascade: body?.cascade,
                    }),
                );
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
