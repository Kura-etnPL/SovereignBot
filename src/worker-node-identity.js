import { randomBytes } from "node:crypto";
import { readFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensureParent, readJsonFile, writeJsonAtomic } from "./fs-util.js";
import { validateNodeId, validateToken, validatePairingBundle, WORKER_NODE_PROTOCOL, validateLoopbackEndpoint } from "./worker-node-protocol.js";

export const WORKER_NODE_IDENTITY_SCHEMA = "sovereignbot.worker-node.identity.v1";
const IDENTITY_FILE = "worker-node-identity.json";
const IDENTITY_CREATE_LOCK_ATTEMPTS = 100;

function identityPath(dataDir) {
    return join(dataDir, IDENTITY_FILE);
}
function validateIdentity(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("worker node identity must be an object");
    const allowed = new Set(["schema", "nodeId", "token", "name", "createdAt"]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            throw new Error(`worker node identity contains unknown field: ${key}`);
    }
    if (value.schema !== WORKER_NODE_IDENTITY_SCHEMA)
        throw new Error("unsupported worker node identity schema");
    const nodeId = validateNodeId(value.nodeId);
    const token = validateToken(value.token);
    const name = String(value.name ?? "").trim();
    if (!name || name.length > 80 || name.includes("\0"))
        throw new Error("worker node identity name is invalid");
    if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)))
        throw new Error("worker node identity createdAt is invalid");
    return { schema: WORKER_NODE_IDENTITY_SCHEMA, nodeId, token, name, createdAt: new Date(value.createdAt).toISOString() };
}

export async function loadOrCreateWorkerIdentity(dataDir, { name = "Sovereign Worker" } = {}) {
    const path = identityPath(dataDir);
    const existing = await readJsonFile(path, null);
    if (existing)
        return validateIdentity(existing);
    const cleanName = String(name).trim();
    if (!cleanName || cleanName.length > 80)
        throw new Error("worker node name must be 1-80 characters");
    await ensureParent(path);
    const lockPath = `${path}.create-lock`;
    for (let attempt = 0; attempt < IDENTITY_CREATE_LOCK_ATTEMPTS; attempt += 1) {
        let lock;
        try {
            lock = await open(lockPath, "wx", 0o600);
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const created = await readJsonFile(path, null);
            if (created)
                return validateIdentity(created);
            if (attempt === IDENTITY_CREATE_LOCK_ATTEMPTS - 1)
                throw new Error("worker node identity creation is already in progress");
            await new Promise((resolve) => setTimeout(resolve, Math.min(50, 5 + attempt)));
            continue;
        }

        try {
            const created = await readJsonFile(path, null);
            if (created)
                return validateIdentity(created);
            const identity = {
                schema: WORKER_NODE_IDENTITY_SCHEMA,
                nodeId: `worker_${randomBytes(8).toString("hex")}`,
                token: randomBytes(32).toString("base64url"),
                name: cleanName,
                createdAt: new Date().toISOString(),
            };
            await writeJsonAtomic(path, identity, { mode: 0o600 });
            return validateIdentity(identity);
        }
        finally {
            await lock.close().catch(() => undefined);
            await unlink(lockPath).catch(() => undefined);
        }
    }
    throw new Error("worker node identity creation failed");
}

export async function readWorkerNodeIdentity(dataDir) {
    return validateIdentity(JSON.parse(await readFile(identityPath(dataDir), "utf8")));
}

export function workerNodeIdentityPath(dataDir) {
    return identityPath(dataDir);
}

export function publicWorkerNodeIdentity(identity) {
    const valid = validateIdentity(identity);
    return { protocol: WORKER_NODE_PROTOCOL, nodeId: valid.nodeId, name: valid.name };
}

// This is deliberately a local-operator-only helper. Callers must not expose its
// return value through a task, provider instruction, health response, or renderer.
export function createPairingBundle(identity, endpoint) {
    const valid = validateIdentity(identity);
    const cleanEndpoint = validateLoopbackEndpoint(endpoint);
    return validatePairingBundle({
        protocol: WORKER_NODE_PROTOCOL,
        nodeId: valid.nodeId,
        name: valid.name,
        endpoint: cleanEndpoint,
        token: valid.token,
    });
}

export async function exportWorkerNodePairingBundle(dataDir, endpoint) {
    return createPairingBundle(await readWorkerNodeIdentity(dataDir), endpoint);
}
