import { randomBytes } from "node:crypto";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";
import {
    modelBindingFromLegacy,
    modelBindingProviderPreference,
    normalizeModelBinding,
    publicModelBinding,
} from "./model-binding.js";

export const COWORKERS_SCHEMA = "sovereignbot.desktop.coworkers.v1";

const PROVIDER_PREFERENCES = new Set(["auto", "codex", "claude"]);
const COMPUTER_MODES = new Set(["shared-login", "private-profile"]);
const COWORKER_STATES = new Set(["active", "paused", "archived"]);
const MAX_COWORKERS = 64;
const MAX_NAME = 80;
const MAX_ROLE = 120;
const MAX_INSTRUCTIONS = 12_000;
const MAX_REFERENCES = 64;

const AUTHORITY_KEYS = new Set([
    "command", "executable", "args", "prefixargs", "env", "environment", "cwd",
    "workspacepath", "sessionid", "harnessstate", "token", "bearer", "bearertoken",
    "apikey", "secret", "actorid", "owneragentid", "assignedagentid", "policy",
    "allowprivatehosts", "governedtools", "capabilities",
]);

function defaultId() {
    return `coworker_${randomBytes(8).toString("hex")}`;
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object`);
}

function normalizedKey(key) {
    return String(key).replaceAll(/[-_\s]/g, "").toLowerCase();
}

function rejectAuthorityBearingFields(value, path = "coworker") {
    if (!value || typeof value !== "object")
        return;
    if (Array.isArray(value)) {
        for (const [index, item] of value.entries())
            rejectAuthorityBearingFields(item, `${path}[${index}]`);
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        if (AUTHORITY_KEYS.has(normalizedKey(key)))
            throw new Error(`authority-bearing coworker field is not allowed: ${path}.${key}`);
        rejectAuthorityBearingFields(child, `${path}.${key}`);
    }
}

function boundedString(value, label, max, { required = false } = {}) {
    if (value === undefined || value === null) {
        if (required)
            throw new Error(`${label} is required`);
        return undefined;
    }
    if (typeof value !== "string")
        throw new Error(`${label} must be a string`);
    const trimmed = value.trim();
    if (!trimmed && required)
        throw new Error(`${label} is required`);
    if (trimmed.length > max)
        throw new Error(`${label} exceeds ${max} characters`);
    return trimmed || undefined;
}

function identifierList(value, label) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new Error(`${label} must be an array`);
    if (value.length > MAX_REFERENCES)
        throw new Error(`${label} exceeds ${MAX_REFERENCES} entries`);
    const out = [];
    for (const item of value) {
        if (typeof item !== "string" || !/^[A-Za-z0-9][\w:-]{0,127}$/.test(item))
            throw new Error(`${label} contains an invalid identifier`);
        if (!out.includes(item))
            out.push(item);
    }
    return out;
}

function normalizeProviderPreference(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !PROVIDER_PREFERENCES.has(value))
        throw new Error(`providerPreference must be one of: ${[...PROVIDER_PREFERENCES].join(", ")}`);
    return value;
}

function normalizeState(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !COWORKER_STATES.has(value))
        throw new Error(`state must be one of: ${[...COWORKER_STATES].join(", ")}`);
    return value;
}

function normalizeComputerMode(value) {
    if (value === undefined)
        return "shared-login";
    if (typeof value !== "string" || !COMPUTER_MODES.has(value))
        throw new Error("computerMode must be shared-login or private-profile");
    return value;
}

function normalizeCreate(input) {
    assertPlainObject(input, "coworker");
    rejectAuthorityBearingFields(input);
    const allowed = new Set([
        "name", "role", "instructions", "avatar", "providerPreference", "skillIds",
        "workspaceIds", "approvalProfileId", "computerProfileId", "computerMode", "modelBinding", "state",
    ]);
    for (const key of Object.keys(input)) {
        if (!allowed.has(key))
            throw new Error(`unknown coworker field: ${key}`);
    }
    const legacyPreference = normalizeProviderPreference(input.providerPreference) ?? "auto";
    const modelBinding = normalizeModelBinding(input.modelBinding, { legacyPreference });
    return {
        name: boundedString(input.name, "name", MAX_NAME, { required: true }),
        role: boundedString(input.role, "role", MAX_ROLE, { required: true }),
        instructions: boundedString(input.instructions, "instructions", MAX_INSTRUCTIONS) ?? "",
        avatar: boundedString(input.avatar, "avatar", 120),
        // Keep this compatibility field for v3 callers and old state files.  New code
        // routes from modelBinding, while the legacy value is derived when a binding is
        // supplied explicitly.
        providerPreference: Object.hasOwn(input, "modelBinding")
            ? modelBindingProviderPreference(modelBinding)
            : legacyPreference,
        modelBinding,
        skillIds: identifierList(input.skillIds, "skillIds") ?? [],
        workspaceIds: identifierList(input.workspaceIds, "workspaceIds") ?? [],
        approvalProfileId: boundedString(input.approvalProfileId, "approvalProfileId", 128),
        computerProfileId: boundedString(input.computerProfileId, "computerProfileId", 128),
        computerMode: normalizeComputerMode(input.computerMode),
        state: normalizeState(input.state) ?? "active",
    };
}

function normalizePatch(input) {
    assertPlainObject(input, "coworker patch");
    rejectAuthorityBearingFields(input);
    const allowed = new Set([
        "name", "role", "instructions", "avatar", "providerPreference", "skillIds",
        "workspaceIds", "approvalProfileId", "computerProfileId", "computerMode", "modelBinding", "state",
    ]);
    for (const key of Object.keys(input)) {
        if (!allowed.has(key))
            throw new Error(`unknown coworker field: ${key}`);
    }
    const patch = {};
    if (Object.hasOwn(input, "name"))
        patch.name = boundedString(input.name, "name", MAX_NAME, { required: true });
    if (Object.hasOwn(input, "role"))
        patch.role = boundedString(input.role, "role", MAX_ROLE, { required: true });
    if (Object.hasOwn(input, "instructions"))
        patch.instructions = boundedString(input.instructions, "instructions", MAX_INSTRUCTIONS) ?? "";
    if (Object.hasOwn(input, "avatar"))
        patch.avatar = boundedString(input.avatar, "avatar", 120);
    if (Object.hasOwn(input, "providerPreference"))
        patch.providerPreference = normalizeProviderPreference(input.providerPreference);
    if (Object.hasOwn(input, "modelBinding"))
        patch.modelBinding = normalizeModelBinding(input.modelBinding, {
            legacyPreference: patch.providerPreference ?? "auto",
        });
    else if (Object.hasOwn(input, "providerPreference"))
        patch.modelBinding = modelBindingFromLegacy(patch.providerPreference);
    if (Object.hasOwn(input, "skillIds"))
        patch.skillIds = identifierList(input.skillIds, "skillIds");
    if (Object.hasOwn(input, "workspaceIds"))
        patch.workspaceIds = identifierList(input.workspaceIds, "workspaceIds");
    if (Object.hasOwn(input, "approvalProfileId"))
        patch.approvalProfileId = boundedString(input.approvalProfileId, "approvalProfileId", 128);
    if (Object.hasOwn(input, "computerProfileId"))
        patch.computerProfileId = boundedString(input.computerProfileId, "computerProfileId", 128);
    if (Object.hasOwn(input, "computerMode"))
        patch.computerMode = normalizeComputerMode(input.computerMode);
    if (Object.hasOwn(input, "state"))
        patch.state = normalizeState(input.state);
    return patch;
}

function sanitizePersisted(entry) {
    try {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return undefined;
        if (typeof entry.id !== "string" || !/^coworker_[a-f0-9]{16}$/i.test(entry.id))
            return undefined;
        const normalized = normalizeCreate({
            name: entry.name,
            role: entry.role,
            instructions: entry.instructions,
            avatar: entry.avatar,
            providerPreference: entry.providerPreference,
            modelBinding: entry.modelBinding,
            skillIds: entry.skillIds,
            workspaceIds: entry.workspaceIds,
            approvalProfileId: entry.approvalProfileId,
            computerProfileId: entry.computerProfileId,
            computerMode: entry.computerMode,
            state: entry.state,
        });
        if (typeof entry.createdAt !== "string" || typeof entry.updatedAt !== "string")
            return undefined;
        return { id: entry.id, ...normalized, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
    }
    catch {
        return undefined;
    }
}

function publicView(entry) {
    const view = structuredClone(entry);
    view.modelBinding = publicModelBinding(entry.modelBinding);
    return view;
}

function internalView(entry) {
    return structuredClone(entry);
}

export function defaultCoworkerBlueprints() {
    return [
        {
            key: "chief-of-staff",
            name: "Chief of Staff",
            role: "Own the outcome, coordinate specialists, escalate only when human judgment is needed.",
            instructions: "Turn high-level goals into coordinated work. Delegate to the right coworkers, monitor progress, request review, and keep the user informed without exposing internal orchestration machinery.",
            avatar: "✦",
            providerPreference: "auto",
            modelBinding: { profile: "automatic" },
        },
        {
            key: "coding-lead",
            name: "Coding Lead",
            role: "Implement, debug, test, and improve software in trusted workspaces.",
            instructions: "Take ownership of software changes. Inspect the workspace, make focused changes, run relevant checks, and hand important changes to an independent reviewer before declaring success.",
            avatar: "⌘",
            providerPreference: "codex",
            modelBinding: { profile: "efficient", provider: "codex", model: "luna" },
        },
        {
            key: "researcher",
            name: "Researcher",
            role: "Investigate questions, compare evidence, and produce decision-ready findings.",
            instructions: "Research thoroughly, distinguish evidence from inference, preserve source provenance, and deliver concise findings that another coworker can act on.",
            avatar: "◈",
            providerPreference: "auto",
            modelBinding: { profile: "automatic" },
        },
    ];
}

export function createCoworkerStore({ persistPath, now = () => new Date().toISOString(), makeId = defaultId } = {}) {
    if (!persistPath)
        throw new Error("coworker store requires persistPath");
    if (typeof now !== "function" || typeof makeId !== "function")
        throw new Error("coworker store requires function clocks/id factory");

    const loaded = loadJsonState(persistPath, null);
    const coworkers = loaded?.schema === COWORKERS_SCHEMA && Array.isArray(loaded.coworkers)
        ? loaded.coworkers.map(sanitizePersisted).filter(Boolean).slice(0, MAX_COWORKERS)
        : [];

    function save() {
        saveJsonState(persistPath, { schema: COWORKERS_SCHEMA, coworkers });
    }

    function requireCoworker(id) {
        const coworker = coworkers.find((entry) => entry.id === String(id));
        if (!coworker)
            throw new Error(`unknown coworker id: ${id}`);
        return coworker;
    }

    return {
        schema: COWORKERS_SCHEMA,

        list({ includeArchived = false } = {}) {
            return {
                schema: COWORKERS_SCHEMA,
                coworkers: coworkers
                    .filter((entry) => includeArchived || entry.state !== "archived")
                    .map(publicView),
            };
        },

        get(id) {
            return publicView(requireCoworker(id));
        },

        // Main-process consumers use the full binding.  Keeping this separate from get/list
        // prevents provider account/model identifiers from crossing into the renderer.
        getInternal(id) {
            return internalView(requireCoworker(id));
        },

        listInternal({ includeArchived = false } = {}) {
            return {
                schema: COWORKERS_SCHEMA,
                coworkers: coworkers
                    .filter((entry) => includeArchived || entry.state !== "archived")
                    .map(internalView),
            };
        },

        create(input) {
            if (coworkers.length >= MAX_COWORKERS)
                throw new Error(`coworker registry limit reached (${MAX_COWORKERS})`);
            const normalized = normalizeCreate(input);
            const id = makeId();
            if (typeof id !== "string" || !/^coworker_[a-f0-9]{16}$/i.test(id))
                throw new Error("coworker id factory returned an invalid id");
            if (coworkers.some((entry) => entry.id === id))
                throw new Error(`duplicate coworker id: ${id}`);
            const timestamp = now();
            const coworker = { id, ...normalized, createdAt: timestamp, updatedAt: timestamp };
            coworkers.push(coworker);
            save();
            return publicView(coworker);
        },

        update(id, patchInput) {
            const coworker = requireCoworker(id);
            const patch = normalizePatch(patchInput);
            if (patch.modelBinding)
                patch.providerPreference = modelBindingProviderPreference(patch.modelBinding);
            Object.assign(coworker, patch, { updatedAt: now() });
            save();
            return publicView(coworker);
        },

        archive(id) {
            return this.update(id, { state: "archived" });
        },

        restore(id) {
            return this.update(id, { state: "active" });
        },

        ensureDefaults() {
            if (coworkers.length)
                return this.list({ includeArchived: true });
            for (const blueprint of defaultCoworkerBlueprints()) {
                const { key: _key, ...input } = blueprint;
                this.create(input);
            }
            return this.list({ includeArchived: true });
        },
    };
}
