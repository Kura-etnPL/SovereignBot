import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SidecarComputerDriver } from "../../vendor/core/src/sidecar-computer-driver.js";
import { accountIsolationNamespace } from "./provider-account.js";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

const HOME_URL = "https://antigravity.google/";
const LOGIN_URL = "https://antigravity.google/";
const MAX_TEXT = 20_000;
const MAX_STATE_REF = 512;
const ANTIGRAVITY_HOSTS = new Set(["antigravity.google", "www.antigravity.google"]);
const ACCOUNT_SLOTS = Object.freeze({ A: "account-a", B: "account-b", C: "account-c" });

export const ANTIGRAVITY_ACCOUNT_SLOTS = Object.freeze(["A", "B", "C"]);

function safeNamespace(value) {
    if (typeof value !== "string" || !/^provider-account-[a-f0-9]{32}$/.test(value))
        throw new Error("Antigravity provider account namespace is invalid");
    return value;
}

export function antigravityAccountNamespace(slot = "A") {
    if (!Object.hasOwn(ACCOUNT_SLOTS, slot)) throw new Error("Antigravity account slot must be A, B, or C");
    return accountIsolationNamespace("antigravity", ACCOUNT_SLOTS[slot]);
}

function compact(value, max = MAX_TEXT) { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max); }
function driverText(driver) { return Promise.resolve(driver.text?.()).then((value) => compact(value?.text ?? value)); }
function errorWithCode(message, code) { const error = new Error(message); error.code = code; return error; }
function ensureSignal(signal) { if (signal?.aborted) throw errorWithCode("Antigravity task cancelled", "CANCELLED"); }
function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        const abort = () => { clearTimeout(timer); reject(errorWithCode("Antigravity task cancelled", "CANCELLED")); };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
    });
}
function allowedContinuationUrl(value) {
    try {
        const url = new URL(String(value));
        if (url.protocol !== "https:" || !ANTIGRAVITY_HOSTS.has(url.hostname.toLowerCase())) return undefined;
        return url.toString();
    } catch { return undefined; }
}
function classifyPage(text) {
    const value = compact(text, 16_000).toLowerCase();
    if (/rate.?limit|too many requests|usage limit|capacity|quota|try again later/.test(value))
        return { health: "capacity-limited", auth: "signed-in", reason: "Antigravity capacity is limited; retry later." };
    if (/log in|login|sign up|welcome back|continue with google|not authenticated|sign in/.test(value))
        return { health: "signed-out", auth: "signed-out", reason: "Sign in to Antigravity." };
    return { health: "ready", auth: "signed-in" };
}
function promptFor(request) {
    const context = Array.isArray(request.conversation) && request.conversation.length
        ? `\nConversation context:\n${request.conversation.map((entry) => `${entry.sender}: ${entry.text}`).join("\n")}` : "";
    return `${request.instruction}${context}`.slice(0, MAX_TEXT);
}
function findComposer(snapshot) {
    return snapshot?.elements?.find((element) => !element.disabled && element.role === "textbox" && /message|prompt|chat|ask|task|command/i.test(`${element.name} ${element.type ?? ""}`))
        ?? snapshot?.elements?.find((element) => !element.disabled && element.role === "textbox");
}
function responseDelta(before, after) {
    const previous = compact(before), current = compact(after);
    if (!current || current === previous) return "";
    if (previous && current.startsWith(previous)) return current.slice(previous.length).trim();
    return current;
}

export class AntigravityProvider {
    #driver;
    #statePath;
    #accountNamespace;
    #timeoutMs;
    #pollMs;
    #busy = false;

    constructor({ accountNamespace, profileDir, driver, driverConfig = {}, timeoutMs = 90_000, pollMs = 150 } = {}) {
        this.#accountNamespace = safeNamespace(accountNamespace);
        if (!profileDir && !driver) throw new Error("Antigravity provider requires a dedicated profile");
        if (!driver) mkdirSync(profileDir, { recursive: true });
        this.#driver = driver ?? new SidecarComputerDriver({ agentId: this.#accountNamespace, profileDir, workspaceDir: profileDir }, { ...driverConfig, headless: true });
        this.#statePath = profileDir ? join(profileDir, "provider-state.json") : undefined;
        this.#timeoutMs = timeoutMs;
        this.#pollMs = pollMs;
    }

    capabilities() { return ["chat", "continuation", "cancellation", "account-isolation"]; }
    models() { return ["antigravity"]; }

    async health() {
        try {
            const transport = await this.#driver.health?.();
            const page = classifyPage(await driverText(this.#driver));
            return { found: true, health: page.health, auth: { state: page.auth }, capabilities: this.capabilities(), models: this.models(), ...(page.reason ? { reason: page.reason } : {}), ...(transport?.browser ? { browser: String(transport.browser).slice(0, 32) } : {}) };
        } catch (error) {
            return { found: false, health: "unavailable", auth: { state: "unverified" }, reason: String(error?.message ?? error).slice(0, 240), capabilities: this.capabilities(), models: this.models() };
        }
    }
    async start(request) { return this.#send(request, undefined); }
    async continue(request) {
        const state = this.#readState();
        if (!state || state.continuationRef !== request?.continuationRef)
            throw errorWithCode("Antigravity continuation does not belong to this provider account", "CONTINUITY_MISMATCH");
        const url = allowedContinuationUrl(state.url);
        if (!url) throw errorWithCode("Antigravity continuation is unavailable", "CONTINUITY_UNAVAILABLE");
        await this.#driver.navigate(url);
        return this.#send(request, state.continuationRef);
    }
    async cancel() { try { await this.#driver.key?.({ key: "Escape" }); } catch {} this.#busy = false; return { cancelled: true }; }

    async #send(request, priorRef) {
        if (this.#busy) throw errorWithCode("Antigravity provider is busy", "BUSY");
        this.#busy = true;
        try {
            ensureSignal(request?.signal);
            if (request?.model !== undefined && request.model !== "antigravity")
                throw errorWithCode("Antigravity model is not available", "MODEL_UNAVAILABLE");
            if (!priorRef && !allowedContinuationUrl(await this.#currentUrl())) await this.#driver.navigate(HOME_URL);
            const before = await driverText(this.#driver);
            const page = classifyPage(before);
            if (page.health === "signed-out") throw errorWithCode("Sign in to Antigravity.", "SIGN_IN_REQUIRED");
            if (page.health === "capacity-limited") throw errorWithCode(page.reason, "CAPACITY_LIMITED");
            const composer = findComposer(await this.#driver.snapshot());
            if (!composer) throw errorWithCode("Antigravity composer is unavailable", "UNAVAILABLE");
            await this.#driver.type({ element: composer, text: promptFor(request) });
            await this.#driver.key({ element: composer, key: "Enter" });
            const deadline = Date.now() + this.#timeoutMs;
            while (Date.now() < deadline) {
                ensureSignal(request?.signal);
                const latest = await driverText(this.#driver);
                const state = classifyPage(latest);
                if (state.health === "capacity-limited") throw errorWithCode(state.reason, "CAPACITY_LIMITED");
                const answer = responseDelta(before, latest);
                if (answer && state.health !== "signed-out") {
                    const continuationRef = priorRef ?? `continuation-${randomUUID()}`;
                    this.#writeState({ continuationRef, url: allowedContinuationUrl(await this.#currentUrl()) ?? HOME_URL });
                    return { text: answer, continuationRef };
                }
                await wait(this.#pollMs, request?.signal);
            }
            throw errorWithCode("Antigravity response timed out", "TIMEOUT");
        } finally { this.#busy = false; }
    }
    #readState() {
        if (!this.#statePath || !existsSync(this.#statePath)) return undefined;
        const value = loadJsonState(this.#statePath, undefined);
        return value && typeof value.continuationRef === "string" && value.continuationRef.length <= MAX_STATE_REF ? { continuationRef: value.continuationRef, url: value.url } : undefined;
    }
    #writeState(value) { if (this.#statePath) saveJsonState(this.#statePath, { schema: "sovereignbot.antigravity.profile.v1", ...value }); }
    async #currentUrl() {
        if (typeof this.#driver.currentUrl === "function") return Promise.resolve(this.#driver.currentUrl()).catch(() => "");
        try { return (await this.#driver.snapshot()).url ?? ""; } catch { return ""; }
    }
}

export function createAntigravityProviderFactory({ dataDir, driverConfig = {}, driverFactory } = {}) {
    if (!dataDir) throw new Error("Antigravity provider factory requires dataDir");
    const providers = new Map(), providerDrivers = new Map(), loginDrivers = new Map();
    const root = join(dataDir, "desktop-state", "provider-profiles", "antigravity");
    const get = (accountNamespace) => {
        const namespace = safeNamespace(accountNamespace);
        if (!providers.has(namespace)) {
            const profileDir = join(root, namespace);
            const driver = driverFactory?.({ accountNamespace: namespace, profileDir, mode: "headless" });
            providerDrivers.set(namespace, driver);
            providers.set(namespace, new AntigravityProvider({ accountNamespace: namespace, profileDir, driver, driverConfig }));
        }
        return providers.get(namespace);
    };
    return {
        get,
        async openLogin(accountNamespace) {
            const namespace = safeNamespace(accountNamespace);
            let driver = loginDrivers.get(namespace);
            if (!driver) {
                const profileDir = join(root, namespace);
                driver = driverFactory?.({ accountNamespace: namespace, profileDir, mode: "login" }) ?? new SidecarComputerDriver({ agentId: namespace, profileDir, workspaceDir: profileDir }, { ...driverConfig, headless: false });
                loginDrivers.set(namespace, driver);
            }
            await driver.navigate(LOGIN_URL);
            return { opened: true };
        },
        async health(accountNamespace) { return get(accountNamespace).health(); },
        async accounts() {
            return Promise.all(Object.entries(ACCOUNT_SLOTS).map(async ([slot]) => {
                const result = await get(antigravityAccountNamespace(slot)).health();
                return { slot, health: result.health, authState: result.auth?.state, ...(result.reason ? { reason: result.reason } : {}), ...(result.capabilities ? { capabilities: result.capabilities } : {}), ...(result.models ? { models: result.models } : {}) };
            }));
        },
        async close() { await Promise.allSettled([...providerDrivers.values()].map((driver) => driver?.close?.()).concat([...loginDrivers.values()].map((driver) => driver?.close?.()))); },
    };
}
