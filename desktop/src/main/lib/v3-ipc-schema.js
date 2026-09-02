// V3 Coworker OS IPC additions. Kept separate from the stable v1.x schema while the V3
// product surface is moving quickly, but bound through the same sender-validated IPC layer.
// Messages/coworker/artifact metadata are data only: renderer payloads cannot carry
// execution authority, provider continuity or secrets.

import { validateComputerActionList } from "../../../vendor/core/src/worker-computer-protocol.js";

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
function workerComputerTargetShape(value) {
    const target = objectPayload(value);
    if (["worker-computer", "vm"].includes(target.kind)) {
        exact(target, new Set(["kind", "nodeId", "workspaceId", "computerId"]));
        if (typeof target.nodeId !== "string" || !/^worker_[0-9a-f]{16}$/i.test(target.nodeId)) throw new Error("computerTarget is invalid");
        return { kind: target.kind, nodeId: identifier(target.nodeId, "nodeId"), workspaceId: identifier(target.workspaceId, "workspaceId"), computerId: identifier(target.computerId, "computerId") };
    }
    if (["local-isolated", "cloud"].includes(target.kind)) {
        exact(target, target.kind === "cloud" ? new Set(["kind", "profileId", "workspaceId", "optIn"]) : new Set(["kind", "profileId", "workspaceId"]));
        if (target.kind === "cloud" && typeof target.optIn !== "boolean") throw new Error("computerTarget optIn is invalid");
        return { kind: target.kind, profileId: identifier(target.profileId, "profileId"), workspaceId: identifier(target.workspaceId, "workspaceId"), ...(target.kind === "cloud" ? { optIn: target.optIn } : {}) };
    }
    if (target.kind === "this-pc") {
        exact(target, new Set(["kind", "workspaceId"]));
        return { kind: target.kind, workspaceId: identifier(target.workspaceId, "workspaceId") };
    }
    throw new Error("computerTarget is invalid");
}
function workerComputerActionsShape(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error("computerActions must contain 1-8 actions");
    value.forEach((entry) => { objectPayload(entry); });
    return validateComputerActionList(value);
}
function memoryTarget(value, { withMemoryId = false, withPatch = false, withPinned = false } = {}) {
    const allowed = new Set(["scope", "ownerId", ...(withMemoryId ? ["memoryId"] : []), ...(withPatch ? ["patch"] : []), ...(withPinned ? ["pinned"] : []), ...(withMemoryId ? [] : ["query", "limit", "includeForgotten"]) ]);
    const input = objectPayload(value);
    exact(input, allowed);
    if (!["coworker", "team", "project"].includes(input.scope)) throw new Error("memory scope is invalid");
    const result = { scope: input.scope, ownerId: input.scope === "project" ? projectId(input.ownerId) : identifier(input.ownerId, `${input.scope}Id`) };
    if (withMemoryId) result.memoryId = identifier(input.memoryId, "memoryId");
    if (withPatch) {
        const patch = objectPayload(input.patch);
        exact(patch, new Set(["title", "content", "tags"]));
        if (patch.title !== undefined) string(patch.title, "title", 180, true);
        if (patch.content !== undefined) string(patch.content, "content", 20_000, true);
        if (patch.tags !== undefined) idArray(patch.tags, "tags", 16);
        result.patch = structuredClone(patch);
    } else if (withPinned) {
        if (typeof input.pinned !== "boolean") throw new Error("pinned must be boolean");
        result.pinned = input.pinned;
    } else {
        if (input.query !== undefined) result.query = string(input.query, "query", 300);
        result.limit = input.limit === undefined ? 50 : positiveInteger(input.limit, "limit", 1, 100);
        if (input.includeForgotten !== undefined && typeof input.includeForgotten !== "boolean") throw new Error("includeForgotten must be boolean");
        result.includeForgotten = input.includeForgotten === true;
    }
    return result;
}
function projectId(value) { if (typeof value !== "string" || !/^project_[a-f0-9]{16}$/i.test(value)) throw new Error("projectId must be a Project identifier"); return value; }
function projectTarget(value, { list = false, create = false } = {}) {
    if (list) {
        if (value === undefined || value === null) return {};
        const input = objectPayload(value); exact(input, new Set(["includeArchived", "limit"]));
        if (input.includeArchived !== undefined && typeof input.includeArchived !== "boolean") throw new Error("includeArchived must be boolean");
        return { includeArchived: input.includeArchived === true, ...(input.limit === undefined ? {} : { limit: positiveInteger(input.limit, "limit", 1, 100) }) };
    }
    const input = objectPayload(value);
    if (create) { exact(input, new Set(["name"])); return { name: string(input.name, "name", 120, true) }; }
    exact(input, new Set(["projectId"]));
    return { projectId: projectId(input.projectId) };
}
function thisPcTarget(value, { list = false } = {}) {
    const input = objectPayload(value);
    const allowed = list ? new Set(["projectId", "coworkerId", "limit"]) : new Set(["projectId", "coworkerId"]);
    exact(input, allowed);
    const out = { projectId: projectId(input.projectId) };
    if (input.coworkerId !== undefined) out.coworkerId = identifier(input.coworkerId, "coworkerId");
    else if (!list) throw new Error("coworkerId is required");
    if (list && input.limit !== undefined) out.limit = positiveInteger(input.limit, "limit", 1, 50);
    return out;
}
const SEARCH_TYPES = new Set(["conversations", "channels", "coworkers", "projects", "artifacts", "skills", "playbooks", "routines", "memory", "jobs", "history"]);
const PALETTE_IDS = new Set(["new-coworker", "new-team", "new-channel", "run-routine", "teach-skill", "open-computer", "search"]);
function searchTarget(value) {
    if (value === undefined || value === null) return { query: "", types: [...SEARCH_TYPES], limit: 50 };
    const input = objectPayload(value);
    exact(input, new Set(["query", "types", "projectId", "limit", "status"]));
    const query = input.query === undefined ? "" : string(input.query, "query", 300);
    if (input.types !== undefined && (!Array.isArray(input.types) || input.types.length > SEARCH_TYPES.size || input.types.some((entry) => typeof entry !== "string" || !SEARCH_TYPES.has(entry)))) throw new Error("search types are invalid");
    const types = input.types === undefined ? [...SEARCH_TYPES] : [...new Set(input.types)];
    if (input.status !== undefined && !["active", "archived", "all"].includes(input.status)) throw new Error("search status is invalid");
    return { query, types, ...(input.projectId === undefined ? {} : { projectId: projectId(input.projectId) }), ...(input.status === undefined ? {} : { status: input.status }), limit: input.limit === undefined ? 50 : positiveInteger(input.limit, "limit", 1, 100) };
}
function paletteArgs(value, allowed, label) { const input = objectPayload(value ?? {}); exact(input, allowed); return input; }
function paletteTarget(value) {
    const input = objectPayload(value);
    exact(input, new Set(["paletteId", "args"]));
    if (typeof input.paletteId !== "string" || !PALETTE_IDS.has(input.paletteId)) throw new Error("paletteId is invalid");
    const allowed = {
        search: new Set(),
        "new-coworker": new Set(["name", "role", "instructions"]),
        "new-team": new Set(["title", "coworkerIds", "leadCoworkerId"]),
        "new-channel": new Set(["teamId", "name"]),
        "run-routine": new Set(["routineId"]),
        "teach-skill": new Set(["coworkerId", "name", "description"]),
        "open-computer": new Set(["coworkerId"]),
    }[input.paletteId];
    const args = paletteArgs(input.args, allowed, input.paletteId);
    const out = { paletteId: input.paletteId, args: structuredClone(args) };
    const requiredString = (key, max) => { if (args[key] !== undefined) string(args[key], key, max, true); else throw new Error(`${key} is required`); };
    if (input.paletteId === "new-coworker") { requiredString("name", 80); requiredString("role", 120); if (args.instructions !== undefined) string(args.instructions, "instructions", 12_000); }
    if (input.paletteId === "new-team") { requiredString("title", 120); if (!Array.isArray(args.coworkerIds) || args.coworkerIds.length < 2 || args.coworkerIds.length > 7) throw new Error("coworkerIds must contain 2-7 IDs"); idArray(args.coworkerIds, "coworkerIds", 7); if (args.leadCoworkerId !== undefined) identifier(args.leadCoworkerId, "leadCoworkerId"); }
    if (input.paletteId === "new-channel") { identifier(args.teamId, "teamId"); requiredString("name", 120); }
    if (["run-routine"].includes(input.paletteId)) identifier(args.routineId, "routineId");
    if (input.paletteId === "teach-skill") { identifier(args.coworkerId, "coworkerId"); requiredString("name", 100); if (args.description !== undefined) string(args.description, "description", 280); }
    if (input.paletteId === "open-computer") identifier(args.coworkerId, "coworkerId");
    return out;
}
function connectedAppsQueryTarget(payload) {
    if (payload === undefined || payload === null) return {};
    const value = objectPayload(payload); exact(value, new Set(["projectId", "query", "category", "status", "limit"]));
    if (value.category !== undefined && !["computer", "workspace", "productivity", "other"].includes(value.category)) throw new Error("connected app category is invalid");
    if (value.status !== undefined && !["available", "configured", "connected", "attention", "ready", "unavailable", "disabled"].includes(value.status)) throw new Error("connected app status is invalid");
    return { ...(value.projectId === undefined ? {} : { projectId: projectId(value.projectId) }), ...(value.query === undefined ? {} : { query: string(value.query, "query", 120) }), ...(value.category === undefined ? {} : { category: value.category }), ...(value.status === undefined ? {} : { status: value.status }), ...(value.limit === undefined ? {} : { limit: positiveInteger(value.limit, "limit", 1, 100) }) };
}
function modelBindingShape(value) {
    if (!isPlainObject(value)) throw new Error("modelBinding must be an object");
    exact(value, new Set(["profile", "provider", "model"]));
    if (![
        "automatic", "efficient", "deep", "economy", "custom",
    ].includes(value.profile ?? "automatic")) throw new Error("modelBinding.profile is invalid");
    if (value.provider !== undefined && !["codex", "claude", "antigravity", "chatgpt-web", "economy"].includes(value.provider))
        throw new Error("modelBinding.provider is invalid");
    for (const [key, child] of [["providerAccountId", value.providerAccountId], ["model", value.model]]) {
        if (child !== undefined && (typeof child !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(child)))
            throw new Error(`modelBinding.${key} must be a safe opaque identifier`);
    }
    if ((value.profile ?? "automatic") === "custom" && (!value.provider || !value.model))
        throw new Error("custom modelBinding requires provider and model");
    return structuredClone(value);
}

function teamPackModelBindingShape(value) {
    if (value === undefined || value === null) return { profile: "automatic" };
    if (!isPlainObject(value)) throw new Error("team pack modelBinding must be an object");
    exact(value, new Set(["profile", "provider", "model"]));
    const profile = value.profile ?? "automatic";
    if (!["automatic", "efficient", "deep", "economy", "custom"].includes(profile))
        throw new Error("team pack modelBinding.profile is invalid");
    if (value.provider !== undefined && !["codex", "claude", "antigravity", "chatgpt-web", "economy"].includes(value.provider))
        throw new Error("team pack modelBinding.provider is invalid");
    for (const [key, child] of [["provider", value.provider], ["model", value.model]]) {
        if (child !== undefined && (typeof child !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(child)))
            throw new Error(`team pack modelBinding.${key} must be a safe opaque identifier`);
    }
    if (profile === "custom" && (!value.provider || !value.model))
        throw new Error("team pack custom modelBinding requires provider and model");
    return {
        profile,
        ...(value.provider ? { provider: value.provider } : {}),
        ...(value.model ? { model: value.model } : {}),
    };
}

function teamPackShape(value) {
    if (!isPlainObject(value)) throw new Error("team pack must be an object");
    assertNoAuthority(value, "pack");
    exact(value, new Set(["schema", "id", "name", "description", "coworkers", "channels", "playbooks"]));
    if (value.schema !== "sovereignbot.desktop.team-pack.v1") throw new Error("team pack schema is invalid");
    const id = identifier(value.id, "packId");
    const name = string(value.name, "team pack name", 120, true);
    const description = string(value.description, "team pack description", 500, true);
    if (!Array.isArray(value.coworkers) || value.coworkers.length < 2 || value.coworkers.length > 8)
        throw new Error("team pack must contain 2 to 8 coworkers");
    const coworkerKeys = new Set();
    const coworkers = value.coworkers.map((entry) => {
        if (!isPlainObject(entry)) throw new Error("team pack coworker must be an object");
        exact(entry, new Set(["key", "name", "role", "instructions", "avatar", "modelBinding"]));
        const key = identifier(entry.key, "team pack coworker key");
        if (coworkerKeys.has(key)) throw new Error(`duplicate team pack coworker key: ${key}`);
        coworkerKeys.add(key);
        const out = {
            key,
            name: string(entry.name, "team pack coworker name", 80, true),
            role: string(entry.role, "team pack coworker role", 120, true),
            instructions: string(entry.instructions, "team pack coworker instructions", 12_000, true),
            modelBinding: teamPackModelBindingShape(entry.modelBinding),
        };
        if (entry.avatar !== undefined) out.avatar = string(entry.avatar, "team pack coworker avatar", 120, true);
        return out;
    });
    if (!Array.isArray(value.channels) || value.channels.length < 1 || value.channels.length > 8)
        throw new Error("team pack must contain 1 to 8 channels");
    const channelKeys = new Set();
    const channels = value.channels.map((entry) => {
        if (!isPlainObject(entry)) throw new Error("team pack channel must be an object");
        exact(entry, new Set(["key", "name", "kind", "instructions", "playbookId"]));
        const key = identifier(entry.key, "team pack channel key");
        if (channelKeys.has(key)) throw new Error(`duplicate team pack channel key: ${key}`);
        channelKeys.add(key);
        if (!["work", "personal", "project"].includes(entry.kind)) throw new Error("team pack channel kind is invalid");
        return {
            key,
            name: string(entry.name, "team pack channel name", 120, true),
            kind: entry.kind,
            instructions: string(entry.instructions, "team pack channel instructions", 12_000, true),
            playbookId: identifier(entry.playbookId, "team pack channel playbookId"),
        };
    });
    if (!Array.isArray(value.playbooks) || value.playbooks.length < 1 || value.playbooks.length > 8)
        throw new Error("team pack must contain 1 to 8 playbooks");
    const playbooks = value.playbooks.map((entry) => {
        if (!isPlainObject(entry)) throw new Error("team pack playbook must be an object");
        exact(entry, new Set(["id", "name", "description", "steps"]));
        if (!Array.isArray(entry.steps) || entry.steps.length > 12) throw new Error("team pack playbook steps are invalid");
        return {
            id: identifier(entry.id, "playbookId"),
            name: string(entry.name, "playbook name", 120, true),
            description: string(entry.description, "playbook description", 500, true),
            steps: entry.steps.map((step) => identifier(step, "playbook step")),
        };
    });
    return { schema: value.schema, id, name, description, coworkers, channels, playbooks };
}

function teamPlaybookShape(value) {
    if (!isPlainObject(value)) throw new Error("playbook must be an object");
    assertNoAuthority(value, "playbook");
    exact(value, new Set(["schema", "id", "name", "description", "steps"]));
    if (value.schema !== "sovereignbot.desktop.playbook.v1") throw new Error("playbook schema is invalid");
    if (!Array.isArray(value.steps) || value.steps.length > 12) throw new Error("playbook steps are invalid");
    return {
        schema: value.schema,
        id: identifier(value.id, "playbookId"),
        name: string(value.name, "playbook name", 120, true),
        description: string(value.description, "playbook description", 500, true),
        steps: value.steps.map((step) => identifier(step, "playbook step")),
    };
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

function accountSlot(value) {
    if (!["A", "B", "C"].includes(value)) throw new Error("accountSlot must be A, B, or C");
    return value;
}

export const V3_IPC_CHANNELS = Object.freeze({
    "provider:setCoworkerAccount": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["coworkerId", "provider", "accountSlot"])); if (value.provider !== "antigravity") throw new Error("account account switching is only supported for Antigravity"); return { coworkerId: identifier(value.coworkerId, "coworkerId"), provider: value.provider, accountSlot: accountSlot(value.accountSlot) }; }),
    "coworker:list": spec(1024, (payload) => { if (payload === undefined || payload === null) return { includeArchived: false }; const value = objectPayload(payload); exact(value, new Set(["includeArchived"])); if (value.includeArchived !== undefined && typeof value.includeArchived !== "boolean") throw new Error("includeArchived must be boolean"); return { includeArchived: value.includeArchived === true }; }),
    "coworker:get": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["coworkerId"])); return { coworkerId: identifier(value.coworkerId, "coworkerId") }; }),
    "coworker:create": spec(24 * 1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["coworker"])); return { coworker: coworkerShape(value.coworker) }; }),
    "coworker:update": spec(24 * 1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["coworkerId", "patch"])); return { coworkerId: identifier(value.coworkerId, "coworkerId"), patch: coworkerShape(value.patch, { patch: true }) }; }),
    "coworker:archive": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["coworkerId"])); return { coworkerId: identifier(value.coworkerId, "coworkerId") }; }),
    "coworker:restore": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["coworkerId"])); return { coworkerId: identifier(value.coworkerId, "coworkerId") }; }),
    "memory:list": spec(4096, (payload) => memoryTarget(payload)),
    "memory:get": spec(2048, (payload) => memoryTarget(payload, { withMemoryId: true })),
    "memory:update": spec(24 * 1024, (payload) => memoryTarget(payload, { withMemoryId: true, withPatch: true })),
    "memory:forget": spec(2048, (payload) => memoryTarget(payload, { withMemoryId: true })),
    "memory:delete": spec(2048, (payload) => memoryTarget(payload, { withMemoryId: true })),
    "memory:pin": spec(2048, (payload) => memoryTarget(payload, { withMemoryId: true, withPinned: true })),
    "memory:sourceTrace": spec(2048, (payload) => memoryTarget(payload, { withMemoryId: true })),
    "memory:listSuggestions": spec(1024, empty),
    "memory:approveSuggestion": spec(2048, (payload) => { const value = objectPayload(payload); exact(value, new Set(["suggestionId"])); return { suggestionId: identifier(value.suggestionId, "suggestionId") }; }),
    "memory:rejectSuggestion": spec(2048, (payload) => { const value = objectPayload(payload); exact(value, new Set(["suggestionId"])); return { suggestionId: identifier(value.suggestionId, "suggestionId") }; }),
    "project:list": spec(2048, (payload) => projectTarget(payload, { list: true })),
    "project:get": spec(1024, (payload) => projectTarget(payload)),
    "project:create": spec(2048, (payload) => projectTarget(payload, { create: true })),
    "project:open": spec(1024, (payload) => projectTarget(payload)),
    "project:archive": spec(1024, (payload) => projectTarget(payload)),
    "project:restore": spec(1024, (payload) => projectTarget(payload)),
    "project:export": spec(1024, (payload) => projectTarget(payload)),
    "project:backup": spec(1024, (payload) => projectTarget(payload)),
    "search:query": spec(4096, (payload) => searchTarget(payload)),
    "palette:list": spec(1024, empty),
    "palette:execute": spec(16 * 1024, (payload) => paletteTarget(payload)),
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
    "team:computerTask": spec(32 * 1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["title", "objective", "ownerCoworkerId", "teamId", "projectId", "workspaceId", "computerTarget", "computerActions"])); return { title: string(value.title, "title", 120, true), objective: string(value.objective, "objective", 8000, true), ownerCoworkerId: identifier(value.ownerCoworkerId, "ownerCoworkerId"), teamId: identifier(value.teamId, "teamId"), ...(value.projectId === undefined ? {} : { projectId: projectId(value.projectId) }), ...(value.workspaceId === undefined ? {} : { workspaceId: identifier(value.workspaceId, "workspaceId") }), computerTarget: workerComputerTargetShape(value.computerTarget), computerActions: value.computerActions === undefined ? [{ operation: "snapshot", input: {} }] : workerComputerActionsShape(value.computerActions) }; }),
    "team:get": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["teamId"])); return { teamId: identifier(value.teamId, "teamId") }; }),
    "team:installPack": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["packId"])); return { packId: identifier(value.packId, "packId") }; }),
    "team:exportPack": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["teamId"])); return { teamId: identifier(value.teamId, "teamId") }; }),
    "team:importPack": spec(64 * 1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["pack"])); return { pack: teamPackShape(value.pack) }; }),
    "team:exportPlaybook": spec(2048, (payload) => { const value = objectPayload(payload); exact(value, new Set(["teamId", "playbookId"])); return { teamId: identifier(value.teamId, "teamId"), playbookId: identifier(value.playbookId, "playbookId") }; }),
    "team:importPlaybook": spec(8 * 1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["teamId", "playbook"])); return { teamId: identifier(value.teamId, "teamId"), playbook: teamPlaybookShape(value.playbook) }; }),
    "team:duplicatePack": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["packId"])); return { packId: identifier(value.packId, "packId") }; }),
    "team:exportPackRecipe": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["packId"])); return { packId: identifier(value.packId, "packId") }; }),
    "team:editPack": spec(64 * 1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["packId", "patch"])); const patch = objectPayload(value.patch); exact(patch, new Set(["name", "description", "coworkers", "channels", "playbooks"])); return { packId: identifier(value.packId, "packId"), patch: structuredClone(patch) }; }),
    "playbook:list": spec(1024, (payload) => { if (payload === undefined || payload === null) return { includeArchived: false }; const value = objectPayload(payload); exact(value, new Set(["includeArchived"])); return { includeArchived: value.includeArchived === true }; }),
    "playbook:create": spec(8 * 1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["playbook"])); const playbook = objectPayload(value.playbook); exact(playbook, new Set(["name", "description", "steps"])); if (!Array.isArray(playbook.steps) || playbook.steps.length > 12) throw new Error("playbook steps are invalid"); return { playbook: { schema: "sovereignbot.desktop.playbook.v1", name: playbook.name, description: playbook.description ?? "", steps: [...playbook.steps] } }; }),
    "playbook:update": spec(8 * 1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["playbookId", "patch"])); const patch = objectPayload(value.patch); exact(patch, new Set(["name", "description", "steps"])); return { playbookId: identifier(value.playbookId, "playbookId"), patch: structuredClone(patch) }; }),
    "playbook:archive": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["playbookId"])); return { playbookId: identifier(value.playbookId, "playbookId") }; }),
    "playbook:restore": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["playbookId"])); return { playbookId: identifier(value.playbookId, "playbookId") }; }),
    "playbook:duplicate": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["playbookId"])); return { playbookId: identifier(value.playbookId, "playbookId") }; }),
    "playbook:export": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["playbookId"])); return { playbookId: identifier(value.playbookId, "playbookId") }; }),
    "playbook:import": spec(8 * 1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["playbook"])); return { playbook: teamPlaybookShape(value.playbook) }; }),
    "playbook:assign": spec(2048, (payload) => { const value = objectPayload(payload); exact(value, new Set(["playbookId", "teamId", "channelId"])); if ((value.teamId === undefined) === (value.channelId === undefined)) throw new Error("playbook assignment requires exactly one teamId or channelId"); return { playbookId: identifier(value.playbookId, "playbookId"), ...(value.teamId ? { teamId: identifier(value.teamId, "teamId") } : {}), ...(value.channelId ? { channelId: identifier(value.channelId, "channelId") } : {}) }; }),
    "team:createChannelFromTemplate": spec(2048, (payload) => { const value = objectPayload(payload); exact(value, new Set(["teamId", "templateId"])); return { teamId: identifier(value.teamId, "teamId"), templateId: identifier(value.templateId, "templateId") }; }),
    "channel:list": spec(1024, (payload) => { if (payload === undefined || payload === null) return {}; const value = objectPayload(payload); exact(value, new Set(["teamId", "includeArchived"])); return { ...(value.teamId === undefined ? {} : { teamId: identifier(value.teamId, "teamId") }), ...(value.includeArchived === true ? { includeArchived: true } : {}) }; }),
    "channel:get": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["channelId"])); return { channelId: identifier(value.channelId, "channelId") }; }),
    "channel:create": spec(16 * 1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["teamId", "name", "kind", "instructions", "workspaceId", "playbookId"])); if (!["work", "personal", "project"].includes(value.kind ?? "project")) throw new Error("channel kind is invalid"); return { teamId: identifier(value.teamId, "teamId"), name: string(value.name, "name", 120, true), kind: value.kind ?? "project", instructions: value.instructions === undefined ? undefined : string(value.instructions, "instructions", 12_000), ...(value.workspaceId ? { workspaceId: identifier(value.workspaceId, "workspaceId") } : {}), ...(value.playbookId ? { playbookId: identifier(value.playbookId, "playbookId") } : {}) }; }),
    "channel:update": spec(16 * 1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["channelId", "patch"])); const patch = objectPayload(value.patch); exact(patch, new Set(["name", "kind", "instructions", "workspaceId", "playbookId"])); if (!Object.keys(patch).length) throw new Error("channel patch must not be empty"); if (patch.name !== undefined) string(patch.name, "name", 120, true); if (patch.kind !== undefined && !["work", "personal", "project"].includes(patch.kind)) throw new Error("channel kind is invalid"); if (patch.instructions !== undefined) string(patch.instructions, "instructions", 12_000); return { channelId: identifier(value.channelId, "channelId"), patch: { ...(patch.name === undefined ? {} : { name: patch.name }), ...(patch.kind === undefined ? {} : { kind: patch.kind }), ...(patch.instructions === undefined ? {} : { instructions: patch.instructions }), ...(patch.workspaceId === undefined ? {} : { workspaceId: identifier(patch.workspaceId, "workspaceId") }), ...(patch.playbookId === undefined ? {} : { playbookId: identifier(patch.playbookId, "playbookId") }) } }; }),
    "channel:archive": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["channelId"])); return { channelId: identifier(value.channelId, "channelId") }; }),
    "channel:restore": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["channelId"])); return { channelId: identifier(value.channelId, "channelId") }; }),
    "connectedApps:list": spec(2048, connectedAppsQueryTarget),
    "connectedApps:search": spec(2048, connectedAppsQueryTarget),
    "connectedApps:assign": spec(2048, (payload) => {
        const value = objectPayload(payload);
        exact(value, new Set(["appId", "projectId", "teamId", "coworkerId", "enabled"]));
        if ((value.teamId === undefined) === (value.coworkerId === undefined))
            throw new Error("connected app assignment requires exactly one teamId or coworkerId");
        if (typeof value.enabled !== "boolean") throw new Error("enabled must be boolean");
        return {
            appId: identifier(value.appId, "appId"),
            ...(value.projectId !== undefined ? { projectId: projectId(value.projectId) } : {}),
            ...(value.teamId !== undefined ? { teamId: identifier(value.teamId, "teamId") } : {}),
            ...(value.coworkerId !== undefined ? { coworkerId: identifier(value.coworkerId, "coworkerId") } : {}),
            enabled: value.enabled,
        };
    }),
    "connectedApps:connect": spec(2048, (payload) => {
        const value = objectPayload(payload); exact(value, new Set(["appId", "projectId", "approveMetered"]));
        if (value.approveMetered !== undefined && typeof value.approveMetered !== "boolean") throw new Error("approveMetered must be boolean");
        return { appId: identifier(value.appId, "appId"), ...(value.projectId === undefined ? {} : { projectId: projectId(value.projectId) }), ...(value.approveMetered === undefined ? {} : { approveMetered: value.approveMetered }) };
    }),
    "connectedApps:disconnect": spec(2048, (payload) => {
        const value = objectPayload(payload); exact(value, new Set(["appId", "projectId"]));
        return { appId: identifier(value.appId, "appId"), ...(value.projectId === undefined ? {} : { projectId: projectId(value.projectId) }) };
    }),
    "connectedApps:health": spec(2048, (payload) => {
        const value = objectPayload(payload); exact(value, new Set(["appId", "projectId"]));
        return { appId: identifier(value.appId, "appId"), ...(value.projectId === undefined ? {} : { projectId: projectId(value.projectId) }) };
    }),
    "connectedApps:review": spec(2048, (payload) => {
        const value = objectPayload(payload); exact(value, new Set(["appId", "projectId"]));
        return { appId: identifier(value.appId, "appId"), ...(value.projectId === undefined ? {} : { projectId: projectId(value.projectId) }) };
    }),
    "connectedApps:disable": spec(2048, (payload) => {
        const value = objectPayload(payload); exact(value, new Set(["appId", "projectId"]));
        return { appId: identifier(value.appId, "appId"), ...(value.projectId === undefined ? {} : { projectId: projectId(value.projectId) }) };
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
    "artifact:open": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["artifactId"])); return { artifactId: identifier(value.artifactId, "artifactId") }; }),
    "artifact:reveal": spec(1024, (payload) => { const value = objectPayload(payload); exact(value, new Set(["artifactId"])); return { artifactId: identifier(value.artifactId, "artifactId") }; }),
    "artifact:hub": spec(2048, (payload) => { if (payload === undefined || payload === null) return { limit: 100 }; const value = objectPayload(payload); exact(value, new Set(["limit", "teamId", "channelId", "coworkerId", "type"])); return { limit: value.limit === undefined ? 100 : positiveInteger(value.limit, "limit", 1, 500), ...(value.teamId ? { teamId: identifier(value.teamId, "teamId") } : {}), ...(value.channelId ? { channelId: identifier(value.channelId, "channelId") } : {}), ...(value.coworkerId ? { coworkerId: identifier(value.coworkerId, "coworkerId") } : {}), ...(value.type ? { type: string(value.type, "type", 120, true) } : {}) }; }),
    "computer:history": spec(1024, (payload) => { if (payload === undefined || payload === null) return { limit: 100 }; const value = objectPayload(payload); exact(value, new Set(["limit"])); return { limit: value.limit === undefined ? 100 : positiveInteger(value.limit, "limit", 1, 500) }; }),
    "thisPc:list": spec(2048, (payload) => thisPcTarget(payload, { list: true })),
    "thisPc:frame": spec(2048, (payload) => thisPcTarget(payload)),
    "thisPc:snapshot": spec(2048, (payload) => thisPcTarget(payload)),
    "thisPc:takeOver": spec(2048, (payload) => thisPcTarget(payload)),
    "thisPc:handBack": spec(2048, (payload) => thisPcTarget(payload)),
    "thisPc:health": spec(2048, (payload) => thisPcTarget(payload)),
});

export function validateV3IpcRequest(channel, payload) {
    const entry = V3_IPC_CHANNELS[channel];
    if (!entry) throw new Error(`unknown V3 ipc channel: ${channel}`);
    if (bytes(payload) > entry.maxPayloadBytes) throw new Error(`ipc payload exceeds ${entry.maxPayloadBytes} bytes`);
    return entry.validateRequest(payload);
}
