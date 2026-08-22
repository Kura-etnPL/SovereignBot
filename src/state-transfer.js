import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
    access,
    chmod,
    lstat,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { AuditLog } from "./audit.js";
import { replaceFileWithRetry } from "./fs-util.js";
import { policyHash } from "./policy-version-store.js";

const BACKUP_FORMAT = "sovereignbot-state-backup";
const EXPORT_FORMAT = "sovereignbot-state-export";
const FORMAT_VERSION = 1;
const CORE_FILES = [
    "tasks.json",
    "task-events.jsonl",
    "memory.jsonl",
    "audit.jsonl",
    "repeat-state.json",
];
const FORBIDDEN_PREFIXES = ["operator-sessions/", "tool-bridges/"];
const POLICY_VERSION_ID = /^policy_[0-9a-f-]{36}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function portablePath(path) {
    return path.split(sep).join("/");
}

function isWithin(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function transientSegment(name) {
    return name === ".staging"
        || name.includes(".tmp-")
        || name.includes(".new-")
        || name.includes(".old-");
}

function safeRelativePath(value, { allowComputers = false } = {}) {
    if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0"))
        return false;
    if (value.startsWith("/") || value.endsWith("/") || value.includes("//"))
        return false;
    const parts = value.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || transientSegment(part)))
        return false;
    if (FORBIDDEN_PREFIXES.some((prefix) => value === prefix.slice(0, -1) || value.startsWith(prefix)))
        return false;
    if (value === "policy-versions/transaction.json")
        return false;
    if (!allowComputers && (value === "computers" || value.startsWith("computers/")))
        return false;
    return true;
}

async function statMaybe(path) {
    try {
        return await lstat(path);
    }
    catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR")
            return undefined;
        throw error;
    }
}

async function normalDirectory(path, { allowMissing = false } = {}) {
    const info = await statMaybe(path);
    if (!info)
        return allowMissing;
    return info.isDirectory() && !info.isSymbolicLink();
}

async function ensureSafeDestinationRoot(path) {
    const absolute = resolve(path);
    if (absolute === parse(absolute).root)
        throw new Error("state destination cannot be a filesystem root");
    const info = await statMaybe(absolute);
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
        throw new Error("state destination must be a normal directory");
    let parent = dirname(absolute);
    while (true) {
        const parentInfo = await statMaybe(parent);
        if (parentInfo) {
            if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
                throw new Error("state destination parent must be a normal directory");
            await access(parent, constants.R_OK | constants.W_OK);
            return absolute;
        }
        const next = dirname(parent);
        if (next === parent)
            throw new Error("state destination has no usable parent directory");
        parent = next;
    }
}

async function appVersion() {
    try {
        const value = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
        return typeof value.version === "string" ? value.version : "unknown";
    }
    catch {
        return "unknown";
    }
}

function configFingerprint(config) {
    const copy = structuredClone(config);
    delete copy.dataDir;
    return sha256(Buffer.from(JSON.stringify(copy)));
}

async function readStableFile(path) {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile())
        throw new Error("state snapshot contains a non-regular file");
    const content = await readFile(path);
    const after = await lstat(path);
    if (!after.isFile()
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs) {
        throw new Error("state changed while backup was being captured; stop the runtime and retry");
    }
    return {
        content,
        fingerprint: {
            size: after.size,
            mtimeMs: after.mtimeMs,
            ctimeMs: after.ctimeMs,
        },
        mode: after.mode & 0o777,
    };
}

async function assertFingerprint(path, fingerprint) {
    const current = await lstat(path);
    if (!current.isFile()
        || current.size !== fingerprint.size
        || current.mtimeMs !== fingerprint.mtimeMs
        || current.ctimeMs !== fingerprint.ctimeMs) {
        throw new Error("state changed while backup was being captured; stop the runtime and retry");
    }
}

async function walkRegularFiles(root, relativeRoot, entries) {
    const info = await statMaybe(root);
    if (!info)
        return;
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("state snapshot root is not a normal directory");
    const children = await readdir(root, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (transientSegment(child.name))
            continue;
        const source = join(root, child.name);
        const rel = relativeRoot ? `${relativeRoot}/${child.name}` : child.name;
        if (!safeRelativePath(rel, { allowComputers: true }))
            throw new Error("state snapshot contains a forbidden path");
        const childInfo = await lstat(source);
        if (childInfo.isSymbolicLink())
            throw new Error("state snapshot contains a symbolic link; stop/clean the source before backup");
        if (childInfo.isDirectory()) {
            await walkRegularFiles(source, rel, entries);
        }
        else if (childInfo.isFile()) {
            entries.push({ source, path: rel });
        }
        else {
            throw new Error("state snapshot contains a special file");
        }
    }
}

async function collectBackupSources(dataDir, includeComputerState) {
    const entries = [];
    const dataInfo = await statMaybe(dataDir);
    if (!dataInfo)
        return entries;
    if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink())
        throw new Error("dataDir must be a normal directory");

    for (const file of CORE_FILES) {
        const source = join(dataDir, file);
        const info = await statMaybe(source);
        if (!info)
            continue;
        if (!info.isFile() || info.isSymbolicLink())
            throw new Error(`durable state path is not a regular file: ${file}`);
        entries.push({ source, path: file });
    }

    const policyRoot = join(dataDir, "policy-versions");
    const transaction = await statMaybe(join(policyRoot, "transaction.json"));
    if (transaction)
        throw new Error("cannot back up while a policy transaction/recovery marker exists");
    await walkRegularFiles(policyRoot, "policy-versions", entries);

    if (includeComputerState)
        await walkRegularFiles(join(dataDir, "computers"), "computers", entries);

    return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
}

async function parseJsonl(path) {
    const info = await statMaybe(path);
    if (!info)
        return [];
    if (!info.isFile() || info.isSymbolicLink())
        throw new Error("JSONL state path is not a regular file");
    const rows = [];
    for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
        if (line.trim())
            rows.push(JSON.parse(line));
    }
    return rows;
}

function validPolicyPointer(pointer) {
    return pointer?.schemaVersion === 1
        && typeof pointer.versionId === "string"
        && POLICY_VERSION_ID.test(pointer.versionId)
        && typeof pointer.hash === "string"
        && SHA256.test(pointer.hash);
}

async function validateStateDirectory(dataDir, { allowMissing = true } = {}) {
    const info = await statMaybe(dataDir);
    if (!info) {
        if (allowMissing)
            return { ok: true, empty: true };
        throw new Error("state directory is missing");
    }
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("state directory must be a normal directory");

    const tasksPath = join(dataDir, "tasks.json");
    if (await statMaybe(tasksPath)) {
        const tasks = await readJson(tasksPath);
        if (!Array.isArray(tasks))
            throw new Error("tasks.json is invalid");
    }
    await parseJsonl(join(dataDir, "memory.jsonl"));
    await parseJsonl(join(dataDir, "task-events.jsonl"));

    const repeatPath = join(dataDir, "repeat-state.json");
    if (await statMaybe(repeatPath)) {
        const repeat = await readJson(repeatPath);
        if (repeat?.version !== 1 || !repeat.entries || typeof repeat.entries !== "object" || Array.isArray(repeat.entries))
            throw new Error("repeat-state.json is invalid");
        for (const [fingerprint, timestamps] of Object.entries(repeat.entries)) {
            if (!SHA256.test(fingerprint) || !Array.isArray(timestamps) || timestamps.some((at) => !Number.isFinite(at)))
                throw new Error("repeat-state.json contains an invalid entry");
        }
    }

    const auditPath = join(dataDir, "audit.jsonl");
    if (await statMaybe(auditPath)) {
        const result = await new AuditLog(auditPath).verify();
        if (!result.ok)
            throw new Error("audit hash chain is invalid");
    }

    const policyRoot = join(dataDir, "policy-versions");
    if (await statMaybe(policyRoot)) {
        if (!await normalDirectory(policyRoot))
            throw new Error("policy-versions is not a normal directory");
        if (await statMaybe(join(policyRoot, "transaction.json")))
            throw new Error("policy transaction/recovery marker is unresolved");
        const activePath = join(policyRoot, "active.json");
        if (await statMaybe(activePath)) {
            const pointer = await readJson(activePath);
            if (!validPolicyPointer(pointer))
                throw new Error("active policy pointer is invalid");
            const versionPath = join(policyRoot, "versions", `${pointer.versionId}.json`);
            const version = await readJson(versionPath);
            if (version?.schemaVersion !== 1
                || version.id !== pointer.versionId
                || !SHA256.test(version.hash ?? "")
                || policyHash(version.policy) !== pointer.hash
                || version.hash !== pointer.hash) {
                throw new Error("active policy version is invalid or hash-mismatched");
            }
        }
    }
    return { ok: true, empty: false };
}

async function outputStage(output) {
    const absolute = resolve(output);
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
    const existing = await statMaybe(absolute);
    if (existing)
        throw new Error("output already exists");
    const stage = join(dirname(absolute), `.${basename(absolute)}.staging-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    return { absolute, stage };
}

async function writePrivateFile(path, content, mode = 0o600) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode });
    await chmod(path, mode).catch(() => undefined);
}

export async function createStateBackup(config, output, { includeComputerState = false } = {}) {
    const dataDir = resolve(config.dataDir);
    const outputPath = resolve(output);
    if (isWithin(dataDir, outputPath))
        throw new Error("backup output cannot be inside dataDir");
    await validateStateDirectory(dataDir, { allowMissing: true });
    const sources = await collectBackupSources(dataDir, includeComputerState);
    const { absolute, stage } = await outputStage(outputPath);
    const captured = [];
    try {
        for (const source of sources) {
            const snapshot = await readStableFile(source.source);
            const path = portablePath(source.path);
            if (!safeRelativePath(path, { allowComputers: includeComputerState }))
                throw new Error("backup source resolved to an unsafe relative path");
            await writePrivateFile(join(stage, "files", ...path.split("/")), snapshot.content, 0o600);
            captured.push({
                source: source.source,
                fingerprint: snapshot.fingerprint,
                manifest: {
                    path,
                    size: snapshot.content.length,
                    sha256: sha256(snapshot.content),
                    mode: snapshot.mode,
                },
            });
        }
        for (const item of captured)
            await assertFingerprint(item.source, item.fingerprint);

        const manifest = {
            format: BACKUP_FORMAT,
            formatVersion: FORMAT_VERSION,
            createdAt: new Date().toISOString(),
            sourceVersion: await appVersion(),
            configFingerprint: configFingerprint(config),
            mode: includeComputerState ? "full-computer" : "core",
            sensitiveComputerState: includeComputerState,
            offlineConsistencyRequired: true,
            files: captured.map((item) => item.manifest),
        };
        await writePrivateFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        await replaceFileWithRetry(stage, absolute);
        return {
            path: absolute,
            mode: manifest.mode,
            files: manifest.files.length,
            sensitiveComputerState: manifest.sensitiveComputerState,
        };
    }
    catch (error) {
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

function validateManifest(manifest) {
    if (!manifest || manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== FORMAT_VERSION)
        throw new Error("backup manifest format/version is unsupported");
    if (!Array.isArray(manifest.files))
        throw new Error("backup manifest file list is invalid");
    if (!["core", "full-computer"].includes(manifest.mode))
        throw new Error("backup manifest mode is invalid");
    const allowComputers = manifest.mode === "full-computer" && manifest.sensitiveComputerState === true;
    const seen = new Set();
    for (const entry of manifest.files) {
        if (!entry || !safeRelativePath(entry.path, { allowComputers }))
            throw new Error("backup manifest contains an unsafe path");
        if (seen.has(entry.path))
            throw new Error("backup manifest contains duplicate paths");
        seen.add(entry.path);
        if (!Number.isInteger(entry.size) || entry.size < 0 || !SHA256.test(entry.sha256 ?? ""))
            throw new Error("backup manifest contains invalid file integrity metadata");
        if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)
            throw new Error("backup manifest contains an invalid file mode");
    }
    return { allowComputers, seen };
}

async function listBundleFiles(root, relativeRoot = "") {
    const info = await statMaybe(root);
    if (!info)
        return [];
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("backup files root is not a normal directory");
    const result = [];
    for (const child of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(root, child.name);
        const rel = relativeRoot ? `${relativeRoot}/${child.name}` : child.name;
        const childInfo = await lstat(path);
        if (childInfo.isSymbolicLink())
            throw new Error("backup bundle contains a symbolic link");
        if (childInfo.isDirectory())
            result.push(...await listBundleFiles(path, rel));
        else if (childInfo.isFile())
            result.push(rel);
        else
            throw new Error("backup bundle contains a special file");
    }
    return result;
}

async function verifyBackupBundle(bundle) {
    const bundlePath = resolve(bundle);
    const info = await statMaybe(bundlePath);
    if (!info?.isDirectory() || info.isSymbolicLink())
        throw new Error("backup bundle must be a normal directory");
    const manifestInfo = await lstat(join(bundlePath, "manifest.json"));
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())
        throw new Error("backup manifest must be a regular file");
    const manifest = await readJson(join(bundlePath, "manifest.json"));
    const { seen } = validateManifest(manifest);
    const actual = await listBundleFiles(join(bundlePath, "files"));
    if (actual.length !== seen.size || actual.some((path) => !seen.has(path)))
        throw new Error("backup bundle contains undeclared or missing files");
    return { bundlePath, manifest };
}

async function copyVerifiedBundleToStage(bundlePath, manifest, stage) {
    for (const entry of manifest.files) {
        const source = join(bundlePath, "files", ...entry.path.split("/"));
        const snapshot = await readStableFile(source);
        if (snapshot.content.length !== entry.size || sha256(snapshot.content) !== entry.sha256)
            throw new Error("backup file integrity check failed");
        const target = join(stage, ...entry.path.split("/"));
        await writePrivateFile(target, snapshot.content, entry.mode);
    }
}

export async function restoreStateBackup(config, bundle, { replace = false } = {}) {
    const dataDir = await ensureSafeDestinationRoot(config.dataDir);
    const bundlePath = resolve(bundle);
    if (isWithin(dataDir, bundlePath))
        throw new Error("backup bundle cannot be inside the destination dataDir");
    const { manifest } = await verifyBackupBundle(bundlePath);
    const targetInfo = await statMaybe(dataDir);
    let targetEmpty = false;
    if (targetInfo) {
        if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink())
            throw new Error("destination dataDir must be a normal directory");
        targetEmpty = (await readdir(dataDir)).length === 0;
        if (!targetEmpty && !replace)
            throw new Error("destination dataDir is not empty; pass --replace for transactional replacement");
    }

    const stage = join(dirname(dataDir), `.${basename(dataDir)}.restore-staging-${randomUUID()}`);
    const recovery = join(dirname(dataDir), `.${basename(dataDir)}.restore-backup-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    try {
        await copyVerifiedBundleToStage(bundlePath, manifest, stage);
        await validateStateDirectory(stage, { allowMissing: false });
        if (targetInfo && targetEmpty) {
            await rm(dataDir, { recursive: true, force: true });
            await replaceFileWithRetry(stage, dataDir);
        }
        else if (!targetInfo) {
            await replaceFileWithRetry(stage, dataDir);
        }
        else {
            await replaceFileWithRetry(dataDir, recovery);
            try {
                await replaceFileWithRetry(stage, dataDir);
            }
            catch (swapError) {
                try {
                    await replaceFileWithRetry(recovery, dataDir);
                }
                catch (rollbackError) {
                    throw new AggregateError([swapError, rollbackError], "restore swap failed and previous dataDir rollback also failed");
                }
                throw swapError;
            }
            await rm(recovery, { recursive: true, force: true });
        }
        await validateStateDirectory(dataDir, { allowMissing: false });
        return {
            path: dataDir,
            mode: manifest.mode,
            files: manifest.files.length,
            sensitiveComputerState: manifest.sensitiveComputerState === true,
        };
    }
    catch (error) {
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

function increment(object, key) {
    object[key] = (object[key] ?? 0) + 1;
}

async function safeExportSummary(config) {
    const dataDir = resolve(config.dataDir);
    const result = {
        generatedAt: new Date().toISOString(),
        sourceVersion: await appVersion(),
        configFingerprint: configFingerprint(config),
        restorable: false,
        tasks: { total: 0, byStatus: {}, byKind: {} },
        memory: { total: 0, byScopeClass: {} },
        audit: { present: false, integrity: "not-present", rows: 0, byType: {} },
        repeat: { activeFingerprintCount: 0 },
        policy: { initialized: false },
        diagnostics: [],
    };

    try {
        const path = join(dataDir, "tasks.json");
        if (await statMaybe(path)) {
            const tasks = await readJson(path);
            if (!Array.isArray(tasks))
                throw new Error("invalid");
            result.tasks.total = tasks.length;
            for (const task of tasks) {
                increment(result.tasks.byStatus, String(task.status ?? "unknown"));
                increment(result.tasks.byKind, String(task.kind ?? "unknown"));
            }
        }
    }
    catch { result.diagnostics.push("tasks-unreadable"); }

    try {
        const rows = await parseJsonl(join(dataDir, "memory.jsonl"));
        result.memory.total = rows.length;
        for (const row of rows) {
            const scope = String(row.scope ?? "unknown");
            const scopeClass = scope.includes(":") ? scope.split(":", 1)[0] : scope;
            increment(result.memory.byScopeClass, scopeClass);
        }
    }
    catch { result.diagnostics.push("memory-unreadable"); }

    try {
        const path = join(dataDir, "audit.jsonl");
        if (await statMaybe(path)) {
            result.audit.present = true;
            const verification = await new AuditLog(path).verify();
            result.audit.integrity = verification.ok ? "ok" : "invalid";
            result.audit.rows = verification.count ?? 0;
            const rows = await parseJsonl(path);
            for (const row of rows)
                increment(result.audit.byType, String(row.type ?? "unknown"));
        }
    }
    catch { result.audit.integrity = "unreadable"; result.diagnostics.push("audit-unreadable"); }

    try {
        const path = join(dataDir, "repeat-state.json");
        if (await statMaybe(path)) {
            const repeat = await readJson(path);
            result.repeat.activeFingerprintCount = repeat?.entries && typeof repeat.entries === "object"
                ? Object.keys(repeat.entries).length
                : 0;
        }
    }
    catch { result.diagnostics.push("repeat-unreadable"); }

    try {
        const path = join(dataDir, "policy-versions", "active.json");
        if (await statMaybe(path)) {
            const active = await readJson(path);
            result.policy = {
                initialized: true,
                versionId: validPolicyPointer(active) ? active.versionId : "invalid",
                hash: validPolicyPointer(active) ? active.hash : undefined,
            };
        }
    }
    catch { result.diagnostics.push("policy-unreadable"); }
    result.diagnostics.sort();
    return result;
}

export async function exportState(config, output) {
    const dataDir = resolve(config.dataDir);
    const outputPath = resolve(output);
    if (isWithin(dataDir, outputPath))
        throw new Error("export output cannot be inside dataDir");
    const { absolute, stage } = await outputStage(outputPath);
    try {
        const summary = await safeExportSummary(config);
        const exportJson = `${JSON.stringify(summary, null, 2)}\n`;
        const manifest = {
            format: EXPORT_FORMAT,
            formatVersion: FORMAT_VERSION,
            createdAt: new Date().toISOString(),
            sourceVersion: summary.sourceVersion,
            restorable: false,
            redacted: true,
            files: [{ path: "export.json", size: Buffer.byteLength(exportJson), sha256: sha256(Buffer.from(exportJson)) }],
        };
        await writePrivateFile(join(stage, "export.json"), exportJson);
        await writePrivateFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        await replaceFileWithRetry(stage, absolute);
        return { path: absolute, restorable: false, redacted: true };
    }
    catch (error) {
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

export async function inspectStateBackup(bundle) {
    const { manifest } = await verifyBackupBundle(bundle);
    return structuredClone(manifest);
}

export const STATE_BACKUP_FORMAT = BACKUP_FORMAT;
export const STATE_EXPORT_FORMAT = EXPORT_FORMAT;
export const STATE_TRANSFER_FORMAT_VERSION = FORMAT_VERSION;
