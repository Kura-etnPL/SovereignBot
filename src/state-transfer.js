import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import {
    access,
    chmod,
    lstat,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AuditLog } from "./audit.js";
import { inspectComputerMigration } from "./computer-migration.js";
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
const CORE_FILE_SET = new Set(CORE_FILES);
const POLICY_VERSION_ID = /^policy_[0-9a-f-]{36}$/;
const POLICY_VERSION_FILE = /^policy-versions\/versions\/(policy_[0-9a-f-]{36})\.json$/;
const POLICY_VERSION_BASENAME = /^(policy_[0-9a-f-]{36})\.json$/;
const SHA256 = /^[0-9a-f]{64}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SAFE_TASK_STATUS = new Set([
    "queued",
    "accepted",
    "running",
    "awaiting_review",
    "changes_requested",
    "completed",
    "failed",
    "blocked",
    "cancelled",
]);
const SAFE_TASK_KIND = new Set(["work", "plan"]);
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_FILES = 250_000;

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

function runtimeScratchName(name) {
    return name === ".bootstrap"
        || name === ".staging"
        || name.includes(".tmp-")
        || name.includes(".new-")
        || name.includes(".old-")
        || name.includes(".restore-staging-")
        || name.includes(".restore-backup-");
}

function portableSegment(name) {
    return typeof name === "string"
        && name.length > 0
        && name.length <= 255
        && !/[<>:"|?*\u0000-\u001f]/.test(name)
        && !/[. ]$/.test(name)
        && !WINDOWS_RESERVED.test(name);
}

function basicPortableRelativePath(value) {
    if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0"))
        return false;
    if (value.startsWith("/") || value.endsWith("/") || value.includes("//"))
        return false;
    const parts = value.split("/");
    return parts.every((part) => part !== "." && part !== ".." && portableSegment(part));
}

function allowedComputerPath(value) {
    if (!basicPortableRelativePath(value) || !value.startsWith("computers/"))
        return false;
    const parts = value.split("/");
    if (parts.length < 2)
        return false;
    // Runtime atomic/recovery scratch may appear directly under the registry root. Nested
    // profile/workspace names are user/browser data and must not be silently filtered merely
    // because they happen to contain a temp-like substring.
    if (parts.length === 2 && runtimeScratchName(parts[1]))
        return false;
    return true;
}

function allowedBackupPath(value, { allowComputers = false } = {}) {
    if (!basicPortableRelativePath(value))
        return false;
    if (CORE_FILE_SET.has(value))
        return true;
    if (value === "policy-versions/active.json")
        return true;
    if (POLICY_VERSION_FILE.test(value))
        return true;
    if (allowComputers && allowedComputerPath(value))
        return true;
    return false;
}

function portableCollisionKey(value) {
    return value.normalize("NFC").toLowerCase();
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

async function assertNoSymlinkComponents(path, label) {
    const absolute = resolve(path);
    const parsed = parse(absolute);
    const rel = relative(parsed.root, absolute);
    let current = parsed.root;
    for (const segment of rel.split(sep).filter(Boolean)) {
        current = join(current, segment);
        const info = await statMaybe(current);
        if (!info)
            continue;
        if (info.isSymbolicLink())
            throw new Error(`${label} cannot traverse a symbolic-link/junction component`);
    }
}

async function ensureSafeDirectoryTarget(path, label = "state destination") {
    const absolute = resolve(path);
    if (absolute === parse(absolute).root)
        throw new Error(`${label} cannot be a filesystem root`);
    await assertNoSymlinkComponents(absolute, label);
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

function stableIdentity(info) {
    return {
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        dev: info.dev,
        ino: info.ino,
    };
}

function sameIdentity(a, b) {
    return a.size === b.size
        && a.mtimeMs === b.mtimeMs
        && a.ctimeMs === b.ctimeMs
        && a.dev === b.dev
        && a.ino === b.ino;
}

async function hashStableFile(path) {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile())
        throw new Error("state snapshot contains a non-regular file");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(path)) {
        bytes += chunk.length;
        hash.update(chunk);
    }
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(stableIdentity(before), stableIdentity(after)) || bytes !== after.size)
        throw new Error("state changed while backup was being captured; stop the runtime and retry");
    return {
        size: bytes,
        sha256: hash.digest("hex"),
        identity: stableIdentity(after),
        mode: after.mode & 0o777,
    };
}

async function copyStableFile(source, target, { targetMode = 0o600 } = {}) {
    const before = await lstat(source);
    if (before.isSymbolicLink() || !before.isFile())
        throw new Error("state snapshot contains a non-regular file");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const hash = createHash("sha256");
    let bytes = 0;
    const tap = new Transform({
        transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            hash.update(chunk);
            callback(null, chunk);
        },
    });
    await pipeline(
        createReadStream(source),
        tap,
        createWriteStream(target, { flags: "wx", mode: targetMode }),
    );
    await chmod(target, targetMode).catch(() => undefined);
    const after = await lstat(source);
    if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(stableIdentity(before), stableIdentity(after)) || bytes !== after.size)
        throw new Error("state changed while backup was being captured; stop the runtime and retry");
    return {
        size: bytes,
        sha256: hash.digest("hex"),
        identity: stableIdentity(after),
        mode: after.mode & 0o777,
    };
}

async function assertFingerprint(path, fingerprint) {
    const current = await hashStableFile(path);
    if (!sameIdentity(current.identity, fingerprint.identity) || current.sha256 !== fingerprint.sha256)
        throw new Error("state changed while backup was being captured; stop the runtime and retry");
}

async function requireRegularFile(path, label) {
    const info = await statMaybe(path);
    if (!info)
        return undefined;
    if (!info.isFile() || info.isSymbolicLink())
        throw new Error(`${label} is not a regular file`);
    return info;
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

async function validatePolicyState(dataDir) {
    const policyRoot = join(dataDir, "policy-versions");
    const rootInfo = await statMaybe(policyRoot);
    if (!rootInfo)
        return;
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
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
        if (runtimeScratchName(name))
            continue;
        const match = POLICY_VERSION_BASENAME.exec(name);
        if (!match)
            throw new Error("policy versions directory contains an unsupported file");
        const path = join(versionsDir, name);
        await requireRegularFile(path, "policy version");
        versionById.set(match[1], validatePolicyVersion(await readJson(path), match[1]));
    }

    const rootNames = await readdir(policyRoot);
    for (const name of rootNames) {
        if (["active.json", "versions"].includes(name) || runtimeScratchName(name))
            continue;
        throw new Error("policy-versions contains an unsupported state file");
    }

    const activePath = join(policyRoot, "active.json");
    const activeInfo = await statMaybe(activePath);
    if (!activeInfo && versionById.size)
        throw new Error("policy versions exist but active.json is missing");
    if (activeInfo) {
        await requireRegularFile(activePath, "active policy pointer");
        const pointer = await readJson(activePath);
        if (!validPolicyPointer(pointer))
            throw new Error("active policy pointer is invalid");
        const version = versionById.get(pointer.versionId);
        if (!version || version.hash !== pointer.hash)
            throw new Error("active policy version is invalid or hash-mismatched");
    }
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
        await requireRegularFile(tasksPath, "tasks.json");
        const tasks = await readJson(tasksPath);
        if (!Array.isArray(tasks))
            throw new Error("tasks.json is invalid");
    }
    await parseJsonl(join(dataDir, "memory.jsonl"));
    await parseJsonl(join(dataDir, "task-events.jsonl"));

    const repeatPath = join(dataDir, "repeat-state.json");
    if (await statMaybe(repeatPath)) {
        await requireRegularFile(repeatPath, "repeat-state.json");
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
        await requireRegularFile(auditPath, "audit.jsonl");
        const result = await new AuditLog(auditPath).verify();
        if (!result.ok)
            throw new Error("audit hash chain is invalid");
    }

    await validatePolicyState(dataDir);

    const computers = join(dataDir, "computers");
    const computersInfo = await statMaybe(computers);
    if (computersInfo && (!computersInfo.isDirectory() || computersInfo.isSymbolicLink()))
        throw new Error("computers state root is not a normal directory");
    const computerStatePath = join(computers, "state.json");
    if (await statMaybe(computerStatePath)) {
        await requireRegularFile(computerStatePath, "computer state");
        const state = await readJson(computerStatePath);
        if (state?.version !== 2 || !state.agents || typeof state.agents !== "object" || Array.isArray(state.agents))
            throw new Error("computer state is invalid or unsupported");
    }

    return { ok: true, empty: false };
}

async function validateTopLevelBackupMembership(dataDir) {
    const info = await statMaybe(dataDir);
    if (!info)
        return;
    const known = new Set([
        ...CORE_FILES,
        "policy-versions",
        "computers",
        "operator-sessions",
        "tool-bridges",
        // Desktop product state and managed artifact content are governed by the
        // Desktop lifecycle service. Core backup intentionally excludes them, but
        // their presence must not make an otherwise valid core state directory
        // appear corrupt.
        "desktop-state",
        "artifacts",
    ]);
    for (const name of await readdir(dataDir)) {
        if (known.has(name) || runtimeScratchName(name))
            continue;
        throw new Error(`dataDir contains unsupported state path: ${name}`);
    }
}

async function assertNoPendingComputerMigration(config, dataDir) {
    let inspection;
    try {
        inspection = await inspectComputerMigration(
            join(dataDir, "computers"),
            (config.agents ?? []).map((agent) => String(agent.id)),
        );
    }
    catch {
        throw new Error("cannot back up while computer registry migration state is invalid or unsafe");
    }
    if (!["none", "current"].includes(inspection.status))
        throw new Error("cannot back up while computer registry migration is required, in progress, or awaiting cleanup");
}

async function collectPolicySources(dataDir, entries) {
    const root = join(dataDir, "policy-versions");
    const info = await statMaybe(root);
    if (!info)
        return;
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("policy-versions is not a normal directory");
    if (await statMaybe(join(root, "transaction.json")))
        throw new Error("cannot back up while a policy transaction/recovery marker exists");

    const active = join(root, "active.json");
    if (await statMaybe(active)) {
        await requireRegularFile(active, "active policy pointer");
        entries.push({ source: active, path: "policy-versions/active.json" });
    }

    const versions = join(root, "versions");
    const versionsInfo = await statMaybe(versions);
    if (versionsInfo) {
        if (!versionsInfo.isDirectory() || versionsInfo.isSymbolicLink())
            throw new Error("policy versions directory is not a normal directory");
        for (const name of (await readdir(versions)).sort()) {
            if (runtimeScratchName(name))
                continue;
            if (!POLICY_VERSION_BASENAME.test(name))
                throw new Error("policy versions directory contains an unsupported file");
            const source = join(versions, name);
            await requireRegularFile(source, "policy version");
            entries.push({ source, path: `policy-versions/versions/${name}` });
        }
    }
}

async function walkComputerSources(root, relativeRoot, entries, depth = 0) {
    const info = await statMaybe(root);
    if (!info)
        return;
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("computer state root is not a normal directory");
    const children = await readdir(root, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (depth === 0 && runtimeScratchName(child.name))
            continue;
        const source = join(root, child.name);
        const rel = `${relativeRoot}/${child.name}`;
        if (!allowedComputerPath(rel))
            throw new Error("computer state contains a forbidden or non-portable path");
        const childInfo = await lstat(source);
        if (childInfo.isSymbolicLink())
            throw new Error("computer state contains a symbolic link/junction; stop/clean the source before backup");
        if (childInfo.isDirectory())
            await walkComputerSources(source, rel, entries, depth + 1);
        else if (childInfo.isFile())
            entries.push({ source, path: rel });
        else
            throw new Error("computer state contains a special file");
    }
}

async function collectBackupSources(dataDir, includeComputerState) {
    const entries = [];
    const dataInfo = await statMaybe(dataDir);
    if (!dataInfo)
        return entries;
    if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink())
        throw new Error("dataDir must be a normal directory");
    await validateTopLevelBackupMembership(dataDir);

    for (const file of CORE_FILES) {
        const source = join(dataDir, file);
        if (!await statMaybe(source))
            continue;
        await requireRegularFile(source, file);
        entries.push({ source, path: file });
    }
    await collectPolicySources(dataDir, entries);
    if (includeComputerState)
        await walkComputerSources(join(dataDir, "computers"), "computers", entries);

    entries.sort((a, b) => a.path.localeCompare(b.path));
    const collisions = new Set();
    for (const entry of entries) {
        const key = portableCollisionKey(entry.path);
        if (collisions.has(key))
            throw new Error("state snapshot contains paths that collide on a case-insensitive portable filesystem");
        collisions.add(key);
    }
    return entries;
}

function sameSourceMembership(before, after) {
    if (before.length !== after.length)
        return false;
    return before.every((entry, index) => entry.path === after[index].path);
}

async function outputStage(output) {
    const absolute = await ensureSafeDirectoryTarget(output, "state output");
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
    await assertNoSymlinkComponents(dirname(absolute), "state output");
    const existing = await statMaybe(absolute);
    if (existing)
        throw new Error("output already exists");
    const stage = join(dirname(absolute), `.${basename(absolute)}.staging-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    return { absolute, stage };
}

async function writePrivateFile(path, content, mode = 0o600) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode, flag: "wx" });
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
    await assertNoPendingComputerMigration(config, dataDir);
    await validateStateDirectory(dataDir, { allowMissing: true });
    const sources = await collectBackupSources(dataDir, includeComputerState);
    const { absolute, stage } = await outputStage(outputPath);
    const captured = [];
    try {
        for (const source of sources) {
            const path = portablePath(source.path);
            if (!allowedBackupPath(path, { allowComputers: includeComputerState }))
                throw new Error("backup source contains an unsafe path or unsupported state file");
            const snapshot = await copyStableFile(
                source.source,
                join(stage, "files", ...path.split("/")),
                { targetMode: 0o600 },
            );
            captured.push({
                source: source.source,
                fingerprint: snapshot,
                manifest: {
                    path,
                    size: snapshot.size,
                    sha256: snapshot.sha256,
                    mode: snapshot.mode,
                },
            });
        }

        await consistencyHook?.();
        for (const item of captured)
            await assertFingerprint(item.source, item.fingerprint);
        await assertNoPendingComputerMigration(config, dataDir);
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
    if (!Array.isArray(manifest.files) || manifest.files.length > MAX_MANIFEST_FILES)
        throw new Error("backup manifest file list is invalid or too large");
    if (!["core", "full-computer"].includes(manifest.mode))
        throw new Error("backup manifest mode is invalid");
    const allowComputers = manifest.mode === "full-computer";
    const seen = new Set();
    const portableSeen = new Set();
    for (const entry of manifest.files) {
        if (!entry || !allowedBackupPath(entry.path, { allowComputers }))
            throw new Error("backup manifest contains an unsafe path or unsupported state file");
        if (seen.has(entry.path))
            throw new Error("backup manifest contains duplicate paths");
        seen.add(entry.path);
        const portableKey = portableCollisionKey(entry.path);
        if (portableSeen.has(portableKey))
            throw new Error("backup manifest contains paths that collide on a case-insensitive portable filesystem");
        portableSeen.add(portableKey);
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !SHA256.test(entry.sha256 ?? ""))
            throw new Error("backup manifest contains invalid file integrity metadata");
        if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)
            throw new Error("backup manifest contains an invalid file mode");
    }
    if ((manifest.mode === "core" && manifest.sensitiveComputerState !== false)
        || (manifest.mode === "full-computer" && manifest.sensitiveComputerState !== true)
        || manifest.offlineConsistencyRequired !== true) {
        throw new Error("backup manifest security metadata is inconsistent");
    }
    if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt)))
        throw new Error("backup manifest provenance metadata is invalid");
    if (typeof manifest.sourceVersion !== "string" || manifest.sourceVersion.length < 1 || manifest.sourceVersion.length > 120)
        throw new Error("backup manifest provenance metadata is invalid");
    return { allowComputers, seen };
}

async function readManifest(path) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES)
        throw new Error("backup manifest must be a bounded regular file");
    return JSON.parse(await readFile(path, "utf8"));
}

async function listBundleFiles(root, relativeRoot = "", result = []) {
    const info = await statMaybe(root);
    if (!info)
        return result;
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("backup files root is not a normal directory");
    for (const child of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(root, child.name);
        const rel = relativeRoot ? `${relativeRoot}/${child.name}` : child.name;
        const childInfo = await lstat(path);
        if (childInfo.isSymbolicLink())
            throw new Error("backup bundle contains a symbolic link/junction");
        if (childInfo.isDirectory()) {
            await listBundleFiles(path, rel, result);
        }
        else if (childInfo.isFile()) {
            result.push(rel);
            if (result.length > MAX_MANIFEST_FILES)
                throw new Error("backup bundle contains too many files");
        }
        else {
            throw new Error("backup bundle contains a special file");
        }
    }
    return result;
}

async function verifyBackupBundle(bundle) {
    const bundlePath = resolve(bundle);
    const info = await statMaybe(bundlePath);
    if (!info?.isDirectory() || info.isSymbolicLink())
        throw new Error("backup bundle must be a normal directory");
    const rootNames = await readdir(bundlePath);
    for (const name of rootNames) {
        if (!["manifest.json", "files"].includes(name))
            throw new Error("backup bundle contains undeclared top-level files");
    }
    const manifestPath = join(bundlePath, "manifest.json");
    const manifestInfo = await statMaybe(manifestPath);
    if (!manifestInfo)
        throw new Error("backup manifest is missing");
    const manifest = await readManifest(manifestPath);
    const { seen } = validateManifest(manifest);
    const actual = await listBundleFiles(join(bundlePath, "files"));
    if (actual.length !== seen.size || actual.some((path) => !seen.has(path)))
        throw new Error("backup bundle contains undeclared or missing files");
    return { bundlePath, manifest };
}

async function copyVerifiedBundleToStage(bundlePath, manifest, stage) {
    for (const entry of manifest.files) {
        const source = join(bundlePath, "files", ...entry.path.split("/"));
        const target = join(stage, ...entry.path.split("/"));
        const targetMode = 0o600 | (entry.mode & 0o100);
        const copied = await copyStableFile(source, target, { targetMode });
        if (copied.size !== entry.size || copied.sha256 !== entry.sha256)
            throw new Error("backup file integrity check failed");
    }
}

async function restorePriorState({ dataDir, recovery, hadTarget, targetWasEmpty, renameFn }) {
    if (await statMaybe(dataDir))
        await rm(dataDir, { recursive: true, force: true });
    if (hadTarget && !targetWasEmpty)
        await movePath(recovery, dataDir, renameFn);
    else if (hadTarget && targetWasEmpty)
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
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
    await assertNoSymlinkComponents(dirname(dataDir), "state destination");
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
        else if (targetInfo && targetEmpty && !newInstalled && !await statMaybe(dataDir)) {
            await mkdir(dataDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
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
    catch {
        result.audit.integrity = "unreadable";
        result.diagnostics.push("audit-unreadable");
    }

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
            files: [{
                path: "export.json",
                size: Buffer.byteLength(exportJson),
                sha256: sha256(Buffer.from(exportJson)),
            }],
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
