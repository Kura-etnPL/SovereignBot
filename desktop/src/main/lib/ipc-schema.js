// Enumerated IPC surface shared by the main process, the sandboxed preload, and tests.
//
// Rules enforced everywhere:
//   - only channels declared here may be registered or invoked;
//   - payloads are validated by exact-shape validators with size caps;
//   - authority-bearing key names are rejected outright: the operator principal is fixed by
//     the main process when it builds the facade, so any payload that even suggests an actor
//     or smuggles continuity/credential material is refused before business logic runs;
//   - there is deliberately no generic (channel, payload) escape hatch.

export const IPC_CHANNELS = Object.freeze({
    "app:handshake": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: validateHandshakeRequest,
    }),
    "operator:getOverview": emptyRequest(),
    "operator:getWorkers": emptyRequest(),
    "operator:getAudit": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: optionalFields({
            limit: integerField(1, 500),
        }),
    }),
    "operator:searchMemory": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 2048,
        validateRequest: optionalFields({
            scope: stringField(120),
            query: stringField(300),
        }),
    }),
    "operator:getPolicy": emptyRequest(),
    "operator:getPolicyVersion": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 2048,
        validateRequest: requiredFields({
            versionId: stringField(200),
        }, 2048),
    }),
    "operator:validatePolicy": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 256 * 1024,
        validateRequest: requiredFields({
            policy: plainObjectField(),
        }, 256 * 1024),
    }),
    "operator:dryRunPolicy": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 256 * 1024,
        validateRequest: optionalFields({
            policy: plainObjectField(),
            action: plainObjectField(),
            repeatCount: integerField(1, 10_000),
        }, 256 * 1024),
    }),
    "operator:applyPolicy": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 512 * 1024,
        validateRequest: (payload) => {
            const base = optionalFields({
                label: stringField(200),
            })(payload);
            if (!isPlainObject(base.policy))
                throw new Error("policy is required");
            if (!Array.isArray(base.checks) || base.checks.length === 0 || base.checks.length > 50)
                throw new Error("checks must be a non-empty array of at most 50 dry-run checks");
            return base;
        },
    }),
    "operator:rollbackPolicy": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 2048,
        validateRequest: requiredFields({
            versionId: stringField(200),
        }, 2048),
    }),
    "operator:getTaskGraph": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 2048,
        validateRequest: requiredFields({
            taskId: idField(),
        }, 2048),
    }),
    "operator:getTaskEvents": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 2048,
        validateRequest: requiredFields({
            taskId: idField(),
        }, 2048),
    }),
    "computer:control": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 2048,
        validateRequest: requiredFields({
            agentId: idField(),
            action: enumField(["take", "release"]),
        }, 2048),
    }),
    "computer:lifecycle": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 2048,
        validateRequest: requiredFields({
            agentId: idField(),
            action: enumField(["start", "stop", "reset"]),
        }, 2048),
    }),
    // Secret plaintext crosses exactly once, bound to the pending secret request id shown by
    // the pending-secret surface; it is never persisted by the bridge.
    "computer:supplySecret": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 32 * 1024,
        validateRequest: requiredFields({
            agentId: idField(),
            requestId: idField(),
            value: stringField(10_000),
        }, 32 * 1024),
    }),
    "computer:browserStatus": emptyRequest(),
    "computer:provisionDriver": emptyRequest(),
    "firstrun:getStatus": emptyRequest(),
    "workspace:addViaDialog": emptyRequest(),
    "workspace:list": emptyRequest(),
    "workspace:setDefault": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: requiredFields({
            id: idField(),
        }, 1024),
    }),
    "workspace:remove": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: requiredFields({
            id: idField(),
        }, 1024),
    }),
    "settings:get": emptyRequest(),
    "settings:update": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 2048,
        validateRequest: (payload) => {
            if (!isPlainObject(payload) || Object.keys(payload).length === 0)
                throw new Error("settings update payload must be a non-empty object");
            assertNoForbiddenKeys(payload);
            const allowed = new Set(["theme", "closeBehavior", "notifications"]);
            for (const key of Object.keys(payload)) {
                if (!allowed.has(key))
                    throw new Error(`unexpected settings field: ${key.slice(0, 40)}`);
            }
            return payload;
        },
    }),
});

// Any request carrying these key names is rejected regardless of channel. They name
// authority or continuity concepts the renderer must never influence.
const FORBIDDEN_KEYS = Object.freeze([
    "actor",
    "owneragentid",
    "assignedagentid",
    "harnessstate",
    "sessionid",
    "bearer",
    "token",
    "capability",
    "password",
    "env",
    "cwd",
    "command",
]);

function assertNoForbiddenKeys(payload) {
    if (!isPlainObject(payload))
        return;
    for (const key of Object.keys(payload)) {
        const squeezed = key.replaceAll("-", "").replaceAll("_", "").toLowerCase();
        if (FORBIDDEN_KEYS.some((forbidden) => squeezed.includes(forbidden))) {
            throw new Error(`ipc payload field is not accepted from the renderer: ${key.slice(0, 40)}`);
        }
    }
}

function emptyRequest() {
    return Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: validateHandshakeRequest,
    });
}

function optionalFields(fields, maxPayloadBytes = 4096) {
    return (payload) => {
        if (payload === undefined || payload === null)
            return {};
        if (!isPlainObject(payload))
            throw new Error("request payload must be an object");
        assertNoForbiddenKeys(payload);
        const out = {};
        for (const [name, validate] of Object.entries(fields)) {
            if (payload[name] !== undefined)
                out[name] = validate(payload[name], name);
        }
        const known = new Set(Object.keys(fields));
        for (const key of Object.keys(payload)) {
            if (!known.has(key))
                throw new Error(`unexpected request field: ${key.slice(0, 40)}`);
        }
        void maxPayloadBytes;
        return out;
    };
}

function requiredFields(fields, maxPayloadBytes) {
    return (payload) => {
        if (!isPlainObject(payload))
            throw new Error("request payload must be an object");
        assertNoForbiddenKeys(payload);
        const out = {};
        for (const [name, validate] of Object.entries(fields)) {
            if (payload[name] === undefined)
                throw new Error(`missing request field: ${name}`);
            out[name] = validate(payload[name], name);
        }
        const known = new Set(Object.keys(fields));
        for (const key of Object.keys(payload)) {
            if (!known.has(key))
                throw new Error(`unexpected request field: ${key.slice(0, 40)}`);
        }
        void maxPayloadBytes;
        return out;
    };
}

function stringField(maxLength) {
    return (value, name) => {
        if (typeof value !== "string")
            throw new Error(`${name} must be a string`);
        if (value.length > maxLength)
            throw new Error(`${name} exceeds ${maxLength} characters`);
        return value;
    };
}

function idField() {
    return (value, name) => {
        if (typeof value !== "string" || !/^[\w][\w.-]{0,119}$/.test(value))
            throw new Error(`${name} must be an identifier`);
        return value;
    };
}

function integerField(min, max) {
    return (value, name) => {
        if (!Number.isInteger(value) || value < min || value > max)
            throw new Error(`${name} must be an integer between ${min} and ${max}`);
        return value;
    };
}

function enumField(values) {
    return (value, name) => {
        if (!values.includes(value))
            throw new Error(`${name} must be one of: ${values.join(", ")}`);
        return value;
    };
}

function plainObjectField() {
    return (value, name) => {
        if (!isPlainObject(value))
            throw new Error(`${name} must be an object`);
        return value;
    };
}

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
