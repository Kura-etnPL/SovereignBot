import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { handleComputerApiRequest } from "./computer-api.js";
import { handleOperatorApiRequest, loopbackHost } from "./operator-api.js";
import { handleOperatorStream } from "./operator-stream.js";
import {
    providerContinuityRefs,
    publicAgentListView,
    publicMemoryRecords,
    publicProgressView,
    publicRuntimeRecords,
    publicTaskGraphView,
    publicTaskListView,
    publicTaskView,
} from "./task-view.js";

const UI_FILES = {
    "/ui/": { path: fileURLToPath(new URL("../ui/index.html", import.meta.url)), type: "text/html; charset=utf-8" },
    "/ui/app.js": { path: fileURLToPath(new URL("../ui/app.js", import.meta.url)), type: "text/javascript; charset=utf-8" },
    "/ui/style.css": { path: fileURLToPath(new URL("../ui/style.css", import.meta.url)), type: "text/css; charset=utf-8" },
};

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
        "cache-control": "no-store",
    });
    response.end(body);
}

async function sendUi(response, pathname, host) {
    if (!loopbackHost(host)) {
        send(response, 404, { error: "operator console is disabled on non-loopback bind" });
        return true;
    }
    if (pathname === "/ui") {
        response.writeHead(302, { location: "/ui/", "cache-control": "no-store" });
        response.end();
        return true;
    }
    const asset = UI_FILES[pathname];
    if (!asset)
        return false;
    const body = await readFile(asset.path);
    response.writeHead(200, {
        "content-type": asset.type,
        "content-length": body.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cross-origin-opener-policy": "same-origin",
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(body);
    return true;
}

function taskIdFromPath(pathname) {
    return decodeURIComponent(pathname.split("/")[2] ?? "");
}

async function runtimeTaskRefs(runtime) {
    return providerContinuityRefs(await runtime.orchestrator.listTasks());
}

async function publicRuntimeTask(runtime, task) {
    return publicTaskView(task, await runtimeTaskRefs(runtime));
}

async function publicRuntimeProgress(runtime, progress) {
    return publicProgressView(progress, await runtimeTaskRefs(runtime));
}

export function startServer(runtime) {
    const host = runtime.config.bindHost ?? "127.0.0.1";
    const port = runtime.config.port ?? 7341;
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

            if (url.pathname === "/ui" || url.pathname.startsWith("/ui/")) {
                if (await sendUi(response, url.pathname, host))
                    return;
            }
            if (url.pathname === "/operator/stream") {
                await handleOperatorStream(runtime, request, response);
                return;
            }
            if (url.pathname.startsWith("/operator/")) {
                await handleOperatorApiRequest(runtime, request, response, url);
                return;
            }
            if (url.pathname.startsWith("/computers")) {
                await handleComputerApiRequest(runtime, request, response, url);
                return;
            }

            if (request.method === "GET" && url.pathname === "/health") { send(response, 200, { ok: true, name: "SovereignBot", version: "0.4-dev" }); return; }
            if (request.method === "GET" && url.pathname === "/agents") { send(response, 200, publicAgentListView(runtime.orchestrator.listAgents())); return; }
            if (request.method === "GET" && url.pathname === "/tasks") { send(response, 200, publicTaskListView(await runtime.orchestrator.listTasks())); return; }
            if (request.method === "POST" && url.pathname === "/tasks") { send(response, 201, await publicRuntimeTask(runtime, await runtime.orchestrator.submit(await readBody(request)))); return; }
            if (request.method === "POST" && url.pathname === "/plans") { send(response, 201, await publicRuntimeTask(runtime, await runtime.orchestrator.createPlan(await readBody(request)))); return; }
            if (request.method === "POST" && url.pathname === "/run") { const finished=await runtime.orchestrator.runUntilIdle(); const refs=await runtimeTaskRefs(runtime); send(response, 200, finished.map((task)=>publicTaskView(task,refs))); return; }
            if (request.method === "GET" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/graph")) { send(response, 200, publicTaskGraphView(await runtime.orchestrator.getTaskGraph(taskIdFromPath(url.pathname)))); return; }
            if (request.method === "GET" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/events")) { const events=await runtime.orchestrator.listTaskEvents(taskIdFromPath(url.pathname)); const tasks=await runtime.orchestrator.listTasks(); send(response, 200, publicRuntimeRecords(events,tasks)); return; }
            if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/delegate")) { const body = await readBody(request); send(response, 201, await publicRuntimeTask(runtime, await runtime.orchestrator.delegate(taskIdFromPath(url.pathname), body?.task ?? body?.spec ?? {}, body?.actorAgentId))); return; }
            if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/progress")) { const body = await readBody(request); send(response, 200, await publicRuntimeProgress(runtime, await runtime.orchestrator.reportProgress(taskIdFromPath(url.pathname), { eventId: body?.eventId, percent: body?.percent, message: body?.message, data: body?.data }, body?.actorAgentId))); return; }
            if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/review")) { const body = await readBody(request); send(response, 200, await publicRuntimeTask(runtime, await runtime.orchestrator.reviewTask(taskIdFromPath(url.pathname), { eventId: body?.eventId, decision: body?.decision, notes: body?.notes }, body?.reviewerAgentId))); return; }
            if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/aggregate")) { const body = await readBody(request); send(response, 200, await publicRuntimeTask(runtime, await runtime.orchestrator.aggregatePlan(taskIdFromPath(url.pathname), body?.actorAgentId))); return; }
            if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/retry")) { send(response, 200, await publicRuntimeTask(runtime, await runtime.orchestrator.retry(taskIdFromPath(url.pathname)))); return; }
            if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/cancel")) { const body = await readBody(request); send(response, 200, await publicRuntimeTask(runtime, await runtime.orchestrator.cancel(taskIdFromPath(url.pathname), { actor: body?.actorAgentId ?? body?.actor, eventId: body?.eventId, reason: body?.reason, cascade: body?.cascade }))); return; }
            if (request.method === "GET" && url.pathname === "/audit/verify") { send(response, 200, await runtime.audit.verify()); return; }
            if (request.method === "GET" && url.pathname === "/memory") { const scope = url.searchParams.get("scope") || undefined; const query = url.searchParams.get("q") || undefined; const records=await runtime.memory.search({ scope, query, limit: 100 }); const tasks=await runtime.orchestrator.listTasks(); send(response, 200, publicMemoryRecords(records,tasks)); return; }
            send(response, 404, { error: "not found" });
        }
        catch (error) {
            send(response, 400, { error: error.message });
        }
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            const address = server.address();
            const actualPort = address && typeof address !== "string" ? address.port : port;
            resolve({ url: `http://${host}:${actualPort}`, close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))) });
        });
    });
}
