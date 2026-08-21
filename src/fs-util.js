import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);

export async function ensureParent(path) {
    await mkdir(dirname(path), { recursive: true });
}

export async function readJsonFile(path, fallback) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return fallback;
        throw error;
    }
}

export async function replaceFileWithRetry(source, destination, {
    renameFn = rename,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attempts = 6,
} = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            await renameFn(source, destination);
            return;
        }
        catch (error) {
            lastError = error;
            if (!TRANSIENT_RENAME_ERRORS.has(error.code) || attempt === attempts - 1)
                throw error;
            await sleepFn(8 * (2 ** attempt));
        }
    }
    throw lastError;
}

export async function writeJsonAtomic(path, value) {
    await ensureParent(path);
    const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
        await replaceFileWithRetry(temp, path);
    }
    catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
    }
}
