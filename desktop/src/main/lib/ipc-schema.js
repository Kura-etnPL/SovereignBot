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
    "goal:submit": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 16 * 1024,
        validateRequest: (payload) => {
            if (!isPlainObject(payload))
                throw new Error("request payload must be an object");
            assertNoForbiddenKeys(payload);
            if (typeof payload.text !== "string" || !payload.text.trim())
                throw new Error("missing request field: text");
            if (payload.text.length > 8000)
                throw new Error("text exceeds 8000 characters");
            const out = { text: payload.text };
            if (payload.workspaceId !== undefined) {
                out.workspaceId = idField()(payload.workspaceId, "workspaceId");
            }
            return out;
        },
    }),
    "goal:list": emptyRequest(),
    "goal:getStatus": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: requiredFields({
            goalId: idField(),
        }, 1024),
    }),
    "goal:getConversation": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: requiredFields({
            goalId: idField(),
        }, 1024),
    }),
    "goal:cancel": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: requiredFields({
            goalId: idField(),
        }, 1024),
    }),
    "job:submit": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 16 * 1024,
        validateRequest: (payload) => {
            if (!isPlainObject(payload)) throw new Error("request payload must be an object");
            assertNoForbiddenKeys(payload);
            if (typeof payload.title !== "string" || !payload.title.trim()) throw new Error("missing request field: title");
            if (payload.title.length > 120) throw new Error("title exceeds 120 characters");
            if (typeof payload.objective !== "string" || !payload.objective.trim()) throw new Error("missing request field: objective");
            if (payload.objective.length > 8000) throw new Error("objective exceeds 8000 characters");
            if (typeof payload.ownerCoworkerId !== "string" || !payload.ownerCoworkerId.trim()) throw new Error("missing request field: ownerCoworkerId");
            const out = { title: payload.title, objective: payload.objective, ownerCoworkerId: idField()(payload.ownerCoworkerId, "ownerCoworkerId") };
            if (payload.parentJobId !== undefined) out.parentJobId = idField()(payload.parentJobId, "parentJobId");
            if (payload.priority !== undefined) out.priority = enumField(["low", "normal", "high"])(payload.priority, "priority");
            if (payload.nextActionAt !== undefined) out.nextActionAt = stringField(64)(payload.nextActionAt, "nextActionAt");
            return out;
        },
    }),
    "job:list": emptyRequest(),
    "job:getStatus": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: requiredFields({ jobId: idField() }, 1024),
    }),
    "job:getConversation": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: requiredFields({ jobId: idField() }, 1024),
    }),
    "job:cancel": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: requiredFields({ jobId: idField() }, 1024),
    }),
    "job:pause": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: requiredFields({ jobId: idField() }, 1024),
    }),
    "job:resume": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: requiredFields({ jobId: idField() }, 1024),
    }),
    "job:approve": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: requiredFields({ jobId: idField() }, 1024),
    }),
    "job:dismiss": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: requiredFields({ jobId: idField() }, 1024),
    }),
    "job:attention": emptyRequest(),
    "settings:get": emptyRequest(),
    "provider:getRoster": emptyRequest(),
    "provider:refresh": emptyRequest(),
    "provider:openLogin": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: requiredFields({
            provider: enumField(["codex", "claude"]),
        }, 1024),
    }),
    "provider:setRoleAssignment": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 1024,
        validateRequest: requiredFields({
            role: enumField(["planner", "worker", "reviewer", "synthesizer"]),
            agentId: idField(),
        }, 1024),
    }),
    "settings:update": Object.freeze({
        direction: "renderer->main",
        maxPayloadBytes: 4096,
        validateRequest: (payload) => {
            if (!isPlainObject(payload) || Object.keys(payload).length === 0)
                throw new Error("settings update payload must be a non-empty object");
            assertNoForbiddenKeys(payload);
            const allowed = new Set(["theme", "closeBehavior", "notifications", "demoMode", "language", "providers", "roles"]);
            for (const key of Object.keys(payload)) {
                if (!allowed.has(key))
                    throw new Error(`unexpected settings field: ${key.slice(0, 40)}`);
            }
            if (payload.providers !== undefined)
                validateProvidersShape(payload.providers);
            if (payload.roles !== undefined)
                validateRolesShape(payload.roles);
            return payload;
        },
    }),
});

function validateProvidersShape(value) {
    if (!isPlainObject(value) || Object.keys(value).length === 0)
        throw new Error("providers must be a non-empty object");
    for (const [provider, entry] of Object.entries(value)) {
        if (!["codex", "claude"].includes(provider))
            throw new Error(`unknown provider: ${String(provider).slice(0, 20)}`);
        if (!isPlainObject(entry))
            throw new Error(`${provider} settings must be an object`);
        if (entry.enabled !== undefined && typeof entry.enabled !== "boolean")
            throw new Error(`${provider}.enabled must be a boolean`);
    }
}

function validateRolesShape(value) {
    if (!isPlainObject(value) || Object.keys(value).length === 0)
        throw new Error("roles must be a non-empty object");
    const identifier = idField();
    for (const [role, agentId] of Object.entries(value)) {
        if (!["planner", "worker", "reviewer", "synthesizer"].includes(role))
            throw new Error(`unknown role: ${String(role).slice(0, 20)}`);
        if (agentId !== null)
            identifier(agentId, role);
    }
}

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
