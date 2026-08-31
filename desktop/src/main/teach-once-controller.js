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
const MAX_TEST_MS = 120_000;
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

function sanitizeLocator(value) {
    if (value === undefined || value === null) return undefined;
    exactKeys(value, new Set(["role", "name", "type"]), "semantic locator");
    const locator = {
        role: text(value.role ?? "generic", "locator role", 80) ?? "generic",
        name: text(value.name ?? "", "locator name", 240) ?? "",
    };
    const type = text(value.type, "locator type", 80);
    if (type) locator.type = type;
    if (!locator.role && !locator.name && !locator.type) throw new Error("semantic locator must contain a role, name, or type");
    return locator;
}

function locatorForElement(element) {
    return sanitizeLocator({
        role: element?.role ?? "generic",
        name: element?.name ?? "",
        type: element?.type,
    });
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

function safeReplayUrl(value, fallbackSite) {
    if (value === undefined || value === null || value === "")
        return fallbackSite ? `https://${fallbackSite}/` : undefined;
    let parsed;
    try { parsed = new URL(value); }
    catch { throw new Error("navigate url must be a valid http/https URL"); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("navigate url must use http or https");
    if (parsed.username || parsed.password) throw new Error("navigate url cannot contain credentials");
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname || /^(169\.254\.169\.254|100\.100\.100\.200|metadata\.google\.internal\.?$)/.test(hostname))
        throw new Error("navigate url targets are not allowed");
    // Query strings and fragments are deliberately not part of a reusable Skill.  They
    // commonly contain one-shot tokens or private state and are not needed to re-open the
    // demonstrated site/page boundary.
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
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
            action.url = safeReplayUrl(value.url, action.site);
        }
        if (["click", "type", "assert"].includes(kind)) action.target = actionTarget(value.target);
        if (value.locator !== undefined) action.locator = sanitizeLocator(value.locator);
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
        const persistedState = ["recording", "generating", "drafted", "testing", "tested", "saved", "cancelled"].includes(value.state) ? value.state : "recording";
        const draft = value.draft ? sanitizeDraft(value.draft) : undefined;
        // A process restart cannot resume an in-flight model/computer operation.  Recover
        // those transient states to the last safe user-visible state instead of falsely
        // presenting a half-finished Skill as tested.
        const recoveredState = persistedState === "generating" || persistedState === "testing"
            ? (draft ? "drafted" : "recording")
            : persistedState;
        const state = ["drafted", "tested", "saved"].includes(recoveredState) && !draft
            ? "recording"
            : recoveredState;
        return {
            id: value.id,
            coworkerId: text(value.coworkerId, "coworkerId", 160, { required: true }),
            name: text(value.name, "teach name", MAX_NAME, { required: true }),
            description: text(value.description ?? "", "teach description", MAX_DESCRIPTION) ?? "",
            state,
            actions,
            draft,
            savedSkillId: value.savedSkillId ? text(value.savedSkillId, "savedSkillId", 160) : undefined,
            createdAt: text(value.createdAt, "createdAt", 64, { required: true }),
            updatedAt: text(value.updatedAt, "updatedAt", 64, { required: true }),
            testedAt: value.testedAt ? text(value.testedAt, "testedAt", 64) : undefined,
            testResult: value.testResult ? sanitizeTestResult(value.testResult) : undefined,
        };
    }
    catch {
        return undefined;
    }
}

export function sanitizeDraft(value) {
    try {
        assertPlainObject(value, "skill draft");
        exactKeys(value, new Set(["name", "description", "instructions", "inputs", "steps", "expectedOutput", "requestedCapabilities", "validators"]), "skill draft");
        if (!Array.isArray(value.inputs) || value.inputs.length > 16) throw new Error("draft inputs must be an array of at most 16 entries");
        const inputs = value.inputs.map((entry, index) => {
            exactKeys(entry, new Set(["name", "type", "description", "required"]), `draft input ${index}`);
            const name = text(entry.name, "draft input name", MAX_INPUT_NAME, { required: true });
            if (!/^[A-Za-z][A-Za-z0-9 _-]{0,79}$/.test(name)) throw new Error("draft input name is invalid");
            if (entry.type !== "string") throw new Error("draft input type must be string");
            if (entry.required !== undefined && typeof entry.required !== "boolean") throw new Error("draft input required must be boolean");
            return {
                name,
                type: "string",
                description: text(entry.description ?? "", "draft input description", 240) ?? "",
                required: entry.required !== false,
            };
        });
        if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > MAX_ACTIONS) throw new Error("draft steps must be a non-empty bounded array");
        if (!Array.isArray(value.requestedCapabilities) || value.requestedCapabilities.length > 2) throw new Error("draft requestedCapabilities must be a bounded array");
        if (value.requestedCapabilities.some((entry) => !["computer", "workspace"].includes(entry))) throw new Error("draft requestedCapabilities contains an unsupported capability");
        if (!Array.isArray(value.validators) || value.validators.length > 24) throw new Error("draft validators must be a bounded array");
        const draft = {
            name: text(value.name, "draft name", MAX_NAME, { required: true }),
            description: text(value.description ?? "", "draft description", MAX_DESCRIPTION) ?? "",
            instructions: text(value.instructions, "draft instructions", 16_000, { required: true }),
            inputs,
            steps: value.steps.map((entry, index) => text(entry, `draft step ${index}`, 800, { required: true })),
            expectedOutput: text(value.expectedOutput ?? "", "draft expected output", 1_000) ?? "",
            requestedCapabilities: [...new Set(value.requestedCapabilities)],
            validators: value.validators.map((entry, index) => text(entry, `draft validator ${index}`, 500, { required: true })),
        };
        const serialized = JSON.stringify(draft);
        // A provider must never turn a Skill into a carrier for raw local paths or
        // one-shot credentials.  Reject suspicious values; do not silently rewrite them.
        if (/[A-Za-z]:[\\/]|\\\\(?:Users|home|tmp)[\\/]/i.test(serialized)
            || /(?:[?&](?:token|secret|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token)=|(?:bearer|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+)/i.test(serialized))
            throw new Error("draft contains a private path or credential-like value");
        return draft;
    }
    catch {
        return undefined;
    }
}

function sanitizeTestResult(value) {
    try {
        exactKeys(value, new Set(["mode", "actionCount", "validatorCount", "checks"]), "test result");
        const mode = text(value.mode, "test result mode", 80, { required: true });
        if (!Number.isInteger(value.actionCount) || value.actionCount < 1 || value.actionCount > MAX_ACTIONS) throw new Error("invalid test action count");
        if (!Number.isInteger(value.validatorCount) || value.validatorCount < 0 || value.validatorCount > MAX_ACTIONS) throw new Error("invalid test validator count");
        if (!Array.isArray(value.checks) || value.checks.length > MAX_ACTIONS) throw new Error("invalid test checks");
        return { mode, actionCount: value.actionCount, validatorCount: value.validatorCount, checks: value.checks.map((entry, index) => text(entry, `test check ${index}`, 180, { required: true })) };
    }
    catch {
        return undefined;
    }
}

function nowIso(now) {
    return new Date(now()).toISOString();
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
        testResult: session.testResult ? clone(session.testResult) : undefined,
    };
}

function safeResult(value) {
    if (!value || typeof value !== "object") return { ok: true };
    return { ok: true, ...(value.clicked ? { clicked: true } : {}), ...(value.typed ? { typed: true } : {}), ...(value.pressed ? { pressed: true } : {}), ...(value.scrolled ? { scrolled: true } : {}), ...(value.url ? { site: optionalSite(value.url) } : {}) };
}

function abortError(message = "operation cancelled") {
    const error = new Error(message);
    error.code = "TEACH_ONCE_CANCELLED";
    return error;
}

function normalizeReplaySnapshot(value) {
    if (!value || typeof value !== "object" || !Array.isArray(value.elements))
        throw new Error("computer test snapshot did not return semantic elements");
    const snapshotId = text(value.snapshotId, "test snapshotId", 160, { required: true });
    const elements = value.elements.map((entry) => {
        assertPlainObject(entry, "test snapshot element");
        const ref = text(entry.ref, "test snapshot ref", 160, { required: true });
        const locator = locatorForElement(entry);
        return {
            ref,
            ...locator,
            ...(entry.disabled === true ? { disabled: true } : {}),
            ...(entry.text ? { text: text(entry.text, "test element text", 2_000) } : {}),
        };
    });
    return { snapshotId, site: optionalSite(value.url), elements };
}

function normalizedMatch(value) {
    return String(value ?? "").trim().toLocaleLowerCase();
}

function matchesLocator(element, locator) {
    if (!locator) return true;
    if (locator.role && normalizedMatch(element.role) !== normalizedMatch(locator.role)) return false;
    if (locator.name && normalizedMatch(element.name) !== normalizedMatch(locator.name)) return false;
    if (locator.type && normalizedMatch(element.type) !== normalizedMatch(locator.type)) return false;
    return true;
}

function targetMatches(element, target) {
    const wanted = normalizedMatch(target);
    if (!wanted) return true;
    const name = normalizedMatch(element.name);
    const textValue = normalizedMatch(element.text);
    const role = normalizedMatch(element.role);
    return name === wanted || textValue === wanted || name.includes(wanted) || textValue.includes(wanted) || `${role} ${name}`.includes(wanted);
}

function resolveReplayElement(snapshot, action, { assertion = false } = {}) {
    let candidates;
    if (action.locator) {
        candidates = snapshot.elements.filter((element) => matchesLocator(element, action.locator));
    }
    else {
        candidates = snapshot.elements.filter((element) => targetMatches(element, action.target));
    }

    if (assertion && !candidates.length && action.expectedOutput)
        candidates = snapshot.elements.filter((element) => targetMatches(element, action.expectedOutput));

    if (!candidates.length) throw new Error(`semantic target not found: ${action.target || action.expectedOutput || "current page"}`);
    if (candidates.length > 1) throw new Error(`semantic target is ambiguous: ${action.target || action.expectedOutput || "current page"}`);
    return candidates[0];
}

function testInputValue(action) {
    // Demonstration values are intentionally never persisted or replayed.  A test uses a
    // deterministic non-secret placeholder so the real Computer path is exercised without
    // asking the model or the test runner to invent credentials.
    return action.sensitive ? "Teach Once test value" : `Teach Once ${action.inputName} value`;
}

function waitWithSignal(milliseconds, signal, deadline) {
    if (!milliseconds) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let settled = false;
        const remaining = Math.max(0, Math.min(milliseconds, deadline - Date.now()));
        const timer = setTimeout(() => finish(), remaining);
        const onAbort = () => finish(abortError());
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else if (Date.now() >= deadline && remaining < milliseconds) reject(new Error("Teach Once test timed out"));
            else resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) finish(abortError());
    });
}

async function replayActions(session, { computer, agentId, taskId, signal, onProgress, deadline = Date.now() + MAX_TEST_MS } = {}) {
    if (!computer?.snapshot || !computer?.navigate) throw new Error("Teach Once test requires a governed Computer executor");
    const checks = [];
    let validatorCount = 0;
    let snapshot;
    const checkBudget = () => {
        if (signal?.aborted) throw abortError();
        if (Date.now() >= deadline) throw new Error("Teach Once test timed out");
    };
    const read = async () => {
        checkBudget();
        snapshot = normalizeReplaySnapshot(await computer.snapshot(agentId, taskId));
        checkBudget();
        return snapshot;
    };
    const report = (index, action, status = "completed") => {
        onProgress?.({ step: index + 1, total: session.actions.length, kind: action.kind, status });
    };

    for (const [index, action] of session.actions.entries()) {
        checkBudget();
        if (action.kind === "navigate") {
            const url = action.url ?? safeReplayUrl(undefined, action.site);
            await computer.navigate(agentId, taskId, url);
            snapshot = undefined;
        }
        else if (action.kind === "click") {
            const current = await read();
            const element = resolveReplayElement(current, action);
            if (element.disabled) throw new Error(`semantic target is disabled: ${action.target}`);
            await computer.click(agentId, taskId, { snapshotId: current.snapshotId, ref: element.ref });
        }
        else if (action.kind === "type") {
            const current = await read();
            const element = resolveReplayElement(current, action);
            if (element.disabled) throw new Error(`semantic input is disabled: ${action.target}`);
            await computer.type(agentId, taskId, { snapshotId: current.snapshotId, ref: element.ref, text: testInputValue(action) });
        }
        else if (action.kind === "key") {
            const current = await read();
            const element = action.locator ? resolveReplayElement(current, action) : undefined;
            await computer.key(agentId, taskId, { snapshotId: current.snapshotId, ...(element ? { ref: element.ref } : {}), key: action.key });
        }
        else if (action.kind === "scroll") {
            await read();
            await computer.scroll(agentId, taskId, { deltaX: 0, deltaY: action.direction === "down" ? action.amount * 600 : -action.amount * 600 });
        }
        else if (action.kind === "wait") {
            await waitWithSignal(action.milliseconds, signal, deadline);
        }
        else if (action.kind === "assert") {
            validatorCount += 1;
            const current = await read();
            if (action.validator === "manual") {
                report(index, action, "awaiting-confirmation");
                return { ok: false, status: "awaiting-confirmation", checks, validatorCount };
            }
            const element = resolveReplayElement(current, action, { assertion: true });
            const observed = String(element.text ?? element.name ?? "");
            const expected = String(action.expectedOutput ?? action.target ?? "");
            const passed = action.validator === "exists"
                ? true
                : action.validator === "contains"
                    ? observed.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
                    : observed === expected;
            if (!passed) throw new Error(`validator ${action.validator} failed for ${action.target}`);
        }
        else {
            throw new Error(`unsupported replay action: ${action.kind}`);
        }
        checks.push(`${index + 1}: ${action.kind}${action.kind === "assert" ? `/${action.validator}` : ""} passed`);
        report(index, action);
    }
    return { ok: true, checks, validatorCount };
}

export function createTeachOnceController({
    dataDir,
    coworkerStore,
    skillStore,
    rawComputer,
    getAgentId,
    generateDraft,
    testExecutor,
    now = () => Date.now(),
    makeId: makeSessionId = makeId,
    persistPath,
    testTimeoutMs = MAX_TEST_MS,
} = {}) {
    if (!dataDir) throw new Error("teach-once controller requires dataDir");
    if (!coworkerStore?.get || !skillStore?.create) throw new Error("teach-once controller requires stores");
    if (!rawComputer?.snapshot || !rawComputer?.navigate) throw new Error("teach-once controller requires governed computer");
    if (typeof getAgentId !== "function") throw new Error("teach-once controller requires getAgentId");
    if (typeof generateDraft !== "function") throw new Error("teach-once controller requires a Coworker draft generator");
    if (!Number.isInteger(testTimeoutMs) || testTimeoutMs < 1 || testTimeoutMs > MAX_TEST_MS) throw new Error(`teach test timeout must be 1-${MAX_TEST_MS} milliseconds`);
    persistPath = persistPath ?? join(dataDir, "desktop-state", "teach-once.json");

    const loaded = loadJsonState(persistPath, null);
    const sessions = loaded?.schema === TEACH_ONCE_SCHEMA && Array.isArray(loaded.sessions)
        ? loaded.sessions.map(sanitizeSession).filter(Boolean).slice(-MAX_SESSIONS)
        : [];
    const snapshots = new Map();
    const inFlight = new Map();
    const activeTests = new Map();
    const draftGenerator = generateDraft;
    const runTest = typeof testExecutor === "function"
        ? testExecutor
        : async ({ session, agentId, signal, execute, onProgress }) => execute({ computer: rawComputer, agentId, taskId: session.id, signal, onProgress });

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

    function releaseOperation(sessionId) {
        inFlight.delete(sessionId);
        for (const [agentId, value] of activeTests.entries()) {
            if (value.sessionId === sessionId) activeTests.delete(agentId);
        }
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
                actionInput = { kind, site, url: safeReplayUrl(url, site), target: actionTarget(input.target, `site:${site}`) };
            }
            else if (kind === "click") {
                if (!snapshot) throw new Error("read the current screen before recording a click");
                const ref = text(input.ref, "element ref", 160, { required: true });
                const element = snapshot.elements.find((entry) => entry.ref === ref);
                if (!element) throw new Error("element ref is not in the current semantic snapshot");
                result = await rawComputer.click(agentId, session.id, { snapshotId: snapshot.snapshotId, ref });
                actionInput = { kind, locator: locatorForElement(element), target: actionTarget(input.target, element.name || `${element.role} target`), ...(input.app ? { app: text(input.app, "action app", 120) } : {}), ...(snapshot.site ? { site: snapshot.site } : {}) };
            }
            else if (kind === "type") {
                if (!snapshot) throw new Error("read the current screen before recording text input");
                const ref = text(input.ref, "element ref", 160, { required: true });
                const element = snapshot.elements.find((entry) => entry.ref === ref);
                if (!element) throw new Error("element ref is not in the current semantic snapshot");
                const value = text(input.text, "demo input", MAX_INPUT_TEXT, { required: true });
                const inputName = text(input.inputName, "inputName", MAX_INPUT_NAME, { required: true });
                result = await rawComputer.type(agentId, session.id, { snapshotId: snapshot.snapshotId, ref, text: value });
                actionInput = { kind, locator: locatorForElement(element), inputName, sensitive: input.sensitive === true, target: actionTarget(input.target, element.name || `${element.role} field`), ...(input.app ? { app: text(input.app, "action app", 120) } : {}), ...(snapshot.site ? { site: snapshot.site } : {}) };
            }
            else if (kind === "key") {
                const key = text(input.key, "key", 32, { required: true });
                if (!KEYS.has(key) && !/^[A-Za-z0-9]$/.test(key)) throw new Error("key is not a supported semantic key");
                if (input.ref !== undefined) {
                    if (!snapshot) throw new Error("read the current screen before recording a key target");
                    const ref = text(input.ref, "element ref", 160, { required: true });
                    if (!snapshot.elements.some((entry) => entry.ref === ref)) throw new Error("element ref is not in the current semantic snapshot");
                    const element = snapshot.elements.find((entry) => entry.ref === ref);
                    actionInput = { kind, key, locator: locatorForElement(element), target: actionTarget(input.target, "current semantic target") };
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
            const existing = inFlight.get(session.id);
            if (existing?.kind === "generate") return existing.promise;
            const previousState = session.state;
            const controller = new AbortController();
            session.state = "generating";
            touch(session);
            const operation = (async () => {
                try {
                    const coworker = coworkerStore.get(session.coworkerId);
                    const generated = await draftGenerator({ session: clone(session), coworker: clone(coworker), signal: controller.signal });
                    const candidate = generated?.draft ?? generated;
                    const draft = sanitizeDraft(candidate);
                    if (!draft) throw new Error("provider returned an invalid structured SkillDraft");
                    if (session.state === "cancelled" || controller.signal.aborted) throw abortError();
                    session.draft = draft;
                    session.testResult = undefined;
                    session.state = "drafted";
                    touch(session);
                    return {
                        session: publicSession(session),
                        draft: clone(session.draft),
                        generation: { mode: "coworker-model" },
                    };
                }
                catch (error) {
                    if (session.state !== "cancelled") {
                        session.state = previousState;
                        touch(session);
                    }
                    throw error?.code === "TEACH_ONCE_CANCELLED"
                        ? error
                        : new Error(`Skill draft generation failed: ${String(error?.message ?? error).slice(0, 300)}`);
                }
                finally {
                    releaseOperation(session.id);
                }
            })();
            inFlight.set(session.id, { kind: "generate", controller, promise: operation });
            return operation;
        },

        test(sessionId) {
            const session = requireSession(sessionId);
            if (session.state !== "drafted" && session.state !== "tested") throw new Error(`teach session is ${session.state}; create a draft first`);
            if (!session.draft) throw new Error("skill draft is missing");
            if (!session.draft.steps.length) throw new Error("skill draft has no steps to test");
            const existing = inFlight.get(session.id);
            if (existing?.kind === "test") return existing.promise;
            const agentId = requireAgent(session);
            const active = activeTests.get(agentId);
            if (active && active.sessionId !== session.id) throw new Error("Computer lane is already testing another Skill");
            const controller = new AbortController();
            const deadline = Date.now() + testTimeoutMs;
            const timeout = setTimeout(() => controller.abort(), testTimeoutMs);
            activeTests.set(agentId, { sessionId: session.id, controller });
            session.state = "testing";
            session.testedAt = undefined;
            session.testResult = undefined;
            touch(session);
            const operation = (async () => {
                try {
                    const result = await runTest({
                        session: clone(session),
                        agentId,
                        signal: controller.signal,
                        onProgress: () => undefined,
                        execute: ({ computer, taskId, signal, onProgress: executorProgress }) => replayActions(session, {
                            computer,
                            agentId,
                            taskId,
                            signal: signal ?? controller.signal,
                            onProgress: executorProgress,
                            deadline,
                        }),
                    });
                    if (result?.status === "awaiting-confirmation") {
                        session.state = "drafted";
                        touch(session);
                        return {
                            ok: false,
                            mode: "governed-computer",
                            status: "awaiting-confirmation",
                            session: publicSession(session),
                            draft: clone(session.draft),
                        };
                    }
                    if (!result?.ok) throw new Error("governed Skill test did not complete");
                    const checks = Array.isArray(result.checks) ? result.checks.slice(0, MAX_ACTIONS).map((entry, index) => text(entry, `test check ${index}`, 180, { required: true })) : [];
                    if (checks.length !== session.actions.length) throw new Error("governed Skill test returned incomplete evidence");
                    session.state = "tested";
                    session.testedAt = nowIso(now);
                    session.testResult = {
                        mode: "governed-computer",
                        actionCount: session.actions.length,
                        validatorCount: Number.isInteger(result.validatorCount) ? result.validatorCount : session.actions.filter((entry) => entry.kind === "assert").length,
                        checks,
                    };
                    touch(session);
                    return { ok: true, mode: "governed-computer", checks: clone(checks), session: publicSession(session), draft: clone(session.draft) };
                }
                catch (error) {
                    if (session.state !== "cancelled") {
                        session.state = "drafted";
                        touch(session);
                    }
                    throw error?.code === "TEACH_ONCE_CANCELLED"
                        ? error
                        : new Error(`governed Skill test failed: ${String(error?.message ?? error).slice(0, 300)}`);
                }
                finally {
                    clearTimeout(timeout);
                    releaseOperation(session.id);
                }
            })();
            inFlight.set(session.id, { kind: "test", controller, promise: operation });
            return operation;
        },

        save(sessionId) {
            const session = requireSession(sessionId);
            if (session.state !== "tested" && session.state !== "saved") throw new Error("test the skill draft before saving it");
            if (session.savedSkillId) {
                return { skill: skillStore.get(session.savedSkillId), session: publicSession(session) };
            }
            const skill = skillStore.create({ ...session.draft, source: "taught", lastTestedAt: session.testedAt });
            session.savedSkillId = skill.id;
            session.state = "saved";
            touch(session);
            return { skill, session: publicSession(session) };
        },

        async cancel(sessionId) {
            const session = requireSession(sessionId);
            const operation = inFlight.get(session.id);
            operation?.controller.abort();
            session.state = "cancelled";
            touch(session);
            snapshots.delete(session.id);
            if (operation) void operation.promise.catch(() => undefined);
            return publicSession(session);
        },
    };
}
