import assert from "node:assert/strict";
import test from "node:test";
import { IPC_CHANNELS, validateIpcRequest } from "../src/main/lib/ipc-schema.js";

test("ipc surface is enumerated and contains no generic channel escape hatch", () => {
    const names = Object.keys(IPC_CHANNELS);
    assert.ok(names.includes("app:handshake"));
    assert.ok(names.includes("operator:getOverview"));
    assert.ok(names.includes("computer:supplySecret"));
    for (const name of names) {
        assert.match(name, /^[a-z]+:[A-Za-z-]+$/, name);
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

test("authority-bearing fields are rejected in any operator request payload", () => {
    for (const field of ["actorId", "actor", "harnessState", "sessionId", "bearerToken", "capability"]) {
        const payload = field === "actorId"
            ? { agentId: "worker", action: "take", [field]: "spoofed" }
            : JSON.parse(`{"agentId":"worker","action":"take","${field}":"x"}`);
        assert.throws(
            () => validateIpcRequest("computer:control", payload),
            /not accepted from the renderer/,
            field,
        );
    }
});

test("operator read and mutate schemas enforce shapes and bounds", () => {
    // audit limit clamps to declared range
    assert.deepEqual(validateIpcRequest("operator:getAudit", { limit: 25 }), { limit: 25 });
    assert.throws(() => validateIpcRequest("operator:getAudit", { limit: 100_000 }), /between 1 and 500/);

    // identifiers are strict
    assert.deepEqual(validateIpcRequest("operator:getTaskGraph", { taskId: "task-abc.1" }), { taskId: "task-abc.1" });
    assert.throws(() => validateIpcRequest("operator:getTaskGraph", { taskId: "../escape" }), /must be an identifier/);
    assert.throws(() => validateIpcRequest("operator:getTaskGraph", {}), /missing request field/);

    // unexpected extra fields rejected even when individually valid
    assert.throws(
        () => validateIpcRequest("operator:searchMemory", { query: "x", surprise: 1 }),
        /unexpected request field/,
    );

    // enums
    assert.deepEqual(validateIpcRequest("computer:lifecycle", { agentId: "worker", action: "reset" }), { agentId: "worker", action: "reset" });
    assert.throws(() => validateIpcRequest("computer:lifecycle", { agentId: "worker", action: "format" }), /must be one of/);
});

test("secret supply binds to a pending request id with bounded plaintext", () => {
    const valid = { agentId: "worker", requestId: "secr_1", value: "p@ss".repeat(10) };
    assert.deepEqual(validateIpcRequest("computer:supplySecret", valid), valid);
    assert.throws(() => validateIpcRequest("computer:supplySecret", { agentId: "worker", requestId: "secr_1" }), /missing request field/);
    assert.throws(
        () => validateIpcRequest("computer:supplySecret", { agentId: "worker", requestId: "secr_1", value: "x".repeat(10_001) }),
        /exceeds 10000 characters/,
    );
});
