import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SidecarComputerDriver } from "../../vendor/core/src/sidecar-computer-driver.js";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

const HOME_URL = "https://chatgpt.com/";
const LOGIN_URL = "https://chatgpt.com/auth/login";
const MAX_TEXT = 20_000;
const MAX_STATE_REF = 512;
const CHATGPT_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com"]);

function safeNamespace(value) {
    if (typeof value !== "string" || !/^provider-account-[a-f0-9]{32}$/.test(value))
        throw new Error("ChatGPT Web provider account namespace is invalid");
    return value;
}

function errorWithCode(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function ensureSignal(signal) {
    if (signal?.aborted)
        throw errorWithCode("ChatGPT Web task cancelled", "CANCELLED");
}

function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const timer = setTimeout(done, ms);
        const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(errorWithCode("ChatGPT Web task cancelled", "CANCELLED"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
    });
}

function allowedContinuationUrl(value) {
    try {
        const url = new URL(String(value));
        if (url.protocol !== "https:" || !CHATGPT_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port)
            return undefined;
        return url.toString();
    }
    catch {
        return undefined;
    }
}

function promptFor(request) {
    const context = Array.isArray(request.conversation) && request.conversation.length
        ? `\nConversation context:\n${request.conversation.map((entry) => `${entry.sender}: ${entry.text}`).join("\n")}`
        : "";
    return `${request.instruction}${context}`.slice(0, MAX_TEXT);
}

function findComposer(snapshot) {
    return snapshot?.elements?.find((element) => !element.disabled
        && element.role === "textbox"
        && /message|prompt|chat|ask|send|与 ChatGPT 聊天/i.test(`${element.name} ${element.type ?? ""}`));
}

function conversationUrl(value) {
    const allowed = allowedContinuationUrl(value);
    return allowed && /^\/(?:g\/[^/]+\/)?c\/[A-Za-z0-9_-]+\/?$/.test(new URL(allowed).pathname) ? allowed : undefined;
}

export class ChatGPTWebProvider {
    #driver;
    #statePath;
    #accountNamespace;
    #timeoutMs;
    #pollMs;
    #busy = false;
    #activeController;
    #makeDriver;
    #closed = false;
    #availableModels = [];
    #chatVerified = false;

    constructor({ accountNamespace, profileDir, driver, driverFactory, driverConfig = {}, timeoutMs = 90_000, pollMs = 150 } = {}) {
        this.#accountNamespace = safeNamespace(accountNamespace);
        if (!profileDir && !driver)
            throw new Error("ChatGPT Web provider requires a dedicated profile");
        if (!driver)
            mkdirSync(profileDir, { recursive: true });
        this.#makeDriver = (mode) => driverFactory?.({ accountNamespace: this.#accountNamespace, profileDir, mode }) ?? new SidecarComputerDriver({
            agentId: this.#accountNamespace,
            profileDir,
            workspaceDir: profileDir,
        }, { ...(typeof driverConfig === "function" ? driverConfig() : driverConfig), headless: mode !== "login" });
        this.#driver = driver ?? this.#makeDriver("headless");
        this.#statePath = profileDir ? join(profileDir, "provider-state.json") : undefined;
        this.#timeoutMs = timeoutMs;
        this.#pollMs = pollMs;
    }

    capabilities() {
        return ["chat", "continuation", "cancellation"];
    }

    models() {
        return [...this.#availableModels];
    }

    async #page() {
        const page = await this.#driver.chatGPTPage?.();
        if (page?.schema !== "sovereignbot.chatgpt-page.v1" || !allowedContinuationUrl(page.url))
            throw errorWithCode("ChatGPT Chat page cannot be verified", "UNAVAILABLE");
        if (page.challenge) throw errorWithCode("ChatGPT requires human verification", "UNAVAILABLE");
        if (!page.authenticated) throw errorWithCode("Sign in to ChatGPT Web.", "SIGN_IN_REQUIRED");
        if (page.chatMode === true) this.#chatVerified = true;
        if (page.chatMode === false || !this.#chatVerified) throw errorWithCode("ChatGPT Chat mode is required; Work is not used", "UNAVAILABLE");
        if (page.capacityLimited) throw errorWithCode("ChatGPT Web capacity is limited; retry later", "CAPACITY_LIMITED");
        this.#availableModels = [...new Set((page.availableModels ?? []).filter(id => ["sol", "gpt-5.6-luna"].includes(id)))];
        return page;
    }

    async #selectModel(model, signal) {
        const target = !model || model === "gpt-5.6-sol" ? "sol" : model;
        if (!["sol", "gpt-5.6-luna"].includes(target)) throw errorWithCode("Requested ChatGPT model is unsupported", "MODEL_UNAVAILABLE");
        let page = await this.#page();
        if (page.selectedModel === target) return page;
        let snapshot = await this.#driver.snapshot();
        const label = target === "sol" ? /^GPT[- ]5\.6 Sol$/i : /^GPT[- ]5\.6 Luna$/i;
        let option = snapshot.elements.find(el => el.role === "menuitemradio" && label.test(el.name) && !el.disabled);
        if (!option) {
            const toggle = snapshot.elements.find(el => el.role === "button" && /^(?:5\.6\s*)?(?:思考强度|极高|高|标准|低|Thinking|Extended|Standard|Light|Heavy)$/i.test(el.name) && !el.disabled);
            if (!toggle) throw errorWithCode("ChatGPT model selector is unavailable", "MODEL_UNAVAILABLE");
            ensureSignal(signal);
            await this.#driver.click({ element: toggle });
            snapshot = await this.#driver.snapshot();
            const submenu = snapshot.elements.find(el => el.role === "menuitem" && /选择模型|Select model/i.test(el.name));
            if (submenu) { await this.#driver.click({ element: submenu }); snapshot = await this.#driver.snapshot(); }
            option = snapshot.elements.find(el => el.role === "menuitemradio" && label.test(el.name) && !el.disabled);
        }
        if (!option) throw errorWithCode("Requested model is not available in ChatGPT Chat", "MODEL_UNAVAILABLE");
        ensureSignal(signal);
        await this.#driver.click({ element: option });
        page = await this.#page();
        if (page.selectedModel !== target) throw errorWithCode("ChatGPT model selection could not be verified", "MODEL_UNAVAILABLE");
        await this.#driver.key({ key: "Escape" });
        await this.#driver.key({ key: "Escape" });
        return page;
    }

    async health() {
        if (this.#closed || this.#busy)
            return { found: !this.#closed, health: "unavailable", auth: { state: "unverified" }, reason: "ChatGPT Web is busy or closed.", models: this.models(), capabilities: this.capabilities() };
        try {
            const transport = await this.#driver.health?.();
            const currentUrl = await this.#currentUrl();
            if (!currentUrl || currentUrl === "about:blank") await this.#driver.navigate(HOME_URL);
            await this.#page();
            const snapshot = await this.#driver.snapshot();
            if (!allowedContinuationUrl(snapshot?.url) || !findComposer(snapshot))
                return { found: true, health: "unavailable", auth: { state: "unverified" }, reason: "ChatGPT Web conversation page is not ready.", capabilities: this.capabilities(), models: this.models() };
            return {
                found: true,
                health: "ready",
                auth: { state: "signed-in" },
                capabilities: this.capabilities(),
                models: this.models(),
                ...(transport?.browser ? { browser: String(transport.browser).slice(0, 32) } : {}),
            };
        }
        catch (error) {
            return { found: false, health: error?.code === "SIGN_IN_REQUIRED" ? "signed-out" : error?.code === "CAPACITY_LIMITED" ? "capacity-limited" : "unavailable", auth: { state: error?.code === "SIGN_IN_REQUIRED" ? "signed-out" : "unverified" }, reason: "ChatGPT Chat is not verified; check sign-in, mode and model availability.", capabilities: this.capabilities(), models: this.models() };
        }
    }

    async start(request) {
        return this.#send(request, undefined);
    }

    async continue(request) {
        const state = this.#readState();
        const stored = state?.continuations?.[request?.continuationRef];
        if (!stored)
            throw errorWithCode("ChatGPT Web continuation does not belong to this provider account", "CONTINUITY_MISMATCH");
        const url = conversationUrl(stored.url);
        if (!url)
            throw errorWithCode("ChatGPT Web continuation is unavailable", "CONTINUITY_UNAVAILABLE");
        return this.#send(request, request.continuationRef, url, stored.mode === "chat");
    }

    async openLogin() {
        if (this.#closed || this.#busy) throw errorWithCode("ChatGPT Web provider is busy or closed", "BUSY");
        this.#busy = true;
        try {
            await this.#driver.close?.();
            this.#driver = this.#makeDriver("login");
            await this.#driver.navigate(LOGIN_URL);
            return { opened: true };
        } finally { this.#busy = false; }
    }

    async close() {
        this.#closed = true;
        this.#activeController?.abort();
        await this.#driver.close?.();
    }

    async cancel() {
        if (!this.#activeController) return { cancelled: true };
        this.#activeController.abort();
        try { await this.#driver.key?.({ key: "Escape" }); } catch {}
        return { cancelled: true };
    }

    async #send(request, priorRef, continuationUrl, verifiedChat = false) {
        if (this.#closed) throw errorWithCode("ChatGPT Web provider is closed", "UNAVAILABLE");
        if (this.#busy)
            throw errorWithCode("ChatGPT Web provider is busy", "BUSY");
        this.#busy = true;
        const controller = new AbortController();
        this.#activeController = controller;
        const abort = () => controller.abort();
        request?.signal?.addEventListener("abort", abort, { once: true });
        if (request?.signal?.aborted) abort();
        const signal = controller.signal;
        try {
            ensureSignal(signal);
            this.#chatVerified = verifiedChat;
            if (continuationUrl) await this.#driver.navigate(continuationUrl);
            if (!priorRef) {
                // A new coworker task must never append to another coworker's chat.
                await this.#driver.navigate(HOME_URL);
            }
            const initialPage = await this.#selectModel(request?.model, signal);
            if (initialPage.generating) throw errorWithCode("ChatGPT is still generating a prior response", "BUSY");
            const priorMessages = new Set((initialPage.assistantMessages ?? []).map(message => message.id));
            const snapshot = await this.#driver.snapshot();
            if (!allowedContinuationUrl(snapshot?.url))
                throw errorWithCode("ChatGPT Web conversation page is unavailable", "UNAVAILABLE");
            const composer = findComposer(snapshot);
            if (!composer)
                throw errorWithCode("ChatGPT Web composer is unavailable", "UNAVAILABLE");
            ensureSignal(signal);
            await this.#driver.type({ element: composer, text: promptFor(request) });
            ensureSignal(signal);
            await this.#driver.key({ element: composer, key: "Enter" });
            const deadline = Date.now() + this.#timeoutMs;
            let lastAnswer;
            while (Date.now() < deadline) {
                ensureSignal(signal);
                const latest = await this.#page();
                ensureSignal(signal);
                const message = latest.assistantMessages?.at(-1);
                const answer = message?.text;
                if (message?.id && !priorMessages.has(message.id) && answer?.trim() && message.complete === true && !latest.generating && lastAnswer === `${message.id}:${answer}`) {
                    if (message.truncated || answer.length > MAX_TEXT) throw errorWithCode("ChatGPT response exceeds the supported text limit", "RESPONSE_TOO_LARGE");
                    const currentUrl = conversationUrl(await this.#currentUrl());
                    ensureSignal(signal);
                    if (!currentUrl) throw errorWithCode("ChatGPT conversation URL could not be saved", "CONTINUITY_UNAVAILABLE");
                    const continuationRef = priorRef ?? `continuation-${randomUUID()}`;
                    this.#writeState({ continuationRef, url: currentUrl });
                    return { text: answer, continuationRef };
                }
                lastAnswer = message?.complete && !latest.generating ? `${message.id}:${answer}` : undefined;
                await wait(this.#pollMs, signal);
            }
            throw errorWithCode("ChatGPT Web response timed out", "TIMEOUT");
        }
        finally {
            request?.signal?.removeEventListener("abort", abort);
            this.#activeController = undefined;
            this.#busy = false;
        }
    }

    #readState() {
        if (!this.#statePath || !existsSync(this.#statePath)) return undefined;
        const value = loadJsonState(this.#statePath, undefined);
        if (value?.schema === "sovereignbot.chatgpt-web.profile.v2" && value.continuations && typeof value.continuations === "object" && !Array.isArray(value.continuations)) return value;
        return value && typeof value.continuationRef === "string" && value.continuationRef.length <= MAX_STATE_REF
            ? { continuations: { [value.continuationRef]: { url: value.url } } } : undefined;
    }

    #writeState(value) {
        if (!this.#statePath) return;
        const continuations = { ...(this.#readState()?.continuations ?? {}) };
        if (!Object.hasOwn(continuations, value.continuationRef) && Object.keys(continuations).length >= 512)
            throw errorWithCode("ChatGPT Web continuation capacity reached", "CAPACITY_LIMITED");
        continuations[value.continuationRef] = { url: value.url, mode: "chat" };
        saveJsonState(this.#statePath, { schema: "sovereignbot.chatgpt-web.profile.v2", continuations });
    }

    async #currentUrl() {
        if (typeof this.#driver.currentUrl === "function")
            return Promise.resolve(this.#driver.currentUrl()).catch(() => "");
        try { return (await this.#driver.snapshot()).url ?? ""; } catch { return ""; }
    }
}

export function createChatGPTWebProviderFactory({ dataDir, driverConfig = {}, driverFactory } = {}) {
    if (!dataDir) throw new Error("ChatGPT Web provider factory requires dataDir");
    const providers = new Map();
    const root = join(dataDir, "desktop-state", "provider-profiles", "chatgpt-web");
    const get = (accountNamespace) => {
        const namespace = safeNamespace(accountNamespace);
        if (!providers.has(namespace)) {
            const profileDir = join(root, namespace);
            providers.set(namespace, new ChatGPTWebProvider({ accountNamespace: namespace, profileDir, driverFactory, driverConfig }));
        }
        return providers.get(namespace);
    };
    return {
        get,
        async openLogin(accountNamespace) {
            return get(accountNamespace).openLogin();
        },
        async health(accountNamespace) {
            return get(accountNamespace).health();
        },
        async close() {
            await Promise.allSettled([...providers.values()].map(provider => provider.close()));
        },
    };
}
