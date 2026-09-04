import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createPrivateKey,
    createPublicKey,
    diffieHellman,
    generateKeyPairSync,
    hkdfSync,
    randomBytes,
    sign,
    verify,
} from "node:crypto";
import { validateComputerEnvelope } from "./worker-computer-protocol.js";

export const WORKER_SECURE_PROTOCOL = "sovereign-worker-secure/1";
export const WORKER_SECURE_VERSION = 1;
export const WORKER_PAIRING_TTL_MS = 10 * 60 * 1000;
export const WORKER_TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const WORKER_TRANSPORTS = Object.freeze(["loopback", "lan", "remote-relay"]);
export const EXTERNAL_CONTROL_OPERATIONS = Object.freeze([
    "listTeams",
    "listCoworkers",
    "listChannels",
    "sendMessage",
    "getConversation",
    "submitOutcome",
    "getStatus",
    "cancel",
    "getArtifacts",
    "listSkills",
    "listRoutines",
    "runRoutineNow",
    "getAttention",
    "requestTakeover",
]);
export const EXTERNAL_CONTROL_PROTOCOL_V1 = "sovereignbot.external-control/1";
export const EXTERNAL_CONTROL_PROTOCOL_V2 = "sovereignbot.external-control/2";
export const EXTERNAL_CONTROL_V2_OPERATIONS = Object.freeze([
    "approveAttention",
    "denyAttention",
    "computerView",
    "releaseTakeover",
]);

const ID = /^[a-z][a-z0-9_-]{2,95}$/;
const DEVICE_ID = /^device_[0-9a-f]{16}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_FRAME_BYTES = 96 * 1024;
const REQUEST_KINDS = new Set(["computer.health", "computer.action", "control.call"]);

function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value;
}

function exactKeys(value, allowed, label) {
    object(value, label);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`${label} contains an unsupported field`);
}

function text(value, label, max, pattern = undefined) {
    if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`${label} is invalid`);
    const clean = value.trim();
    if (pattern && !pattern.test(clean)) throw new Error(`${label} has an invalid format`);
    return clean;
}

function timestamp(value, label) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
    return new Date(value).toISOString();
}

function b64(value, label) {
    const clean = text(value, label, 8192, BASE64URL);
    if (Buffer.from(clean, "base64url").toString("base64url") !== clean) throw new Error(`${label} is invalid`);
    return clean;
}

function nowMs(now) {
    const value = typeof now === "function" ? now() : now;
    const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error("clock value is invalid");
    return parsed;
}

function atOrAfter(now, expiresAt) {
    return nowMs(now) >= Date.parse(expiresAt);
}

function randomId(prefix) { return `${prefix}_${randomBytes(12).toString("hex")}`; }
function randomCode() { return randomBytes(5).toString("hex").toUpperCase().slice(0, 10); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function bytes(value) { return Buffer.from(value, "base64url"); }
function encode(value) { return Buffer.from(value).toString("base64url"); }

function keyExport(key, type) { return key.export({ format: "der", type }).toString("base64url"); }
function publicKey(value) { return createPublicKey({ key: bytes(value), format: "der", type: "spki" }); }
function privateKey(value) { return createPrivateKey({ key: bytes(value), format: "der", type: "pkcs8" }); }

export function canonicalSecureJson(value) {
    if (value === undefined) return "null";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalSecureJson).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalSecureJson(value[key])}`).join(",")}}`;
}

function signedBytes(label, value) { return Buffer.from(`${label}\n${canonicalSecureJson(value)}`); }

export function validateTransport(value) {
    if (typeof value !== "string" || !WORKER_TRANSPORTS.includes(value)) throw new Error("Worker transport is not supported");
    return value;
}

export function createWorkerDeviceIdentity({ deviceId = `device_${randomBytes(8).toString("hex")}`, name = "Sovereign Worker", platform = "unknown", now = () => Date.now(), keyEpoch = 1 } = {}) {
    const signing = generateKeyPairSync("ed25519");
    const agreement = generateKeyPairSync("x25519");
    const identity = {
        schema: "sovereignbot.worker-device.identity.v1",
        deviceId: text(deviceId, "deviceId", 96, DEVICE_ID),
        name: text(name, "device name", 120),
        platform: text(platform, "device platform", 40),
        keyEpoch,
        createdAt: new Date(nowMs(now)).toISOString(),
        signingPublicKey: keyExport(signing.publicKey, "spki"),
        signingPrivateKey: keyExport(signing.privateKey, "pkcs8"),
        agreementPublicKey: keyExport(agreement.publicKey, "spki"),
        agreementPrivateKey: keyExport(agreement.privateKey, "pkcs8"),
    };
    return validateWorkerDeviceIdentity(identity);
}

export function validateWorkerDeviceIdentity(value) {
    exactKeys(value, new Set(["schema", "deviceId", "name", "platform", "keyEpoch", "createdAt", "rotatedAt", "signingPublicKey", "signingPrivateKey", "agreementPublicKey", "agreementPrivateKey"]), "Worker device identity");
    if (value.schema !== "sovereignbot.worker-device.identity.v1") throw new Error("Worker device identity schema is not supported");
    const identity = {
        schema: value.schema,
        deviceId: text(value.deviceId, "deviceId", 96, DEVICE_ID),
        name: text(value.name, "device name", 120),
        platform: text(value.platform, "device platform", 40),
        keyEpoch: value.keyEpoch,
        createdAt: timestamp(value.createdAt, "createdAt"),
        ...(value.rotatedAt === undefined ? {} : { rotatedAt: timestamp(value.rotatedAt, "rotatedAt") }),
        signingPublicKey: b64(value.signingPublicKey, "signingPublicKey"),
        signingPrivateKey: b64(value.signingPrivateKey, "signingPrivateKey"),
        agreementPublicKey: b64(value.agreementPublicKey, "agreementPublicKey"),
        agreementPrivateKey: b64(value.agreementPrivateKey, "agreementPrivateKey"),
    };
    if (!Number.isInteger(identity.keyEpoch) || identity.keyEpoch < 1 || identity.keyEpoch > 1_000_000) throw new Error("Worker device keyEpoch is invalid");
    if (!verify(null, Buffer.from("identity"), publicKey(identity.signingPublicKey), sign(null, Buffer.from("identity"), privateKey(identity.signingPrivateKey)))) throw new Error("Worker device signing key pair is invalid");
    diffieHellman({ privateKey: privateKey(identity.agreementPrivateKey), publicKey: publicKey(identity.agreementPublicKey) });
    return identity;
}

export function publicWorkerDeviceIdentity(value) {
    const identity = validateWorkerDeviceIdentity(value);
    return { protocol: WORKER_SECURE_PROTOCOL, deviceId: identity.deviceId, name: identity.name, platform: identity.platform, keyEpoch: identity.keyEpoch, signingPublicKey: identity.signingPublicKey, agreementPublicKey: identity.agreementPublicKey };
}

export function rotateWorkerDeviceIdentity(value, { now = () => Date.now() } = {}) {
    const previous = validateWorkerDeviceIdentity(value);
    return createWorkerDeviceIdentity({ deviceId: previous.deviceId, name: previous.name, platform: previous.platform, keyEpoch: previous.keyEpoch + 1, now });
}

function validatePublicIdentity(value) {
    exactKeys(value, new Set(["protocol", "deviceId", "name", "platform", "keyEpoch", "signingPublicKey", "agreementPublicKey"]), "Worker public identity");
    if (value.protocol !== WORKER_SECURE_PROTOCOL) throw new Error("Worker secure protocol is not supported");
    const deviceId = text(value.deviceId, "deviceId", 96, DEVICE_ID);
    const name = text(value.name, "device name", 120);
    const platform = text(value.platform, "device platform", 40);
    if (!Number.isInteger(value.keyEpoch) || value.keyEpoch < 1) throw new Error("Worker public key epoch is invalid");
    const signingPublicKey = b64(value.signingPublicKey, "signingPublicKey");
    const agreementPublicKey = b64(value.agreementPublicKey, "agreementPublicKey");
    publicKey(signingPublicKey); publicKey(agreementPublicKey);
    return { protocol: WORKER_SECURE_PROTOCOL, deviceId, name, platform, keyEpoch: value.keyEpoch, signingPublicKey, agreementPublicKey };
}

function pairingTranscript(offer, responder) {
    return { protocol: WORKER_SECURE_PROTOCOL, version: WORKER_SECURE_VERSION, challengeId: offer.challengeId, challengeDigest: offer.challengeDigest, initiatorDeviceId: offer.initiatorDeviceId, responderDeviceId: responder.deviceId, transport: offer.transport, initiatorKeyEpoch: offer.initiatorKeyEpoch, responderKeyEpoch: responder.keyEpoch };
}

function signValue(label, value, identity) { return encode(sign(null, signedBytes(label, value), privateKey(identity.signingPrivateKey))); }
function verifyValue(label, value, signature, publicSigningKey) { return verify(null, signedBytes(label, value), publicKey(publicSigningKey), bytes(signature)); }

export function validatePairingOffer(value) {
    exactKeys(value, new Set(["protocol", "version", "challengeId", "challengeDigest", "code", "initiatorDeviceId", "initiatorName", "initiatorPlatform", "initiatorKeyEpoch", "initiatorSigningPublicKey", "initiatorAgreementPublicKey", "transport", "expiresAt", "signature"]), "Worker pairing offer");
    if (value.protocol !== WORKER_SECURE_PROTOCOL || value.version !== WORKER_SECURE_VERSION) throw new Error("Worker pairing protocol downgrade or mismatch");
    const offer = {
        protocol: WORKER_SECURE_PROTOCOL, version: WORKER_SECURE_VERSION,
        challengeId: text(value.challengeId, "challengeId", 128, ID), challengeDigest: text(value.challengeDigest, "challengeDigest", 64, /^[a-f0-9]{64}$/),
        code: text(value.code, "pairing code", 16, /^[A-Z0-9]{6,16}$/), initiatorDeviceId: text(value.initiatorDeviceId, "initiatorDeviceId", 96, DEVICE_ID),
        initiatorName: text(value.initiatorName, "initiatorName", 120), initiatorPlatform: text(value.initiatorPlatform, "initiatorPlatform", 40),
        initiatorKeyEpoch: value.initiatorKeyEpoch, initiatorSigningPublicKey: b64(value.initiatorSigningPublicKey, "initiatorSigningPublicKey"), initiatorAgreementPublicKey: b64(value.initiatorAgreementPublicKey, "initiatorAgreementPublicKey"),
        transport: validateTransport(value.transport), expiresAt: timestamp(value.expiresAt, "pairing offer expiresAt"), signature: b64(value.signature, "pairing offer signature"),
    };
    if (!Number.isInteger(offer.initiatorKeyEpoch) || offer.initiatorKeyEpoch < 1) throw new Error("initiatorKeyEpoch is invalid");
    const signed = { ...offer }; delete signed.code; delete signed.signature;
    if (!verifyValue("worker-pairing-offer", signed, offer.signature, offer.initiatorSigningPublicKey)) throw new Error("Worker pairing offer signature is invalid");
    return offer;
}

export function createPairingOffer(identity, { transport = "lan", ttlMs = WORKER_PAIRING_TTL_MS, now = () => Date.now(), challengeId = randomId("challenge"), code = randomCode() } = {}) {
    const local = validateWorkerDeviceIdentity(identity);
    validateTransport(transport);
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > WORKER_PAIRING_TTL_MS) throw new Error("pairing TTL is invalid");
    const expiresAt = new Date(nowMs(now) + ttlMs).toISOString();
    const unsigned = { protocol: WORKER_SECURE_PROTOCOL, version: WORKER_SECURE_VERSION, challengeId: text(challengeId, "challengeId", 128, ID), challengeDigest: digest(code), initiatorDeviceId: local.deviceId, initiatorName: local.name, initiatorPlatform: local.platform, initiatorKeyEpoch: local.keyEpoch, initiatorSigningPublicKey: local.signingPublicKey, initiatorAgreementPublicKey: local.agreementPublicKey, transport: validateTransport(transport), expiresAt };
    return validatePairingOffer({ ...unsigned, code, signature: signValue("worker-pairing-offer", unsigned, local) });
}

export function acceptPairingOffer(identity, offerValue, code, { transport, trustTtlMs = WORKER_TRUST_TTL_MS, now = () => Date.now() } = {}) {
    const local = validateWorkerDeviceIdentity(identity);
    const offer = validatePairingOffer(offerValue);
    if (transport !== undefined && validateTransport(transport) !== offer.transport) throw new Error("pairing transport mismatch");
    if (atOrAfter(now, offer.expiresAt)) throw new Error("pairing offer has expired");
    if (typeof code !== "string" || digest(code.trim().toUpperCase()) !== offer.challengeDigest) throw new Error("pairing code is invalid");
    if (!Number.isInteger(trustTtlMs) || trustTtlMs < 1_000 || trustTtlMs > 365 * 24 * 60 * 60 * 1000) throw new Error("trust TTL is invalid");
    const responder = publicWorkerDeviceIdentity(local);
    const transcript = pairingTranscript(offer, responder);
    const acceptedAt = new Date(nowMs(now)).toISOString();
    const responseUnsigned = { ...transcript, responder, acceptedAt, expiresAt: new Date(nowMs(now) + trustTtlMs).toISOString() };
    return { protocol: WORKER_SECURE_PROTOCOL, version: WORKER_SECURE_VERSION, challengeId: offer.challengeId, responder, acceptedAt, expiresAt: responseUnsigned.expiresAt, signature: signValue("worker-pairing-response", responseUnsigned, local) };
}

export function completePairing(identity, offerValue, responseValue, { now = () => Date.now() } = {}) {
    const local = validateWorkerDeviceIdentity(identity);
    const offer = validatePairingOffer(offerValue);
    object(responseValue, "Worker pairing response");
    exactKeys(responseValue, new Set(["protocol", "version", "challengeId", "responder", "acceptedAt", "expiresAt", "signature"]), "Worker pairing response");
    if (responseValue.protocol !== WORKER_SECURE_PROTOCOL || responseValue.version !== WORKER_SECURE_VERSION || responseValue.challengeId !== offer.challengeId) throw new Error("Worker pairing response protocol mismatch");
    const responder = validatePublicIdentity(responseValue.responder);
    if (atOrAfter(now, offer.expiresAt) || atOrAfter(now, responseValue.expiresAt)) throw new Error("Worker pairing response has expired");
    const signed = { ...pairingTranscript(offer, responder), responder, acceptedAt: timestamp(responseValue.acceptedAt, "acceptedAt"), expiresAt: timestamp(responseValue.expiresAt, "expiresAt") };
    if (!verifyValue("worker-pairing-response", signed, responseValue.signature, responder.signingPublicKey)) throw new Error("Worker pairing response signature is invalid");
    if (responder.deviceId === local.deviceId) throw new Error("Worker cannot pair with itself");
    return { deviceId: responder.deviceId, name: responder.name, platform: responder.platform, keyEpoch: responder.keyEpoch, signingPublicKey: responder.signingPublicKey, agreementPublicKey: responder.agreementPublicKey, transport: offer.transport, status: "trusted", trustedAt: new Date(nowMs(now)).toISOString(), expiresAt: signed.expiresAt, lastSeenAt: undefined };
}

export function trustRecord(value) {
    exactKeys(value, new Set(["deviceId", "name", "platform", "keyEpoch", "signingPublicKey", "agreementPublicKey", "transport", "status", "trustedAt", "expiresAt", "lastSeenAt", "revokedAt"]), "trusted device record");
    const record = { deviceId: text(value.deviceId, "deviceId", 96, DEVICE_ID), name: text(value.name, "device name", 120), platform: text(value.platform, "device platform", 40), keyEpoch: value.keyEpoch, signingPublicKey: b64(value.signingPublicKey, "signingPublicKey"), agreementPublicKey: b64(value.agreementPublicKey, "agreementPublicKey"), transport: validateTransport(value.transport), status: text(value.status, "trust status", 16, /^(trusted|revoked|expired|rotating|pending)$/), trustedAt: timestamp(value.trustedAt, "trustedAt"), expiresAt: timestamp(value.expiresAt, "expiresAt"), ...(value.lastSeenAt === undefined ? {} : { lastSeenAt: timestamp(value.lastSeenAt, "lastSeenAt") }), ...(value.revokedAt === undefined ? {} : { revokedAt: timestamp(value.revokedAt, "revokedAt") }) };
    if (!Number.isInteger(record.keyEpoch) || record.keyEpoch < 1) throw new Error("trusted device keyEpoch is invalid");
    publicKey(record.signingPublicKey); publicKey(record.agreementPublicKey);
    return record;
}

export function publicTrustRecord(value, { now = () => Date.now() } = {}) {
    const record = trustRecord(value);
    const expired = record.status === "trusted" && atOrAfter(now, record.expiresAt);
    return { protocol: WORKER_SECURE_PROTOCOL, deviceId: record.deviceId, name: record.name, platform: record.platform, transport: record.transport, status: expired ? "expired" : record.status, keyEpoch: record.keyEpoch, expiresAt: record.expiresAt, lastSeenAt: record.lastSeenAt };
}

function securePayload(value) {
    exactKeys(value, new Set(["kind", "envelope", "operation", "input", "controlVersion"]), "secure Worker request");
    if (!REQUEST_KINDS.has(value.kind)) throw new Error("secure Worker request kind is not supported");
    if (value.kind === "computer.action") {
        if (value.operation !== undefined || value.input !== undefined || value.controlVersion !== undefined) throw new Error("computer action request cannot contain control fields");
        return { kind: value.kind, envelope: validateComputerEnvelope(value.envelope) };
    }
    if (value.kind === "control.call") {
        if (value.envelope !== undefined) throw new Error("external control request cannot contain a computer envelope");
        const version = value.controlVersion === undefined ? 1 : value.controlVersion;
        if (!Number.isInteger(version) || ![1, 2].includes(version)) throw new Error("secure external control version is not supported");
        const operations = version === 2 ? [...EXTERNAL_CONTROL_OPERATIONS, ...EXTERNAL_CONTROL_V2_OPERATIONS] : EXTERNAL_CONTROL_OPERATIONS;
        if (typeof value.operation !== "string" || !operations.includes(value.operation)) throw new Error("secure external control operation is not supported");
        object(value.input, "secure external control input");
        if (Buffer.byteLength(canonicalSecureJson(value.input), "utf8") > 48 * 1024) throw new Error("secure external control input is too large");
        return { kind: value.kind, ...(value.controlVersion === undefined ? {} : { controlVersion: version }), operation: value.operation, input: structuredClone(value.input) };
    }
    if (value.envelope !== undefined) throw new Error("computer health request cannot contain an envelope");
    if (value.operation !== undefined || value.input !== undefined || value.controlVersion !== undefined) throw new Error("computer health request cannot contain control fields");
    return { kind: value.kind };
}

export function validateSecureFrame(value) {
    exactKeys(value, new Set(["protocol", "version", "transport", "senderDeviceId", "recipientDeviceId", "sessionId", "sequence", "keyEpoch", "messageId", "nonce", "ciphertext", "tag", "signature"]), "secure Worker frame");
    if (value.protocol !== WORKER_SECURE_PROTOCOL || value.version !== WORKER_SECURE_VERSION) throw new Error("secure Worker frame protocol downgrade or mismatch");
    const frame = { protocol: WORKER_SECURE_PROTOCOL, version: WORKER_SECURE_VERSION, transport: validateTransport(value.transport), senderDeviceId: text(value.senderDeviceId, "senderDeviceId", 96, DEVICE_ID), recipientDeviceId: text(value.recipientDeviceId, "recipientDeviceId", 96, DEVICE_ID), sessionId: text(value.sessionId, "sessionId", 128, ID), sequence: value.sequence, keyEpoch: value.keyEpoch, messageId: text(value.messageId, "messageId", 128, ID), nonce: b64(value.nonce, "nonce"), ciphertext: b64(value.ciphertext, "ciphertext"), tag: b64(value.tag, "tag"), signature: b64(value.signature, "signature") };
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 1 || !Number.isInteger(frame.keyEpoch) || frame.keyEpoch < 1) throw new Error("secure Worker frame counters are invalid");
    if (Buffer.byteLength(JSON.stringify(frame), "utf8") > MAX_FRAME_BYTES) throw new Error("secure Worker frame is too large");
    if (bytes(frame.nonce).length !== 12 || bytes(frame.tag).length !== 16) throw new Error("secure Worker frame AEAD fields are invalid");
    return frame;
}

function frameAad(frame) {
    const { signature: _signature, nonce: _nonce, ciphertext: _ciphertext, tag: _tag, ...aad } = frame;
    return Buffer.from(canonicalSecureJson(aad));
}

function deriveSessionKey(local, peer, sessionId) {
    const shared = diffieHellman({ privateKey: privateKey(local.agreementPrivateKey), publicKey: publicKey(peer.agreementPublicKey) });
    const pair = [local.deviceId, peer.deviceId].sort().join(":");
    return Buffer.from(hkdfSync("sha256", shared, Buffer.from(sessionId), Buffer.from(`${WORKER_SECURE_PROTOCOL}:${pair}`), 32));
}

function peerRecordFor(value) { return trustRecord(value); }

export function createOpaqueRelay() {
    const routes = new Map();
    const observed = [];
    return Object.freeze({
        register(deviceId, receiver) { const id = text(deviceId, "relay deviceId", 96, DEVICE_ID); if (!receiver || typeof receiver.receiveFrame !== "function") throw new Error("relay receiver is invalid"); routes.set(id, receiver); return () => routes.delete(id); },
        async forward(rawFrame) { const frame = validateSecureFrame(rawFrame); observed.push(structuredClone(frame)); const receiver = routes.get(frame.recipientDeviceId); if (!receiver) throw new Error("relay recipient is unavailable"); return receiver.receiveFrame(frame); },
        inspect() { return observed.map((frame) => structuredClone(frame)); },
    });
}

export function createSecureChannel({ localIdentity, peerIdentity, localTrust, transport, relay, now = () => Date.now(), sessionId = randomId("session") } = {}) {
    const local = validateWorkerDeviceIdentity(localIdentity);
    const peer = validatePublicIdentity(peerIdentity?.signingPrivateKey ? publicWorkerDeviceIdentity(peerIdentity) : peerIdentity);
    const trusted = peerRecordFor(localTrust);
    validateTransport(transport);
    if (trusted.deviceId !== peer.deviceId || trusted.transport !== transport || trusted.status !== "trusted" || trusted.keyEpoch !== peer.keyEpoch || trusted.signingPublicKey !== peer.signingPublicKey || trusted.agreementPublicKey !== peer.agreementPublicKey) throw new Error("Worker peer is not trusted for this transport or key epoch");
    if (atOrAfter(now, trusted.expiresAt)) throw new Error("Worker peer trust has expired");
    if (sessionId.length < 8) throw new Error("secure sessionId is invalid");
    const sessionKey = deriveSessionKey(local, peer, sessionId);
    let peerEndpoint;
    let sequence = 0;
    let highestReceived = 0;
    const pending = new Map();
    let handler = async () => { throw new Error("secure Worker channel has no request handler"); };

    function makeFrame(payload, replyTo = undefined) {
        const messageId = replyTo ?? randomId("message");
        const nextSequence = ++sequence;
        const body = Buffer.from(canonicalSecureJson(payload));
        const nonce = randomBytes(12);
        const header = { protocol: WORKER_SECURE_PROTOCOL, version: WORKER_SECURE_VERSION, transport, senderDeviceId: local.deviceId, recipientDeviceId: peer.deviceId, sessionId, sequence: nextSequence, keyEpoch: local.keyEpoch, messageId };
        const cipher = createCipheriv("aes-256-gcm", sessionKey, nonce);
        cipher.setAAD(Buffer.from(canonicalSecureJson(header)));
        const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
        const tag = cipher.getAuthTag();
        const frame = { ...header, nonce: encode(nonce), ciphertext: encode(ciphertext), tag: encode(tag) };
        return validateSecureFrame({ ...frame, signature: signValue("worker-secure-frame", frame, local) });
    }

    async function receiveFrame(rawFrame) {
        const frame = validateSecureFrame(rawFrame);
        if (frame.transport !== transport || frame.senderDeviceId !== peer.deviceId || frame.recipientDeviceId !== local.deviceId || frame.sessionId !== sessionId || frame.keyEpoch !== peer.keyEpoch) throw new Error("secure Worker frame identity, transport, or epoch mismatch");
        if (frame.sequence <= highestReceived) throw new Error("secure Worker frame replay or out-of-order sequence rejected");
        const peerRecord = peerRecordFor(trusted);
        const unsigned = { ...frame };
        delete unsigned.signature;
        if (!verifyValue("worker-secure-frame", unsigned, frame.signature, peerRecord.signingPublicKey)) throw new Error("secure Worker frame signature is invalid");
        highestReceived = frame.sequence;
        const decipher = createDecipheriv("aes-256-gcm", sessionKey, bytes(frame.nonce));
        decipher.setAAD(frameAad(frame));
        decipher.setAuthTag(bytes(frame.tag));
        let parsed;
        try { parsed = JSON.parse(Buffer.concat([decipher.update(bytes(frame.ciphertext)), decipher.final()]).toString("utf8")); }
        catch { throw new Error("secure Worker frame authentication failed"); }
        object(parsed, "secure Worker payload");
        if (parsed.type === "response") {
            const waiter = pending.get(frame.messageId);
            if (!waiter) throw new Error("secure Worker response is unexpected");
            pending.delete(frame.messageId);
            if (parsed.ok !== true) waiter.reject(new Error(parsed.error || "secure Worker request failed")); else waiter.resolve(parsed.data);
            return { accepted: true, response: true };
        }
        const result = await handler(parsed);
        if (!peerEndpoint) throw new Error("secure Worker channel is not connected");
        const responseFrame = makeFrame({ type: "response", ok: true, data: result }, frame.messageId);
        return relay ? relay.forward(responseFrame) : peerEndpoint.receiveFrame(responseFrame);
    }

    const endpoint = {
        deviceId: local.deviceId,
        peerDeviceId: peer.deviceId,
        transport,
        setRequestHandler(value) { if (typeof value !== "function") throw new Error("secure Worker request handler is invalid"); handler = value; },
        connect(value) { if (!value || typeof value.receiveFrame !== "function") throw new Error("secure Worker peer endpoint is invalid"); peerEndpoint = value; },
        async request(payload) { const valid = securePayload(payload); const frame = makeFrame(valid); return new Promise((resolve, reject) => { pending.set(frame.messageId, { resolve, reject }); Promise.resolve(relay ? relay.forward(frame) : peerEndpoint?.receiveFrame(frame)).catch((error) => { pending.delete(frame.messageId); reject(error); }); }); },
        receiveFrame,
    };
    return Object.freeze(endpoint);
}

export function createSecureChannelPair({ leftIdentity, rightIdentity, leftTrust, rightTrust, transport = "lan", relay = createOpaqueRelay(), now = () => Date.now(), sessionId = randomId("session") } = {}) {
    const left = createSecureChannel({ localIdentity: leftIdentity, peerIdentity: rightIdentity, localTrust: leftTrust, transport, relay, now, sessionId });
    const right = createSecureChannel({ localIdentity: rightIdentity, peerIdentity: leftIdentity, localTrust: rightTrust, transport, relay, now, sessionId });
    left.connect(right); right.connect(left);
    if (relay) { relay.register(left.deviceId, left); relay.register(right.deviceId, right); }
    return { left, right, relay, sessionId };
}

export function createSecureWorkerComputerClient(channel) {
    if (!channel?.request) throw new Error("secure Worker Computer client requires a channel");
    return Object.freeze({
        async computerHealth() { return channel.request({ kind: "computer.health" }); },
        async computerAction(envelope) { return channel.request({ kind: "computer.action", envelope: validateComputerEnvelope(envelope) }); },
    });
}

export function attachSecureWorkerComputerServer(channel, { computerHealth, computerAction } = {}) {
    if (!channel?.setRequestHandler || typeof computerHealth !== "function" || typeof computerAction !== "function") throw new Error("secure Worker Computer server requires bounded handlers");
    channel.setRequestHandler(async (payload) => {
        exactKeys(payload, new Set(["kind", "envelope", "type"]), "secure Worker payload");
        if (payload.kind === "computer.health") return computerHealth();
        if (payload.kind === "computer.action") return computerAction(validateComputerEnvelope(payload.envelope));
        throw new Error("secure Worker payload kind is not supported");
    });
    return channel;
}

export function createSecureExternalControlClient(channel) {
    if (!channel?.request) throw new Error("secure external control client requires a channel");
    const call = (operation, input = {}) => channel.request({ kind: "control.call", operation, input });
    return Object.freeze({
        listTeams: () => call("listTeams"),
        listCoworkers: () => call("listCoworkers"),
        listChannels: (input = {}) => call("listChannels", input),
        sendMessage: (input) => call("sendMessage", input),
        getConversation: (input) => call("getConversation", input),
        submitOutcome: (input) => call("submitOutcome", input),
        getStatus: (input) => call("getStatus", input),
        cancel: (input) => call("cancel", input),
        getArtifacts: (input) => call("getArtifacts", input),
        listSkills: (input = {}) => call("listSkills", input),
        listRoutines: () => call("listRoutines"),
        runRoutineNow: (input) => call("runRoutineNow", input),
        getAttention: () => call("getAttention"),
        requestTakeover: (input) => call("requestTakeover", input),
    });
}

export function createSecureRemoteControllerClient(channel) {
    if (!channel?.request) throw new Error("secure remote controller client requires a channel");
    const call = (operation, input = {}) => channel.request({ kind: "control.call", controlVersion: 2, operation, input });
    return Object.freeze({
        listTeams: () => channel.request({ kind: "control.call", operation: "listTeams", input: {} }),
        listCoworkers: () => channel.request({ kind: "control.call", operation: "listCoworkers", input: {} }),
        listChannels: (input = {}) => channel.request({ kind: "control.call", operation: "listChannels", input }),
        sendMessage: (input) => channel.request({ kind: "control.call", operation: "sendMessage", input }),
        getConversation: (input) => channel.request({ kind: "control.call", operation: "getConversation", input }),
        submitOutcome: (input) => channel.request({ kind: "control.call", operation: "submitOutcome", input }),
        getStatus: (input) => channel.request({ kind: "control.call", operation: "getStatus", input }),
        cancel: (input) => channel.request({ kind: "control.call", operation: "cancel", input }),
        getArtifacts: (input) => channel.request({ kind: "control.call", operation: "getArtifacts", input }),
        listSkills: (input = {}) => channel.request({ kind: "control.call", operation: "listSkills", input }),
        listRoutines: () => channel.request({ kind: "control.call", operation: "listRoutines", input: {} }),
        runRoutineNow: (input) => channel.request({ kind: "control.call", operation: "runRoutineNow", input }),
        getAttention: () => channel.request({ kind: "control.call", operation: "getAttention", input: {} }),
        requestTakeover: (input) => channel.request({ kind: "control.call", operation: "requestTakeover", input }),
        approveAttention: (input) => call("approveAttention", input),
        denyAttention: (input) => call("denyAttention", input),
        computerView: (input) => call("computerView", input),
        releaseTakeover: (input) => call("releaseTakeover", input),
    });
}

export function attachSecureExternalControlServer(channel, { invoke } = {}) {
    if (!channel?.setRequestHandler || typeof invoke !== "function") throw new Error("secure external control server requires a bounded invoker");
    channel.setRequestHandler(async (payload) => {
        exactKeys(payload, new Set(["kind", "controlVersion", "operation", "input"]), "secure external control payload");
        const version = payload.controlVersion === undefined ? 1 : payload.controlVersion;
        const operations = version === 2 ? [...EXTERNAL_CONTROL_OPERATIONS, ...EXTERNAL_CONTROL_V2_OPERATIONS] : EXTERNAL_CONTROL_OPERATIONS;
        if (payload.kind !== "control.call" || !operations.includes(payload.operation)) throw new Error("secure external control operation is not supported");
        object(payload.input, "secure external control input");
        return invoke(payload.operation, structuredClone(payload.input), { deviceId: channel.peerDeviceId, transport: channel.transport, controlVersion: version });
    });
    return channel;
}
