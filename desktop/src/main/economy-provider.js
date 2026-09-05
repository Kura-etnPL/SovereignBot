import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { saveJsonState } from "./lib/desktop-state.js";

export const ECONOMY_MODES = Object.freeze(["free", "fixed-subscription", "local", "metered"]);
const MAX_ID = 128;
const MAX_MONEY = 1_000_000_000;
const ECONOMY_SCHEMA = "sovereignbot.desktop.economy-usage.v1";
const PRIVATE_RESULT_KEYS = new Set(["provider", "providerId", "accountId", "accountNamespace", "budget", "spendCap", "usage", "cost", "sessionId", "cookies", "storageState"]);

function errorWithCode(code, message) {
    const error = new Error(`[ECONOMY:${code}] ${message}`);
    error.code = code;
    return error;
}

function opaqueId(value, label = "provider id") {
    if (typeof value !== "string" || !value.trim() || value.length > MAX_ID || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
        throw new Error(`${label} must be a safe opaque identifier`);
    return value;
}

function money(value, label, { required = false } = {}) {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_MONEY)
        throw new Error(`${label} must be a finite number from 0 to ${MAX_MONEY}`);
    return Math.round(value * 1_000_000) / 1_000_000;
}

function stringList(value, label) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 32) throw new Error(`${label} must be an array of at most 32 identifiers`);
    return [...new Set(value.map((entry) => opaqueId(entry, label)))];
}

function normalizeConfig(config = {}) {
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Economy config must be an object");
    const providers = Array.isArray(config.providers) ? config.providers.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Economy provider must be an object");
        const id = opaqueId(entry.id);
        const mode = entry.mode ?? "fixed-subscription";
        if (!ECONOMY_MODES.includes(mode)) throw new Error(`Economy provider ${id} mode is invalid`);
        return {
            id,
            mode,
            enabled: entry.enabled !== false,
            model: opaqueId(entry.model ?? "economy", `Economy provider ${id} model`),
            capabilities: stringList(entry.capabilities, `Economy provider ${id} capabilities`) ?? ["chat", "continuation", "cancellation"],
        };
    }) : [];
    if (new Set(providers.map((entry) => entry.id)).size !== providers.length) throw new Error("Economy provider ids must be unique");
    const rawMetered = config.metered ?? {};
    if (!rawMetered || typeof rawMetered !== "object" || Array.isArray(rawMetered)) throw new Error("Economy metered config must be an object");
    const metered = {
        enabled: rawMetered.enabled === true,
        budget: money(rawMetered.budget ?? 0, "Economy metered budget", { required: true }),
        perRunCap: money(rawMetered.perRunCap ?? 0, "Economy metered perRunCap", { required: true }),
        totalCap: money(rawMetered.totalCap ?? 0, "Economy metered totalCap", { required: true }),
    };
    return { providers, metered };
}

function assertAdapter(adapter, providerId) {
    if (!adapter || typeof adapter !== "object") throw new Error(`Economy provider ${providerId} adapter is missing`);
    for (const method of ["capabilities", "models", "health", "start", "continue", "cancel"])
        if (typeof adapter[method] !== "function") throw new Error(`Economy provider ${providerId} adapter must implement ${method}`);
}

function safeResult(result, providerId) {
    if (!result || typeof result !== "object" || Array.isArray(result)) throw errorWithCode("INVALID_RESULT", `Economy provider ${providerId} returned an invalid result`);
    for (const key of PRIVATE_RESULT_KEYS)
        if (Object.hasOwn(result, key)) throw errorWithCode("INVALID_RESULT", `Economy provider ${providerId} returned a private field`);
    const text = result.text ?? result.output?.text;
    if (typeof text !== "string" || !text.trim()) throw errorWithCode("INVALID_RESULT", `Economy provider ${providerId} returned no text`);
    if (result.continuationRef !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(String(result.continuationRef)))
        throw errorWithCode("INVALID_RESULT", `Economy provider ${providerId} returned an invalid continuation`);
    return { text: text.slice(0, 20_000), ...(result.continuationRef === undefined ? {} : { continuationRef: String(result.continuationRef) }) };
}

function safeHealth(value, entry, capabilities, models) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { found: false, health: "unavailable" };
    const health = ["ready", "signed-out", "capacity-limited", "unavailable"].includes(value.health) ? value.health : "unavailable";
    return {
        found: value.found === true,
        health,
        ...(value.reason ? { reason: String(value.reason).slice(0, 300) } : {}),
        capabilities,
        models,
    };
}

function safeList(values, fallback) {
    const list = typeof values === "function" ? values() : values;
    return Array.isArray(list) ? [...new Set(list.filter((entry) => typeof entry === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry)).slice(0, 32))] : fallback;
}

function createUsageLedger(path) {
    let persisted;
    if (existsSync(path)) {
        try { persisted = JSON.parse(readFileSync(path, "utf8")); }
        catch { throw errorWithCode("LEDGER_CORRUPT", "Economy usage ledger cannot be parsed; execution is blocked"); }
        if (!persisted || persisted.schema !== ECONOMY_SCHEMA || !Number.isInteger(persisted.sequence) || persisted.sequence < 0 || !Number.isFinite(persisted.spent) || persisted.spent < 0 || !persisted.reservations || typeof persisted.reservations !== "object" || Array.isArray(persisted.reservations) || !persisted.entries || typeof persisted.entries !== "object" || Array.isArray(persisted.entries))
            throw errorWithCode("LEDGER_CORRUPT", "Economy usage ledger is invalid; execution is blocked");
    }
    const state = persisted
        ? { schema: ECONOMY_SCHEMA, sequence: persisted.sequence, spent: persisted.spent, reservations: { ...persisted.reservations }, entries: { ...persisted.entries } }
        : { schema: ECONOMY_SCHEMA, sequence: 0, spent: 0, reservations: {}, entries: {} };
    const persist = () => { state.sequence += 1; saveJsonState(path, state); };
    const activeReservation = (taskId) => state.reservations[taskId];
    return {
        reserve({ taskId, providerId, budget, perRunCap, totalCap }) {
            const id = opaqueId(taskId, "task id");
            const existing = activeReservation(id);
            if (existing) return { ...existing, reused: true };
            if (!Number.isFinite(perRunCap) || perRunCap <= 0) throw errorWithCode("SPEND_CAP_INVALID", "Metered per-run spend cap must be greater than zero");
            if (state.spent + Object.values(state.reservations).reduce((sum, entry) => sum + entry.amount, 0) + perRunCap > budget)
                throw errorWithCode("BUDGET_EXHAUSTED", "Metered remaining budget is below the per-run cap");
            if (state.spent + Object.values(state.reservations).reduce((sum, entry) => sum + entry.amount, 0) + perRunCap > totalCap)
                throw errorWithCode("TOTAL_CAP_EXCEEDED", "Metered total spend cap would be exceeded");
            const reservation = { providerId, amount: perRunCap, reservedAt: new Date().toISOString(), sequence: state.sequence + 1 };
            state.reservations[id] = reservation;
            persist();
            return { ...reservation, reused: false };
        },
        settle(taskId, { success }) {
            const id = opaqueId(taskId, "task id");
            const reservation = state.reservations[id];
            if (!reservation) return { charged: 0, released: 0 };
            delete state.reservations[id];
            if (success) {
                state.spent += reservation.amount;
                state.entries[id] = { providerId: reservation.providerId, amount: reservation.amount, settledAt: new Date().toISOString(), outcome: "completed" };
                persist();
                return { charged: reservation.amount, released: 0 };
            }
            state.entries[id] = { providerId: reservation.providerId, amount: 0, settledAt: new Date().toISOString(), outcome: "released" };
            persist();
            return { charged: 0, released: reservation.amount };
        },
        snapshot() {
            return { schema: ECONOMY_SCHEMA, spent: state.spent, reserved: Object.values(state.reservations).reduce((sum, entry) => sum + entry.amount, 0), entries: structuredClone(state.entries) };
        },
    };
}

class EconomyProvider {
    constructor({ entry, adapter, metered, ledger }) {
        this.entry = entry;
        this.adapter = adapter;
        this.metered = metered;
        this.ledger = ledger;
        this.active = new Map();
        this._capabilities = safeList(adapter.capabilities, entry.capabilities);
        this._models = safeList(adapter.models, [entry.model]);
        if (!this._models.includes(entry.model)) throw new Error(`Economy provider ${entry.id} does not advertise its configured model`);
    }

    capabilities() { return [...this._capabilities, ...(this.metered ? ["trusted-budget"] : [])]; }
    models() { return [...this._models]; }
    async health() {
        if (!this.entry.enabled) return { found: false, health: "unavailable", reason: "Economy provider is disabled" };
        if (this.metered && !this.metered.enabled) return { found: false, health: "unavailable", reason: "Metered Economy provider is disabled by trusted configuration" };
        try { return safeHealth(await this.adapter.health(), this.entry, this.capabilities(), this.models()); }
        catch (error) { return { found: false, health: "unavailable", reason: String(error?.message ?? error).slice(0, 300), capabilities: this.capabilities(), models: this.models() }; }
    }
    start(request) { return this.#execute("start", request); }
    continue(request) { return this.#execute("continue", request); }
    async cancel(request = {}) {
        const taskId = String(request.taskId ?? "");
        const active = this.active.get(taskId);
        if (active) active.cancelled = true;
        try { await this.adapter.cancel({ taskId, continuationRef: request.continuationRef }); }
        finally { if (this.metered && taskId) this.ledger.settle(taskId, { success: false }); }
        return { cancelled: true };
    }
    async #execute(method, request = {}) {
        const taskId = opaqueId(request.taskId, "task id");
        const trustedRequest = {
            taskId,
            title: request.title,
            instruction: request.instruction,
            conversation: Array.isArray(request.conversation) ? request.conversation : [],
            model: this.entry.model,
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.continuationRef ? { continuationRef: request.continuationRef } : {}),
        };
        let reservation;
        if (this.metered) {
            if (!this.metered.enabled) throw errorWithCode("METERED_DISABLED", "Metered Economy execution is disabled");
            reservation = this.ledger.reserve({ taskId, providerId: this.entry.id, budget: this.metered.budget, perRunCap: this.metered.perRunCap, totalCap: this.metered.totalCap });
        }
        this.active.set(taskId, { cancelled: false, reservation });
        try {
            const result = await this.adapter[method](trustedRequest);
            if (this.active.get(taskId)?.cancelled) throw errorWithCode("CANCELLED", "Economy task cancelled");
            const safe = safeResult(result, this.entry.id);
            if (this.metered) this.ledger.settle(taskId, { success: true });
            return safe;
        }
        catch (error) {
            if (this.metered) this.ledger.settle(taskId, { success: false });
            throw error;
        }
        finally { this.active.delete(taskId); }
    }
}

export function createEconomyProviderFactory({ dataDir, config = {}, adapterFactory, ledgerPath } = {}) {
    if (!dataDir) throw new Error("Economy provider factory requires dataDir");
    const normalized = normalizeConfig(config);
    const ledger = createUsageLedger(ledgerPath ?? join(dataDir, "desktop-state", "economy-usage.json"));
    const providers = new Map();
    const entries = new Map(normalized.providers.map((entry) => [entry.id, entry]));
    const register = (providerId, adapter) => {
        const id = opaqueId(providerId);
        const entry = entries.get(id);
        if (!entry) throw new Error(`Economy provider ${id} is not configured`);
        assertAdapter(adapter, id);
        providers.set(id, new EconomyProvider({ entry, adapter, metered: entry.mode === "metered" ? normalized.metered : undefined, ledger }));
    };
    for (const entry of normalized.providers) {
        if (!entry.enabled) continue;
        const adapter = adapterFactory?.({ providerId: entry.id, mode: entry.mode, model: entry.model });
        if (adapter) register(entry.id, adapter);
    }
    const defaultProviderId = () => [...normalized.providers].find((entry) => entry.enabled && providers.has(entry.id) && (entry.mode !== "metered" || normalized.metered.enabled))?.id;
    const provider = (providerId = defaultProviderId()) => {
        if (!providerId || !providers.has(providerId)) throw errorWithCode("UNAVAILABLE", "No configured Economy provider is available");
        const entry = entries.get(providerId);
        if (entry.mode === "metered" && !normalized.metered.enabled) throw errorWithCode("METERED_DISABLED", "Metered Economy execution is disabled");
        return providers.get(providerId);
    };
    return {
        get: provider,
        register,
        defaultProviderId,
        configured() { return normalized.providers.length > 0; },
        available() { return Boolean(defaultProviderId()); },
        async health() {
            const id = defaultProviderId();
            if (!id) return { found: false, health: "unavailable", reason: normalized.providers.length ? "No configured Economy provider is enabled and available" : "No Economy provider is configured", capabilities: [], models: [] };
            const result = await providers.get(id).health();
            return { providerId: id, ...result };
        },
        async capabilities(providerId) { return provider(providerId).capabilities(); },
        async models(providerId) { return provider(providerId).models(); },
        usageSnapshot() { return ledger.snapshot(); },
        async close() { await Promise.allSettled([...providers.values()].map((entry) => entry.adapter?.close?.())); },
    };
}
