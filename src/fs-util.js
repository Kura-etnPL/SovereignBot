import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
export async function writeJsonAtomic(path, value) {
    await ensureParent(path);
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temp, path);
}
