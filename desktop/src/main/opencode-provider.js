// OpenCode Zen free-model and Go adapter. Runtime registration is intentionally
// left to the caller; this module only implements the economy-provider contract.
import { randomUUID } from "node:crypto";

export const OPENCODE_ENDPOINTS = Object.freeze({
    zen: "https://opencode.ai/zen/v1/chat/completions",
    go: "https://opencode.ai/zen/go/v1/chat/completions",
});

// These are the models currently documented as free by OpenCode Zen. Do not
// infer free access from a model name or silently fall back to a paid model.
export const OPENCODE_ZEN_FREE_MODELS = Object.freeze([
    "big-pickle", "mimo-v2.5-free", "ling-3.0-flash-fin-free",
    "nemotron-3-ultra-free", "nemotron-3.5-lightning-free",
]);

// Go is a subscription product; its chat-completions models are allowlisted
// separately and are never used as a fallback for Zen or another Go model.
export const OPENCODE_GO_CHAT_MODELS = Object.freeze([
    "glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5.1", "kimi-k3",
    "kimi-k2.7-code", "kimi-k2.6", "longcat-2.0", "deepseek-v4-pro",
    "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "mimo-v2.5",
    "mimo-v2.5-pro", "hy4-preview", "hy3", "omen-alpha",
]);

const MAX_INPUT = 120_000;
const MAX_OUTPUT = 20_000;
const MAX_RESPONSE_BYTES = 512_000;
const MAX_CONTEXT_MESSAGES = 48;
const DEFAULT_TIMEOUT = 60_000;

class OpenCodeError extends Error {
    constructor(code, message) { super(`[OPENCODE:${code}] ${message}`); this.code = code; }
}
function fail(code, message) { return new OpenCodeError(code, message); }

function cleanText(value, label, max) {
    if (typeof value !== "string" || !value.trim()) throw fail("INVALID_REQUEST", `${label} must be non-empty text`);
    if (value.length > max) throw fail("REQUEST_TOO_LARGE", `${label} exceeds the bounded limit`);
    return value;
}

function messagesFor(request, prior = []) {
    const supplied = Array.isArray(request.conversation) ? request.conversation : [];
    const messages = [...prior, ...supplied.filter((entry) => entry && typeof entry === "object").map((entry) => ({
        role: entry.role === "assistant" || ["assistant", "self"].includes(entry.sender) ? "assistant" : "user",
        content: typeof entry.content === "string" ? entry.content.slice(0, MAX_INPUT) : typeof entry.text === "string" ? entry.text.slice(0, MAX_INPUT) : String(entry.content ?? entry.text ?? "").slice(0, MAX_INPUT),
    })).filter((entry) => entry.content.trim())];
    if (request.instruction !== undefined) messages.push({ role: "user", content: cleanText(request.instruction, "instruction", MAX_INPUT) });
    if (JSON.stringify(messages).length > MAX_INPUT) throw fail("REQUEST_TOO_LARGE", "conversation exceeds the bounded limit");
    if (messages.length > MAX_CONTEXT_MESSAGES) return messages.slice(-MAX_CONTEXT_MESSAGES);
    return messages;
}

function readText(payload) {
    const choice = payload?.choices?.[0];
    const content = choice?.message?.content ?? choice?.text;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("");
    return "";
}

async function readBoundedJson(response) {
    if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        try {
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                total += part.value.byteLength;
                if (total > MAX_RESPONSE_BYTES) throw fail("RESPONSE_TOO_LARGE", "OpenCode response exceeds the bounded limit");
                chunks.push(part.value);
            }
        } finally { reader.releaseLock?.(); }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder().decode(bytes));
    }
    if (typeof response.text !== "function" && typeof response.json === "function") return response.json();
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) throw fail("RESPONSE_TOO_LARGE", "OpenCode response exceeds the bounded limit");
    return JSON.parse(raw);
}

function makeRef(counter) {
    return `opencode-${counter.toString(36)}-${randomUUID()}`;
}

export function createOpenCodeProviderAdapter({
    providerId = "opencode-zen-free", kind = "zen", model,
    credentialResolver, transport = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT,
} = {}) {
    const models = kind === "zen" ? OPENCODE_ZEN_FREE_MODELS : kind === "go" ? OPENCODE_GO_CHAT_MODELS : [];
    if (!(kind in OPENCODE_ENDPOINTS)) throw new Error("OpenCode kind must be zen or go");
    if (!models.includes(model)) throw fail("MODEL_NOT_ALLOWED", `Model is not allowlisted for OpenCode ${kind}`);
    if (typeof credentialResolver !== "function") throw fail("CREDENTIAL_RESOLVER_REQUIRED", "A trusted credential resolver is required");
    if (typeof transport !== "function") throw new Error("OpenCode transport must be fetch-compatible");
    const contexts = new Map();
    const active = new Map();
    let sequence = 0;
    let closed = false;

    async function credential() {
        let value;
        try { value = await credentialResolver({ providerId, kind, model }); }
        catch { throw fail("SIGNED_OUT", "OpenCode credential is unavailable"); }
        if (typeof value !== "string" || !value.trim()) throw fail("SIGNED_OUT", "OpenCode credential is unavailable");
        return value;
    }

    async function health() {
        try {
            await credential();
            return { found: true, health: "ready", capabilities: ["chat", "continuation", "cancellation"], models: [...models] };
        } catch { return { found: false, health: "signed-out", reason: "OpenCode credential is unavailable", capabilities: ["chat", "continuation", "cancellation"], models: [...models] }; }
    }

    async function callRequest(method, input = {}) {
        if (closed) throw fail("UNAVAILABLE", "OpenCode adapter is closed");
        const activeKey = String(input.taskId ?? input.continuationRef ?? makeRef(++sequence));
        if (active.has(activeKey)) throw fail("BUSY", "OpenCode task is already active");
        if (method === "continue" && (!input.continuationRef || !contexts.has(input.continuationRef))) throw fail("INVALID_CONTINUATION", "Continuation does not belong to this adapter");
        const prior = method === "continue" ? contexts.get(input.continuationRef).messages : [];
        const messages = messagesFor(input, prior);
        if (!messages.length) throw fail("INVALID_REQUEST", "instruction or conversation is required");
        const controller = new AbortController();
        const session = method === "continue" ? contexts.get(input.continuationRef)?.session : makeRef(++sequence);
        const signal = input.signal;
        const abort = () => controller.abort(signal?.reason ?? new Error("cancelled"));
        if (signal) { if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); }
        const timer = setTimeout(() => controller.abort(new Error("timeout")), Math.min(Math.max(timeoutMs, 1), 120_000));
        active.set(activeKey, controller);
        try {
            const token = await credential();
            if (controller.signal.aborted) throw fail("CANCELLED", "OpenCode request cancelled");
            const response = await transport(OPENCODE_ENDPOINTS[kind], {
                method: "POST", signal: controller.signal,
                redirect: "error",
                headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "user-agent": "SovereignBot-OpenCode/1", "x-opencode-session": session },
                body: JSON.stringify({ model, messages, max_tokens: 4096, stream: false }),
            });
            if (controller.signal.aborted) throw fail("CANCELLED", "OpenCode request cancelled");
            if (!response?.ok) throw fail("UPSTREAM", "OpenCode request failed");
            let payload;
            try { payload = await readBoundedJson(response); } catch (error) { if (error instanceof OpenCodeError) throw error; throw fail("UPSTREAM", "OpenCode returned invalid JSON"); }
            if (controller.signal.aborted) throw fail("CANCELLED", "OpenCode request cancelled");
            const text = readText(payload);
            if (payload?.choices?.[0]?.finish_reason !== "stop") throw fail("INCOMPLETE_RESPONSE", "OpenCode did not finish a complete text response");
            if (!text.trim()) throw fail("EMPTY_RESPONSE", "OpenCode returned no text");
            if (text.length > MAX_OUTPUT) throw fail("RESPONSE_TOO_LARGE", "OpenCode text exceeds the bounded limit");
            const continuationRef = makeRef(++sequence);
            contexts.set(continuationRef, { session, messages: [...messages, { role: "assistant", content: text.slice(0, MAX_OUTPUT) }].slice(-MAX_CONTEXT_MESSAGES) });
            if (method === "continue") contexts.delete(input.continuationRef);
            if (contexts.size > 512) contexts.delete(contexts.keys().next().value);
            return { text: text.slice(0, MAX_OUTPUT), continuationRef };
        } catch (error) {
            if (controller.signal.aborted) {
                const cancelled = signal?.aborted || controller.signal.reason?.message === "cancelled";
                throw fail(cancelled ? "CANCELLED" : "TIMEOUT", cancelled ? "OpenCode request cancelled" : "OpenCode request timed out");
            }
            if (error instanceof OpenCodeError) throw error;
            throw fail("UPSTREAM", "OpenCode request failed");
        } finally { clearTimeout(timer); if (activeKey) active.delete(String(activeKey)); signal?.removeEventListener?.("abort", abort); }
    }

    return {
        capabilities: () => ["chat", "continuation", "cancellation"],
        models: () => [...models],
        health,
        close: async () => { closed = true; for (const controller of active.values()) controller.abort(new Error("cancelled")); contexts.clear(); },
        start: (request) => requestCall("start", request),
        continue: (request) => requestCall("continue", request),
        cancel: async ({ taskId, continuationRef } = {}) => {
            const key = taskId ?? continuationRef;
            if (key && active.has(String(key))) active.get(String(key)).abort(new Error("cancelled"));
            if (continuationRef) contexts.delete(String(continuationRef));
            return { cancelled: true };
        },
    };
    function requestCall(method, request) { return request === undefined ? Promise.reject(fail("INVALID_REQUEST", "request is required")) : callRequest(method, request); }
}

export const createOpenCodeAdapter = createOpenCodeProviderAdapter;
