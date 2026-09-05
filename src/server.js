import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleComputerApiRequest } from "./computer-api.js";
import { handleOperatorApiRequest, loopbackHost } from "./operator-api.js";
import { handleOperatorStream } from "./operator-stream.js";
import { createDesktopBridge } from "./desktop-bridge.js";
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
import { VERSION } from "./version.js";

const DESKTOP_UI_DIR = fileURLToPath(new URL("../desktop/ui", import.meta.url));

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
};

function isDesktopFile(pathname) {
    const filename = pathname.replace(/^\/+/, "");
    if (!filename || filename.includes("/")) return false;
    return existsSync(join(DESKTOP_UI_DIR, filename));
}

async function sendDesktopUi(response, pathname) {
    let cleanPath = pathname;
    if (cleanPath === "/" || cleanPath === "" || cleanPath === "/desktop" || cleanPath === "/desktop/") {
        cleanPath = "/index.html";
    }
    if (cleanPath.startsWith("/desktop/")) {
        cleanPath = cleanPath.slice("/desktop".length);
    }
    const safePath = join(DESKTOP_UI_DIR, cleanPath.replace(/^\/+/, ""));
    if (!existsSync(safePath) || !statSync(safePath).isFile()) {
        return false;
    }
    const ext = extname(safePath).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const body = await readFile(safePath);
    response.writeHead(200, {
        "content-type": mime,
        "content-length": body.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' https://apis.google.com https://www.gstatic.com https://*.firebaseapp.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.firebaseapp.com https://accounts.google.com; img-src 'self' data: blob: https://*.googleusercontent.com https://*.gstatic.com https://ssl.gstatic.com; frame-src 'self' https://accounts.google.com https://*.firebaseapp.com; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors *",
    });
    response.end(body);
    return true;
}

const UI_FILES = {
    "/ui/": { path: fileURLToPath(new URL("../ui/index.html", import.meta.url)), type: "text/html; charset=utf-8" },
    "/ui/app.js": { path: fileURLToPath(new URL("../ui/app.js", import.meta.url)), type: "text/javascript; charset=utf-8" },
    "/ui/style.css": { path: fileURLToPath(new URL("../ui/style.css", import.meta.url)), type: "text/css; charset=utf-8" },
};
const RUNTIME_OWNED_TASK_FIELDS = new Set([
    "id",
    "status",
    "attempt",
    "assignedAgentId",
    "ownerAgentId",
    "harnessState",
    "result",
    "candidateResult",
    "error",
    "progress",
    "lastRetryAt",
    "aggregate",
    "createdAt",
    "updatedAt",
]);

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

function publicSubmissionSpec(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return value;
    const spec = { ...value };
    for (const field of RUNTIME_OWNED_TASK_FIELDS)
        delete spec[field];
    return spec;
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
    const desktopBridge = createDesktopBridge({ runtime });
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

            if (request.method === "POST" && url.pathname === "/api/desktop/ipc") {
                const body = await readBody(request);
                const result = await desktopBridge.handleIpc(body?.channel, body?.payload);
                send(response, 200, { ok: true, result });
                return;
            }

            if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/desktop") || (request.method === "GET" && isDesktopFile(url.pathname))) {
                if (await sendDesktopUi(response, url.pathname))
                    return;
            }

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

            if (request.method === "GET" && url.pathname === "/health") { send(response, 200, { ok: true, name: "SovereignBot", version: VERSION }); return; }
            if (request.method === "GET" && url.pathname === "/agents") { send(response, 200, publicAgentListView(runtime.orchestrator.listAgents())); return; }
            if (request.method === "GET" && url.pathname === "/tasks") { send(response, 200, publicTaskListView(await runtime.orchestrator.listTasks())); return; }
            if (request.method === "POST" && url.pathname === "/tasks") { send(response, 201, await publicRuntimeTask(runtime, await runtime.orchestrator.submit(publicSubmissionSpec(await readBody(request))))); return; }
            if (request.method === "POST" && url.pathname === "/plans") { send(response, 201, await publicRuntimeTask(runtime, await runtime.orchestrator.createPlan(await readBody(request)))); return; }
            if (request.method === "POST" && url.pathname === "/run") { const finished=await runtime.orchestrator.runUntilIdle(); const refs=await runtimeTaskRefs(runtime); send(response, 200, finished.map((task)=>publicTaskView(task,refs))); return; }
            if (request.method === "GET" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/graph")) { send(response, 200, publicTaskGraphView(await runtime.orchestrator.getTaskGraph(taskIdFromPath(url.pathname)))); return; }
            if (request.method === "GET" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/events")) { const events=await runtime.orchestrator.listTaskEvents(taskIdFromPath(url.pathname)); const tasks=await runtime.orchestrator.listTasks(); send(response, 200, publicRuntimeRecords(events,tasks)); return; }
            if (request.method === "POST" && url.pathname.startsWith("/tasks/") && url.pathname.endsWith("/delegate")) { const body = await readBody(request); send(response, 201, await publicRuntimeTask(runtime, await runtime.orchestrator.delegate(taskIdFromPath(url.pathname), publicSubmissionSpec(body?.task ?? body?.spec ?? {}), body?.actorAgentId))); return; }
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
