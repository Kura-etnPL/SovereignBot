import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";

export class TaskStore {
    #path;
    #writeQueue = Promise.resolve();

    constructor(dataDir) {
        this.#path = join(dataDir, "tasks.json");
    }

    async list() {
        return readJsonFile(this.#path, []);
    }

    async get(id) {
        return (await this.list()).find((task) => task.id === id);
    }

    async children(parentTaskId) {
        return (await this.list()).filter((task) => task.parentTaskId === parentTaskId);
    }

    async descendants(rootTaskId) {
        const tasks = await this.list();
        const byParent = new Map();
        for (const task of tasks) {
            if (!task.parentTaskId)
                continue;
            const children = byParent.get(task.parentTaskId) ?? [];
            children.push(task);
            byParent.set(task.parentTaskId, children);
        }
        const result = [];
        const queue = [...(byParent.get(rootTaskId) ?? [])];
        const seen = new Set();
        while (queue.length) {
            const task = queue.shift();
            if (!task || seen.has(task.id))
                continue;
            seen.add(task.id);
            result.push(task);
            queue.push(...(byParent.get(task.id) ?? []));
        }
        return result;
    }

    async upsert(task) {
        return this.#mutate(async (tasks) => {
            const index = tasks.findIndex((candidate) => candidate.id === task.id);
            if (index === -1)
                tasks.push(structuredClone(task));
            else
                tasks[index] = structuredClone(task);
            return structuredClone(task);
        });
    }

    async update(id, updater) {
        return this.#mutate(async (tasks) => {
            const index = tasks.findIndex((candidate) => candidate.id === id);
            if (index === -1)
                throw new Error(`task not found: ${id}`);
            const next = await updater(structuredClone(tasks[index]));
            tasks[index] = structuredClone(next);
            return structuredClone(next);
        });
    }

    async #mutate(mutator) {
        const operation = this.#writeQueue.then(async () => {
            const tasks = await readJsonFile(this.#path, []);
            const result = await mutator(tasks);
            await writeJsonAtomic(this.#path, tasks);
            return result;
        });
        this.#writeQueue = operation.catch(() => undefined);
        return operation;
    }
}
