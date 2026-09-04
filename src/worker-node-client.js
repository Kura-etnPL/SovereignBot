import { request as httpRequest } from "node:http";
import {
    WORKER_NODE_BODY_LIMIT,
    WORKER_NODE_PROTOCOL,
    WorkerNodeProtocolError,
    validateDispatchPayload,
    validateLoopbackEndpoint,
    validateToken,
} from "./worker-node-protocol.js";
import { validateComputerEnvelope } from "./worker-computer-protocol.js";

const DEFAULT_TIMEOUT_MS = 5_000;

function safeClientError(statusCode, body) {
    if (statusCode === 401) return new WorkerNodeProtocolError("Worker Node authentication failed", 401, "unauthorized");
    if (statusCode === 404) return new WorkerNodeProtocolError("Worker Node task was not found", 404, "not_found");
    if (statusCode === 409) return new WorkerNodeProtocolError("Worker Node dispatch request conflicts with an existing request", 409, "conflict");
    if (statusCode === 422) return new WorkerNodeProtocolError("Worker Node rejected the request", 422, "validation_failed");
    if (statusCode === 413) return new WorkerNodeProtocolError("Worker Node request is too large", 413, "too_large");
    void body;
    return new WorkerNodeProtocolError("Worker Node request failed", statusCode >= 500 ? 503 : statusCode, statusCode >= 500 ? "worker_node_failure" : "request_failed");
}

function transportError(error) {
    const failure = new Error("worker-node transport unavailable");
    failure.code = "WORKER_NODE_TRANSPORT";
    failure.cause = error;
    return failure;
}

function requestJson(endpoint, token, method, pathname, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const cleanEndpoint = validateLoopbackEndpoint(endpoint);
    const validToken = validateToken(token);
    const url = new URL(cleanEndpoint);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const text = body === undefined ? "" : JSON.stringify(body);
    if (Buffer.byteLength(text, "utf8") > WORKER_NODE_BODY_LIMIT)
        throw new WorkerNodeProtocolError("Worker Node request is too large", 413, "too_large");
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            protocol: url.protocol,
            hostname,
            port: url.port,
            method,
            path: pathname,
            headers: {
                accept: "application/json",
                "content-type": "application/json",
                "content-length": Buffer.byteLength(text, "utf8"),
                authorization: `Bearer ${validToken}`,
            },
            timeout: timeoutMs,
        }, (response) => {
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
                size += chunk.length;
                if (size <= WORKER_NODE_BODY_LIMIT)
                    chunks.push(chunk);
                else
                    req.destroy(new Error("response too large"));
            });
            response.on("end", () => {
                let parsed;
                try {
                    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                }
                catch {
                    reject(transportError(new Error("Worker Node returned invalid JSON")));
                    return;
                }
                if ((response.statusCode ?? 500) >= 400) {
                    reject(safeClientError(response.statusCode ?? 500, parsed));
                    return;
                }
                resolve(parsed);
            });
        });
        req.on("timeout", () => req.destroy(new Error("Worker Node request timed out")));
        req.on("error", (error) => reject(transportError(error)));
        if (text)
            req.write(text);
        req.end();
    });
}

export function createWorkerNodeClient({ endpoint, token, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const cleanEndpoint = validateLoopbackEndpoint(endpoint);
    const privateToken = validateToken(token);
    return Object.freeze({
        endpoint: cleanEndpoint,
        async health() {
            return requestJson(cleanEndpoint, privateToken, "GET", "/v1/health", undefined, { timeoutMs });
        },
        async dispatch(payload) {
            return requestJson(cleanEndpoint, privateToken, "POST", "/v1/dispatch", validateDispatchPayload(payload), { timeoutMs });
        },
        async getTask(remoteTaskId) {
            if (typeof remoteTaskId !== "string" || !/^task_[0-9a-f-]{16,64}$/i.test(remoteTaskId))
                throw new WorkerNodeProtocolError("remoteTaskId is invalid", 400, "invalid_request");
            return requestJson(cleanEndpoint, privateToken, "GET", `/v1/tasks/${encodeURIComponent(remoteTaskId)}`, undefined, { timeoutMs });
        },
        async cancel(remoteTaskId) {
            if (typeof remoteTaskId !== "string" || !/^task_[0-9a-f-]{16,64}$/i.test(remoteTaskId))
                throw new WorkerNodeProtocolError("remoteTaskId is invalid", 400, "invalid_request");
            return requestJson(cleanEndpoint, privateToken, "POST", `/v1/tasks/${encodeURIComponent(remoteTaskId)}/cancel`, {}, { timeoutMs });
        },
        async computerHealth() {
            return requestJson(cleanEndpoint, privateToken, "GET", "/v1/computer/health", undefined, { timeoutMs });
        },
        async computerAction(payload) {
            return requestJson(cleanEndpoint, privateToken, "POST", "/v1/computer/action", validateComputerEnvelope(payload), { timeoutMs });
        },
    });
}

export { transportError as workerNodeTransportError };
