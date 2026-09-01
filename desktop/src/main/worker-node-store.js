import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";
import { createWorkerNodeClient } from "./worker-node-client.js";
import { createWorkerTrustStore } from "../../vendor/core/src/worker-trust-store.js";
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
    "nodeId", "name", "protocol", "platform", "arch", "enabled", "status",
    "capabilities", "workspaces", "computer", "trust", "lastSeenAt", "lastError",
]);

function safeText(value, max = 500) {
    return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function safeError(value) {
    return safeText(value, 500)
        .replace(/\b[A-Za-z]:[\\/][^\s]+/g, "<redacted-path>")
        .replace(/((?:bearer|token|password|secret|cookie|credential|session|continuation|endpoint|transport))\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function publicComputer(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {
        id: "",
        state: "offline",
        capacity: 0,
        currentLoad: 0,
        capabilities: [],
    };
    return {
        id: safeText(value.id, 160),
        name: safeText(value.name ?? "Worker Computer", 120),
        state: ["online", "capacity-limited", "offline", "attention"].includes(value.state) ? value.state : "offline",
        capacity: Number.isInteger(value.capacity) && value.capacity >= 0 ? value.capacity : 0,
        currentLoad: Number.isInteger(value.currentLoad) && value.currentLoad >= 0 ? value.currentLoad : 0,
        capabilities: Array.isArray(value.capabilities) ? [...new Set(value.capabilities.map((entry) => safeText(entry, 64)))].slice(0, 24) : [],
    };
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

function publicTrust(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const rawStatus = ["unpaired", "pending", "trusted", "revoked", "expired", "rotating", "legacy"].includes(source.status) ? source.status : "unpaired";
    const status = rawStatus === "trusted" && source.expiresAt && Number.isFinite(Date.parse(source.expiresAt)) && Date.now() >= Date.parse(source.expiresAt) ? "expired" : rawStatus;
    const transport = ["loopback", "lan", "remote-relay"].includes(source.transport) ? source.transport : "loopback";
    const deviceId = typeof source.deviceId === "string" && /^device_[0-9a-f]{16}$/i.test(source.deviceId) ? source.deviceId : undefined;
    return { status, transport, ...(deviceId ? { deviceId } : {}), ...(Number.isInteger(source.keyEpoch) && source.keyEpoch > 0 ? { keyEpoch: source.keyEpoch } : {}), ...(source.expiresAt ? { expiresAt: safeText(source.expiresAt, 64) } : {}), ...(source.lastSeenAt ? { lastSeenAt: safeText(source.lastSeenAt, 64) } : {}) };
}

function publicRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    if (Object.keys(value).some((key) => !PUBLIC_KEYS.has(key) && key !== "endpoint")) return undefined;
    try {
        const workspaces = Array.isArray(value.workspaces) ? value.workspaces.map(publicWorkspace).filter(Boolean) : [];
        return {
            nodeId: validateNodeId(value.nodeId),
            name: String(value.name ?? "").trim().slice(0, 80),
            protocol: value.protocol === WORKER_NODE_PROTOCOL ? WORKER_NODE_PROTOCOL : "",
            platform: safeText(value.platform, 40),
            arch: safeText(value.arch, 40),
            enabled: value.enabled !== false,
            status: ["online", "offline", "blocked"].includes(value.status) ? value.status : "offline",
            capabilities: Array.isArray(value.capabilities) ? [...new Set(value.capabilities.map((entry) => safeText(entry, 64)))].slice(0, 16) : [],
            workspaces,
            computer: publicComputer(value.computer),
            trust: publicTrust(value.trust),
            lastSeenAt: value.lastSeenAt ? safeText(value.lastSeenAt, 64) : undefined,
            lastError: value.lastError ? safeError(value.lastError) : undefined,
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
        computer: publicComputer(health.computer),
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

export function createWorkerNodeStore({ dataDir, persistPath, credentialsPath, clientFactory = createWorkerNodeClient, trustStore, secureClientFactory } = {}) {
    if (!dataDir) throw new Error("Worker Node store requires dataDir");
    const statePath = persistPath ?? join(dataDir, "desktop-state", "worker-nodes.json");
    const privatePath = credentialsPath ?? join(dataDir, "desktop-state", "worker-node-credentials.json");
    const loaded = loadJsonState(statePath, null);
    const nodes = new Map();
    for (const entry of loaded?.schema === WORKER_NODES_SCHEMA && Array.isArray(loaded.nodes) ? loaded.nodes : []) {
        const clean = publicRecord(entry);
        if (clean?.protocol === WORKER_NODE_PROTOCOL) nodes.set(clean.nodeId, { ...clean, endpoint: entry.endpoint });
    }
    const credentials = credentialsState(loadJsonState(privatePath, null));
    const localTrustStore = trustStore ?? createWorkerTrustStore({ dataDir, name: "Sovereign Desktop", platform: "win32" });

    function savePublic() { saveJsonState(statePath, { schema: WORKER_NODES_SCHEMA, nodes: [...nodes.values()].map(publicRecord) }); }
    function savePrivate() { saveJsonState(privatePath, { schema: WORKER_NODE_CREDENTIALS_SCHEMA, credentials: [...credentials.values()] }, { mode: 0o600 }); }
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

    function secureClient(nodeId) {
        const node = getNode(nodeId);
        const trust = publicTrust(node.trust);
        if (trust.status !== "trusted" || !trust.deviceId || !["lan", "remote-relay"].includes(trust.transport)) throw new Error("Worker secure transport is not trusted");
        if (typeof secureClientFactory !== "function") throw new Error("Worker secure transport is unavailable");
        return secureClientFactory({ nodeId: node.nodeId, peer: localTrustStore.getPeer(trust.deviceId), identity: localTrustStore.identity(), transport: trust.transport });
    }

    function saveTrustProjection(nodeId, record) {
        const node = getNode(nodeId);
        node.trust = record ? { ...record } : { status: "unpaired", transport: "loopback" };
        savePublic();
        return publicRecord(node);
    }

    async function pair(bundleValue) {
        const bundle = validatePairingBundle(bundleValue);
        const existing = nodes.get(bundle.nodeId);
        const existingCredential = credentials.get(bundle.nodeId);
        if (existing?.endpoint && existing.endpoint !== bundle.endpoint)
            throw new Error("Worker Node identity is already paired at a different endpoint");
        if (existingCredential && existingCredential.endpoint !== bundle.endpoint)
            throw new Error("Worker Node identity is already paired at a different endpoint");
        const client = clientFactory({ endpoint: bundle.endpoint, token: bundle.token });
        const health = validateHealth(bundle, await client.health());
        // A successfully authenticated bundle may rotate the private bearer token for
        // the same durable node identity. Invalid bundles fail at health() before either
        // the credential or public online record is replaced.
        credentials.set(bundle.nodeId, bundle);
        nodes.set(bundle.nodeId, { ...health, endpoint: bundle.endpoint, enabled: existing?.enabled !== false, status: "online", trust: existing?.trust ?? { status: "legacy", transport: "loopback" } });
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

    async function trustCompleteViaDialog(parentWindow, dialog, nodeId) {
        const result = await dialog.showOpenDialog(parentWindow, {
            title: "Choose secure Worker pairing response",
            properties: ["openFile", "dontAddToRecent"],
            filters: [{ name: "JSON", extensions: ["json"] }],
            buttonLabel: "Complete secure pairing",
        });
        if (result.canceled || !result.filePaths?.length) return { paired: false };
        const { readFile } = await import("node:fs/promises");
        const raw = await readFile(result.filePaths[0], "utf8");
        if (Buffer.byteLength(raw, "utf8") > 16 * 1024) throw new Error("secure Worker pairing response is too large");
        const value = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value) || !value.offer || !value.response) throw new Error("secure Worker pairing response must contain offer and response");
        return { paired: true, node: saveTrustProjection(nodeId, localTrustStore.completePairing(value.offer, value.response)) };
    }

    async function refresh(nodeId) {
        const targets = nodeId ? [getNode(nodeId)] : [...nodes.values()];
        const result = [];
        for (const node of targets) {
            try {
                const trust = publicTrust(node.trust);
                if (trust.transport !== "loopback") {
                    if (trust.status !== "trusted") throw new Error(`Worker secure trust is ${trust.status}`);
                    const health = await secureClient(node.nodeId).computerHealth();
                    nodes.set(node.nodeId, { ...node, status: "online", computer: publicComputer(health?.computer), lastSeenAt: new Date().toISOString(), lastError: undefined });
                    result.push(publicRecord(nodes.get(node.nodeId)));
                    continue;
                }
                const credential = credentials.get(node.nodeId);
                if (!credential) throw new Error("Worker Node credential is unavailable");
                const health = validateHealth(credential, await privateClient(node.nodeId).health());
                nodes.set(node.nodeId, { ...health, endpoint: credential.endpoint, enabled: node.enabled });
            }
            catch (error) {
                nodes.set(node.nodeId, { ...node, status: node.enabled ? "offline" : "blocked", lastError: safeError(error?.message ?? "Worker Node refresh failed") });
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

    async function resolveComputerTarget(nodeId, workspaceId, computerId) {
        const node = getNode(nodeId);
        const trust = publicTrust(node.trust);
        if (trust.transport !== "loopback") {
            if (trust.status !== "trusted") throw new Error(`selected Worker secure trust is ${trust.status}`);
            const workspace = node.workspaces.find((entry) => entry.id === validateWorkspaceId(workspaceId));
            if (!node.enabled || node.status !== "online" || !workspace) throw new Error("selected secure Worker workspace is unavailable");
            const client = secureClient(nodeId);
            const health = await client.computerHealth();
            const computer = publicComputer(health?.computer);
            if (!computerId || computer.id !== String(computerId)) throw new Error("selected Worker Computer is not advertised by the secure Worker");
            if (!["online", "capacity-limited"].includes(computer.state)) throw new Error("selected secure Worker Computer is unavailable");
            return { node: publicRecord(node), workspace: structuredClone(workspace), computer, client };
        }
        const target = resolveDispatchTarget(nodeId, workspaceId);
        const health = typeof target.client.computerHealth === "function" ? await target.client.computerHealth() : { computer: target.node.computer };
        const computer = publicComputer(health?.computer);
        if (!computerId || computer.id !== String(computerId)) throw new Error("selected Worker Computer is not advertised by the Worker Node");
        if (!["online", "capacity-limited"].includes(computer.state)) throw new Error("selected Worker Computer is unavailable");
        return { node: target.node, workspace: target.workspace, computer, client: target.client };
    }

    async function resolveVmTarget(nodeId, workspaceId, computerId) {
        const node = getNode(nodeId);
        const trust = publicTrust(node.trust);
        if (trust.status !== "trusted" || !["lan", "remote-relay"].includes(trust.transport))
            throw new Error("VM Computer target requires a trusted secure Worker profile");
        return resolveComputerTarget(nodeId, workspaceId, computerId);
    }

    return {
        list() { return { schema: WORKER_NODES_SCHEMA, nodes: [...nodes.values()].map(publicRecord) }; },
        get(nodeId) { return publicRecord(getNode(nodeId)); },
        client(nodeId) { return privateClient(nodeId); },
        resolveDispatchTarget,
        resolveComputerTarget,
        resolveVmTarget,
        async cancel(nodeId, remoteTaskId) {
            return privateClient(nodeId).cancel(remoteTaskId);
        },
        pair,
        pairViaDialog,
        trustCompleteViaDialog,
        trust: {
            list() { return localTrustStore.list(); },
            beginPairing(nodeId, options = {}) {
                const node = getNode(nodeId);
                const offer = localTrustStore.beginPairing(options);
                node.trust = { status: "pending", transport: offer.transport, expiresAt: offer.expiresAt, pairingChallengeId: offer.challengeId };
                savePublic();
                return { offer, node: publicRecord(node) };
            },
            completePairing(nodeId, offer, response) {
                const record = localTrustStore.completePairing(offer, response);
                return saveTrustProjection(nodeId, record);
            },
            revoke(nodeId) {
                const node = getNode(nodeId);
                const deviceId = publicTrust(node.trust).deviceId;
                if (!deviceId) throw new Error("Worker Node has no trusted device identity");
                return saveTrustProjection(nodeId, localTrustStore.revoke(deviceId));
            },
            rotate(nodeId) {
                const node = getNode(nodeId);
                const deviceId = publicTrust(node.trust).deviceId;
                if (!deviceId) throw new Error("Worker Node has no trusted device identity");
                localTrustStore.beginRotation(deviceId);
                localTrustStore.rotateIdentity();
                const rotated = localTrustStore.list().peers.find((entry) => entry.deviceId === deviceId);
                return saveTrustProjection(nodeId, rotated ?? { status: "rotating", transport: publicTrust(node.trust).transport, deviceId });
            },
        },
        // The main process may reuse this paired identity for the bounded
        // External Control Plane. It is never exposed through preload/IPC.
        secureTrustStore() { return localTrustStore; },
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
