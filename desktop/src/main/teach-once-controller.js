import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

export const TEACH_ONCE_SCHEMA = "sovereignbot.desktop.teach-once.v1";

const SESSION_ID = /^teach_[a-f0-9]{16}$/i;
const MAX_SESSIONS = 64;
const MAX_ACTIONS = 64;
const MAX_NAME = 100;
const MAX_DESCRIPTION = 280;
const MAX_TARGET = 240;
const MAX_INPUT_NAME = 80;
const MAX_INPUT_TEXT = 4_000;
const MAX_URL = 2_000;
const MAX_WAIT_MS = 10_000;
const ACTION_KINDS = new Set(["navigate", "click", "type", "key", "scroll", "wait", "assert"]);
const VALIDATORS = new Set(["exists", "contains", "equals", "manual"]);
const KEYS = new Set([
    "Enter", "Tab", "Escape", "Space", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

function makeId() {
    return `teach_${randomBytes(8).toString("hex")}`;
}

function clone(value) {
    return structuredClone(value);
}

function text(value, label, max, { required = false } = {}) {
    if (value === undefined || value === null) {
        if (required) throw new Error(`${label} is required`);
        return undefined;
    }
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    const trimmed = value.trim();
    if (required && !trimmed) throw new Error(`${label} is required`);
    if (trimmed.length > max) throw new Error(`${label} exceeds ${max} characters`);
    return trimmed || undefined;
}

function boolean(value, label, fallback = false) {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
    return value;
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function exactKeys(value, allowed, label) {
    assertPlainObject(value, label);
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unexpected ${label} field: ${key}`);
}

function safeSite(value) {
    let parsed;
    try { parsed = new URL(value); }
    catch { throw new Error("navigate url must be a valid http/https URL"); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("navigate url must use http or https");
    if (parsed.username || parsed.password) throw new Error("navigate url cannot contain credentials");
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname || /^(169\.254\.169\.254|100\.100\.100\.200|metadata\.google\.internal\.?)$/.test(hostname))
        throw new Error("navigate url targets are not allowed");
    return hostname;
}

function optionalSite(value) {
    if (!value) return undefined;
    try { return safeSite(value); }
    catch { return undefined; }
}

function actionTarget(value, fallback = "semantic target") {
    const target = text(value ?? fallback, "action target", MAX_TARGET, { required: true });
    if (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(target)) throw new Error("action target must be semantic, not an absolute path");
    return target;
}

function publicAction(action) {
    return clone(action);
}

function sanitizeAction(value) {
    try {
        assertPlainObject(value, "teach action");
        if (!ACTION_KINDS.has(value.kind)) return undefined;
        const kind = value.kind;
        const action = { kind };
        if (kind === "navigate") {
            action.site = text(value.site, "action site", 255, { required: true });
            action.target = actionTarget(value.target, `site:${action.site}`);
        }
        if (["click", "type", "assert"].includes(kind)) action.target = actionTarget(value.target);
        if (value.app !== undefined) action.app = text(value.app, "action app", 120);
        if (value.site !== undefined && kind !== "navigate") action.site = text(value.site, "action site", 255);
        if (kind === "type") {
            action.inputName = text(value.inputName, "inputName", MAX_INPUT_NAME, { required: true });
            action.sensitive = value.sensitive === true;
        }
        if (kind === "key") {
            const key = text(value.key, "key", 32, { required: true });
            if (!KEYS.has(key) && !/^[A-Za-z0-9]$/.test(key)) throw new Error("key is not a supported semantic key");
            action.key = key;
        }
        if (kind === "scroll") {
            if (!["up", "down"].includes(value.direction)) throw new Error("scroll direction must be up or down");
            if (!Number.isInteger(value.amount) || value.amount < 1 || value.amount > 10) throw new Error("scroll amount must be 1-10");
            action.direction = value.direction;
            action.amount = value.amount;
        }
        if (kind === "wait") {
            if (!Number.isInteger(value.milliseconds) || value.milliseconds < 0 || value.milliseconds > MAX_WAIT_MS)
                throw new Error(`wait milliseconds must be 0-${MAX_WAIT_MS}`);
            action.milliseconds = value.milliseconds;
        }
        if (kind === "assert") {
            if (!VALIDATORS.has(value.validator)) throw new Error("validator must be exists, contains, equals, or manual");
            action.validator = value.validator;
            action.expectedOutput = text(value.expectedOutput, "expectedOutput", 500);
        }
        if (value.expectedOutput !== undefined && kind !== "assert") action.expectedOutput = text(value.expectedOutput, "expectedOutput", 500);
        return action;
    }
    catch {
        return undefined;
    }
}

function sanitizeSession(value) {
    try {
        if (!value || typeof value !== "object" || !SESSION_ID.test(value.id)) return undefined;
        const actions = Array.isArray(value.actions)
            ? value.actions.map(sanitizeAction).filter(Boolean).slice(0, MAX_ACTIONS)
            : [];
        const state = ["recording", "drafted", "tested", "saved", "cancelled"].includes(value.state) ? value.state : "recording";
        return {
            id: value.id,
            coworkerId: text(value.coworkerId, "coworkerId", 160, { required: true }),
            name: text(value.name, "teach name", MAX_NAME, { required: true }),
            description: text(value.description ?? "", "teach description", MAX_DESCRIPTION) ?? "",
            state,
            actions,
            draft: value.draft ? sanitizeDraft(value.draft) : undefined,
            savedSkillId: value.savedSkillId ? text(value.savedSkillId, "savedSkillId", 160) : undefined,
            createdAt: text(value.createdAt, "createdAt", 64, { required: true }),
            updatedAt: text(value.updatedAt, "updatedAt", 64, { required: true }),
            testedAt: value.testedAt ? text(value.testedAt, "testedAt", 64) : undefined,
        };
    }
    catch {
        return undefined;
    }
}

function sanitizeDraft(value) {
    try {
        assertPlainObject(value, "skill draft");
        const inputs = Array.isArray(value.inputs) ? value.inputs.slice(0, 16).map((entry) => ({
            name: text(entry.name, "draft input name", MAX_INPUT_NAME, { required: true }),
            type: "string",
            description: text(entry.description ?? "", "draft input description", 240) ?? "",
            required: entry.required !== false,
        })) : [];
        return {
            name: text(value.name, "draft name", MAX_NAME, { required: true }),
            description: text(value.description ?? "", "draft description", MAX_DESCRIPTION) ?? "",
            inputs,
            steps: Array.isArray(value.steps) ? value.steps.slice(0, MAX_ACTIONS).map((entry) => text(entry, "draft step", 800, { required: true })) : [],
            expectedOutput: text(value.expectedOutput ?? "", "draft expected output", 1_000) ?? "",
            requestedCapabilities: Array.isArray(value.requestedCapabilities) ? [...new Set(value.requestedCapabilities.filter((entry) => ["computer", "workspace"].includes(entry)))] : [],
            validators: Array.isArray(value.validators) ? value.validators.slice(0, 24).map((entry) => text(entry, "draft validator", 500, { required: true })) : [],
        };
    }
    catch {
        return undefined;
    }
}

function nowIso(now) {
    return new Date(now()).toISOString();
}

function draftFromSession(session) {
    const inputNames = [];
    const inputs = [];
    const steps = [];
    const validators = [];
    let expectedOutput = "A successful completion is visible to the user.";

    for (const action of session.actions) {
        if (action.kind === "navigate") {
            steps.push(`Open ${action.site} and continue with the task.`);
        }
        else if (action.kind === "click") {
            steps.push(`Click the ${action.target}${action.app ? ` in ${action.app}` : ""}${action.site ? ` on ${action.site}` : ""}.`);
        }
        else if (action.kind === "type") {
            if (!inputNames.includes(action.inputName)) {
                inputNames.push(action.inputName);
                inputs.push({ name: action.inputName, type: "string", description: `Value for ${action.target}.`, required: true });
            }
            steps.push(`Enter {{input:${action.inputName}}} into ${action.target}.`);
        }
        else if (action.kind === "key") {
            steps.push(`Press ${action.key}.`);
        }
        else if (action.kind === "scroll") {
            steps.push(`Scroll ${action.direction} ${action.amount} step${action.amount === 1 ? "" : "s"} to find the next target.`);
        }
        else if (action.kind === "wait") {
            steps.push(`Wait ${Math.max(0.1, action.milliseconds / 1000).toFixed(1)} seconds for the page to settle.`);
        }
        else if (action.kind === "assert") {
            const statement = action.expectedOutput || action.target;
            validators.push(`${action.validator}: ${statement}`);
            expectedOutput = statement;
            steps.push(`Verify that ${statement}.`);
        }
    }

    const name = session.name;
    const description = session.description || "A reusable task taught through semantic Computer actions.";
    const instructions = [
        "Use semantic/tool actions and accessible role/name targets; never rely on absolute coordinates.",
        inputs.length ? `Inputs: ${inputs.map((entry) => `{{input:${entry.name}}}`).join(", ")}.` : "This task has no user inputs.",
        "Steps:",
        ...steps.map((step, index) => `${index + 1}. ${step}`),
        `Expected output: ${expectedOutput}`,
        validators.length ? `Validators: ${validators.join("; ")}` : "Validator: confirm the expected output is visible.",
        "Requested capabilities are advisory only; the Governor and trusted configuration decide what is allowed.",
    ].join("\n");

    return {
        name,
        description,
        instructions,
        inputs,
        steps,
        expectedOutput,
        requestedCapabilities: ["computer"],
        validators: validators.length ? validators : ["manual: expected output is visible"],
    };
}

function publicSession(session) {
    return {
        id: session.id,
        coworkerId: session.coworkerId,
        name: session.name,
        description: session.description,
        state: session.state,
        actions: session.actions.map(publicAction),
        draft: session.draft ? clone(session.draft) : undefined,
        savedSkillId: session.savedSkillId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        testedAt: session.testedAt,
    };
}

function safeResult(value) {
    if (!value || typeof value !== "object") return { ok: true };
    return { ok: true, ...(value.clicked ? { clicked: true } : {}), ...(value.typed ? { typed: true } : {}), ...(value.pressed ? { pressed: true } : {}), ...(value.scrolled ? { scrolled: true } : {}), ...(value.url ? { site: optionalSite(value.url) } : {}) };
}

export function createTeachOnceController({
    dataDir,
    coworkerStore,
    skillStore,
    rawComputer,
    getAgentId,
    now = () => Date.now(),
    makeId: makeSessionId = makeId,
    persistPath,
} = {}) {
    if (!dataDir) throw new Error("teach-once controller requires dataDir");
    if (!coworkerStore?.get || !skillStore?.create) throw new Error("teach-once controller requires stores");
    if (!rawComputer?.snapshot || !rawComputer?.navigate) throw new Error("teach-once controller requires governed computer");
    if (typeof getAgentId !== "function") throw new Error("teach-once controller requires getAgentId");
    persistPath = persistPath ?? join(dataDir, "desktop-state", "teach-once.json");

    const loaded = loadJsonState(persistPath, null);
    const sessions = loaded?.schema === TEACH_ONCE_SCHEMA && Array.isArray(loaded.sessions)
        ? loaded.sessions.map(sanitizeSession).filter(Boolean).slice(-MAX_SESSIONS)
        : [];
    const snapshots = new Map();

    function save() {
        saveJsonState(persistPath, { schema: TEACH_ONCE_SCHEMA, sessions });
    }

    function requireSession(sessionId) {
        if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error("invalid teach session id");
        const session = sessions.find((entry) => entry.id === sessionId);
        if (!session) throw new Error(`unknown teach session id: ${sessionId}`);
        if (session.state === "cancelled") throw new Error("teach session is cancelled");
        return session;
    }

    function requireAgent(session) {
        coworkerStore.get(session.coworkerId);
        const agentId = getAgentId(session.coworkerId);
        if (typeof agentId !== "string" || !agentId) throw new Error("coworker has no active Computer lane");
        return agentId;
    }

    function touch(session) {
        session.updatedAt = nowIso(now);
        save();
    }

    function requireRecording(session) {
        if (session.state !== "recording") throw new Error(`teach session is ${session.state}; start a new demonstration`);
        if (session.actions.length >= MAX_ACTIONS) throw new Error(`teach session action limit reached (${MAX_ACTIONS})`);
    }

    return {
        schema: TEACH_ONCE_SCHEMA,

        list() {
            return { schema: TEACH_ONCE_SCHEMA, sessions: sessions.filter((entry) => entry.state !== "cancelled").map(publicSession) };
        },

        get(sessionId) {
            return publicSession(requireSession(sessionId));
        },

        start({ coworkerId, name, description } = {}) {
            if (sessions.filter((entry) => entry.state !== "cancelled").length >= MAX_SESSIONS) throw new Error(`teach session limit reached (${MAX_SESSIONS})`);
            coworkerStore.get(coworkerId);
            const agentId = getAgentId(coworkerId);
            if (typeof agentId !== "string" || !agentId) throw new Error("coworker has no active Computer lane");
            const session = {
                id: makeSessionId(),
                coworkerId: text(coworkerId, "coworkerId", 160, { required: true }),
                name: text(name, "teach name", MAX_NAME, { required: true }),
                description: text(description ?? "", "teach description", MAX_DESCRIPTION) ?? "",
                state: "recording",
                actions: [],
                createdAt: nowIso(now),
                updatedAt: nowIso(now),
            };
            if (!SESSION_ID.test(session.id) || sessions.some((entry) => entry.id === session.id)) throw new Error("teach session id factory returned invalid or duplicate id");
            sessions.push(session);
            save();
            return publicSession(session);
        },

        async snapshot(sessionId) {
            const session = requireSession(sessionId);
            requireRecording(session);
            const agentId = requireAgent(session);
            const result = await rawComputer.snapshot(agentId, session.id);
            if (!result || typeof result !== "object" || !Array.isArray(result.elements)) throw new Error("computer snapshot did not return semantic elements");
            const elements = result.elements.map((entry) => ({
                ref: text(entry.ref, "snapshot ref", 160, { required: true }),
                role: text(entry.role ?? "generic", "snapshot role", 80) ?? "generic",
                name: text(entry.name ?? "", "snapshot name", 240) ?? "",
                type: text(entry.type ?? "", "snapshot type", 80),
            }));
            snapshots.set(session.id, { snapshotId: text(result.snapshotId, "snapshotId", 160, { required: true }), elements, site: optionalSite(result.url) });
            return {
                sessionId: session.id,
                snapshotId: snapshots.get(session.id).snapshotId,
                site: snapshots.get(session.id).site,
                elements: elements.map(clone),
            };
        },

        async recordAction(sessionId, input = {}) {
            const session = requireSession(sessionId);
            requireRecording(session);
            assertPlainObject(input, "teach action input");
            const kind = text(input.kind, "action kind", 32, { required: true });
            if (!ACTION_KINDS.has(kind)) throw new Error("action kind is not supported");
            const agentId = requireAgent(session);
            const snapshot = snapshots.get(session.id);
            let result;
            let actionInput;

            if (kind === "navigate") {
                const url = text(input.url, "navigate url", MAX_URL, { required: true });
                const site = safeSite(url);
                result = await rawComputer.navigate(agentId, session.id, url);
                snapshots.delete(session.id);
                actionInput = { kind, site, target: actionTarget(input.target, `site:${site}`) };
            }
            else if (kind === "click") {
                if (!snapshot) throw new Error("read the current screen before recording a click");
                const ref = text(input.ref, "element ref", 160, { required: true });
                const element = snapshot.elements.find((entry) => entry.ref === ref);
                if (!element) throw new Error("element ref is not in the current semantic snapshot");
                result = await rawComputer.click(agentId, session.id, { snapshotId: snapshot.snapshotId, ref });
                actionInput = { kind, target: actionTarget(input.target, element.name || `${element.role} target`), ...(input.app ? { app: text(input.app, "action app", 120) } : {}), ...(snapshot.site ? { site: snapshot.site } : {}) };
            }
            else if (kind === "type") {
                if (!snapshot) throw new Error("read the current screen before recording text input");
                const ref = text(input.ref, "element ref", 160, { required: true });
                const element = snapshot.elements.find((entry) => entry.ref === ref);
                if (!element) throw new Error("element ref is not in the current semantic snapshot");
                const value = text(input.text, "demo input", MAX_INPUT_TEXT, { required: true });
                const inputName = text(input.inputName, "inputName", MAX_INPUT_NAME, { required: true });
                result = await rawComputer.type(agentId, session.id, { snapshotId: snapshot.snapshotId, ref, text: value });
                actionInput = { kind, inputName, sensitive: input.sensitive === true, target: actionTarget(input.target, element.name || `${element.role} field`), ...(input.app ? { app: text(input.app, "action app", 120) } : {}), ...(snapshot.site ? { site: snapshot.site } : {}) };
            }
            else if (kind === "key") {
                const key = text(input.key, "key", 32, { required: true });
                if (!KEYS.has(key) && !/^[A-Za-z0-9]$/.test(key)) throw new Error("key is not a supported semantic key");
                if (input.ref !== undefined) {
                    if (!snapshot) throw new Error("read the current screen before recording a key target");
                    const ref = text(input.ref, "element ref", 160, { required: true });
                    if (!snapshot.elements.some((entry) => entry.ref === ref)) throw new Error("element ref is not in the current semantic snapshot");
                    actionInput = { kind, key, target: actionTarget(input.target, "current semantic target") };
                    result = await rawComputer.key(agentId, session.id, { snapshotId: snapshot.snapshotId, ref, key });
                }
                else {
                    actionInput = { kind, key, target: actionTarget(input.target, "current page") };
                    result = await rawComputer.key(agentId, session.id, { key });
                }
            }
            else if (kind === "scroll") {
                if (!snapshot) throw new Error("read the current screen before recording a scroll");
                const direction = input.direction;
                const amount = input.amount;
                if (!["up", "down"].includes(direction)) throw new Error("scroll direction must be up or down");
                if (!Number.isInteger(amount) || amount < 1 || amount > 10) throw new Error("scroll amount must be 1-10");
                result = await rawComputer.scroll(agentId, session.id, { deltaX: 0, deltaY: direction === "down" ? amount * 600 : -amount * 600 });
                actionInput = { kind, direction, amount };
            }
            else if (kind === "wait") {
                const milliseconds = input.milliseconds;
                if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > MAX_WAIT_MS) throw new Error(`wait milliseconds must be 0-${MAX_WAIT_MS}`);
                if (milliseconds) await new Promise((resolve) => setTimeout(resolve, milliseconds));
                actionInput = { kind, milliseconds };
                result = { waited: true };
            }
            else {
                const validator = text(input.validator, "validator", 32, { required: true });
                if (!VALIDATORS.has(validator)) throw new Error("validator must be exists, contains, equals, or manual");
                actionInput = { kind, validator, target: actionTarget(input.target), ...(input.expectedOutput ? { expectedOutput: text(input.expectedOutput, "expectedOutput", 500) } : {}) };
                result = { asserted: true };
            }

            const normalized = sanitizeAction(actionInput);
            if (!normalized) throw new Error("recorded action could not be normalized");
            session.actions.push(normalized);
            touch(session);
            return { session: publicSession(session), action: publicAction(normalized), result: safeResult(result) };
        },

        finish(sessionId) {
            const session = requireSession(sessionId);
            if (session.state !== "recording" && session.state !== "drafted") throw new Error(`teach session is ${session.state}`);
            if (!session.actions.length) throw new Error("record at least one semantic action before creating a draft");
            session.draft = draftFromSession(session);
            session.state = "drafted";
            touch(session);
            return { session: publicSession(session), draft: clone(session.draft) };
        },

        test(sessionId) {
            const session = requireSession(sessionId);
            if (!session.draft) session.draft = draftFromSession(session);
            if (!session.draft.steps.length) throw new Error("skill draft has no steps to test");
            const semanticOnly = session.actions.every((entry) => ACTION_KINDS.has(entry.kind) && (!entry.target || !/[\\/]{2,}|^[A-Za-z]:/.test(entry.target)));
            if (!semanticOnly) throw new Error("skill draft contains a non-semantic target");
            session.state = "tested";
            session.testedAt = nowIso(now);
            touch(session);
            return { ok: true, mode: "semantic-replay-preview", checks: ["semantic targets", "bounded steps", "authority-free skill metadata"], session: publicSession(session), draft: clone(session.draft) };
        },

        save(sessionId) {
            const session = requireSession(sessionId);
            if (session.state !== "tested" && session.state !== "saved") throw new Error("test the skill draft before saving it");
            if (session.savedSkillId) {
                return { skill: skillStore.get(session.savedSkillId), session: publicSession(session) };
            }
            const skill = skillStore.create({ ...session.draft, source: "taught" });
            session.savedSkillId = skill.id;
            session.state = "saved";
            touch(session);
            return { skill, session: publicSession(session) };
        },

        cancel(sessionId) {
            const session = requireSession(sessionId);
            session.state = "cancelled";
            touch(session);
            snapshots.delete(session.id);
            return publicSession(session);
        },
    };
}
