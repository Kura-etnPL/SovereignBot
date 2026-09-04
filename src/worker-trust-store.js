import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    WORKER_PAIRING_TTL_MS,
    WORKER_SECURE_PROTOCOL,
    WORKER_TRUST_TTL_MS,
    acceptPairingOffer,
    completePairing,
    createPairingOffer,
    createWorkerDeviceIdentity,
    publicTrustRecord,
    publicWorkerDeviceIdentity,
    rotateWorkerDeviceIdentity,
    trustRecord,
    validatePairingOffer,
    validateWorkerDeviceIdentity,
} from "./worker-secure-transport.js";

export const WORKER_TRUST_SCHEMA = "sovereignbot.worker-trust.v1";
export const WORKER_DEVICE_IDENTITY_FILE = "worker-device-identity.json";
export const WORKER_TRUST_STATE_FILE = "worker-trust-state.json";

function clone(value) { return structuredClone(value); }

function loadJson(path, fallback) {
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch { return clone(fallback); }
}

function saveJson(path, value, mode = undefined) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? "utf8" : { encoding: "utf8", mode });
    renameSync(temp, path);
}

function validState(value) {
    if (!value || value.schema !== WORKER_TRUST_SCHEMA || !Array.isArray(value.peers) || !Array.isArray(value.pendingChallenges) || !Array.isArray(value.consumedChallenges)) return { schema: WORKER_TRUST_SCHEMA, peers: [], pendingChallenges: [], consumedChallenges: [] };
    const peers = [];
    for (const entry of value.peers) { try { peers.push(trustRecord(entry)); } catch { /* corrupt private state fails closed */ } }
    const pendingChallenges = value.pendingChallenges.filter((entry) => entry && typeof entry.challengeId === "string" && typeof entry.challengeDigest === "string" && typeof entry.expiresAt === "string").slice(-64).map(clone);
    const consumedChallenges = value.consumedChallenges.filter((entry) => typeof entry === "string").slice(-256);
    return { schema: WORKER_TRUST_SCHEMA, peers, pendingChallenges, consumedChallenges };
}

function responderPeer(offer, response) {
    const identity = response.responder;
    return trustRecord({ deviceId: offer.initiatorDeviceId, name: offer.initiatorName, platform: offer.initiatorPlatform, keyEpoch: offer.initiatorKeyEpoch, signingPublicKey: offer.initiatorSigningPublicKey, agreementPublicKey: offer.initiatorAgreementPublicKey, transport: offer.transport, status: "trusted", trustedAt: response.acceptedAt, expiresAt: response.expiresAt });
}

export function createWorkerTrustStore({ dataDir, identityPath, statePath, identity, name = "Sovereign Worker", platform = process.platform, now = () => Date.now() } = {}) {
    if (!dataDir && !identityPath) throw new Error("Worker trust store requires dataDir or identityPath");
    const privateIdentityPath = identityPath ?? join(dataDir, "desktop-state", WORKER_DEVICE_IDENTITY_FILE);
    const privateStatePath = statePath ?? join(dataDir, "desktop-state", WORKER_TRUST_STATE_FILE);
    let localIdentity;
    if (identity) localIdentity = validateWorkerDeviceIdentity(identity);
    else {
        const existing = loadJson(privateIdentityPath, null);
        localIdentity = existing ? validateWorkerDeviceIdentity(existing) : createWorkerDeviceIdentity({ name, platform, now });
        if (!existing) saveJson(privateIdentityPath, localIdentity, 0o600);
    }
    let state = validState(loadJson(privateStatePath, null));

    function save() { saveJson(privateStatePath, state, 0o600); }
    function peer(deviceId) { const value = state.peers.find((entry) => entry.deviceId === deviceId); return value ? clone(value) : undefined; }
    function ensureNotConsumed(challengeId) { if (state.consumedChallenges.includes(challengeId)) throw new Error("pairing challenge has already been consumed"); }
    function putPeer(value) { state.peers = [...state.peers.filter((entry) => entry.deviceId !== value.deviceId), trustRecord(value)]; }

    function beginPairing({ transport = "lan", ttlMs = WORKER_PAIRING_TTL_MS, trustTtlMs = WORKER_TRUST_TTL_MS } = {}) {
        const offer = createPairingOffer(localIdentity, { transport, ttlMs, now });
        state.pendingChallenges = [...state.pendingChallenges.filter((entry) => !entry.expiresAt || Date.parse(entry.expiresAt) > Number(new Date(now()))), { challengeId: offer.challengeId, challengeDigest: offer.challengeDigest, transport: offer.transport, expiresAt: offer.expiresAt, trustTtlMs }].slice(-64);
        save();
        return clone(offer);
    }

    function acceptPairing(offerValue, code, { trustTtlMs = WORKER_TRUST_TTL_MS, transport } = {}) {
        const offer = validatePairingOffer(offerValue);
        ensureNotConsumed(offer.challengeId);
        const response = acceptPairingOffer(localIdentity, offer, code, { trustTtlMs, transport, now });
        putPeer(responderPeer(offer, response));
        state.consumedChallenges = [...state.consumedChallenges.filter((id) => id !== offer.challengeId), offer.challengeId].slice(-256);
        save();
        return clone(response);
    }

    function finishPairing(offerValue, responseValue) {
        const offer = validatePairingOffer(offerValue);
        ensureNotConsumed(offer.challengeId);
        const pending = state.pendingChallenges.find((entry) => entry.challengeId === offer.challengeId);
        if (!pending || pending.challengeDigest !== offer.challengeDigest || pending.transport !== offer.transport) throw new Error("pairing challenge is unknown or expired");
        const record = completePairing(localIdentity, offer, responseValue, { now });
        putPeer(record);
        state.pendingChallenges = state.pendingChallenges.filter((entry) => entry.challengeId !== offer.challengeId);
        state.consumedChallenges = [...state.consumedChallenges, offer.challengeId].slice(-256);
        save();
        return publicTrustRecord(record, { now });
    }

    function revoke(deviceId) {
        const current = peer(deviceId);
        if (!current) throw new Error("unknown trusted Worker device");
        putPeer({ ...current, status: "revoked", revokedAt: new Date(now()).toISOString() });
        save();
        return publicTrustRecord(state.peers.find((entry) => entry.deviceId === deviceId), { now });
    }

    function beginRotation(deviceId) {
        const current = peer(deviceId);
        if (!current) throw new Error("unknown trusted Worker device");
        putPeer({ ...current, status: "rotating" });
        save();
        return publicTrustRecord(state.peers.find((entry) => entry.deviceId === deviceId), { now });
    }

    function rotateIdentity() {
        localIdentity = rotateWorkerDeviceIdentity(localIdentity, { now });
        saveJson(privateIdentityPath, localIdentity, 0o600);
        state.peers = state.peers.map((entry) => entry.status === "trusted" ? { ...entry, status: "rotating" } : entry);
        save();
        return publicWorkerDeviceIdentity(localIdentity);
    }

    function getPeer(deviceId) {
        const current = peer(deviceId);
        if (!current) throw new Error("unknown trusted Worker device");
        if (current.status !== "trusted") throw new Error(`Worker device trust is ${current.status}`);
        if (new Date(now()).getTime() >= Date.parse(current.expiresAt)) throw new Error("Worker device trust has expired");
        return current;
    }

    return {
        identity() { return clone(localIdentity); },
        publicIdentity() { return publicWorkerDeviceIdentity(localIdentity); },
        beginPairing,
        acceptPairing,
        completePairing: finishPairing,
        revoke,
        beginRotation,
        rotateIdentity,
        getPeer,
        list() { return { schema: WORKER_TRUST_SCHEMA, localDeviceId: localIdentity.deviceId, peers: state.peers.map((entry) => publicTrustRecord(entry, { now })) }; },
        paths: { identityPath: privateIdentityPath, statePath: privateStatePath },
        _privateState() { return clone(state); },
    };
}
