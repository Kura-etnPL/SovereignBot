import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

export const EXTERNAL_CONTROLLER_SCHEMA = "sovereignbot.desktop.external-controllers.v1";
export const EXTERNAL_CONTROLLER_SCOPES = Object.freeze([
    "teams:read",
    "coworkers:read",
    "channels:read",
    "messages:write",
    "conversation:read",
    "outcomes:write",
    "outcomes:read",
    "outcomes:cancel",
    "artifacts:read",
    "skills:read",
    "routines:read",
    "routines:run",
    "attention:read",
    "attention:decide",
    "takeover:request",
    "computer:view",
    "computer:release",
]);

const OPERATION_SCOPE = Object.freeze({
    listTeams: "teams:read",
    listCoworkers: "coworkers:read",
    listChannels: "channels:read",
    sendMessage: "messages:write",
    getConversation: "conversation:read",
    submitOutcome: "outcomes:write",
    getStatus: "outcomes:read",
    cancel: "outcomes:cancel",
    getArtifacts: "artifacts:read",
    listSkills: "skills:read",
    listRoutines: "routines:read",
    runRoutineNow: "routines:run",
    getAttention: "attention:read",
    approveAttention: "attention:decide",
    denyAttention: "attention:decide",
    requestTakeover: "takeover:request",
    computerView: "computer:view",
    releaseTakeover: "computer:release",
});
const UNBOUND_READ_OPERATIONS = new Set(["listTeams", "listCoworkers", "listChannels", "listSkills", "listRoutines", "getAttention"]);

const DEVICE_ID = /^device_[0-9a-f]{16}$/i;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CONTROLLERS = 128;
const MAX_BINDINGS = 128;
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_IN_FLIGHT = 8;

function clone(value) { return structuredClone(value); }
function safeText(value, max = 120) { return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max); }
function timestamp(value, label) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
    return new Date(value).toISOString();
}
function id(value, label) {
    if (typeof value !== "string" || !OPAQUE_ID.test(value)) throw new Error(`${label} must be an opaque identifier`);
    return value;
}
function deviceId(value) {
    if (typeof value !== "string" || !DEVICE_ID.test(value)) throw new Error("external controller deviceId is invalid");
    return value;
}
function arrayOfIds(value, label) {
    if (!Array.isArray(value) || value.length > MAX_BINDINGS) throw new Error(`${label} must contain at most ${MAX_BINDINGS} identifiers`);
    return [...new Set(value.map((entry) => id(entry, label)))];
}
function arrayOfScopes(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > EXTERNAL_CONTROLLER_SCOPES.length) throw new Error("external controller scopes are invalid");
    const scopes = [...new Set(value)];
    if (scopes.some((entry) => !EXTERNAL_CONTROLLER_SCOPES.includes(entry))) throw new Error("external controller scope is not supported");
    return scopes;
}
function nowMs(now) {
    const value = typeof now === "function" ? now() : now;
    return value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
}
function validRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    try {
        const scopes = arrayOfScopes(value.scopes);
        const teamIds = arrayOfIds(value.teamIds, "teamIds");
        const projectIds = arrayOfIds(value.projectIds, "projectIds");
        if (!teamIds.length && !projectIds.length) return undefined;
        if (!value.createdAt || !value.expiresAt) return undefined;
        const transport = ["loopback", "lan", "remote-relay"].includes(value.transport) ? value.transport : undefined;
        if (!transport) return undefined;
        return {
            deviceId: deviceId(value.deviceId),
            name: safeText(value.name),
            platform: safeText(value.platform, 40),
            transport,
            status: ["active", "revoked", "expired", "rotating"].includes(value.status) ? value.status : "revoked",
            scopes,
            teamIds,
            projectIds,
            createdAt: timestamp(value.createdAt, "createdAt"),
            expiresAt: timestamp(value.expiresAt, "expiresAt"),
            ...(value.lastSeenAt === undefined ? {} : { lastSeenAt: timestamp(value.lastSeenAt, "lastSeenAt") }),
            ...(value.revokedAt === undefined ? {} : { revokedAt: timestamp(value.revokedAt, "revokedAt") }),
            ...(value.rotationRequestedAt === undefined ? {} : { rotationRequestedAt: timestamp(value.rotationRequestedAt, "rotationRequestedAt") }),
        };
    }
    catch { return undefined; }
}

export function createExternalControllerStore({ dataDir, persistPath, trustStore, now = () => Date.now() } = {}) {
    if (!dataDir || !trustStore?.getPeer || !trustStore?.list) throw new Error("external controller store requires dataDir and Worker trust store");
    const statePath = persistPath ?? join(dataDir, "desktop-state", "external-controllers.json");
    const loaded = loadJsonState(statePath, null);
    const controllers = new Map(
        loaded?.schema === EXTERNAL_CONTROLLER_SCHEMA && Array.isArray(loaded.controllers)
            ? loaded.controllers.map(validRecord).filter(Boolean).slice(-MAX_CONTROLLERS).map((entry) => [entry.deviceId, entry])
            : [],
    );
    const inFlight = new Map();

    function save() { saveJsonState(statePath, { schema: EXTERNAL_CONTROLLER_SCHEMA, controllers: [...controllers.values()].slice(-MAX_CONTROLLERS) }); }
    function current(device) {
        const record = controllers.get(deviceId(device));
        if (!record) throw new Error("external controller is not granted");
        return record;
    }
    function safeStatus(record) {
        let peer;
        try { peer = trustStore.list().peers.find((entry) => entry.deviceId === record.deviceId); }
        catch {}
        if (!peer) return "unpaired";
        if (record.status === "active" && nowMs(now) >= Date.parse(record.expiresAt)) return "expired";
        if (peer?.status && peer.status !== "trusted") return peer.status;
        return record.status;
    }
    function publicRecord(record) {
        const status = safeStatus(record);
        return {
            deviceId: record.deviceId,
            name: record.name,
            platform: record.platform,
            transport: record.transport,
            status,
            scopes: [...record.scopes],
            teamIds: [...record.teamIds],
            projectIds: [...record.projectIds],
            health: status === "active" ? "trusted" : status === "rotating" ? "rotation-required" : "unavailable",
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
        };
    }
    function trustedPeer(device) {
        const record = current(device);
        if (safeStatus(record) !== "active") throw new Error(`external controller trust is ${safeStatus(record)}`);
        return trustStore.getPeer(record.deviceId);
    }

    function grant({ deviceId: remoteDeviceId, name, platform, transport, scopes, teamIds, projectIds, expiresAt } = {}) {
        const remoteId = deviceId(remoteDeviceId);
        const peer = trustStore.getPeer(remoteId);
        if (transport !== undefined && transport !== peer.transport) throw new Error("external controller transport does not match paired trust");
        const cleanScopes = arrayOfScopes(scopes);
        const cleanTeams = arrayOfIds(teamIds, "teamIds");
        const cleanProjects = arrayOfIds(projectIds, "projectIds");
        if (!cleanTeams.length && !cleanProjects.length) throw new Error("external controller requires a Team or Project binding");
        const expires = expiresAt === undefined ? new Date(nowMs(now) + MAX_TTL_MS).toISOString() : timestamp(expiresAt, "expiresAt");
        if (Date.parse(expires) <= nowMs(now) || Date.parse(expires) > nowMs(now) + MAX_TTL_MS) throw new Error("external controller expiry is invalid");
        const record = {
            deviceId: remoteId,
            name: safeText(name ?? peer.name),
            platform: safeText(platform ?? peer.platform, 40),
            transport: transport ?? peer.transport,
            status: "active",
            scopes: cleanScopes,
            teamIds: cleanTeams,
            projectIds: cleanProjects,
            createdAt: new Date(nowMs(now)).toISOString(),
            expiresAt: expires,
        };
        controllers.set(remoteId, record);
        save();
        return publicRecord(record);
    }
    function authorize(remoteDeviceId, operation, context = {}) {
        if (!Object.hasOwn(OPERATION_SCOPE, operation)) throw new Error("external control operation is not supported");
        const record = current(remoteDeviceId);
        if (safeStatus(record) !== "active") throw new Error(`external controller trust is ${safeStatus(record)}`);
        const peer = trustedPeer(record.deviceId);
        if (context.transport !== undefined && context.transport !== peer.transport) throw new Error("external controller transport mismatch");
        if (!record.scopes.includes(OPERATION_SCOPE[operation])) throw new Error(`external controller scope denied for ${operation}`);
        const team = context.teamId === undefined ? undefined : id(context.teamId, "teamId");
        const project = context.projectId === undefined ? undefined : id(context.projectId, "projectId");
        if (team && record.teamIds.length && !record.teamIds.includes(team)) throw new Error("external controller Team binding denied");
        if (record.projectIds.length && project && !record.projectIds.includes(project)) throw new Error("external controller Project binding denied");
        if (record.projectIds.length && !project && !UNBOUND_READ_OPERATIONS.has(operation)) throw new Error("external controller Project binding denied");
        record.lastSeenAt = new Date(nowMs(now)).toISOString();
        save();
        return clone(record);
    }
    function touch(remoteDeviceId) {
        const record = current(remoteDeviceId);
        record.lastSeenAt = new Date(nowMs(now)).toISOString();
        save();
        return publicRecord(record);
    }
    function beginRequest(remoteDeviceId) {
        const record = current(remoteDeviceId);
        if (safeStatus(record) !== "active") throw new Error(`external controller trust is ${safeStatus(record)}`);
        trustedPeer(record.deviceId);
        const active = inFlight.get(record.deviceId) ?? 0;
        if (active >= MAX_IN_FLIGHT) throw new Error("external controller capacity is unavailable");
        inFlight.set(record.deviceId, active + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const remaining = (inFlight.get(record.deviceId) ?? 1) - 1;
            if (remaining > 0) inFlight.set(record.deviceId, remaining); else inFlight.delete(record.deviceId);
        };
    }
    function revoke(remoteDeviceId) {
        const record = current(remoteDeviceId);
        trustStore.revoke(record.deviceId);
        record.status = "revoked";
        record.revokedAt = new Date(nowMs(now)).toISOString();
        save();
        return publicRecord(record);
    }
    function rotate(remoteDeviceId) {
        const record = current(remoteDeviceId);
        trustStore.beginRotation(record.deviceId);
        record.status = "rotating";
        record.rotationRequestedAt = new Date(nowMs(now)).toISOString();
        save();
        return publicRecord(record);
    }
    function beginPairing(options = {}) { return trustStore.beginPairing(options); }
    function completePairing(offer, response, grantOptions = {}) {
        const peer = trustStore.completePairing(offer, response);
        return grant({ ...grantOptions, deviceId: peer.deviceId, transport: peer.transport });
    }

    return {
        list() { return { schema: EXTERNAL_CONTROLLER_SCHEMA, controllers: [...controllers.values()].map(publicRecord) }; },
        get(remoteDeviceId) { return publicRecord(current(remoteDeviceId)); },
        grant,
        authorize,
        touch,
        beginRequest,
        revoke,
        rotate,
        beginPairing,
        completePairing,
        paths: { publicPath: statePath },
        _privateState() { return { schema: EXTERNAL_CONTROLLER_SCHEMA, controllers: clone([...controllers.values()]) }; },
    };
}

export function externalControlScope(operation) { return OPERATION_SCOPE[operation]; }
