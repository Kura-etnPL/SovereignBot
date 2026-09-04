import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
    attachSecureWorkerComputerServer,
    createOpaqueRelay,
    createSecureChannelPair,
    createSecureWorkerComputerClient,
    validateSecureFrame,
} from "../src/worker-secure-transport.js";
import { createWorkerTrustStore } from "../src/worker-trust-store.js";

const WORKSPACE = "workspace_0000000000000001";
const COMPUTER = "computer_0000000000000001";
const JOB = "job_0000000000000001";
const OWNER = "coworker_0000000000000001";

function root(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }

function pairedStores(clock = () => Date.now()) {
    const a = createWorkerTrustStore({ dataDir: root("sovereign-secure-a-"), name: "LAN Windows", platform: "win32", now: clock });
    const b = createWorkerTrustStore({ dataDir: root("sovereign-secure-b-"), name: "LAN Linux", platform: "linux", now: clock });
    const offer = a.beginPairing({ transport: "remote-relay", ttlMs: 60_000, trustTtlMs: 60_000 });
    const response = b.acceptPairing(offer, offer.code, { trustTtlMs: 60_000 });
    a.completePairing(offer, response);
    return { a, b, offer, cleanup: () => { const aDir = dirname(a.paths.identityPath); const bDir = dirname(b.paths.identityPath); rmSync(aDir, { recursive: true, force: true }); rmSync(bDir, { recursive: true, force: true }); } };
}

function channel(stores, relay = createOpaqueRelay(), clock = () => Date.now(), transport = stores.a.list().peers[0]?.transport ?? "remote-relay") {
    const pair = createSecureChannelPair({ leftIdentity: stores.a.identity(), rightIdentity: stores.b.identity(), leftTrust: stores.a.getPeer(stores.b.identity().deviceId), rightTrust: stores.b.getPeer(stores.a.identity().deviceId), transport, relay, now: clock });
    attachSecureWorkerComputerServer(pair.right, {
        computerHealth: async () => ({ protocol: "sovereign-worker-computer/1", computer: { id: COMPUTER, state: "online", capacity: 1, currentLoad: 0, capabilities: ["snapshot", "type"] } }),
        computerAction: async (envelope) => ({ protocol: "sovereign-worker-computer/1", requestId: envelope.requestId, status: "completed", summary: "bounded action completed", result: { operation: envelope.operation } }),
    });
    return { ...pair, client: createSecureWorkerComputerClient(pair.left) };
}

test("LAN Windows/Linux pairing is mutual, one-time, durable, and key-epoch aware", async () => {
    const stores = pairedStores();
    try {
        assert.equal(stores.a.list().peers[0].status, "trusted");
        assert.equal(stores.b.list().peers[0].platform, "win32");
        assert.throws(() => stores.b.acceptPairing(stores.offer, stores.offer.code), /consumed|already/i);
        const c = channel(stores);
        assert.deepEqual((await c.client.computerHealth()).computer.id, COMPUTER);
        const envelope = { protocol: "sovereign-worker-computer/1", requestId: "computer_request_0000000000000001", jobId: JOB, ownerCoworkerId: OWNER, workspaceId: WORKSPACE, computerId: COMPUTER, operation: "snapshot", input: {}, attempt: 0, createdAt: "2026-09-02T00:00:00.000Z" };
        assert.equal((await c.client.computerAction(envelope)).requestId, envelope.requestId);
        assert.deepEqual(stores.a.list().peers[0].transport, "remote-relay");
    } finally { stores.cleanup(); }
});

test("remote relay only forwards opaque ciphertext and rejects tamper, replay, wrong identity, and downgrade", async () => {
    const stores = pairedStores();
    try {
        const relay = createOpaqueRelay();
        const c = channel(stores, relay);
        await c.client.computerHealth();
        const frames = relay.inspect();
        assert.ok(frames.length >= 2);
        assert.equal(JSON.stringify(frames).includes(WORKSPACE), false);
        assert.equal(JSON.stringify(frames).includes("computer.action"), false);
        assert.equal(JSON.stringify(frames).includes("/home/"), false);
        assert.throws(() => validateSecureFrame({ ...frames[0], version: 0 }), /downgrade|mismatch/i);
        await assert.rejects(() => relay.forward({ ...frames[0], ciphertext: `${frames[0].ciphertext.slice(0, -1)}A` }), /identity|replay|authentication|signature/i);
        await assert.rejects(() => relay.forward(frames[0]), /replay|sequence/i);
        await assert.rejects(() => relay.forward({ ...frames[0], senderDeviceId: "device_ffffffffffffffff" }), /identity|recipient|signature/i);
    } finally { stores.cleanup(); }
});

test("expiry and explicit revoke fail closed; re-pair after key rotation restores only the new epoch", async () => {
    let clock = Date.parse("2026-09-02T00:00:00.000Z");
    const stores = pairedStores(() => clock);
    try {
        stores.a.revoke(stores.b.identity().deviceId);
        assert.throws(() => channel(stores), /revoked/i);
    } finally { stores.cleanup(); }

    clock = Date.parse("2026-09-02T00:00:00.000Z");
    const a = createWorkerTrustStore({ dataDir: root("sovereign-secure-rotate-a-"), name: "LAN Windows", platform: "win32", now: () => clock });
    const b = createWorkerTrustStore({ dataDir: root("sovereign-secure-rotate-b-"), name: "LAN Linux", platform: "linux", now: () => clock });
    try {
        let offer = a.beginPairing({ transport: "lan", ttlMs: 60_000, trustTtlMs: 1_000 });
        let response = b.acceptPairing(offer, offer.code, { trustTtlMs: 1_000 });
        a.completePairing(offer, response);
        clock += 2_000;
        assert.throws(() => channel({ a, b }, createOpaqueRelay(), () => clock), /expired/i);
        b.rotateIdentity();
        a.beginRotation(b.identity().deviceId);
        clock -= 2_000;
        offer = a.beginPairing({ transport: "lan", ttlMs: 60_000, trustTtlMs: 60_000 });
        response = b.acceptPairing(offer, offer.code, { trustTtlMs: 60_000 });
        a.completePairing(offer, response);
        const c = channel({ a, b }, createOpaqueRelay(), () => clock);
        assert.equal((await c.client.computerHealth()).computer.id, COMPUTER);
        assert.ok(b.identity().keyEpoch > 1);
    } finally { rmSync(a.paths.identityPath, { force: true }); rmSync(a.paths.statePath, { force: true }); rmSync(b.paths.identityPath, { force: true }); rmSync(b.paths.statePath, { force: true }); }
});
