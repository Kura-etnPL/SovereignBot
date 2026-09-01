import { createServer } from "node:http";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { VERSION } from "./version.js";
import { WorkerNodeDispatchStore } from "./worker-node-dispatch-store.js";
import { WorkerComputerActionStore } from "./worker-computer-action-store.js";
import { WORKER_COMPUTER_PROTOCOL, computerEnvelopeHash, validateComputerEnvelope } from "./worker-computer-protocol.js";
import { loadOrCreateWorkerIdentity } from "./worker-node-identity.js";
import {
    WORKER_NODE_BODY_LIMIT,
    WORKER_NODE_PROTOCOL,
    WorkerNodeProtocolError,
    constantTimeTokenEqual,
    dispatchBodyHash,
    isLoopbackAddress,
    safeProtocolError,
    validateDispatchPayload,
    validateLoopbackBindHost,
    validateNodeId,
    validateWorkspaceId,
} from "./worker-node-protocol.js";

const ACTIVE_TASK_STATUSES = new Set(["queued", "accepted", "running", "awaiting_review", "changes_requested"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

function safeText(value, max = 500) {
    return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function exactObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    return value;
}

function canonicalWorkspace(raw) {
    exactObject(raw, "workspace");
    const keys = Object.keys(raw);
    if (keys.some((key) => !["id", "name", "path"].includes(key)))
        throw new Error("worker workspace contains an unknown field");
    const id = validateWorkspaceId(raw.id);
    const name = String(raw.name ?? "").trim();
    if (!name || name.length > 120 || name.includes("\0"))
        throw new Error("worker workspace name must be 1-120 characters");
    const rawPath = String(raw.path ?? "");
    if (!isAbsolute(rawPath) || rawPath.includes("\0") || !existsSync(rawPath))
        throw new Error("worker workspace path must be an existing absolute directory");
    const path = realpathSync(rawPath);
    if (!statSync(path).isDirectory())
        throw new Error("worker workspace path must be a directory");
    return { id, name, path };
}

export function validateWorkerNodeConfig(config) {
    exactObject(config, "worker node config");
    const bindHost = validateLoopbackBindHost(config.bindHost ?? "127.0.0.1");
    if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
        throw new Error("worker node port must be an integer from 0 through 65535");
    if (typeof config.dataDir !== "string" || !config.dataDir.trim())
        throw new Error("worker node dataDir is required");
    const name = String(config.name ?? "").trim();
    if (!name || name.length > 80)
        throw new Error("worker node name must be 1-80 characters");
    const supervisorAgentId = String(config.supervisorAgentId ?? "");
    const workerAgentId = String(config.workerAgentId ?? "");
    if (!supervisorAgentId || !workerAgentId || supervisorAgentId === workerAgentId)
        throw new Error("worker node supervisorAgentId and workerAgentId must be distinct");
    if (!Array.isArray(config.workspaces) || config.workspaces.length === 0 || config.workspaces.length > 64)
        throw new Error("worker node workspaces must contain 1-64 entries");
    const workspaces = config.workspaces.map(canonicalWorkspace);
    if (new Set(workspaces.map((entry) => entry.id)).size !== workspaces.length)
        throw new Error("worker node workspace ids must be unique");
    if (!Array.isArray(config.agents))
        throw new Error("worker node agents are required");
    const supervisor = config.agents.find((agent) => agent?.id === supervisorAgentId);
    const worker = config.agents.find((agent) => agent?.id === workerAgentId);
    if (!supervisor || supervisor.role !== "supervisor")
        throw new Error("worker node supervisor agent is invalid");
    if (!worker || worker.role === "supervisor" || !Array.isArray(worker.capabilities))
        throw new Error("worker node worker agent is invalid");
    if (worker.governedTools?.includes?.("computer") || worker.capabilities.some((capability) => ["browser", "computer"].includes(capability)))
        throw new Error("worker node worker cannot have browser or computer authority");
    return {
        ...structuredClone(config),
        dataDir: config.dataDir,
        name,
        bindHost,
        port: config.port,
        supervisorAgentId,
        workerAgentId,
        workspaces,
    };
}

export async function loadWorkerNodeConfig(configPath) {
    return validateWorkerNodeConfig(await loadConfig(configPath));
}

function redactNodeLocalText(value, workspaces = []) {
    let text = String(value ?? "");
    for (const workspace of workspaces)
        text = text.split(workspace.path).join("<node-local-workspace>");
    // Provider output is untrusted. Even if a child emits an absolute path that is
    // not one of the configured workspace roots, it must not cross the Worker Node
    // protocol boundary.
    return text
        .replace(/\b[A-Za-z]:[\\/][^\r\n]*/g, "<node-local-path>")
        .replace(/\\\\[^\r\n]+/g, "<node-local-path>")
        .replace(/(^|[\s"'=:(\[])(\/(?:home|opt|tmp|var|srv|mnt|media|root|usr|etc|workspace|workspaces|app|run)\/[^\s"'`<>]*)/g, "$1<node-local-path>");
}

function publicResult(task, workspaces) {
    const result = task?.result;
    if (typeof result === "string")
        return redactNodeLocalText(result, workspaces).slice(0, 8000);
    if (!result || typeof result !== "object" || Array.isArray(result))
        return undefined;
    const text = typeof result.text === "string"
        ? result.text
        : (typeof result.output?.text === "string" ? result.output.text : undefined);
    return text === undefined ? undefined : redactNodeLocalText(text, workspaces).slice(0, 8000);
}

function remoteStatus(status) {
    if (["queued", "accepted", "running"].includes(status))
        return status;
    if (status === "completed") return "completed";
    if (status === "cancelled") return "cancelled";
    return "failed";
}

function publicComputerText(value, max = 8000) {
    return String(value ?? "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\b[A-Za-z]:[\\/][^\r\n]*/g, "<node-local-path>")
        .replace(/\\\\[^\r\n]+/g, "<node-local-path>")
        .replace(/(^|[\s"'=:(\[])(\/(?:home|opt|tmp|var|srv|mnt|media|root|usr|etc|workspace|workspaces|app|run)\/[^\s"'`<>]*)/g, "$1<node-local-path>")
        .replace(/((?:bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|password|secret|credential))\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
        .slice(0, max);
}

function publicComputerResult(value, depth = 0) {
    if (depth > 4 || value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return publicComputerText(value);
    if (Array.isArray(value)) return value.slice(0, 32).map((entry) => publicComputerResult(entry, depth + 1));
    if (typeof value !== "object") return undefined;
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, 32)) {
        if (/token|secret|cookie|credential|endpoint|transport|path|cwd|session|continuation|provider|backend|raw/i.test(key)) continue;
        out[publicComputerText(key, 80)] = publicComputerResult(entry, depth + 1);
    }
    return out;
}

function publicComputerHealth(adapter, identity) {
    const raw = typeof adapter?.health === "function" ? adapter.health() : undefined;
    const value = raw && typeof raw === "object" ? raw : {};
    const computer = value.computer && typeof value.computer === "object" ? value.computer : value;
    return {
        protocol: WORKER_COMPUTER_PROTOCOL,
        computer: {
            id: publicComputerText(computer.id ?? `computer:${identity.nodeId}`, 160),
            name: publicComputerText(computer.name ?? "Worker Computer", 120),
            state: ["online", "capacity-limited", "offline", "attention"].includes(computer.state) ? computer.state : "offline",
            capacity: Number.isInteger(computer.capacity) && computer.capacity >= 0 ? computer.capacity : 0,
            currentLoad: Number.isInteger(computer.currentLoad) && computer.currentLoad >= 0 ? computer.currentLoad : 0,
            capabilities: Array.isArray(computer.capabilities) ? [...new Set(computer.capabilities.map((entry) => publicComputerText(entry, 64)))].slice(0, 24) : [],
        },
    };
}

export function createWorkerNodeService({ config, runtime, identity, ledger, computerAdapter, computerLedger, now = () => Date.now() } = {}) {
    const validated = validateWorkerNodeConfig(config);
    if (!runtime?.orchestrator)
        throw new Error("Worker Node service requires a Core runtime");
    if (!identity?.nodeId || !identity?.token)
        throw new Error("Worker Node service requires a private identity");
    const workspaceById = new Map(validated.workspaces.map((entry) => [entry.id, entry]));
    const worker = validated.agents.find((entry) => entry.id === validated.workerAgentId);
    const dispatchStore = ledger ?? new WorkerNodeDispatchStore(validated.dataDir, { now });
    const computerActionStore = computerLedger ?? new WorkerComputerActionStore(validated.dataDir, { now });
    const locks = new Map();

    function sanitizedError(error) {
        const message = redactNodeLocalText(safeText(error?.message ?? error), validated.workspaces);
        return message || "Worker Node operation failed";
    }

    async function taskById(id) {
        try {
            return await runtime.orchestrator.requireTask(id);
        }
        catch {
            const tasks = await runtime.orchestrator.listTasks();
            return tasks.find((task) => task.id === id);
        }
    }

    async function statusFor(record, remoteTaskId = record.remoteTaskId) {
        const task = remoteTaskId ? await taskById(remoteTaskId) : undefined;
        const status = record.status === "failed" && !TERMINAL_TASK_STATUSES.has(task?.status ?? "")
            ? "failed"
            : remoteStatus(task?.status ?? record.status);
        const summary = status === "completed"
            ? "Worker Node task completed"
            : status === "cancelled"
                ? "Worker Node task cancelled"
                : status === "failed"
                    ? sanitizedError(task?.error ?? record.statusSummary)
                    : sanitizedError(record.statusSummary || `Worker Node task ${status}`);
        return {
            protocol: WORKER_NODE_PROTOCOL,
            remoteTaskId,
            status,
            summary,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            ...(status === "completed" ? { result: publicResult(task, validated.workspaces) } : {}),
        };
    }

    async function createRemoteTask(payload, workspace) {
        const plan = await runtime.orchestrator.createPlan({
            title: `worker-node: ${payload.title}`,
            ownerAgentId: validated.supervisorAgentId,
            input: { requestId: payload.requestId, jobId: payload.jobId },
        });
        const task = await runtime.orchestrator.delegateTrusted(plan.id, {
                title: payload.title,
                requiredCapabilities: payload.requiredCapabilities,
                preferredAgentId: validated.workerAgentId,
                input: {
                    instruction: payload.instruction,
                    requestId: payload.requestId,
                    jobId: payload.jobId,
                    requiredCapabilities: payload.requiredCapabilities,
                    attempt: payload.attempt,
                },
        }, { workspaceId: workspace.id, cwd: workspace.path }, validated.supervisorAgentId);
        const updated = await dispatchStore.update(payload.requestId, {
            planId: plan.id,
            remoteTaskId: task.id,
            status: "accepted",
            statusSummary: "Worker Node task accepted",
        });
        return { task, record: updated };
    }

    async function execute(payload) {
        try {
            await runtime.orchestrator.runUntilIdle();
            const record = await dispatchStore.get(payload.requestId);
            const finished = await taskById(record?.remoteTaskId);
            const status = remoteStatus(finished?.status ?? "failed");
            await dispatchStore.update(payload.requestId, {
                status,
                statusSummary: status === "completed"
                    ? "Worker Node task completed"
                    : sanitizedError(finished?.error ?? `Worker Node task ended as ${status}`),
            });
        }
        catch (error) {
            await dispatchStore.update(payload.requestId, {
                status: "failed",
                statusSummary: sanitizedError(error),
            }).catch(() => undefined);
        }
    }

    async function dispatch(input) {
        const payload = validateDispatchPayload(input);
        const existing = await dispatchStore.get(payload.requestId);
        const hash = dispatchBodyHash(payload);
        if (existing) {
            if (existing.bodyHash !== hash)
                throw new WorkerNodeProtocolError("requestId is already bound to a different request body", 409, "conflict");
            const status = await statusFor(existing);
            return { ...status, duplicate: true };
        }
        const workspace = workspaceById.get(payload.workspaceId);
        if (!workspace)
            throw new WorkerNodeProtocolError("workspace is not advertised by this Worker Node", 422, "workspace_mismatch");
        if (!payload.requiredCapabilities.every((capability) => worker.capabilities.includes(capability)))
            throw new WorkerNodeProtocolError("Worker Node cannot satisfy the requested capabilities", 422, "capability_mismatch");

        const record = {
            requestId: payload.requestId,
            bodyHash: hash,
            planId: null,
            remoteTaskId: null,
            status: "accepted",
            statusSummary: "Worker Node request accepted",
            createdAt: new Date(now()).toISOString(),
            updatedAt: new Date(now()).toISOString(),
        };
        await dispatchStore.put(record);
        let created;
        try {
            created = await createRemoteTask(payload, workspace);
        }
        catch (error) {
            await dispatchStore.update(payload.requestId, {
                status: "failed",
                statusSummary: sanitizedError(error),
            }).catch(() => undefined);
            throw new WorkerNodeProtocolError("Worker Node could not create the task", 503, "worker_node_failure");
        }
        void execute(payload);
        return {
            protocol: WORKER_NODE_PROTOCOL,
            remoteTaskId: created.task.id,
            status: "accepted",
            summary: "Worker Node request accepted",
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            duplicate: false,
        };
    }

    async function dispatchSerialized(input) {
        const payload = validateDispatchPayload(input);
        const previous = locks.get(payload.requestId);
        if (previous)
            return previous;
        const current = dispatch(input);
        locks.set(payload.requestId, current);
        try {
            return await current;
        }
        finally {
            locks.delete(payload.requestId);
        }
    }

    async function taskStatus(remoteTaskId) {
        const record = await dispatchStore.findByRemoteTaskId(remoteTaskId);
        if (!record)
            throw new WorkerNodeProtocolError("Worker Node task was not found", 404, "not_found");
        return statusFor(record, remoteTaskId);
    }

    async function cancel(remoteTaskId) {
        const record = await dispatchStore.findByRemoteTaskId(remoteTaskId);
        if (!record)
            throw new WorkerNodeProtocolError("Worker Node task was not found", 404, "not_found");
        const before = await statusFor(record, remoteTaskId);
        if (["completed", "failed", "cancelled"].includes(before.status))
            return { ...before, confirmed: before.status === "cancelled" };
        await runtime.orchestrator.cancel(remoteTaskId, { reason: "cancelled by paired Desktop", cascade: false });
        const updated = await dispatchStore.update(record.requestId, { status: "cancelled", statusSummary: "Worker Node task cancelled" });
        return { ...(await statusFor(updated, remoteTaskId)), confirmed: true };
    }

    async function health() {
        const tasks = await runtime.orchestrator.listTasks();
        return {
            protocol: WORKER_NODE_PROTOCOL,
            node: {
                id: identity.nodeId,
                name: identity.name,
                platform: process.platform,
                arch: process.arch,
                version: VERSION,
            },
            ready: true,
            capabilities: [...new Set(worker.capabilities)].sort(),
            workspaces: validated.workspaces.map(({ id, name }) => ({ id, name })),
            activeTaskCount: tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)).length,
            computer: publicComputerHealth(computerAdapter, identity).computer,
        };
    }

    async function computerHealth() {
        return publicComputerHealth(computerAdapter, identity);
    }

    async function computerAction(input) {
        const envelope = validateComputerEnvelope(input);
        const hash = computerEnvelopeHash(envelope);
        const existing = await computerActionStore.get(envelope.requestId);
        if (existing) {
            if (existing.bodyHash !== hash) throw new WorkerNodeProtocolError("requestId is already bound to a different Computer action", 409, "conflict");
            return { protocol: WORKER_COMPUTER_PROTOCOL, requestId: envelope.requestId, status: existing.status, summary: existing.summary, ...(existing.result === undefined ? {} : { result: existing.result }), duplicate: true };
        }
        const computer = (await computerHealth()).computer;
        if (computer.id !== envelope.computerId) throw new WorkerNodeProtocolError("Computer target is not advertised by this Worker Node", 422, "computer_mismatch");
        if (!validated.workspaces.some((entry) => entry.id === envelope.workspaceId)) throw new WorkerNodeProtocolError("workspace is not advertised by this Worker Node", 422, "workspace_mismatch");
        if (!computerAdapter || typeof computerAdapter.execute !== "function" || !["online", "capacity-limited"].includes(computer.state))
            throw new WorkerNodeProtocolError("Worker Computer is unavailable", 503, "computer_unavailable");
        if (!computer.capabilities.includes(envelope.operation) && !["snapshot", "health"].includes(envelope.operation))
            throw new WorkerNodeProtocolError("Worker Computer cannot satisfy the requested capability", 422, "capability_mismatch");
        const started = new Date(now()).toISOString();
        try {
            const result = publicComputerResult(await computerAdapter.execute({ operation: envelope.operation, input: envelope.input, jobId: envelope.jobId, ownerCoworkerId: envelope.ownerCoworkerId, projectId: envelope.projectId, workspaceId: envelope.workspaceId, computerId: envelope.computerId, attempt: envelope.attempt }));
            const record = await computerActionStore.put({ requestId: envelope.requestId, bodyHash: hash, status: "completed", result, summary: "Worker Computer action completed", createdAt: started, updatedAt: new Date(now()).toISOString() });
            return { protocol: WORKER_COMPUTER_PROTOCOL, requestId: envelope.requestId, status: record.status, summary: record.summary, result: record.result, duplicate: false };
        }
        catch (error) {
            await computerActionStore.put({ requestId: envelope.requestId, bodyHash: hash, status: "failed", summary: publicComputerText(error?.message ?? "Worker Computer action failed", 500), createdAt: started, updatedAt: new Date(now()).toISOString() }).catch(() => undefined);
            throw new WorkerNodeProtocolError("Worker Computer action failed", 503, "computer_failure");
        }
    }

    return {
        config: validated,
        identity,
        dispatch: dispatchSerialized,
        taskStatus,
        cancel,
        health,
        computerHealth,
        computerAction,
        async init() { await dispatchStore.init(); await computerActionStore.init(); },
        async close() { await runtime.close?.(); },
    };
}

async function readJsonBody(request) {
    const length = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(length) && length > WORKER_NODE_BODY_LIMIT)
        throw new WorkerNodeProtocolError("request body is too large", 413, "too_large");
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > WORKER_NODE_BODY_LIMIT)
            throw new WorkerNodeProtocolError("request body is too large", 413, "too_large");
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (!chunks.length)
        return undefined;
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    catch {
        throw new WorkerNodeProtocolError("request body must be valid JSON", 400, "invalid_json");
    }
}

function sendJson(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
    });
    response.end(body);
}

function taskIdFromPath(pathname, cancel = false) {
    const parts = pathname.split("/");
    if (cancel && parts.length === 5 && parts[4] === "cancel")
        return decodeURIComponent(parts[3]);
    if (!cancel && parts.length === 4)
        return decodeURIComponent(parts[3]);
    return undefined;
}

export async function startWorkerNodeServer({ config, runtime, identity, ledger, computerAdapter, computerLedger, serverFactory = createServer } = {}) {
    const validated = validateWorkerNodeConfig(config);
    const privateIdentity = identity ?? await loadOrCreateWorkerIdentity(validated.dataDir, { name: validated.name });
    const ownedRuntime = runtime ? false : true;
    const coreRuntime = runtime ?? await createRuntime(validated);
    const service = createWorkerNodeService({ config: validated, runtime: coreRuntime, identity: privateIdentity, ledger, computerAdapter, computerLedger });
    await service.init();
    const server = serverFactory(async (request, response) => {
        try {
            if (!isLoopbackAddress(request.socket?.remoteAddress)) {
                sendJson(response, 403, { error: "Worker Node accepts loopback connections only" });
                return;
            }
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (url.search || url.hash) {
                sendJson(response, 400, { error: "query and fragment are not accepted" });
                return;
            }
            const protectedRoute = url.pathname.startsWith("/v1/");
            if (protectedRoute) {
                const authorization = request.headers.authorization;
                const expected = `Bearer ${privateIdentity.token}`;
                if (typeof authorization !== "string" || !constantTimeTokenEqual(authorization, expected)) {
                    sendJson(response, 401, { error: "Worker Node authentication failed" });
                    return;
                }
            }
            if (request.method === "GET" && url.pathname === "/v1/health") {
                sendJson(response, 200, await service.health());
                return;
            }
            if (request.method === "GET" && url.pathname === "/v1/computer/health") {
                sendJson(response, 200, await service.computerHealth());
                return;
            }
            if (request.method === "POST" && url.pathname === "/v1/computer/action") {
                const result = await service.computerAction(await readJsonBody(request));
                sendJson(response, result.duplicate ? 200 : 202, result);
                return;
            }
            if (request.method === "POST" && url.pathname === "/v1/dispatch") {
                const result = await service.dispatch(await readJsonBody(request));
                sendJson(response, result.duplicate ? 200 : 202, result);
                return;
            }
            if (request.method === "GET" && url.pathname.startsWith("/v1/tasks/")) {
                const remoteTaskId = taskIdFromPath(url.pathname);
                if (!remoteTaskId) throw new WorkerNodeProtocolError("invalid Worker Node task path", 404, "not_found");
                sendJson(response, 200, await service.taskStatus(remoteTaskId));
                return;
            }
            if (request.method === "POST" && url.pathname.startsWith("/v1/tasks/") && url.pathname.endsWith("/cancel")) {
                const remoteTaskId = taskIdFromPath(url.pathname, true);
                if (!remoteTaskId) throw new WorkerNodeProtocolError("invalid Worker Node cancel path", 404, "not_found");
                await readJsonBody(request);
                sendJson(response, 200, await service.cancel(remoteTaskId));
                return;
            }
            sendJson(response, 404, { error: "not found" });
        }
        catch (error) {
            const safe = safeProtocolError(error);
            sendJson(response, safe.status, { error: safe.message, code: safe.code });
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(validated.port, validated.bindHost, resolve);
    });
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : validated.port;
    const host = validated.bindHost === "::1" ? `[${validated.bindHost}]` : validated.bindHost;
    const url = `http://${host}:${port}`;
    return {
        url,
        nodeId: privateIdentity.nodeId,
        service,
        async close() {
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            if (ownedRuntime)
                await coreRuntime.close?.();
        },
    };
}
