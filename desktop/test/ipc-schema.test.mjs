import assert from "node:assert/strict";
import test from "node:test";
import { IPC_CHANNELS, validateIpcRequest } from "../src/main/lib/ipc-schema.js";

test("ipc surface is enumerated and contains no generic channel escape hatch", () => {
    const names = Object.keys(IPC_CHANNELS);
    assert.ok(names.includes("app:handshake"));
    for (const name of names) {
        assert.match(name, /^[a-z]+:[a-z-]+$/, name);
        assert.equal(typeof IPC_CHANNELS[name].validateRequest, "function");
        assert.equal(typeof IPC_CHANNELS[name].maxPayloadBytes, "number");
    }
});

test("handshake requests accept empty payloads only", () => {
    assert.deepEqual(validateIpcRequest("app:handshake", undefined), {});
    assert.deepEqual(validateIpcRequest("app:handshake", {}), {});
    assert.throws(() => validateIpcRequest("app:handshake", { actorId: "operator" }), /must be empty/);
    assert.throws(() => validateIpcRequest("app:handshake", [1, 2]), /must be an object/);
    assert.throws(() => validateIpcRequest("app:handshake", "x"), /must be an object/);
});

test("unknown or oversized payloads and channels are rejected fail-closed", () => {
    assert.throws(() => validateIpcRequest("nope:not-a-channel", {}), /unknown ipc channel/);
    assert.throws(
        () => validateIpcRequest("app:handshake", JSON.parse(`{"pad":"${"x".repeat(4096)}"}`)),
        /exceeds|empty/,
    );
});
