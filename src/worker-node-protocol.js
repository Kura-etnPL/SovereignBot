import { createHash, timingSafeEqual } from "node:crypto";

export const WORKER_NODE_PROTOCOL = "sovereign-worker/1";
export const WORKER_NODE_BODY_LIMIT = 64 * 1024;
export const WORKER_NODE_MAX_TITLE = 120;
export const WORKER_NODE_MAX_INSTRUCTION = 20_000;
export const WORKER_NODE_MAX_CAPABILITIES = 16;

const PAIRING_KEYS = new Set(["protocol", "nodeId", "name", "endpoint", "token"]);
const DISPATCH_KEYS = new Set([
    "protocol",
    "requestId",
    "jobId",
    "title",
    "instruction",
    "workspaceId",
    "requiredCapabilities",
    "attempt",
    "createdAt",
]);
const NODE_ID = /^worker_[0-9a-f]{16}$/i;
const REQUEST_ID = /^worker_request_[0-9a-f]{16}$/i;
const JOB_ID = /^job_[0-9a-f-]{16,64}$/i;
const IDENTIFIER = /^[A-Za-z0-9][\w:.-]{0,159}$/;
const TOKEN = /^[A-Za-z0-9_-]{43,256}$/;
const CAPABILITY = /^[A-Za-z0-9][\w:.-]{0,63}$/;

export class WorkerNodeProtocolError extends Error {
    statusCode;
    code;

    constructor(message, statusCode = 400, code = "invalid_request") {
        super(message);
        this.name = "WorkerNodeProtocolError";
        this.statusCode = statusCode;
        this.code = code;
    }
}

function fail(message, statusCode = 400, code = "invalid_request") {
    throw new WorkerNodeProtocolError(message, statusCode, code);
}

function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        fail(`${label} must be an object`);
    return value;
}

function exactKeys(value, allowed, label) {
    object(value, label);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            fail(`${label} contains unknown field: ${key}`);
    }
}

function boundedString(value, label, max, { required = true, pattern } = {}) {
    if (typeof value !== "string")
        fail(`${label} must be a string`);
    const trimmed = value.trim();
    if (required && !trimmed)
        fail(`${label} is required`);
    if (trimmed.length > max)
        fail(`${label} exceeds ${max} characters`);
    if (trimmed.includes("\0") || [...trimmed].some((char) => char.charCodeAt(0) < 0x20 && char !== "\n" && char !== "\r" && char !== "\t"))
        fail(`${label} contains a control character`);
    if (pattern && !pattern.test(trimmed))
        fail(`${label} has an invalid format`);
    return trimmed;
}

export function validateNodeId(value, label = "nodeId") {
    return boundedString(value, label, 32, { pattern: NODE_ID });
}

export function validateRequestId(value, label = "requestId") {
    return boundedString(value, label, 64, { pattern: REQUEST_ID });
}

export function validateJobId(value, label = "jobId") {
    return boundedString(value, label, 80, { pattern: JOB_ID });
}

export function validateWorkspaceId(value, label = "workspaceId") {
    return boundedString(value, label, 160, { pattern: IDENTIFIER });
}

export function validateToken(value, label = "token") {
    return boundedString(value, label, 256, { pattern: TOKEN });
}

export function validateLoopbackBindHost(value) {
    if (typeof value !== "string" || !["127.0.0.1", "::1"].includes(value.toLowerCase()))
        fail("Worker Node bindHost must be a numeric loopback host: 127.0.0.1 or ::1");
    return value.toLowerCase();
}

function endpointHost(url) {
    return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

export function validateLoopbackEndpoint(value, { allowPortZero = false } = {}) {
    if (typeof value !== "string" || value.length > 256)
        fail("Worker Node endpoint must be a loopback HTTP endpoint");
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        fail("Worker Node endpoint must be a valid URL");
    }
    const host = endpointHost(parsed);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "::1"].includes(host))
        fail("Worker Node endpoint must be a loopback HTTP endpoint");
    if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== ""))
        fail("Worker Node endpoint must not contain credentials, query, fragment, or a path");
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < (allowPortZero ? 0 : 1) || port > 65535)
        fail("Worker Node endpoint must contain a valid port");
    const hostText = host === "::1" ? `[${host}]` : host;
    return `http://${hostText}:${port}`;
}

export function isLoopbackAddress(value) {
    if (typeof value !== "string")
        return false;
    const normalized = value.replace(/^\[|\]$/g, "").toLowerCase();
    return normalized === "127.0.0.1"
        || normalized === "::1"
        || normalized === "::ffff:127.0.0.1";
}

export function validatePairingBundle(value) {
    exactKeys(value, PAIRING_KEYS, "pairing bundle");
    if (value.protocol !== WORKER_NODE_PROTOCOL)
        fail("pairing bundle protocol is not supported");
    const nodeId = validateNodeId(value.nodeId);
    const name = boundedString(value.name, "name", 80);
    const endpoint = validateLoopbackEndpoint(value.endpoint);
    const token = validateToken(value.token);
    return { protocol: WORKER_NODE_PROTOCOL, nodeId, name, endpoint, token };
}

function validateCapabilities(value) {
    if (!Array.isArray(value) || value.length > WORKER_NODE_MAX_CAPABILITIES)
        fail(`requiredCapabilities must be an array of at most ${WORKER_NODE_MAX_CAPABILITIES} capabilities`);
    const result = value.map((entry) => boundedString(entry, "capability", 64, { pattern: CAPABILITY }));
    if (new Set(result).size !== result.length)
        fail("requiredCapabilities must not contain duplicates");
    return result;
}

export function validateDispatchPayload(value) {
    exactKeys(value, DISPATCH_KEYS, "dispatch");
    if (value.protocol !== WORKER_NODE_PROTOCOL)
        fail("dispatch protocol is not supported");
    const requestId = validateRequestId(value.requestId);
    const jobId = validateJobId(value.jobId);
    const title = boundedString(value.title, "title", WORKER_NODE_MAX_TITLE);
    const instruction = boundedString(value.instruction, "instruction", WORKER_NODE_MAX_INSTRUCTION);
    const workspaceId = validateWorkspaceId(value.workspaceId);
    const requiredCapabilities = validateCapabilities(value.requiredCapabilities);
    if (!Number.isInteger(value.attempt) || value.attempt < 0 || value.attempt > 1000)
        fail("attempt must be a non-negative integer no greater than 1000");
    if (typeof value.createdAt !== "string" || value.createdAt.length > 64 || !Number.isFinite(Date.parse(value.createdAt)))
        fail("createdAt must be a valid ISO timestamp");
    const createdAt = new Date(value.createdAt).toISOString();
    return { protocol: WORKER_NODE_PROTOCOL, requestId, jobId, title, instruction, workspaceId, requiredCapabilities, attempt: value.attempt, createdAt };
}

export function canonicalJson(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function dispatchBodyHash(value) {
    return createHash("sha256").update(canonicalJson(validateDispatchPayload(value))).digest("hex");
}

export function constantTimeTokenEqual(left, right) {
    if (typeof left !== "string" || typeof right !== "string")
        return false;
    const a = Buffer.from(left, "utf8");
    const b = Buffer.from(right, "utf8");
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(a, b);
}

export function safeProtocolError(error) {
    if (error instanceof WorkerNodeProtocolError)
        return { status: error.statusCode, code: error.code, message: error.message };
    return { status: 500, code: "worker_node_failure", message: "Worker Node request failed" };
}

export function isWorkerNodeId(value) {
    return typeof value === "string" && NODE_ID.test(value);
}
