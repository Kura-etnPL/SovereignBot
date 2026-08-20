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
