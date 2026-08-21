import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";

const VERSION = 1;

function fingerprintInput(action) {
    return JSON.stringify([
        action.agentId ?? "",
        action.category ?? "",
        action.operation ?? "",
        action.repeatKey ?? action.target ?? "",
        action.taskId ?? "",
    ]);
}

export function actionRepeatFingerprint(action) {
    return createHash("sha256").update(fingerprintInput(action)).digest("hex");
}

function emptyState() {
    return { version: VERSION, entries: {} };
}

function validateState(value) {
    if (!value || value.version !== VERSION || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries))
        throw new Error("repeat state is invalid or unsupported");
    for (const [fingerprint, timestamps] of Object.entries(value.entries)) {
        if (!/^[0-9a-f]{64}$/.test(fingerprint) || !Array.isArray(timestamps) || timestamps.some((at) => !Number.isFinite(at)))
            throw new Error("repeat state contains an invalid fingerprint/timestamp entry");
    }
    return value;
}

export class RepeatStore {
    #path;
    #windowMs;
    #maxActive;
    #state;
    #queue = Promise.resolve();
    #now;

    constructor(dataDir, { windowMs = 180_000, maxActiveFingerprints = 10_000, now = () => Date.now() } = {}) {
        this.#path = join(dataDir, "repeat-state.json");
        this.#windowMs = windowMs;
        this.#maxActive = maxActiveFingerprints;
        this.#now = now;
    }

    async init() {
        this.#state = validateState(await readJsonFile(this.#path, emptyState()));
        await this.#pruneAndPersist(this.#now());
    }

    async observe(action) {
        const operation = this.#queue.then(async () => {
            if (!this.#state)
                throw new Error("repeat store is not initialized");
            const now = this.#now();
            const next = structuredClone(this.#state);
            this.#prune(next, now);
            const fingerprint = actionRepeatFingerprint(action);
            const existing = next.entries[fingerprint] ?? [];
            if (!next.entries[fingerprint] && Object.keys(next.entries).length >= this.#maxActive)
                throw new Error(`repeat safety state reached max active fingerprints (${this.#maxActive})`);
            existing.push(now);
            next.entries[fingerprint] = existing;

            // Persist the current attempt before policy may allow the action.
            await writeJsonAtomic(this.#path, next);
            this.#state = next;
            return existing.length;
        });
        this.#queue = operation.catch(() => undefined);
        return operation;
    }

    async #pruneAndPersist(now) {
        const next = structuredClone(this.#state);
        const changed = this.#prune(next, now);
        if (changed) {
            await writeJsonAtomic(this.#path, next);
            this.#state = next;
        }
    }

    #prune(state, now) {
        let changed = false;
        for (const [fingerprint, timestamps] of Object.entries(state.entries)) {
            const fresh = timestamps.filter((at) => now - at <= this.#windowMs);
            if (fresh.length !== timestamps.length)
                changed = true;
            if (fresh.length)
                state.entries[fingerprint] = fresh;
            else {
                delete state.entries[fingerprint];
                changed = true;
            }
        }
        return changed;
    }
}
