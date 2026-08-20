import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function normalizeForCompare(path) {
    return process.platform === "win32" ? path.toLowerCase() : path;
}

export function resolveWorkspacePath(root, requested = ".") {
    if (typeof requested !== "string" || requested.includes("\0"))
        throw new Error("workspace path must be a valid string");
    if (isAbsolute(requested) || /^[A-Za-z]:[\\/]/.test(requested))
        throw new Error("workspace paths must be relative");

    const rootResolved = resolve(root);
    const target = resolve(rootResolved, requested || ".");
    const rootCompare = normalizeForCompare(rootResolved);
    const targetCompare = normalizeForCompare(target);
    if (targetCompare !== rootCompare && !targetCompare.startsWith(`${rootCompare}${sep}`))
        throw new Error("workspace path escapes the agent workspace");
    return target;
}

export function describeWorkspacePath(path) {
    const normalized = path.replace(/\\/g, "/");
    const name = normalized.split("/").pop() ?? normalized;
    const dot = name.lastIndexOf(".");
    return {
        path: normalized,
        name,
        extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
    };
}

async function rejectSymlinkTraversal(root, target, allowMissingTail) {
    const rel = relative(root, target);
    if (!rel)
        return;
    let current = root;
    for (const segment of rel.split(sep).filter(Boolean)) {
        current = resolve(current, segment);
        try {
            const metadata = await lstat(current);
            if (metadata.isSymbolicLink())
                throw new Error("workspace path crosses a symbolic link or junction");
        }
        catch (error) {
            if (allowMissingTail && error.code === "ENOENT")
                return;
            throw error;
        }
    }
}

export class ComputerWorkspace {
    #root;

    constructor(root) {
        this.#root = resolve(root);
    }

    async init() {
        await mkdir(this.#root, { recursive: true });
    }

    async list(path = ".") {
        const target = resolveWorkspacePath(this.#root, path);
        await rejectSymlinkTraversal(this.#root, target, false);
        const entries = await readdir(target, { withFileTypes: true });
        return Promise.all(entries.map(async (entry) => {
            const absolute = resolve(target, entry.name);
            const metadata = await lstat(absolute);
            return {
                name: entry.name,
                path: relative(this.#root, absolute).replace(/\\/g, "/") || ".",
                type: metadata.isSymbolicLink()
                    ? "symlink"
                    : entry.isDirectory()
                        ? "directory"
                        : entry.isFile()
                            ? "file"
                            : "other",
                size: metadata.size,
                modifiedAt: metadata.mtime.toISOString(),
            };
        }));
    }

    async read(path, encoding = "utf8") {
        const target = resolveWorkspacePath(this.#root, path);
        await rejectSymlinkTraversal(this.#root, target, false);
        if (encoding === "base64")
            return (await readFile(target)).toString("base64");
        return readFile(target, "utf8");
    }

    async write(path, content, encoding = "utf8") {
        const target = resolveWorkspacePath(this.#root, path);
        await rejectSymlinkTraversal(this.#root, target, true);
        await mkdir(dirname(target), { recursive: true });
        // Re-check after creating missing directories so an existing link can never become the final hop.
        await rejectSymlinkTraversal(this.#root, dirname(target), false);
        try {
            const existing = await lstat(target);
            if (existing.isSymbolicLink())
                throw new Error("workspace path crosses a symbolic link or junction");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        const buffer = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
        await writeFile(target, buffer);
        return { path: relative(this.#root, target).replace(/\\/g, "/"), bytes: buffer.byteLength };
    }
}
