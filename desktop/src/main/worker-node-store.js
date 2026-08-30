import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";
import { createWorkerNodeClient } from "./worker-node-client.js";
import {
    WORKER_NODE_PROTOCOL,
    validateLoopbackEndpoint,
    validateNodeId,
    validatePairingBundle,
    validateWorkspaceId,
} from "../../vendor/core/src/worker-node-protocol.js";

export const WORKER_NODES_SCHEMA = "sovereignbot.desktop.worker-nodes.v1";
export const WORKER_NODE_CREDENTIALS_SCHEMA = "sovereignbot.desktop.worker-node-credentials.v1";

const PUBLIC_KEYS = new Set([
    "nodeId", "name", "protocol", "endpoint", "platform", "arch", "enabled", "status",
    "capabilities", "workspaces", "lastSeenAt", "lastError",
]);

function safeText(value, max = 500) {
    return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function publicWorkspace(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    try {
        const id = validateWorkspaceId(value.id);
        const name = String(value.name ?? "").trim();
        if (!name || name.length > 120) return undefined;
        return { id, name };
    }
    catch { return undefined; }
}

function publicRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    if (Object.keys(value).some((key) => !PUBLIC_KEYS.has(key))) return undefined;
    try {
        const workspaces = Array.isArray(value.workspaces) ? value.workspaces.map(publicWorkspace).filter(Boolean) : [];
        return {
            nodeId: validateNodeId(value.nodeId),
            name: String(value.name ?? "").trim().slice(0, 80),
            protocol: value.protocol === WORKER_NODE_PROTOCOL ? WORKER_NODE_PROTOCOL : "",
            endpoint: validateLoopbackEndpoint(value.endpoint),
            platform: safeText(value.platform, 40),
            arch: safeText(value.arch, 40),
            enabled: value.enabled !== false,
            status: ["online", "offline", "blocked"].includes(value.status) ? value.status : "offline",
            capabilities: Array.isArray(value.capabilities) ? [...new Set(value.capabilities.map((entry) => safeText(entry, 64)))].slice(0, 16) : [],
            workspaces,
            lastSeenAt: value.lastSeenAt ? safeText(value.lastSeenAt, 64) : undefined,
            lastError: value.lastError ? safeText(value.lastError, 500) : undefined,
        };
    }
    catch { return undefined; }
}

function validateHealth(bundle, health) {
    if (!health || typeof health !== "object" || Array.isArray(health) || health.protocol !== WORKER_NODE_PROTOCOL)
        throw new Error("Worker Node health protocol mismatch");
    if (!health.node || health.node.id !== bundle.nodeId || typeof health.node.name !== "string")
        throw new Error("Worker Node identity mismatch");
    if (!Array.isArray(health.workspaces))
        throw new Error("Worker Node health omitted workspaces");
    const workspaces = health.workspaces.map(publicWorkspace).filter(Boolean);
    if (workspaces.length !== health.workspaces.length)
        throw new Error("Worker Node health contains invalid workspace metadata");
    return {
        protocol: WORKER_NODE_PROTOCOL,
        nodeId: bundle.nodeId,
        name: health.node.name.trim().slice(0, 80),
        endpoint: bundle.endpoint,
        platform: safeText(health.node.platform, 40),
        arch: safeText(health.node.arch, 40),
        enabled: true,
        status: health.ready === true ? "online" : "offline",
        capabilities: Array.isArray(health.capabilities) ? [...new Set(health.capabilities.map((entry) => safeText(entry, 64)))].slice(0, 16) : [],
        workspaces,
        lastSeenAt: new Date().toISOString(),
        lastError: undefined,
    };
}

function credentialsState(value) {
    if (!value || value.schema !== WORKER_NODE_CREDENTIALS_SCHEMA || !Array.isArray(value.credentials))
        return new Map();
    const out = new Map();
    for (const entry of value.credentials) {
        try {
            const bundle = validatePairingBundle(entry);
            out.set(bundle.nodeId, bundle);
        }
        catch { /* invalid private state is ignored and cannot reach the public projection */ }
    }
    return out;
}

export function createWorkerNodeStore({ dataDir, persistPath, credentialsPath, clientFactory = createWorkerNodeClient } = {}) {
    if (!dataDir) throw new Error("Worker Node store requires dataDir");
    const statePath = persistPath ?? join(dataDir, "desktop-state", "worker-nodes.json");
    const privatePath = credentialsPath ?? join(dataDir, "desktop-state", "worker-node-credentials.json");
    const loaded = loadJsonState(statePath, null);
    const nodes = new Map();
    for (const entry of loaded?.schema === WORKER_NODES_SCHEMA && Array.isArray(loaded.nodes) ? loaded.nodes : []) {
        const clean = publicRecord(entry);
        if (clean?.protocol === WORKER_NODE_PROTOCOL) nodes.set(clean.nodeId, clean);
    }
    const credentials = credentialsState(loadJsonState(privatePath, null));

    function savePublic() { saveJsonState(statePath, { schema: WORKER_NODES_SCHEMA, nodes: [...nodes.values()] }); }
    function savePrivate() { saveJsonState(privatePath, { schema: WORKER_NODE_CREDENTIALS_SCHEMA, credentials: [...credentials.values()] }); }
    function getNode(nodeId) {
        const id = validateNodeId(nodeId);
        const node = nodes.get(id);
        if (!node) throw new Error(`unknown Worker Node: ${id}`);
        return node;
    }
    function privateClient(nodeId) {
        const id = validateNodeId(nodeId);
        const credential = credentials.get(id);
        if (!credential) throw new Error("Worker Node credential is unavailable");
        return clientFactory({ endpoint: credential.endpoint, token: credential.token });
    }

    async function pair(bundleValue) {
        const bundle = validatePairingBundle(bundleValue);
        const existing = nodes.get(bundle.nodeId);
        const existingCredential = credentials.get(bundle.nodeId);
        if (existing && existing.endpoint !== bundle.endpoint)
            throw new Error("Worker Node identity is already paired at a different endpoint");
        if (existingCredential && (existingCredential.endpoint !== bundle.endpoint || existingCredential.token !== bundle.token))
            throw new Error("Worker Node identity is already paired with different credentials");
        const client = clientFactory({ endpoint: bundle.endpoint, token: bundle.token });
        const health = validateHealth(bundle, await client.health());
        credentials.set(bundle.nodeId, bundle);
        nodes.set(bundle.nodeId, { ...health, enabled: existing?.enabled !== false, status: "online" });
        savePrivate();
        savePublic();
        return publicRecord(nodes.get(bundle.nodeId));
    }

    async function pairViaDialog(parentWindow, dialog) {
        const result = await dialog.showOpenDialog(parentWindow, {
            title: "Choose Worker Node pairing bundle",
            properties: ["openFile", "dontAddToRecent"],
            filters: [{ name: "JSON", extensions: ["json"] }],
            buttonLabel: "Pair Worker Node",
        });
        if (result.canceled || !result.filePaths?.length) return { paired: false };
        const { readFile } = await import("node:fs/promises");
        const raw = await readFile(result.filePaths[0], "utf8");
        if (Buffer.byteLength(raw, "utf8") > 8192) throw new Error("Worker Node pairing bundle is too large");
        return { paired: true, node: await pair(JSON.parse(raw)) };
    }

    async function refresh(nodeId) {
        const targets = nodeId ? [getNode(nodeId)] : [...nodes.values()];
        const result = [];
        for (const node of targets) {
            try {
                const credential = credentials.get(node.nodeId);
                if (!credential) throw new Error("Worker Node credential is unavailable");
                const health = validateHealth(credential, await privateClient(node.nodeId).health());
                nodes.set(node.nodeId, { ...health, enabled: node.enabled });
            }
            catch (error) {
                nodes.set(node.nodeId, { ...node, status: node.enabled ? "offline" : "blocked", lastError: safeText(error?.message ?? "Worker Node refresh failed") });
            }
            result.push(publicRecord(nodes.get(node.nodeId)));
        }
        savePublic();
        return nodeId ? result[0] : { schema: WORKER_NODES_SCHEMA, nodes: result };
    }

    function resolveDispatchTarget(nodeId, workspaceId) {
        const node = getNode(nodeId);
        const workspace = node.workspaces.find((entry) => entry.id === validateWorkspaceId(workspaceId));
        if (!node.enabled || node.status !== "online" || node.protocol !== WORKER_NODE_PROTOCOL)
            throw new Error("selected Worker Node is unavailable or disabled");
        if (!workspace)
            throw new Error("selected workspace is not advertised by the Worker Node");
        return { node: publicRecord(node), workspace: structuredClone(workspace), client: privateClient(node.nodeId) };
    }

    return {
        list() { return { schema: WORKER_NODES_SCHEMA, nodes: [...nodes.values()].map(publicRecord) }; },
        get(nodeId) { return publicRecord(getNode(nodeId)); },
        client(nodeId) { return privateClient(nodeId); },
        resolveDispatchTarget,
        async cancel(nodeId, remoteTaskId) {
            return privateClient(nodeId).cancel(remoteTaskId);
        },
        pair,
        pairViaDialog,
        refresh,
        setEnabled(nodeId, enabled) {
            if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
            const node = getNode(nodeId);
            node.enabled = enabled;
            node.status = enabled ? (node.status === "blocked" ? "offline" : node.status) : "blocked";
            savePublic();
            return publicRecord(node);
        },
        remove(nodeId) {
            const id = validateNodeId(nodeId);
            const removed = nodes.delete(id);
            const removedCredential = credentials.delete(id);
            if (removed) {
                if (nodes.size) savePublic();
                else rmSync(statePath, { force: true });
            }
            if (removedCredential || removed) {
                if (credentials.size) savePrivate();
                else rmSync(privatePath, { force: true });
            }
            return { removed };
        },
        paths: { publicPath: statePath },
    };
}
