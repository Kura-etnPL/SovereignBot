import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";

export const WORKER_COMPUTER_LEDGER_SCHEMA = "sovereignbot.worker-computer.action-ledger.v1";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function cleanRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const allowed = new Set(["requestId", "bodyHash", "status", "result", "summary", "createdAt", "updatedAt"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
    if (typeof value.requestId !== "string" || typeof value.bodyHash !== "string") return undefined;
    if (!TERMINAL.has(value.status) || typeof value.summary !== "string" || value.summary.length > 500) return undefined;
    if (!Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) return undefined;
    return {
        requestId: value.requestId,
        bodyHash: value.bodyHash,
        status: value.status,
        ...(value.result === undefined ? {} : { result: structuredClone(value.result) }),
        summary: value.summary,
        createdAt: new Date(value.createdAt).toISOString(),
        updatedAt: new Date(value.updatedAt).toISOString(),
    };
}

export class WorkerComputerActionStore {
    #path;
    #records = new Map();
    #loaded = false;
    #writeQueue = Promise.resolve();

    constructor(dataDir, { now = () => Date.now(), maxEntries = 500, maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
        this.#path = join(dataDir, "worker-computer-action-ledger.json");
        this.now = now;
        this.maxEntries = maxEntries;
        this.maxAgeMs = maxAgeMs;
    }
    async init() {
        if (this.#loaded) return;
        const loaded = await readJsonFile(this.#path, null);
        const cutoff = this.now() - this.maxAgeMs;
        const entries = loaded?.schema === WORKER_COMPUTER_LEDGER_SCHEMA && Array.isArray(loaded.entries) ? loaded.entries : [];
        for (const entry of entries.map(cleanRecord).filter(Boolean)) {
            if (Date.parse(entry.updatedAt) >= cutoff) this.#records.set(entry.requestId, entry);
        }
        this.#loaded = true;
        await this.#save();
    }
    async get(requestId) { await this.init(); const value = this.#records.get(requestId); return value ? structuredClone(value) : undefined; }
    async put(record) { await this.init(); const clean = cleanRecord(record); if (!clean) throw new Error("invalid Worker Computer action record"); this.#records.set(clean.requestId, clean); await this.#save(); return structuredClone(clean); }
    async #save() {
        const entries = [...this.#records.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, this.maxEntries);
        this.#records = new Map(entries.map((entry) => [entry.requestId, entry]));
        const operation = this.#writeQueue.then(() => writeJsonAtomic(this.#path, { schema: WORKER_COMPUTER_LEDGER_SCHEMA, entries }));
        this.#writeQueue = operation.catch(() => undefined);
        await operation;
    }
}
