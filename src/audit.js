import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createId } from "./id.js";

// Keep ordinary domain fields such as `value`, `text`, and `content` usable in the audit log. The
// actual computer type/write paths never put their payloads into audit metadata. Redact credential-
// shaped fields globally, and make the secret channel stricter below.
const SENSITIVE_AUDIT_KEY = /^(password|passwd|secret|secret[_-]?value|token|authorization|cookie|set-cookie|api[_-]?key|session[_-]?id)$/i;

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

function sanitize(value, key, eventType) {
    if (key && SENSITIVE_AUDIT_KEY.test(key))
        return "[REDACTED]";
    if (eventType?.startsWith("computer.secret_") && key === "error")
        return "secret operation failed";
    if (eventType?.startsWith("computer.secret_") && /^(text|content|value)$/i.test(key ?? ""))
        return "[REDACTED]";
    if (Array.isArray(value))
        return value.map((item) => sanitize(item, undefined, eventType));
    if (value && typeof value === "object") {
        const out = {};
        for (const [childKey, child] of Object.entries(value))
            out[childKey] = sanitize(child, childKey, eventType);
        return out;
    }
    return value;
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
        const safeInput = {
            ...input,
            actor: sanitize(input.actor, "actor", input.type),
            subject: sanitize(input.subject, "subject", input.type),
            data: sanitize(input.data, undefined, input.type),
        };
        const operation = this.#appendQueue.then(() => this.#appendNow(safeInput));
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
