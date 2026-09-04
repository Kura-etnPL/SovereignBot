import { createHash } from "node:crypto";
import { validateJobId, validateRequestId, validateWorkspaceId } from "./worker-node-protocol.js";

export const WORKER_COMPUTER_PROTOCOL = "sovereign-worker-computer/1";
export const WORKER_COMPUTER_MAX_ACTIONS = 8;

const OPERATIONS = new Set(["health", "snapshot", "navigate", "click", "type", "key", "scroll", "list_files", "read_file", "write_file", "request_help", "takeover", "release"]);
const ENVELOPE_KEYS = new Set(["protocol", "requestId", "jobId", "ownerCoworkerId", "projectId", "workspaceId", "computerId", "operation", "input", "attempt", "createdAt"]);
const OP_KEYS = new Map([
    ["health", []], ["snapshot", []], ["navigate", ["url"]], ["click", ["snapshotId", "ref"]],
    ["type", ["snapshotId", "ref", "text"]], ["key", ["snapshotId", "ref", "key"]], ["scroll", ["deltaX", "deltaY"]],
    ["list_files", ["path"]], ["read_file", ["path", "encoding"]], ["write_file", ["path", "content", "encoding"]],
    ["request_help", ["reason"]], ["takeover", ["actorId"]], ["release", ["actorId"]],
]);
const SAFE_TEXT = /(?:[A-Za-z]:[\\/]|(?:^|\s)\/(?:Users|home|tmp|var|private|workspace|worktrees?)\b|file:\/\/|(?:bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|password|secret|credential)\s*[:=]|(?:session[_ -]?id|continuity|provider[_ -]?(?:id|session|account)|webdriver|sidecar|backendRef|rawPath|\bcwd\b)|(?:\bcoordinates?\b|screen\s+position|click\s+at|\bx\s*[:=]\s*\d+\b|\by\s*[:=]\s*\d+\b))/i;

function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value;
}

function exactKeys(value, allowed, label) {
    object(value, label);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`${label} contains an unsupported field`);
}

function bounded(value, label, max, { optional = false, safe = true } = {}) {
    if (value === undefined && optional) return undefined;
    if (typeof value !== "string" || (!optional && !value.trim()) || value.length > max) throw new Error(`${label} is invalid`);
    const clean = value.trim();
    if (safe && SAFE_TEXT.test(clean)) throw new Error(`${label} contains private, secret, runtime, or coordinate data`);
    return clean;
}

function relativePath(value, label) {
    const clean = bounded(value, label, 512);
    if (clean === ".") return clean;
    if (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|file:)/.test(clean) || clean.split(/[\\/]+/).includes("..")) throw new Error(`${label} must be a relative workspace path`);
    return clean.replaceAll("\\", "/");
}

function safeInput(operation, value) {
    const input = object(value ?? {}, `${operation} input`);
    exactKeys(input, new Set(OP_KEYS.get(operation)), `${operation} input`);
    switch (operation) {
        case "navigate": {
            const url = bounded(input.url, "navigate url", 2_000, { safe: false });
            let parsed;
            try { parsed = new URL(url); } catch { throw new Error("navigate url is invalid"); }
            if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("navigate url must be a credential-free stable http/https URL");
            return { url: parsed.toString() };
        }
        case "click": return { snapshotId: bounded(input.snapshotId, "snapshotId", 160, { safe: false }), ref: bounded(input.ref, "element ref", 160, { safe: false }) };
        case "type": return { snapshotId: bounded(input.snapshotId, "snapshotId", 160, { safe: false }), ref: bounded(input.ref, "element ref", 160, { safe: false }), text: bounded(input.text, "type text", 4_000) };
        case "key": return { ...(input.snapshotId === undefined ? {} : { snapshotId: bounded(input.snapshotId, "snapshotId", 160, { safe: false }) }), ...(input.ref === undefined ? {} : { ref: bounded(input.ref, "element ref", 160, { safe: false }) }), key: bounded(input.key, "key", 32, { safe: false }) };
        case "scroll":
            if (!Number.isInteger(input.deltaX) || !Number.isInteger(input.deltaY) || Math.abs(input.deltaX) > 2_000 || Math.abs(input.deltaY) > 2_000) throw new Error("scroll delta is invalid");
            return { deltaX: input.deltaX, deltaY: input.deltaY };
        case "list_files": return { path: relativePath(input.path ?? ".", "file path") };
        case "read_file": return { path: relativePath(input.path, "file path"), ...(input.encoding === undefined ? {} : { encoding: bounded(input.encoding, "file encoding", 32, { safe: false }) }) };
        case "write_file": return { path: relativePath(input.path, "file path"), content: bounded(input.content ?? "", "file content", 64_000), ...(input.encoding === undefined ? {} : { encoding: bounded(input.encoding, "file encoding", 32, { safe: false }) }) };
        case "request_help": return { reason: bounded(input.reason, "help reason", 240) };
        case "takeover":
        case "release": return { actorId: bounded(input.actorId, "actorId", 120, { safe: false }) };
        default: return {};
    }
}

export function validateComputerEnvelope(value) {
    exactKeys(value, ENVELOPE_KEYS, "Worker Computer envelope");
    if (value.protocol !== WORKER_COMPUTER_PROTOCOL) throw new Error("Worker Computer protocol is not supported");
    const requestId = bounded(value.requestId, "requestId", 96, { safe: false });
    const jobId = validateJobId(value.jobId);
    const ownerCoworkerId = bounded(value.ownerCoworkerId, "ownerCoworkerId", 160, { safe: false });
    const projectId = value.projectId === undefined ? undefined : bounded(value.projectId, "projectId", 160, { safe: false });
    const workspaceId = validateWorkspaceId(value.workspaceId);
    const computerId = bounded(value.computerId, "computerId", 160, { safe: false });
    if (!OPERATIONS.has(value.operation)) throw new Error("Worker Computer operation is not supported");
    if (!Number.isInteger(value.attempt) || value.attempt < 0 || value.attempt > 1000) throw new Error("attempt is invalid");
    if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("createdAt is invalid");
    return { protocol: WORKER_COMPUTER_PROTOCOL, requestId, jobId, ownerCoworkerId, ...(projectId ? { projectId } : {}), workspaceId, computerId, operation: value.operation, input: safeInput(value.operation, value.input), attempt: value.attempt, createdAt: new Date(value.createdAt).toISOString() };
}

export function validateComputerActionList(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > WORKER_COMPUTER_MAX_ACTIONS) throw new Error(`computer actions must contain 1-${WORKER_COMPUTER_MAX_ACTIONS} actions`);
    return value.map((entry) => {
        object(entry, "computer action");
        exactKeys(entry, new Set(["operation", "input"]), "computer action");
        if (!OPERATIONS.has(entry.operation) || entry.operation === "health" || entry.operation === "takeover" || entry.operation === "release") throw new Error("computer action cannot use this operation");
        return { operation: entry.operation, input: safeInput(entry.operation, entry.input) };
    });
}

export function computerEnvelopeHash(value) {
    return createHash("sha256").update(JSON.stringify(validateComputerEnvelope(value))).digest("hex");
}

export const workerComputerOperations = Object.freeze([...OPERATIONS]);
