import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const VERSION = 1;
const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_TTL_MS = 12 * 60 * 60_000;
const MAX_ACTIVE_SESSIONS = 64;

function hashToken(token) {
    return createHash("sha256").update(String(token)).digest("hex");
}

function validateRecord(value) {
    if (!value || value.version !== VERSION || !Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt))
        throw new Error("operator session record is invalid or unsupported");
    return value;
}

export class OperatorSessionStore {
    #dir;
    #now;

    constructor(dataDir, { now = () => Date.now() } = {}) {
        this.#dir = join(dataDir, "operator-sessions");
        this.#now = now;
    }

    async init() {
        await mkdir(this.#dir, { recursive: true, mode: 0o700 });
        await this.#prune();
    }

    async issue({ ttlMs = DEFAULT_TTL_MS, label = "local-operator" } = {}) {
        if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS)
            throw new Error(`operator session ttlMs must be an integer between 1 and ${MAX_TTL_MS}`);
        await mkdir(this.#dir, { recursive: true, mode: 0o700 });
        await this.#prune();
        const active = (await readdir(this.#dir)).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
        if (active.length >= MAX_ACTIVE_SESSIONS)
            throw new Error(`operator session limit reached (${MAX_ACTIVE_SESSIONS})`);

        for (let attempt = 0; attempt < 4; attempt += 1) {
            const token = randomBytes(32).toString("base64url");
            const hash = hashToken(token);
            const now = this.#now();
            const record = {
                version: VERSION,
                createdAt: now,
                expiresAt: now + ttlMs,
                label: String(label).slice(0, 120),
            };
            try {
                await writeFile(this.#path(hash), `${JSON.stringify(record, null, 2)}\n`, {
                    encoding: "utf8",
                    mode: 0o600,
                    flag: "wx",
                });
                return { token, expiresAt: record.expiresAt, label: record.label };
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
            }
        }
        throw new Error("could not allocate a unique operator session");
    }

    async authenticate(token) {
        if (typeof token !== "string" || token.length < 24)
            return false;
        const hash = hashToken(token);
        try {
            const record = validateRecord(JSON.parse(await readFile(this.#path(hash), "utf8")));
            if (record.expiresAt <= this.#now()) {
                await unlink(this.#path(hash)).catch(() => undefined);
                return false;
            }
            return true;
        }
        catch (error) {
            if (error.code === "ENOENT" || error instanceof SyntaxError)
                return false;
            throw error;
        }
    }

    async revoke(token) {
        if (typeof token !== "string" || !token)
            return false;
        try {
            await unlink(this.#path(hashToken(token)));
            return true;
        }
        catch (error) {
            if (error.code === "ENOENT")
                return false;
            throw error;
        }
    }

    async #prune() {
        const now = this.#now();
        for (const name of await readdir(this.#dir)) {
            if (!/^[0-9a-f]{64}\.json$/.test(name))
                continue;
            const path = join(this.#dir, name);
            try {
                const record = validateRecord(JSON.parse(await readFile(path, "utf8")));
                if (record.expiresAt <= now)
                    await unlink(path).catch(() => undefined);
            }
            catch (error) {
                if (error.code === "ENOENT")
                    continue;
                throw error;
            }
        }
    }

    #path(hash) {
        return join(this.#dir, `${hash}.json`);
    }
}

export const OPERATOR_SESSION_DEFAULT_TTL_MS = DEFAULT_TTL_MS;
export const OPERATOR_SESSION_MAX_TTL_MS = MAX_TTL_MS;
