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
const POLICY_VERSION_FILE = /^policy-versions\/versions\/(policy_[0-9a-f-]{36})\.json$/;
const SHA256 = /^[0-9a-f]{64}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SAFE_TASK_STATUS = new Set(["queued", "accepted", "running", "awaiting_review", "changes_requested", "completed", "failed", "blocked", "cancelled"]);
const SAFE_TASK_KIND = new Set(["work", "plan"]);

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
        || name.includes(".old-")
        || name.includes(".restore-staging-")
        || name.includes(".restore-backup-");
}

function portableSegment(name) {
    return !/[<>:"|?*\u0000-\u001f]/.test(name)
        && !/[. ]$/.test(name)
        && !WINDOWS_RESERVED.test(name);
}

function safeRelativePath(value, { allowComputers = false } = {}) {
    if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0"))
        return false;
    if (value.startsWith("/") || value.endsWith("/") || value.includes("//"))
        return false;
    const parts = value.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || transientSegment(part) || !portableSegment(part)))
        return false;
    if (FORBIDDEN_PREFIXES.some((prefix) => value === prefix.slice(0, -1) || value.startsWith(prefix)))
        return false;
    if (value === "policy-versions/transaction.json")
        return false;
    if (!allowComputers && (value === "computers" || value.startsWith("computers/")))
        return false;
    return true;
}

function allowedBackupPath(value, { allowComputers = false } = {}) {
    if (!safeRelativePath(value, { allowComputers }))
        return false;
    if (CORE_FILES.includes(value))
        return true;
    if (value === "policy-versions/active.json")
        return true;
    if (POLICY_VERSION_FILE.test(value))
        return true;
    if (allowComputers && value.startsWith("computers/"))
        return true;
    return false;
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

async function ensureSafeDirectoryTarget(path, label = "state destination") {
    const absolute = resolve(path);
    if (absolute === parse(absolute).root)
        throw new Error(`${label} cannot be a filesystem root`);
    const info = await statMaybe(absolute);
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
        throw new Error(`${label} must be a normal directory`);
    let parent = dirname(absolute);
    while (true) {
        const parentInfo = await statMaybe(parent);
        if (parentInfo) {
            if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
                throw new Error(`${label} parent must be a normal directory`);
            await access(parent, constants.R_OK | constants.W_OK);
            return absolute;
        }
        const next = dirname(parent);
        if (next === parent)
            throw new Error(`${label} has no usable parent directory`);
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
            sha256: sha256(content),
        },
        mode: after.mode & 0o777,
    };
}

async function assertFingerprint(path, fingerprint) {
    const current = await readStableFile(path);
    if (current.fingerprint.size !== fingerprint.size
        || current.fingerprint.mtimeMs !== fingerprint.mtimeMs
        || current.fingerprint.ctimeMs !== fingerprint.ctimeMs
        || current.fingerprint.sha256 !== fingerprint.sha256) {
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
            throw new Error("state snapshot contains a forbidden or non-portable path");
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

function sameSourceMembership(before, after) {
    if (before.length !== after.length)
        return false;
    return before.every((entry, index) => entry.path === after[index].path);
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
        && SHA256.test(pointer.hash)
        && typeof pointer.activatedAt === "string"
        && !Number.isNaN(Date.parse(pointer.activatedAt));
}

function validatePolicyVersion(version, expectedId) {
    if (!version || version.schemaVersion !== 1 || version.id !== expectedId || !POLICY_VERSION_ID.test(version.id ?? ""))
        throw new Error("policy version is invalid");
    if (!SHA256.test(version.hash ?? ""))
        throw new Error("policy version has an invalid hash");
    if (typeof version.createdAt !== "string" || Number.isNaN(Date.parse(version.createdAt)))
        throw new Error("policy version has an invalid createdAt");
    if (version.parentVersionId !== undefined && version.parentVersionId !== null && !POLICY_VERSION_ID.test(version.parentVersionId))
        throw new Error("policy version has an invalid parentVersionId");
    if (version.label !== undefined && typeof version.label !== "string")
        throw new Error("policy version has an invalid label");
    if (policyHash(version.policy) !== version.hash)
        throw new Error("policy version hash mismatch");
    return version;
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
        const versionsDir = join(policyRoot, "versions");
        const versionsInfo = await statMaybe(versionsDir);
        if (versionsInfo && (!versionsInfo.isDirectory() || versionsInfo.isSymbolicLink()))
            throw new Error("policy versions directory is not a normal directory");
        const versionNames = versionsInfo ? await readdir(versionsDir) : [];
        const versionById = new Map();
        for (const name of versionNames) {
            const match = /^(policy_[0-9a-f-]{36})\.json$/.exec(name);
            if (!match)
                throw new Error("policy versions directory contains an unsupported file");
            const path = join(versionsDir, name);
            const versionInfo = await statMaybe(path);
            if (!versionInfo?.isFile() || versionInfo.isSymbolicLink())
                throw new Error("policy version is not a regular file");
            versionById.set(match[1], validatePolicyVersion(await readJson(path), match[1]));
        }
        const activePath = join(policyRoot, "active.json");
        const activeInfo = await statMaybe(activePath);
        if (!activeInfo && versionById.size)
            throw new Error("policy versions exist but active.json is missing");
        if (activeInfo) {
            if (!activeInfo.isFile() || activeInfo.isSymbolicLink())
                throw new Error("active policy pointer is not a regular file");
            const pointer = await readJson(activePath);
            if (!validPolicyPointer(pointer))
                throw new Error("active policy pointer is invalid");
            const version = versionById.get(pointer.versionId);
            if (!version || version.hash !== pointer.hash)
                throw new Error("active policy version is invalid or hash-mismatched");
        }
    }
    return { ok: true, empty: false };
}

async function outputStage(output) {
    const absolute = await ensureSafeDirectoryTarget(output, "state output");
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

async function movePath(source, destination, renameFn = rename) {
    await replaceFileWithRetry(source, destination, { renameFn });
}

export async function createStateBackup(config, output, {
    includeComputerState = false,
    consistencyHook,
} = {}) {
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
            if (!allowedBackupPath(path, { allowComputers: includeComputerState }))
                throw new Error("backup source contains an unsafe path or unsupported state file");
            await writePrivateFile(join(stage, "files", ...path.split("/")), snapshot.content, 0o600);
            captured.push({
                source: source.source,
                fingerprint: snapshot.fingerprint,
                manifest: {
                    path,
                    size: snapshot.content.length,
                    sha256: snapshot.fingerprint.sha256,
                    mode: snapshot.mode,
                },
            });
        }

        await consistencyHook?.();
        for (const item of captured)
            await assertFingerprint(item.source, item.fingerprint);
        const finalSources = await collectBackupSources(dataDir, includeComputerState);
        if (!sameSourceMembership(sources, finalSources))
            throw new Error("state file membership changed while backup was being captured; stop the runtime and retry");

        const manifest = {
            format: BACKUP_FORMAT,
            formatVersion: FORMAT_VERSION,
            createdAt: new Date().toISOString(),
            sourceVersion: await appVersion(),
            mode: includeComputerState ? "full-computer" : "core",
            sensitiveComputerState: includeComputerState,
            offlineConsistencyRequired: true,
            files: captured.map((item) => item.manifest),
        };
        await writePrivateFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        await movePath(stage, absolute);
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
    if ((manifest.mode === "core" && manifest.sensitiveComputerState !== false)
        || (manifest.mode === "full-computer" && manifest.sensitiveComputerState !== true)
        || manifest.offlineConsistencyRequired !== true) {
        throw new Error("backup manifest security metadata is inconsistent");
    }
    if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt)) || typeof manifest.sourceVersion !== "string")
        throw new Error("backup manifest provenance metadata is invalid");
    const allowComputers = manifest.mode === "full-computer";
    const seen = new Set();
    for (const entry of manifest.files) {
        if (!entry || !allowedBackupPath(entry.path, { allowComputers }))
            throw new Error("backup manifest contains an unsafe path or unsupported state file");
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
    const manifestInfo = await statMaybe(join(bundlePath, "manifest.json"));
    if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink())
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
        if (snapshot.content.length !== entry.size || snapshot.fingerprint.sha256 !== entry.sha256)
            throw new Error("backup file integrity check failed");
        const target = join(stage, ...entry.path.split("/"));
        await writePrivateFile(target, snapshot.content, entry.mode & 0o700);
    }
}

async function restorePriorState({ dataDir, recovery, hadTarget, targetWasEmpty, renameFn }) {
    const installed = await statMaybe(dataDir);
    if (installed)
        await rm(dataDir, { recursive: true, force: true });
    if (hadTarget && !targetWasEmpty) {
        await movePath(recovery, dataDir, renameFn);
    }
    else if (hadTarget && targetWasEmpty) {
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
    }
}

export async function restoreStateBackup(config, bundle, {
    replace = false,
    renameFn = rename,
} = {}) {
    const dataDir = await ensureSafeDirectoryTarget(config.dataDir);
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

    await mkdir(dirname(dataDir), { recursive: true, mode: 0o700 });
    const stage = join(dirname(dataDir), `.${basename(dataDir)}.restore-staging-${randomUUID()}`);
    const recovery = join(dirname(dataDir), `.${basename(dataDir)}.restore-backup-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    let previousMoved = false;
    let newInstalled = false;
    try {
        await copyVerifiedBundleToStage(bundlePath, manifest, stage);
        await validateStateDirectory(stage, { allowMissing: false });

        if (targetInfo && targetEmpty) {
            await rm(dataDir, { recursive: true, force: true });
            await movePath(stage, dataDir, renameFn);
            newInstalled = true;
        }
        else if (!targetInfo) {
            await movePath(stage, dataDir, renameFn);
            newInstalled = true;
        }
        else {
            await movePath(dataDir, recovery, renameFn);
            previousMoved = true;
            try {
                await movePath(stage, dataDir, renameFn);
                newInstalled = true;
            }
            catch (swapError) {
                try {
                    await movePath(recovery, dataDir, renameFn);
                    previousMoved = false;
                }
                catch (rollbackError) {
                    throw new AggregateError([swapError, rollbackError], "restore swap failed and previous dataDir rollback also failed");
                }
                throw swapError;
            }
        }

        try {
            await validateStateDirectory(dataDir, { allowMissing: false });
        }
        catch (validationError) {
            try {
                await restorePriorState({
                    dataDir,
                    recovery,
                    hadTarget: Boolean(targetInfo),
                    targetWasEmpty: targetEmpty,
                    renameFn,
                });
                previousMoved = false;
                newInstalled = false;
            }
            catch (rollbackError) {
                throw new AggregateError([validationError, rollbackError], "restored state validation failed and previous dataDir rollback also failed");
            }
            throw validationError;
        }

        if (previousMoved) {
            await rm(recovery, { recursive: true, force: true });
            previousMoved = false;
        }
        return {
            path: dataDir,
            mode: manifest.mode,
            files: manifest.files.length,
            sensitiveComputerState: manifest.sensitiveComputerState === true,
        };
    }
    catch (error) {
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
        if (previousMoved && !newInstalled) {
            try {
                await movePath(recovery, dataDir, renameFn);
                previousMoved = false;
            }
            catch (rollbackError) {
                throw new AggregateError([error, rollbackError], "restore failed and previous dataDir rollback also failed");
            }
        }
        throw error;
    }
}

function increment(object, key) {
    object[key] = (object[key] ?? 0) + 1;
}

function safeTaskStatus(value) {
    return SAFE_TASK_STATUS.has(value) ? value : "unknown";
}

function safeTaskKind(value) {
    return SAFE_TASK_KIND.has(value) ? value : "unknown";
}

function safeScopeClass(value) {
    if (value === "global")
        return "global";
    if (typeof value === "string" && value.startsWith("agent:"))
        return "agent";
    if (typeof value === "string" && value.startsWith("task:"))
        return "task";
    return "unknown";
}

async function safeExportSummary(config) {
    const dataDir = resolve(config.dataDir);
    const result = {
        generatedAt: new Date().toISOString(),
        sourceVersion: await appVersion(),
        restorable: false,
        tasks: { total: 0, byStatus: {}, byKind: {} },
        memory: { total: 0, byScopeClass: {} },
        audit: { present: false, integrity: "not-present", rows: 0 },
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
                increment(result.tasks.byStatus, safeTaskStatus(task?.status));
                increment(result.tasks.byKind, safeTaskKind(task?.kind));
            }
        }
    }
    catch { result.diagnostics.push("tasks-unreadable"); }

    try {
        const rows = await parseJsonl(join(dataDir, "memory.jsonl"));
        result.memory.total = rows.length;
        for (const row of rows)
            increment(result.memory.byScopeClass, safeScopeClass(row?.scope));
    }
    catch { result.diagnostics.push("memory-unreadable"); }

    try {
        const path = join(dataDir, "audit.jsonl");
        if (await statMaybe(path)) {
            result.audit.present = true;
            const verification = await new AuditLog(path).verify();
            result.audit.integrity = verification.ok ? "ok" : "invalid";
            result.audit.rows = verification.count ?? 0;
        }
    }
    catch { result.audit.integrity = "unreadable"; result.diagnostics.push("audit-unreadable"); }

    try {
        const path = join(dataDir, "repeat-state.json");
        if (await statMaybe(path)) {
            const repeat = await readJson(path);
            result.repeat.activeFingerprintCount = repeat?.entries && typeof repeat.entries === "object" && !Array.isArray(repeat.entries)
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
        await movePath(stage, absolute);
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
