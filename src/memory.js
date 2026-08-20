import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createId } from "./id.js";
export class MemoryStore {
    path;
    constructor(path) {
        this.path = path;
    }
    async put(input) {
        await mkdir(dirname(this.path), { recursive: true });
        const record = {
            id: createId("mem"),
            at: new Date().toISOString(),
            scope: input.scope,
            key: input.key,
            value: input.value,
            tags: input.tags ?? [],
        };
        await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
        return record;
    }
    async all() {
        try {
            const raw = await readFile(this.path, "utf8");
            return raw
                .split(/\r?\n/)
                .filter(Boolean)
                .map((line) => JSON.parse(line));
        }
        catch (error) {
            if (error.code === "ENOENT")
                return [];
            throw error;
        }
    }
    async latest(scope, key) {
        return (await this.all())
            .filter((record) => record.scope === scope && record.key === key)
            .at(-1);
    }
    async search(input) {
        const query = input.query?.trim().toLowerCase();
        const tags = input.tags ?? [];
        const filtered = (await this.all()).filter((record) => {
            if (input.scope && record.scope !== input.scope)
                return false;
            if (tags.length && !tags.every((tag) => record.tags.includes(tag)))
                return false;
            if (!query)
                return true;
            const haystack = `${record.key} ${JSON.stringify(record.value)} ${record.tags.join(" ")}`.toLowerCase();
            return haystack.includes(query);
        });
        return filtered.slice(-(input.limit ?? 50)).reverse();
    }
}
