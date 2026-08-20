import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createId } from "./id.js";

export class TaskEventStore {
    #path;
    #loaded = false;
    #events = [];
    #byId = new Map();
    #nextSeq = new Map();
    #appendQueue = Promise.resolve();

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
            data: input.data,
        };
        await appendFile(this.#path, `${JSON.stringify(event)}\n`, "utf8");
        this.#events.push(event);
        this.#byId.set(id, event);
        this.#nextSeq.set(input.taskId, event.seq + 1);
        return { event: structuredClone(event), duplicate: false };
    }

    async list(taskIds) {
        await this.init();
        if (!taskIds)
            return structuredClone(this.#events);
        const wanted = new Set(Array.isArray(taskIds) ? taskIds : [taskIds]);
        return structuredClone(this.#events.filter((event) => wanted.has(event.taskId)));
    }
}
