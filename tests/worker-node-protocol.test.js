import assert from "node:assert/strict";
import test from "node:test";
import {
    WORKER_NODE_PROTOCOL,
    canonicalJson,
    constantTimeTokenEqual,
    dispatchBodyHash,
    validateDispatchPayload,
    validateLoopbackEndpoint,
    validatePairingBundle,
} from "../src/worker-node-protocol.js";

const token = "a".repeat(43);
const bundle = {
    protocol: WORKER_NODE_PROTOCOL,
    nodeId: "worker_0123456789abcdef",
    name: "Test node",
    endpoint: "http://127.0.0.1:7342",
    token,
};
const dispatch = {
    protocol: WORKER_NODE_PROTOCOL,
    requestId: "worker_request_0123456789abcdef",
    jobId: "job_0123456789abcdef",
    title: "Bounded title",
    instruction: "Do the bounded work",
    workspaceId: "ws_main",
    requiredCapabilities: ["general"],
    attempt: 0,
    createdAt: "2026-08-30T00:00:00.000Z",
};

test("Worker Node endpoints and pairing bundles are strict loopback contracts", () => {
    assert.equal(validateLoopbackEndpoint(bundle.endpoint), bundle.endpoint);
    assert.equal(validateLoopbackEndpoint("http://[::1]:7342"), "http://[::1]:7342");
    for (const endpoint of [
        "http://0.0.0.0:7342",
        "http://192.168.1.4:7342",
        "https://127.0.0.1:7342",
        "http://127.0.0.1:7342/path",
        "http://127.0.0.1:7342?token=x",
        "http://user:pass@127.0.0.1:7342",
    ]) assert.throws(() => validateLoopbackEndpoint(endpoint));
    assert.deepEqual(validatePairingBundle(bundle), bundle);
    assert.throws(() => validatePairingBundle({ ...bundle, extra: true }), /unknown field/);
    assert.throws(() => validatePairingBundle({ ...bundle, token: "short" }), /invalid format/);
});
test("dispatch is exact, bounded, canonical and rejects authority material", () => {
    assert.deepEqual(validateDispatchPayload(dispatch), dispatch);
    assert.equal(dispatchBodyHash(dispatch), dispatchBodyHash({ ...dispatch, title: dispatch.title }));
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    for (const field of ["cwd", "path", "absolutePath", "command", "args", "env", "token", "credential", "secret", "provider", "providerSession", "sessionId", "browser", "computer", "policy", "grant", "url"]) {
        assert.throws(() => validateDispatchPayload({ ...dispatch, [field]: "forbidden" }), /unknown field/);
    }
    assert.throws(() => validateDispatchPayload({ ...dispatch, instruction: "x".repeat(20_001) }), /exceeds/);
    assert.throws(() => validateDispatchPayload({ ...dispatch, requiredCapabilities: ["general", "general"] }), /duplicates/);
    assert.throws(() => validateDispatchPayload({ ...dispatch, attempt: -1 }), /non-negative/);
});

test("token comparison does not coerce or expose credentials", () => {
    assert.equal(constantTimeTokenEqual(token, token), true);
    assert.equal(constantTimeTokenEqual(token, `${token}x`), false);
    assert.equal(constantTimeTokenEqual(token, undefined), false);
});
