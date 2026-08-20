import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";

export class TaskStore {
    #path;

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
        const tasks = await this.list();
        const index = tasks.findIndex((candidate) => candidate.id === task.id);
        if (index === -1)
            tasks.push(task);
        else
            tasks[index] = task;
        await writeJsonAtomic(this.#path, tasks);
    }
}
