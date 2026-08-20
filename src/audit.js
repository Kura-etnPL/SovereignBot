import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createId } from "./id.js";

function stable(value) {
    if (Array.isArray(value))
        return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value)
            .filter(([, val]) => val !== undefined)
            .sort(([a], [b]) => a.localeCompare(b));
        return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stable(val)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function digest(record) {
    return createHash("sha256").update(stable(record)).digest("hex");
}

export class AuditLog {
    #path;
    #tail;
    #appendQueue = Promise.resolve();

    constructor(path) {
        this.#path = path;
    }

    async init() {
        await mkdir(dirname(this.#path), { recursive: true });
        const records = await this.readAll();
        const last = records.at(-1);
        this.#tail = last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: "GENESIS" };
    }

    async append(input) {
        const operation = this.#appendQueue.then(() => this.#appendNow(input));
        this.#appendQueue = operation.catch(() => undefined);
        return operation;
    }

    async #appendNow(input) {
        if (!this.#tail)
            await this.init();
        const tail = this.#tail;
        const unsigned = {
            id: createId("audit"),
            seq: tail.seq + 1,
            at: new Date().toISOString(),
            type: input.type,
            actor: input.actor,
            subject: input.subject,
            data: input.data,
            prevHash: tail.hash,
        };
        const record = { ...unsigned, hash: digest(unsigned) };
        await appendFile(this.#path, `${JSON.stringify(record)}\n`, "utf8");
        this.#tail = { seq: record.seq, hash: record.hash };
        return record;
    }

    async readAll() {
        try {
            const raw = await readFile(this.#path, "utf8");
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

    async verify() {
        await this.#appendQueue;
        const records = await this.readAll();
        let prevHash = "GENESIS";
        let expectedSeq = 1;
        for (const record of records) {
            if (record.seq !== expectedSeq) {
                return { ok: false, seq: record.seq, reason: `expected sequence ${expectedSeq}` };
            }
            if (record.prevHash !== prevHash) {
                return { ok: false, seq: record.seq, reason: "previous hash mismatch" };
            }
            const { hash, ...unsigned } = record;
            if (digest(unsigned) !== hash) {
                return { ok: false, seq: record.seq, reason: "record hash mismatch" };
            }
            prevHash = hash;
            expectedSeq += 1;
        }
        return { ok: true, count: records.length };
    }
}
