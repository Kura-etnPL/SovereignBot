// Enumerated IPC surface shared by the main process, the sandboxed preload, and tests.
//
// Rules enforced everywhere:
//  - only channels declared here may be registered or invoked;
//  - payloads are validated by exact-shape validators with size caps;
//  - there is deliberately no generic (channel, payload) escape hatch.

export const IPC_CHANNELS = Object.freeze({
    "app:handshake": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: validateHandshakeRequest,
        describeResponse: "() => { ok:true, version:string, platform:string, locale:string }",
    }),
});

function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value) {
    return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function validateHandshakeRequest(payload) {
    if (payload === undefined || payload === null)
        return {};
    if (!isPlainObject(payload))
        throw new Error("handshake payload must be an object");
    if (Object.keys(payload).length !== 0)
        throw new Error("handshake payload must be empty");
    return {};
}

export function validateIpcRequest(channel, payload) {
    const entry = IPC_CHANNELS[channel];
    if (!entry)
        throw new Error(`unknown ipc channel: ${String(channel).slice(0, 64)}`);
    if (byteLength(payload) > entry.maxPayloadBytes)
        throw new Error(`ipc payload exceeds ${entry.maxPayloadBytes} bytes`);
    return entry.validateRequest(payload);
}
