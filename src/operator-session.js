import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";

const VERSION = 1;
const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_TTL_MS = 12 * 60 * 60_000;
const MAX_ACTIVE_SESSIONS = 64;

function hashToken(token) {
    return createHash("sha256").update(String(token)).digest("hex");
}

function emptyState() {
    return { version: VERSION, sessions: {} };
}

function validateState(value) {
    if (!value || value.version !== VERSION || !value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions))
        throw new Error("operator session state is invalid or unsupported");
    for (const [hash, session] of Object.entries(value.sessions)) {
        if (!/^[0-9a-f]{64}$/.test(hash))
            throw new Error("operator session state contains an invalid token hash");
        if (!session || !Number.isFinite(session.createdAt) || !Number.isFinite(session.expiresAt))
            throw new Error("operator session state contains invalid timestamps");
    }
    return value;
}

function safeEqualHex(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
        return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export class OperatorSessionStore {
    #path;
    #queue = Promise.resolve();
    #now;

    constructor(dataDir, { now = () => Date.now() } = {}) {
        this.#path = join(dataDir, "operator-sessions.json");
        this.#now = now;
    }

    async init() {
        await this.#mutate((state, now) => {
            this.#prune(state, now);
            return undefined;
        });
    }

    async issue({ ttlMs = DEFAULT_TTL_MS, label = "local-operator" } = {}) {
        if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS)
            throw new Error(`operator session ttlMs must be an integer between 1 and ${MAX_TTL_MS}`);
        const token = randomBytes(32).toString("base64url");
        const tokenHash = hashToken(token);
        const session = await this.#mutate((state, now) => {
            this.#prune(state, now);
            if (Object.keys(state.sessions).length >= MAX_ACTIVE_SESSIONS)
                throw new Error(`operator session limit reached (${MAX_ACTIVE_SESSIONS})`);
            const record = {
                createdAt: now,
                expiresAt: now + ttlMs,
                label: String(label).slice(0, 120),
            };
            state.sessions[tokenHash] = record;
            return record;
        });
        return { token, expiresAt: session.expiresAt, label: session.label };
    }

    async authenticate(token) {
        if (typeof token !== "string" || token.length < 24)
            return false;
        const candidate = hashToken(token);
        const state = validateState(await readJsonFile(this.#path, emptyState()));
        const now = this.#now();
        for (const [hash, session] of Object.entries(state.sessions)) {
            if (session.expiresAt <= now)
                continue;
            if (safeEqualHex(hash, candidate))
                return true;
        }
        return false;
    }

    async revoke(token) {
        if (typeof token !== "string" || !token)
            return false;
        const candidate = hashToken(token);
        return this.#mutate((state, now) => {
            this.#prune(state, now);
            let removed = false;
            for (const hash of Object.keys(state.sessions)) {
                if (safeEqualHex(hash, candidate)) {
                    delete state.sessions[hash];
                    removed = true;
                    break;
                }
            }
            return removed;
        });
    }

    async #mutate(mutator) {
        const operation = this.#queue.then(async () => {
            const state = validateState(await readJsonFile(this.#path, emptyState()));
            const result = await mutator(state, this.#now());
            await writeJsonAtomic(this.#path, state);
            return result;
        });
        this.#queue = operation.catch(() => undefined);
        return operation;
    }

    #prune(state, now) {
        for (const [hash, session] of Object.entries(state.sessions)) {
            if (session.expiresAt <= now)
                delete state.sessions[hash];
        }
    }
}

export const OPERATOR_SESSION_DEFAULT_TTL_MS = DEFAULT_TTL_MS;
export const OPERATOR_SESSION_MAX_TTL_MS = MAX_TTL_MS;
