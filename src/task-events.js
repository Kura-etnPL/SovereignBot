import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createId } from "./id.js";
import { sanitizeRuntimeData } from "./runtime-data-redaction.js";

export class TaskEventStore {
    #path;
    #loaded = false;
    #events = [];
    #byId = new Map();
    #nextSeq = new Map();
    #appendQueue = Promise.resolve();
    #listeners = new Set();

    constructor(dataDir) {
        this.#path = join(dataDir, "task-events.jsonl");
    }

    async init() {
        if (this.#loaded)
            return;
        await mkdir(dirname(this.#path), { recursive: true });
        try {
            const raw = await readFile(this.#path, "utf8");
            for (const line of raw.split(/\r?\n/).filter(Boolean)) {
                const event = JSON.parse(line);
                this.#events.push(event);
                this.#byId.set(event.id, event);
                this.#nextSeq.set(event.taskId, Math.max(this.#nextSeq.get(event.taskId) ?? 1, event.seq + 1));
            }
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        this.#loaded = true;
    }

    subscribe(listener) {
        if (typeof listener !== "function")
            throw new Error("task event listener must be a function");
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    subscriberCount() {
        return this.#listeners.size;
    }

    async append(input) {
        const operation = this.#appendQueue.then(() => this.#appendNow(input));
        this.#appendQueue = operation.catch(() => undefined);
        return operation;
    }

    async #appendNow(input) {
        await this.init();
        const id = input.eventId ?? createId("event");
        const existing = this.#byId.get(id);
        if (existing) {
            if (existing.taskId !== input.taskId || existing.type !== input.type) {
                throw new Error(`event id ${id} is already bound to ${existing.taskId}/${existing.type}`);
            }
            return { event: structuredClone(existing), duplicate: true };
        }

        const event = {
            id,
            taskId: input.taskId,
            seq: this.#nextSeq.get(input.taskId) ?? 1,
            at: new Date().toISOString(),
            type: input.type,
            actor: input.actor,
            data: sanitizeRuntimeData(input.data, undefined, input.type),
        };
        await appendFile(this.#path, `${JSON.stringify(event)}\n`, "utf8");
        this.#events.push(event);
        this.#byId.set(id, event);
        this.#nextSeq.set(input.taskId, event.seq + 1);
        this.#notify(event);
        return { event: structuredClone(event), duplicate: false };
    }

    #notify(event) {
        for (const listener of [...this.#listeners]) {
            try {
                listener(structuredClone(event));
            }
            catch {
                // Telemetry observers cannot turn a durable task-event append into an application failure.
            }
        }
    }

    async list(taskIds) {
        await this.init();
        if (!taskIds)
            return structuredClone(this.#events);
        const wanted = new Set(Array.isArray(taskIds) ? taskIds : [taskIds]);
        return structuredClone(this.#events.filter((event) => wanted.has(event.taskId)));
    }
}
