// V3 Coworker OS IPC additions. Kept separate from the stable v1.x schema while the V3
// product surface is moving quickly, but bound through the same sender-validated IPC layer.
// Messages/coworker/artifact metadata are data only: renderer payloads cannot carry
// execution authority, provider continuity or secrets.

const FORBIDDEN = [
    "actor", "owneragentid", "assignedagentid", "harnessstate", "sessionid", "bearer",
    "token", "capability", "password", "secret", "apikey", "env", "cwd", "command",
    "executable", "prefixargs", "policy", "governedtools", "allowprivatehosts",
];

function isPlainObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function assertNoAuthority(value, path = "payload") {
    if (Array.isArray(value)) { value.forEach((entry, index) => assertNoAuthority(entry, `${path}[${index}]`)); return; }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
        const squeezed = key.replaceAll(/[-_\s]/g, "").toLowerCase();
        if (FORBIDDEN.some((forbidden) => squeezed.includes(forbidden))) throw new Error(`ipc payload field is not accepted from the renderer: ${path}.${key}`);
        assertNoAuthority(child, `${path}.${key}`);
    }
}
function bytes(value) { return Buffer.byteLength(JSON.stringify(value ?? null), "utf8"); }
function objectPayload(payload) { if (!isPlainObject(payload)) throw new Error("request payload must be an object"); assertNoAuthority(payload); return payload; }
function empty(payload) { if (payload === undefined || payload === null) return {}; const value = objectPayload(payload); if (Object.keys(value).length) throw new Error("request payload must be empty"); return {}; }
function identifier(value, name) { if (typeof value !== "string" || !/^[A-Za-z0-9][\w:.-]{0,127}$/.test(value)) throw new Error(`${name} must be an identifier`); return value; }
function string(value, name, max, required = false) { if (value === undefined || value === null) { if (required) throw new Error(`missing request field: ${name}`); return undefined; } if (typeof value !== "string") throw new Error(`${name} must be a string`); if (value.length > max) throw new Error(`${name} exceeds ${max} characters`); if (required && !value.trim()) throw new Error(`${name} is required`); return value; }
function idArray(value, name, max) { if (value === undefined) return undefined; if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must be an array of at most ${max} identifiers`); return [...new Set(value.map((entry) => identifier(entry, name)))]; }
function exact(value, allowed) { for (const key of Object.keys(value)) { if (!allowed.has(key)) throw new Error(`unexpected request field: ${key}`); } }
function positiveInteger(value, name, min, max) { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`); return value; }
function modelBindingShape(value) {
    if (!isPlainObject(value)) throw new Error("modelBinding must be an object");
    exact(value, new Set(["profile", "provider", "providerAccountId", "model"]));
    if (![
        "automatic", "efficient", "deep", "economy", "custom",
    ].includes(value.profile ?? "automatic")) throw new Error("modelBinding.profile is invalid");
    if (value.provider !== undefined && !["codex", "claude", "antigravity", "chatgpt-web"].includes(value.provider))
        throw new Error("modelBinding.provider is invalid");
    for (const [key, child] of [["providerAccountId", value.providerAccountId], ["model", value.model]]) {
        if (child !== undefined && (typeof child !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(child)))
            throw new Error(`modelBinding.${key} must be a safe opaque identifier`);
    }
    if ((value.profile ?? "automatic") === "custom" && (!value.provider || !value.model))
        throw new Error("custom modelBinding requires provider and model");
    return structuredClone(value);
}

function coworkerShape(value, { patch = false } = {}) {
    if (!isPlainObject(value)) throw new Error(patch ? "patch must be an object" : "coworker must be an object");
    assertNoAuthority(value, patch ? "patch" : "coworker");
    const allowed = new Set(["name", "role", "instructions", "avatar", "providerPreference", "modelBinding", "skillIds", "workspaceIds", "approvalProfileId", "computerProfileId", "computerMode", "state"]);
    exact(value, allowed);
    if (!patch) { string(value.name, "name", 80, true); string(value.role, "role", 120, true); }
    else if (Object.keys(value).length === 0) throw new Error("coworker patch must not be empty");
    if (value.name !== undefined) string(value.name, "name", 80, true);
    if (value.role !== undefined) string(value.role, "role", 120, true);
    if (value.instructions !== undefined) string(value.instructions, "instructions", 12_000);
    if (value.avatar !== undefined) string(value.avatar, "avatar", 120);
    if (value.providerPreference !== undefined && !["auto", "codex", "claude"].includes(value.providerPreference)) throw new Error("providerPreference must be auto, codex, or claude");
    if (value.modelBinding !== undefined) modelBindingShape(value.modelBinding);
    idArray(value.skillIds, "skillIds", 64);
    idArray(value.workspaceIds, "workspaceIds", 64);
    if (value.approvalProfileId !== undefined) string(value.approvalProfileId, "approvalProfileId", 128);
    if (value.computerProfileId !== undefined) string(value.computerProfileId, "computerProfileId", 128);
    if (value.computerMode !== undefined && !["shared-login", "private-profile"].includes(value.computerMode)) throw new Error("computerMode must be shared-login or private-profile");
    if (value.state !== undefined && !["active", "paused", "archived"].includes(value.state)) throw new Error("state must be active, paused, or archived");
    return structuredClone(value);
}
function spec(maxPayloadBytes, validateRequest) { return Object.freeze({ direction: "renderer->main", maxPayloadBytes, validateRequest }); }

export const V3_IPC_CHANNELS = Object.freeze({
    "coworker:list": spec(1024, (payload) => { if (payload === undefined || payload === null) return { includeArchived: false }; const value = objectPayload(payload); exact(value, new Set(["includeArchived"])); if (value.includeArchived !== undefined && typeof value.includeArchived !== "boolean") throw new Error("includeArchived must be boolean"); return { includeArchived: value.includeArchived === true }; }),
    "coworker:get": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["coworkerId"])); return { coworkerId: identifier(value.coworkerId, "coworkerId") }; }),
    "coworker:create": spec(24 * 1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["coworker"])); return { coworker: coworkerShape(value.coworker) }; }),
    "coworker:update": spec(24 * 1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["coworkerId", "patch"])); return { coworkerId: identifier(value.coworkerId, "coworkerId"), patch: coworkerShape(value.patch, { patch: true }) }; }),
    "coworker:archive": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["coworkerId"])); return { coworkerId: identifier(value.coworkerId, "coworkerId") }; }),
    "coworker:restore": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["coworkerId"])); return { coworkerId: identifier(value.coworkerId, "coworkerId") }; }),
    "conversation:list": spec(1024, empty),
    "conversation:get": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["conversationId"])); return { conversationId: identifier(value.conversationId, "conversationId") }; }),
    "conversation:createDirect": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["coworkerId"])); return { coworkerId: identifier(value.coworkerId, "coworkerId") }; }),
    "conversation:createTeam": spec(4096, (payload) => {
        const value = objectPayload(payload);
        exact(value, new Set(["title", "coworkerIds", "leadCoworkerId"]));
        const coworkerIds = idArray(value.coworkerIds, "coworkerIds", 7);
        if (!coworkerIds || coworkerIds.length < 2) throw new Error("team conversation requires at least two coworkerIds");
        const leadCoworkerId = value.leadCoworkerId === undefined ? undefined : identifier(value.leadCoworkerId, "leadCoworkerId");
        if (leadCoworkerId && !coworkerIds.includes(leadCoworkerId)) throw new Error("leadCoworkerId must be a team member");
        return { title: string(value.title, "title", 120), coworkerIds, ...(leadCoworkerId ? { leadCoworkerId } : {}) };
    }),
    "team:list": spec(1024, empty),
    "team:get": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["teamId"])); return { teamId: identifier(value.teamId, "teamId") }; }),
    "team:installPack": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["packId"])); return { packId: identifier(value.packId, "packId") }; }),
    "channel:list": spec(1024, (payload) => { if (payload === undefined || payload === null) return {}; const value = objectPayload(payload); exact(value, new Set(["teamId"])); return value.teamId === undefined ? {} : { teamId: identifier(value.teamId, "teamId") }; }),
    "channel:get": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["channelId"])); return { channelId: identifier(value.channelId, "channelId") }; }),
    "connectedApps:list": spec(1024, empty),
    "connectedApps:assign": spec(2048, (payload) => {
        const value = objectPayload(payload);
        exact(value, new Set(["appId", "teamId", "coworkerId", "enabled"]));
        if ((value.teamId === undefined) === (value.coworkerId === undefined))
            throw new Error("connected app assignment requires exactly one teamId or coworkerId");
        if (typeof value.enabled !== "boolean") throw new Error("enabled must be boolean");
        return {
            appId: identifier(value.appId, "appId"),
            ...(value.teamId !== undefined ? { teamId: identifier(value.teamId, "teamId") } : {}),
            ...(value.coworkerId !== undefined ? { coworkerId: identifier(value.coworkerId, "coworkerId") } : {}),
            enabled: value.enabled,
        };
    }),
    "conversation:send": spec(32 * 1024, (payload) => {
        const value = objectPayload(payload);
        const allowed = new Set(["conversationId", "text", "mentions", "replyTo", "artifactIds", "clientMessageId"]);
        exact(value, allowed);
        const out = { conversationId: identifier(value.conversationId, "conversationId"), text: string(value.text, "text", 12_000, true) };
        if (value.mentions !== undefined) out.mentions = idArray(value.mentions, "mentions", 8);
        if (value.replyTo !== undefined) out.replyTo = identifier(value.replyTo, "replyTo");
        if (value.artifactIds !== undefined) out.artifactIds = idArray(value.artifactIds, "artifactIds", 24);
        if (value.clientMessageId !== undefined) out.clientMessageId = string(value.clientMessageId, "clientMessageId", 128);
        return out;
    }),
    "artifact:list": spec(2048, (payload) => { if (payload === undefined || payload === null) return { limit: 100 }; const value = objectPayload(payload); exact(value, new Set(["conversationId", "coworkerId", "limit"])); const out = {}; if (value.conversationId !== undefined) out.conversationId = identifier(value.conversationId, "conversationId"); if (value.coworkerId !== undefined) out.coworkerId = identifier(value.coworkerId, "coworkerId"); out.limit = value.limit === undefined ? 100 : positiveInteger(value.limit, "limit", 1, 500); return out; }),
    "artifact:get": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["artifactId"])); return { artifactId: identifier(value.artifactId, "artifactId") }; }),
    "artifact:preview": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["artifactId"])); return { artifactId: identifier(value.artifactId, "artifactId") }; }),
    "artifact:reveal": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["artifactId"])); return { artifactId: identifier(value.artifactId, "artifactId") }; }),
});

export function validateV3IpcRequest(channel, payload) {
    const entry = V3_IPC_CHANNELS[channel];
    if (!entry) throw new Error(`unknown V3 ipc channel: ${channel}`);
    if (bytes(payload) > entry.maxPayloadBytes) throw new Error(`ipc payload exceeds ${entry.maxPayloadBytes} bytes`);
    return entry.validateRequest(payload);
}
