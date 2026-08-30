import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";

export const WORKER_NODE_LEDGER_SCHEMA = "sovereignbot.worker-node.dispatch-ledger.v1";
const MAX_ENTRIES = 500;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE = new Set(["accepted", "running"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function cleanRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const keys = new Set(["requestId", "bodyHash", "planId", "remoteTaskId", "status", "statusSummary", "createdAt", "updatedAt"]);
    if (Object.keys(value).some((key) => !keys.has(key)))
        return undefined;
    if (typeof value.requestId !== "string" || typeof value.bodyHash !== "string")
        return undefined;
    if (!(value.planId === null || typeof value.planId === "string") || !(value.remoteTaskId === null || typeof value.remoteTaskId === "string"))
        return undefined;
    if (!TERMINAL.has(value.status) && !ACTIVE.has(value.status))
        return undefined;
    if (typeof value.statusSummary !== "string" || value.statusSummary.length > 500)
        return undefined;
    if (!Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt)))
        return undefined;
    return {
        requestId: value.requestId,
        bodyHash: value.bodyHash,
        planId: value.planId,
        remoteTaskId: value.remoteTaskId,
        status: value.status,
        statusSummary: value.statusSummary,
        createdAt: new Date(value.createdAt).toISOString(),
        updatedAt: new Date(value.updatedAt).toISOString(),
    };
}
export class WorkerNodeDispatchStore {
    #path;
    #records = new Map();
    #loaded = false;
    #writeQueue = Promise.resolve();

    constructor(dataDir, { now = () => Date.now(), maxEntries = MAX_ENTRIES, maxAgeMs = MAX_AGE_MS } = {}) {
        this.#path = join(dataDir, "worker-node-dispatch-ledger.json");
        this.now = now;
        this.maxEntries = maxEntries;
        this.maxAgeMs = maxAgeMs;
    }

    now;
    maxEntries;
    maxAgeMs;

    async init() {
        if (this.#loaded)
            return;
        const loaded = await readJsonFile(this.#path, null);
        const entries = loaded?.schema === WORKER_NODE_LEDGER_SCHEMA && Array.isArray(loaded.entries)
            ? loaded.entries.map(cleanRecord).filter(Boolean)
            : [];
        const cutoff = this.now() - this.maxAgeMs;
        for (const entry of entries) {
            if (Date.parse(entry.updatedAt) < cutoff)
                continue;
            if (ACTIVE.has(entry.status)) {
                entry.status = "failed";
                entry.statusSummary = "interrupted by Worker Node restart";
                entry.updatedAt = new Date(this.now()).toISOString();
            }
            this.#records.set(entry.requestId, entry);
        }
        this.#loaded = true;
        await this.#save();
    }

    async get(requestId) {
        await this.init();
        const value = this.#records.get(requestId);
        return value ? structuredClone(value) : undefined;
    }

    async findByRemoteTaskId(remoteTaskId) {
        await this.init();
        for (const value of this.#records.values()) {
            if (value.remoteTaskId === remoteTaskId)
                return structuredClone(value);
        }
        return undefined;
    }

    async list() {
        await this.init();
        return structuredClone([...this.#records.values()]);
    }

    async put(record) {
        await this.init();
        const clean = cleanRecord(record);
        if (!clean)
            throw new Error("invalid Worker Node dispatch ledger record");
        this.#records.set(clean.requestId, clean);
        await this.#save();
        return structuredClone(clean);
    }

    async update(requestId, patch) {
        await this.init();
        const current = this.#records.get(requestId);
        if (!current)
            throw new Error(`Worker Node dispatch request not found: ${requestId}`);
        const next = cleanRecord({ ...current, ...patch, updatedAt: new Date(this.now()).toISOString() });
        if (!next)
            throw new Error("invalid Worker Node dispatch ledger update");
        this.#records.set(requestId, next);
        await this.#save();
        return structuredClone(next);
    }

    async #save() {
        const entries = [...this.#records.values()]
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
            .slice(0, this.maxEntries);
        this.#records = new Map(entries.map((entry) => [entry.requestId, entry]));
        const operation = this.#writeQueue.then(() => writeJsonAtomic(this.#path, { schema: WORKER_NODE_LEDGER_SCHEMA, entries }));
        this.#writeQueue = operation.catch(() => undefined);
        await operation;
    }
}
