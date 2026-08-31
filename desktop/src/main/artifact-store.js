import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

export const ARTIFACTS_SCHEMA = "sovereignbot.desktop.artifacts.v1";
const MAX_ARTIFACTS = 5_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 128 * 1024;
const MAX_ATTACHMENT_CONTEXT_BYTES = 24 * 1024;
const MAX_TITLE = 180;

const MIME_BY_EXT = new Map([
    [".md", "text/markdown"], [".txt", "text/plain"], [".json", "application/json"],
    [".csv", "text/csv"], [".html", "text/html"], [".css", "text/css"], [".js", "text/javascript"],
    [".ts", "text/typescript"], [".py", "text/x-python"], [".diff", "text/x-diff"], [".patch", "text/x-diff"],
    [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"],
    [".pdf", "application/pdf"], [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    [".zip", "application/zip"],
]);

function makeId() {
    return `artifact_${randomBytes(8).toString("hex")}`;
}

function validId(value, prefix) {
    return typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9][\\w:-]{0,127}$`).test(value);
}

function boundedText(value, label, max, required = false) {
    if (value === undefined || value === null) {
        if (required) throw new Error(`${label} is required`);
        return undefined;
    }
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    const trimmed = value.trim();
    if (!trimmed && required) throw new Error(`${label} is required`);
    if (trimmed.length > max) throw new Error(`${label} exceeds ${max} characters`);
    return trimmed || undefined;
}

function safeRelativePath(value) {
    const path = boundedText(value, "artifact path", 1_024, true);
    if (path.includes("\0") || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path))
        throw new Error("artifact path must be relative to the trusted workspace");
    const normalized = path.replaceAll("\\", "/");
    if (normalized.split("/").some((part) => part === "" || part === "." || part === ".."))
        throw new Error("artifact path contains unsafe traversal components");
    return normalized;
}

function inside(root, candidate) {
    const rel = relative(root, candidate);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !resolve(rel).startsWith(`${sep}${sep}`));
}

function assertWorkspaceFile(workspacePath, relativePath) {
    const root = realpathSync(workspacePath);
    if (!statSync(root).isDirectory()) throw new Error("trusted workspace is not a directory");
    const requested = resolve(root, ...relativePath.split("/"));
    const actual = realpathSync(requested);
    if (!inside(root, actual)) throw new Error("artifact path escapes the trusted workspace");
    const lstat = lstatSync(requested);
    if (lstat.isSymbolicLink()) throw new Error("artifact source may not be a symbolic link");
    const stat = statSync(actual);
    if (!stat.isFile()) throw new Error("artifact source must be a regular file");
    if (stat.size < 0 || stat.size > MAX_FILE_BYTES) throw new Error(`artifact source exceeds ${MAX_FILE_BYTES} bytes`);
    return { root, actual, stat };
}

function assertPickedFile(path) {
    if (typeof path !== "string" || !path || path.includes("\0")) throw new Error("picked attachment path is invalid");
    const requested = resolve(path);
    const lstat = lstatSync(requested);
    if (lstat.isSymbolicLink()) throw new Error("picked attachment may not be a symbolic link");
    const actual = realpathSync(requested);
    const stat = statSync(actual);
    if (!stat.isFile()) throw new Error("picked attachment must be a regular file");
    if (stat.size < 0 || stat.size > MAX_FILE_BYTES) throw new Error(`attachment exceeds ${MAX_FILE_BYTES} bytes`);
    return { actual, stat };
}

function sha256File(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function mimeFor(path) {
    return MIME_BY_EXT.get(extname(path).toLowerCase()) ?? "application/octet-stream";
}

function clone(value) {
    return structuredClone(value);
}

function publicView(entry) {
    // Both paths are main-process-only implementation details. `sourceRelativePath`
    // points back into a trusted workspace and is just as sensitive as the managed
    // storage path; renderer-facing artifact APIs must never carry either one.
    const { storageRelativePath: _storagePath, sourceRelativePath: _sourcePath, ...visible } = entry;
    return clone(visible);
}

function sanitizePersisted(entry) {
    try {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
        if (!/^artifact_[a-f0-9]{16}$/i.test(entry.id)) return undefined;
        if (typeof entry.title !== "string" || !entry.title || entry.title.length > MAX_TITLE) return undefined;
        if (typeof entry.fileName !== "string" || !entry.fileName) return undefined;
        if (typeof entry.mimeType !== "string" || !entry.mimeType) return undefined;
        if (!Number.isInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) return undefined;
        if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) return undefined;
        if (typeof entry.storageRelativePath !== "string" || !entry.storageRelativePath) return undefined;
        if (typeof entry.createdAt !== "string") return undefined;
        return { ...entry };
    } catch {
        return undefined;
    }
}

export function createArtifactStore({ dataDir, persistPath = join(dataDir, "desktop-state", "artifacts.json"), now = () => new Date().toISOString(), makeArtifactId = makeId } = {}) {
    if (!dataDir) throw new Error("artifact store requires dataDir");
    const rootDir = join(dataDir, "artifacts");
    mkdirSync(rootDir, { recursive: true });
    const loaded = loadJsonState(persistPath, null);
    const artifacts = loaded?.schema === ARTIFACTS_SCHEMA && Array.isArray(loaded.artifacts)
        ? loaded.artifacts.map(sanitizePersisted).filter(Boolean).slice(-MAX_ARTIFACTS)
        : [];

    function save() {
        saveJsonState(persistPath, { schema: ARTIFACTS_SCHEMA, artifacts });
    }

    function requireArtifact(id) {
        const artifact = artifacts.find((entry) => entry.id === String(id));
        if (!artifact) throw new Error(`unknown artifact id: ${id}`);
        return artifact;
    }

    function storagePath(entry) {
        const full = resolve(rootDir, entry.storageRelativePath);
        if (!inside(realpathSync(rootDir), full)) throw new Error("artifact storage path is invalid");
        return full;
    }

    function allocateStoredCopy({ actual, stat, title, metadata = {} }) {
        if (artifacts.length >= MAX_ARTIFACTS) throw new Error(`artifact registry limit reached (${MAX_ARTIFACTS})`);
        const id = makeArtifactId();
        if (!/^artifact_[a-f0-9]{16}$/i.test(id) || artifacts.some((entry) => entry.id === id))
            throw new Error("artifact id factory returned an invalid or duplicate id");
        const fileName = basename(actual);
        const artifactDir = join(rootDir, id);
        mkdirSync(artifactDir, { recursive: false });
        const storedName = fileName.slice(0, 180) || "artifact";
        const destination = join(artifactDir, storedName);
        copyFileSync(actual, destination);
        const entry = {
            id,
            title: boundedText(title, "artifact title", MAX_TITLE) ?? fileName,
            fileName,
            mimeType: mimeFor(fileName),
            size: stat.size,
            sha256: sha256File(destination),
            ...metadata,
            storageRelativePath: relative(rootDir, destination),
            createdAt: now(),
        };
        artifacts.push(entry);
        save();
        return publicView(entry);
    }

    return {
        schema: ARTIFACTS_SCHEMA,

        list({ conversationId, coworkerId, limit = 100 } = {}) {
            if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("artifact list limit must be 1..500");
            let result = artifacts;
            if (conversationId !== undefined) result = result.filter((entry) => entry.conversationId === conversationId);
            if (coworkerId !== undefined) result = result.filter((entry) => entry.createdByCoworkerId === coworkerId);
            return { schema: ARTIFACTS_SCHEMA, artifacts: result.slice(-limit).reverse().map(publicView) };
        },

        get(id) {
            return publicView(requireArtifact(id));
        },

        managedPath(id) {
            return storagePath(requireArtifact(id));
        },

        previewText(id) {
            const entry = requireArtifact(id);
            if (!entry.mimeType.startsWith("text/") && entry.mimeType !== "application/json")
                return { artifact: publicView(entry), preview: undefined, truncated: false };
            const full = storagePath(entry);
            const buffer = readFileSync(full);
            const slice = buffer.subarray(0, MAX_PREVIEW_BYTES);
            return { artifact: publicView(entry), preview: slice.toString("utf8"), truncated: buffer.length > MAX_PREVIEW_BYTES };
        },

        contextForMessage(artifactIds = []) {
            return artifactIds.slice(0, 12).map((id) => {
                const entry = requireArtifact(id);
                const result = { id: entry.id, title: entry.title, fileName: entry.fileName, mimeType: entry.mimeType, size: entry.size };
                if (entry.sourceKind === "user" && (entry.mimeType.startsWith("text/") || entry.mimeType === "application/json")) {
                    const buffer = readFileSync(storagePath(entry));
                    result.text = buffer.subarray(0, MAX_ATTACHMENT_CONTEXT_BYTES).toString("utf8");
                    result.truncated = buffer.length > MAX_ATTACHMENT_CONTEXT_BYTES;
                }
                return result;
            });
        },

        ingestPickedFile({ sourcePath, title, conversationId }) {
            if (conversationId !== undefined && !validId(conversationId, "conv")) throw new Error("invalid conversationId");
            const { actual, stat } = assertPickedFile(sourcePath);
            return allocateStoredCopy({
                actual,
                stat,
                title,
                metadata: {
                    sourceKind: "user",
                    ...(conversationId ? { conversationId } : {}),
                },
            });
        },

        ingestWorkspaceFile({ workspaceId, workspacePath, relativePath, title, createdByCoworkerId, conversationId, sourceMessageId }) {
            const safePath = safeRelativePath(relativePath);
            const { actual, stat } = assertWorkspaceFile(workspacePath, safePath);
            if (typeof workspaceId !== "string" || !workspaceId) throw new Error("workspaceId is required");
            if (createdByCoworkerId !== undefined && !validId(createdByCoworkerId, "coworker")) throw new Error("invalid createdByCoworkerId");
            if (conversationId !== undefined && !validId(conversationId, "conv")) throw new Error("invalid conversationId");
            if (sourceMessageId !== undefined && !validId(sourceMessageId, "msg")) throw new Error("invalid sourceMessageId");
            return allocateStoredCopy({
                actual,
                stat,
                title,
                metadata: {
                    sourceKind: "coworker",
                    workspaceId,
                    sourceRelativePath: safePath,
                    ...(createdByCoworkerId ? { createdByCoworkerId } : {}),
                    ...(conversationId ? { conversationId } : {}),
                    ...(sourceMessageId ? { sourceMessageId } : {}),
                },
            });
        },
    };
}
