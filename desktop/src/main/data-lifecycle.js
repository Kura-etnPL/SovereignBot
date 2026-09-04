import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile, lstat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
    createStateBackup,
    exportState,
    restoreStateBackup,
} from "../../vendor/core/src/state-transfer.js";

export const DESKTOP_LIFECYCLE_SCHEMA = "sovereignbot.desktop.lifecycle.v1";
export const DESKTOP_STATE_VERSION = 4;
export const DESKTOP_BACKUP_FORMAT = "sovereignbot.desktop-state-backup";
export const DESKTOP_EXPORT_FORMAT = "sovereignbot.desktop-state-export";

const DESKTOP_FILES = Object.freeze([
    "settings.json", "workspaces.json", "coworkers.json", "conversations.json", "artifacts.json",
    "goals.json", "jobs.json", "routines.json", "event-triggers.json", "teams.json", "skills.json",
    "projects.json", "product-surfaces.json", "teach-once.json", "coworker-dispatch.json",
    "connected-apps.json", "external-team-outcomes.json", "notifications.json",
]);
const CORE_FILES = Object.freeze(["tasks.json", "task-events.jsonl", "memory.jsonl", "repeat-state.json"]);
const SECRET_KEYS = /(?:credential|secret|token|cookie|private|password|session|relay|browserprofile|sourcepath|storagepath|absolutepath|workspacepath|path|cwd|root|directory)/i;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_BACKUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,96}$/;

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
function lifecyclePath(dataDir) { return join(dataDir, "desktop-state", "lifecycle.json"); }
function backupRootFor(dataDir) { return `${resolve(dataDir)}.backups`; }
function exportRootFor(dataDir) { return `${resolve(dataDir)}.exports`; }
function isWithin(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !resolve(rel).startsWith(`${sep}${sep}`));
}
function safeRelative(value) {
    if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("lifecycle path is invalid");
    const normalized = value.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === ".."))
        throw new Error("lifecycle path must be relative and traversal-free");
    return normalized;
}
async function exists(path) { try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; } }
async function assertRegular(path, label) {
    const info = await exists(path);
    if (!info) return undefined;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`${label} exceeds lifecycle size limit`);
    return info;
}
async function assertDirectory(path, label) {
    const info = await exists(path);
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a normal directory`);
    return true;
}
async function atomicJson(path, value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.lifecycle-${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { await rename(temp, path); } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
}
async function readJson(path, fallback = undefined) {
    const info = await assertRegular(path, basename(path));
    if (!info) return fallback;
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { throw new Error(`${basename(path)} is invalid JSON: ${error.message}`); }
}
function redact(value, key = "") {
    if (SECRET_KEYS.test(key)) return "<redacted>";
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === "object") {
        const result = {};
        for (const [childKey, childValue] of Object.entries(value)) {
            if (SECRET_KEYS.test(childKey)) continue;
            result[childKey] = redact(childValue, childKey);
        }
        return result;
    }
    return value;
}
function artifactExportName(id, fileName) {
    const clean = basename(String(fileName || "artifact")).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 180) || "artifact";
    return `artifacts/${id}/${clean}`;
}
async function copyHashed(source, target, relativePath) {
    const before = await lstat(source);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) throw new Error("lifecycle source must be a bounded regular file");
    const content = await readFile(source);
    const after = await lstat(source);
    if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("lifecycle source changed during capture");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { flag: "wx", mode: 0o600 });
    return { path: relativePath, size: content.length, sha256: sha256(content) };
}
async function verifyFiles(root, entries) {
    for (const entry of entries) {
        const path = safeRelative(entry.path);
        const source = join(root, ...path.split("/"));
        let cursor = resolve(root);
        for (const part of path.split("/")) {
            cursor = join(cursor, part);
            const component = await exists(cursor);
            if (component?.isSymbolicLink()) throw new Error("lifecycle bundle contains a symbolic-link component");
        }
        const info = await assertRegular(source, "lifecycle bundle file");
        if (!info) throw new Error("lifecycle bundle file is missing");
        const content = await readFile(source);
        if (content.length !== entry.size || sha256(content) !== entry.sha256) throw new Error("lifecycle bundle hash mismatch");
    }
}
async function listBundleFiles(root, prefix = "", result = []) {
    const info = await exists(root);
    if (!info) return result;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("lifecycle bundle files root must be a normal directory");
    for (const name of await readdir(root)) {
        const child = join(root, name);
        const childInfo = await exists(child);
        if (childInfo.isSymbolicLink()) throw new Error("lifecycle bundle contains a symbolic link");
        const path = prefix ? `${prefix}/${name}` : name;
        if (childInfo.isDirectory()) await listBundleFiles(child, path, result);
        else if (childInfo.isFile()) result.push(path);
        else throw new Error("lifecycle bundle contains a special file");
    }
    return result;
}
function validateLifecycleManifest(manifest, format) {
    if (!manifest || manifest.format !== format || manifest.formatVersion !== 1 || !Array.isArray(manifest.files))
        throw new Error("lifecycle manifest format/version is unsupported");
    const seen = new Set();
    for (const entry of manifest.files) {
        const path = safeRelative(entry?.path);
        if (format === DESKTOP_BACKUP_FORMAT && !isSafeBackupPath(path)) throw new Error("lifecycle manifest contains an unsupported state path");
        if (seen.has(path) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/i.test(entry.sha256 ?? ""))
            throw new Error("lifecycle manifest contains invalid or duplicate file metadata");
        seen.add(path);
    }
    return seen;
}
function isSafeBackupPath(path) {
    if (CORE_FILES.some((name) => path === `core/${name}`)) return true;
    if (path === "core/policy-versions/active.json" || /^core\/policy-versions\/versions\/policy_[a-f0-9-]{36}\.json$/i.test(path)) return true;
    if (/^desktop-state\/(?:settings|workspaces|coworkers|conversations|artifacts|goals|jobs|routines|event-triggers|teams|skills|projects|product-surfaces|teach-once|coworker-dispatch|connected-apps|external-team-outcomes|notifications)\.json$/.test(path)) return true;
    return /^artifacts\/artifact_[a-f0-9]{16}\/[^/]+$/i.test(path);
}
async function readBundle(root, format) {
    const info = await exists(root);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("lifecycle bundle must be a normal directory");
    for (const name of await readdir(root)) if (!["manifest.json", "files"].includes(name)) throw new Error("lifecycle bundle contains undeclared top-level material");
    const manifest = await readJson(join(root, "manifest.json"));
    const seen = validateLifecycleManifest(manifest, format);
    const actual = await listBundleFiles(join(root, "files"));
    if (actual.length !== seen.size || actual.some((path) => !seen.has(path))) throw new Error("lifecycle bundle contains undeclared or missing files");
    await verifyFiles(join(root, "files"), manifest.files);
    return manifest;
}
async function listSafeDesktopSources(dataDir) {
    const stateDir = join(dataDir, "desktop-state");
    const entries = [];
    if (!(await assertDirectory(stateDir, "desktop state"))) return entries;
    for (const name of DESKTOP_FILES) {
        const source = join(stateDir, name);
        if (await exists(source)) entries.push({ source, path: `desktop-state/${name}` });
    }
    const artifactRoot = join(dataDir, "artifacts");
    if (await assertDirectory(artifactRoot, "artifact store")) {
        for (const artifactId of (await readdir(artifactRoot)).sort()) {
            if (!/^artifact_[a-f0-9]{16}$/i.test(artifactId)) continue;
            const dir = join(artifactRoot, artifactId);
            if (!(await assertDirectory(dir, "artifact directory"))) continue;
            for (const fileName of (await readdir(dir)).sort()) {
                const source = join(dir, fileName);
                const info = await exists(source);
                if (!info) continue;
                if (info.isSymbolicLink() || !info.isFile()) throw new Error("artifact store contains an unsafe entry");
                entries.push({ source, path: `artifacts/${artifactId}/${basename(fileName)}` });
            }
        }
    }
    return entries;
}
export function createDesktopDataLifecycle({ dataDir, audit, stopRuntime, releaseLeases, clearControllerCache, migrationHook, backupRoot = backupRootFor(dataDir), exportRoot = exportRootFor(dataDir) } = {}) {
    if (!dataDir) throw new Error("data lifecycle requires dataDir");
    const root = resolve(dataDir);
    const config = { dataDir: root };
    async function attention(reason, error) {
        const payload = { schema: "sovereignbot.desktop.attention.v1", reason, error: String(error?.message ?? error).slice(0, 500), at: new Date().toISOString() };
        await atomicJson(join(root, "desktop-state", "attention.json"), payload);
        try { await audit?.append({ type: "desktop.lifecycle.attention", actor: "system", subject: "desktop-state", data: { reason: payload.reason, error: payload.error } }); } catch {}
        return payload;
    }
    async function readMarker() {
        const marker = await readJson(lifecyclePath(root), undefined);
        if (!marker) return { schema: DESKTOP_LIFECYCLE_SCHEMA, stateVersion: 3, revision: 0, migrated: false };
        if (marker.schema !== DESKTOP_LIFECYCLE_SCHEMA || !Number.isInteger(marker.stateVersion) || marker.stateVersion < 3 || marker.stateVersion > DESKTOP_STATE_VERSION)
            throw new Error("desktop lifecycle marker is unsupported");
        return marker;
    }
    async function createBackup({ id = `backup-${Date.now()}` } = {}) {
        if (!MAX_BACKUP_ID.test(id)) throw new Error("backup id is invalid");
        await mkdir(backupRoot, { recursive: true, mode: 0o700 });
        const output = join(backupRoot, id);
        if (!isWithin(backupRoot, output) || await exists(output)) throw new Error("backup destination is invalid or already exists");
        const stage = `${output}.staging-${randomUUID()}`;
        await mkdir(join(stage, "files"), { recursive: true, mode: 0o700 });
        try {
            const coreTemp = `${output}.core-${randomUUID()}`;
            await createStateBackup(config, coreTemp);
            const coreManifest = await readJson(join(coreTemp, "manifest.json"));
            const files = [];
            for (const entry of coreManifest.files) {
                const source = join(coreTemp, "files", ...entry.path.split("/"));
                files.push(await copyHashed(source, join(stage, "files", "core", ...entry.path.split("/")), `core/${entry.path}`));
            }
            await rm(coreTemp, { recursive: true, force: true });
            for (const source of await listSafeDesktopSources(root))
                files.push(await copyHashed(source.source, join(stage, "files", ...source.path.split("/")), source.path));
            const manifest = { format: DESKTOP_BACKUP_FORMAT, formatVersion: 1, createdAt: new Date().toISOString(), stateVersion: DESKTOP_STATE_VERSION, sensitiveStateExcluded: true, files };
            await atomicJson(join(stage, "manifest.json"), manifest);
            await rename(stage, output);
            return { id, files: files.length, createdAt: manifest.createdAt, stateVersion: manifest.stateVersion };
        } catch (error) {
            await rm(stage, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }
    }
    async function inspectBackup(id) {
        if (!MAX_BACKUP_ID.test(String(id))) throw new Error("backup id is invalid");
        const path = join(backupRoot, String(id));
        if (!isWithin(backupRoot, path)) throw new Error("backup id escapes backup root");
        const manifest = await readBundle(path, DESKTOP_BACKUP_FORMAT);
        return { id: String(id), createdAt: manifest.createdAt, stateVersion: manifest.stateVersion, files: manifest.files.length, sensitiveStateExcluded: manifest.sensitiveStateExcluded === true };
    }
    async function listBackups() {
        if (!(await assertDirectory(backupRoot, "backup root"))) return { backups: [] };
        const backups = [];
        for (const id of (await readdir(backupRoot)).sort().reverse()) {
            if (!MAX_BACKUP_ID.test(id)) continue;
            try { backups.push(await inspectBackup(id)); } catch { /* malformed bundles are omitted from the UI and remain non-restorable */ }
        }
        return { backups };
    }
    async function restoreBackup({ id, replace = true } = {}) {
        if (!MAX_BACKUP_ID.test(String(id))) throw new Error("backup id is invalid");
        const source = join(backupRoot, String(id));
        const manifest = await readBundle(source, DESKTOP_BACKUP_FORMAT);
        const preRestore = await createBackup({ id: `pre-restore-${Date.now()}-${randomUUID().slice(0, 8)}` });
        const stage = `${root}.lifecycle-restore-${randomUUID()}`;
        const recovery = `${root}.lifecycle-recovery-${randomUUID()}`;
        await mkdir(stage, { recursive: true, mode: 0o700 });
        try {
            const coreBundle = `${stage}.core`;
            await mkdir(join(coreBundle, "files"), { recursive: true, mode: 0o700 });
            const coreEntries = manifest.files.filter((entry) => entry.path.startsWith("core/"));
            const coreManifest = { format: "sovereignbot-state-backup", formatVersion: 1, createdAt: manifest.createdAt, sourceVersion: "desktop-lifecycle", mode: "core", sensitiveComputerState: false, offlineConsistencyRequired: true, files: coreEntries.map((entry) => ({ ...entry, mode: 0o600, path: entry.path.slice(5) })) };
            await atomicJson(join(coreBundle, "manifest.json"), coreManifest);
            for (const entry of coreEntries) await copyFile(join(source, "files", ...entry.path.split("/")), join(coreBundle, "files", ...entry.path.slice(5).split("/")));
            await restoreStateBackup({ dataDir: `${stage}.core-state` }, coreBundle, { replace: false });
            for (const entry of coreEntries) {
                const target = join(stage, ...entry.path.slice(5).split("/"));
                await mkdir(dirname(target), { recursive: true, mode: 0o700 });
                await copyFile(join(`${stage}.core-state`, ...entry.path.slice(5).split("/")), target);
            }
            for (const entry of manifest.files.filter((item) => !item.path.startsWith("core/"))) {
                const target = join(stage, ...entry.path.split("/"));
                await mkdir(dirname(target), { recursive: true, mode: 0o700 });
                await copyFile(join(source, "files", ...entry.path.split("/")), target);
            }
            if (await exists(root) && !replace) throw new Error("destination state is not empty");
            const productPaths = [...CORE_FILES, ...DESKTOP_FILES.map((name) => `desktop-state/${name}`), "artifacts"];
            for (const path of productPaths) {
                const incoming = join(stage, ...path.split("/"));
                const destination = join(root, ...path.split("/"));
                if (await exists(destination)) {
                    const previous = join(recovery, ...path.split("/"));
                    await mkdir(dirname(previous), { recursive: true, mode: 0o700 });
                    await rename(destination, previous);
                }
                if (!(await exists(incoming))) continue;
                await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
                await rename(incoming, destination);
            }
            await rm(recovery, { recursive: true, force: true });
            return { restored: true, id: String(id), files: manifest.files.length, preRestoreBackupId: preRestore.id };
        } catch (error) {
            await rm(stage, { recursive: true, force: true }).catch(() => undefined);
            // Restore only the governed product paths. Protected computer, credential,
            // browser, relay, and controller state never participates in this swap.
            if (await exists(recovery)) {
                for (const path of [...CORE_FILES, ...DESKTOP_FILES.map((name) => `desktop-state/${name}`), "artifacts"].reverse()) {
                    const previous = join(recovery, ...path.split("/"));
                    const destination = join(root, ...path.split("/"));
                    if (await exists(previous)) {
                        await rm(destination, { recursive: true, force: true }).catch(() => undefined);
                        await mkdir(dirname(destination), { recursive: true, mode: 0o700 }).catch(() => undefined);
                        await rename(previous, destination).catch(() => undefined);
                    }
                }
            }
            await rm(recovery, { recursive: true, force: true }).catch(() => undefined);
            await attention("restore-failed", error);
            throw error;
        } finally {
            await rm(`${stage}.core`, { recursive: true, force: true }).catch(() => undefined);
            await rm(`${stage}.core-state`, { recursive: true, force: true }).catch(() => undefined);
        }
    }
    async function exportData({ id = `export-${Date.now()}` } = {}) {
        if (!MAX_BACKUP_ID.test(id)) throw new Error("export id is invalid");
        await mkdir(exportRoot, { recursive: true, mode: 0o700 });
        const output = join(exportRoot, id);
        if (await exists(output)) throw new Error("export destination already exists");
        const stage = `${output}.staging-${randomUUID()}`;
        await mkdir(join(stage, "files"), { recursive: true, mode: 0o700 });
        try {
            const coreExport = `${output}.core-${randomUUID()}`;
            await exportState(config, coreExport);
            const coreText = await readFile(join(coreExport, "export.json"));
            const files = [{ path: "metadata/core-export.json", size: coreText.length, sha256: sha256(coreText) }];
            await mkdir(join(stage, "files", "metadata"), { recursive: true, mode: 0o700 });
            await writeFile(join(stage, "files", "metadata", "core-export.json"), coreText, { flag: "wx", mode: 0o600 });
            const desktopMetadata = [];
            for (const source of await listSafeDesktopSources(root)) {
                const content = await readFile(source.source);
                if (source.path.startsWith("artifacts/")) {
                    const targetPath = artifactExportName(source.path.split("/")[1], basename(source.path));
                    files.push(await copyHashed(source.source, join(stage, "files", ...targetPath.split("/")), targetPath));
                } else {
                    let value;
                    try { value = JSON.parse(content); } catch { value = { unreadable: true }; }
                    desktopMetadata.push({ path: source.path, schema: value?.schema, sha256: sha256(content), bytes: content.length, metadata: redact(value) });
                }
            }
            const metadataText = Buffer.from(`${JSON.stringify({ format: DESKTOP_EXPORT_FORMAT, generatedAt: new Date().toISOString(), redacted: true, restorable: false, desktopState: desktopMetadata }, null, 2)}\n`);
            await mkdir(join(stage, "files", "metadata"), { recursive: true, mode: 0o700 });
            await writeFile(join(stage, "files", "metadata", "desktop-state.json"), metadataText, { flag: "wx", mode: 0o600 });
            files.push({ path: "metadata/desktop-state.json", size: metadataText.length, sha256: sha256(metadataText) });
            await atomicJson(join(stage, "manifest.json"), { format: DESKTOP_EXPORT_FORMAT, formatVersion: 1, createdAt: new Date().toISOString(), redacted: true, restorable: false, files });
            await rm(coreExport, { recursive: true, force: true });
            await rename(stage, output);
            return { id, files: files.length, redacted: true, restorable: false };
        } catch (error) { await rm(stage, { recursive: true, force: true }).catch(() => undefined); throw error; }
    }
    async function migrate() {
        const marker = await readMarker();
        if (marker.stateVersion === DESKTOP_STATE_VERSION) return { migrated: false, stateVersion: DESKTOP_STATE_VERSION, revision: marker.revision };
        try {
            const backup = await createBackup({ id: `pre-migration-${Date.now()}-${randomUUID().slice(0, 8)}` });
            await migrationHook?.({ phase: "before-commit", fromVersion: marker.stateVersion, toVersion: DESKTOP_STATE_VERSION, backupId: backup.id });
            const next = { schema: DESKTOP_LIFECYCLE_SCHEMA, stateVersion: DESKTOP_STATE_VERSION, revision: marker.revision + 1, migrated: true, migratedFrom: marker.stateVersion, migratedAt: new Date().toISOString(), backupId: backup.id };
            await atomicJson(lifecyclePath(root), next);
            return { migrated: true, stateVersion: DESKTOP_STATE_VERSION, revision: next.revision, backupId: backup.id };
        } catch (error) { await attention("migration-failed", error); throw error; }
    }
    async function prepareReset() {
        const backup = await createBackup({ id: `pre-reset-${Date.now()}-${randomUUID().slice(0, 8)}` });
        return { confirmation: randomUUID(), expiresAt: Date.now() + 60_000, backupId: backup.id };
    }
    const resetConfirmations = new Map();
    async function cleanReset({ confirmation, backupId } = {}) {
        const prepared = resetConfirmations.get(String(confirmation));
        if (!prepared || prepared.expiresAt < Date.now() || prepared.backupId !== backupId) throw new Error("clean reset requires a fresh confirmed backup");
        resetConfirmations.delete(String(confirmation));
        await stopRuntime?.();
        await releaseLeases?.();
        await clearControllerCache?.();
        const recovery = `${root}.reset-recovery-${randomUUID()}`;
        const moved = [];
        try {
            await mkdir(recovery, { recursive: true, mode: 0o700 });
            const productPaths = [...CORE_FILES, ...DESKTOP_FILES.map((name) => `desktop-state/${name}`), "artifacts"];
            for (const path of productPaths) {
                const source = join(root, ...path.split("/"));
                if (!(await exists(source))) continue;
                const target = join(recovery, ...path.split("/"));
                await mkdir(dirname(target), { recursive: true, mode: 0o700 });
                await rename(source, target);
                moved.push({ source, target });
            }
            await atomicJson(lifecyclePath(root), { schema: DESKTOP_LIFECYCLE_SCHEMA, stateVersion: DESKTOP_STATE_VERSION, revision: 1, resetAt: new Date().toISOString(), resetBackupId: backupId });
            await rm(recovery, { recursive: true, force: true });
            return { reset: true, backupId };
        } catch (error) {
            for (const { source, target } of moved.reverse()) if (await exists(target) && !(await exists(source))) await mkdir(dirname(source), { recursive: true, mode: 0o700 }).then(() => rename(target, source)).catch(() => undefined);
            await rm(recovery, { recursive: true, force: true }).catch(() => undefined);
            await attention("reset-failed", error);
            throw error;
        }
    }
    return {
        async recover() { return migrate(); },
        migrate,
        status: async () => ({ schema: DESKTOP_LIFECYCLE_SCHEMA, stateVersion: (await readMarker()).stateVersion, backups: (await listBackups()).backups.length }),
        backup: createBackup,
        listBackups,
        inspectBackup,
        restoreBackup,
        exportData,
        prepareReset: async () => { const value = await prepareReset(); resetConfirmations.set(value.confirmation, value); return value; },
        cleanReset,
    };
}
