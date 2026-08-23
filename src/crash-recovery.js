import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { createReadStream } from "node:fs";
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
import { replaceFileWithRetry } from "./fs-util.js";
import { preflightRuntimeStartup } from "./startup-preflight.js";

const FORMAT = "sovereignbot-recovery-quarantine";
const FORMAT_VERSION = 1;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TMP_SUFFIX = `\\.tmp-\\d+-${UUID}`;
const BRIDGE_ID = `bridge_${UUID}`;
const TASK_ID = new RegExp(`^task_${UUID}$`);
const ACTIVE_TASK_STATUSES = new Set(["accepted", "running"]);
const CONTROLLED_SCANS = [
    {
        dir: "",
        category: "atomic-temp",
        exact: [
            new RegExp(`^tasks\\.json${TMP_SUFFIX}$`),
            new RegExp(`^repeat-state\\.json${TMP_SUFFIX}$`),
        ],
    },
    {
        dir: "policy-versions",
        category: "policy-pointer-temp",
        exact: [new RegExp(`^active\\.json${TMP_SUFFIX}$`)],
    },
    {
        dir: "computers",
        category: "computer-state-temp",
        exact: [new RegExp(`^state\\.json${TMP_SUFFIX}$`)],
    },
];
const BRIDGE_FILE = new RegExp(`^${BRIDGE_ID}\\.(?:bootstrap|claude-mcp)\\.json$`);
const TEMP_LIKE = /(?:\.tmp-|\.new-|\.old-|\.restore-staging-|\.restore-backup-)/;

function recoveryError(message) {
    return new Error(`crash recovery failed: ${message}`);
}

function portablePath(path) {
    return path.split(sep).join("/");
}

function isWithin(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
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
    let current = parsed.root;
    for (const segment of relative(parsed.root, absolute).split(sep).filter(Boolean)) {
        current = join(current, segment);
        const info = await statMaybe(current);
        if (!info)
            continue;
        if (info.isSymbolicLink())
            throw recoveryError(`${label} traverses a symbolic-link/junction component`);
    }
}

async function requireRegularFile(path, label) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
        throw recoveryError(`${label} must be a regular non-symlink file`);
    return info;
}

function identity(info) {
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

async function hashRegularFile(path, label) {
    const before = await requireRegularFile(path, label);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
        size += chunk.length;
    }
    const after = await requireRegularFile(path, label);
    if (!sameIdentity(identity(before), identity(after)) || size !== after.size)
        throw recoveryError(`${label} changed while recovery was being inspected`);
    return {
        size,
        sha256: hash.digest("hex"),
        identity: identity(after),
    };
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

function reportBlock(blocking, code, path, summary) {
    blocking.push({ code, ...(path ? { path } : {}), summary });
}

async function scanControlledDirectory(dataDir, spec, recoverable, blocking) {
    const dir = spec.dir ? join(dataDir, spec.dir) : dataDir;
    const info = await statMaybe(dir);
    if (!info)
        return;
    if (!info.isDirectory() || info.isSymbolicLink()) {
        reportBlock(blocking, "unsafe-recovery-root", spec.dir || ".", `${spec.dir || "dataDir"} is not a normal directory`);
        return;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const matches = spec.exact.some((pattern) => pattern.test(entry.name));
        if (!matches) {
            if (TEMP_LIKE.test(entry.name)) {
                reportBlock(
                    blocking,
                    "unrecognized-runtime-scratch",
                    portablePath(spec.dir ? join(spec.dir, entry.name) : entry.name),
                    "temp-like filename is not an audited recoverable pattern",
                );
            }
            continue;
        }
        const rel = portablePath(spec.dir ? join(spec.dir, entry.name) : entry.name);
        const source = join(dir, entry.name);
        if (!entry.isFile() || entry.isSymbolicLink()) {
            reportBlock(blocking, "unsafe-recoverable-entry", rel, "recognized recovery path is not a regular file");
            continue;
        }
        try {
            const snapshot = await hashRegularFile(source, rel);
            recoverable.push({ path: rel, category: spec.category, source, snapshot });
        }
        catch (error) {
            reportBlock(blocking, "unreadable-recoverable-entry", rel, error.message);
        }
    }
}

async function scanToolBridges(dataDir, recoverable, blocking) {
    const root = join(dataDir, "tool-bridges");
    const info = await statMaybe(root);
    if (!info)
        return;
    if (!info.isDirectory() || info.isSymbolicLink()) {
        reportBlock(blocking, "unsafe-bridge-root", "tool-bridges", "tool-bridges is not a normal directory");
        return;
    }
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        const rel = `tool-bridges/${entry.name}`;
        if (!BRIDGE_FILE.test(entry.name)) {
            reportBlock(blocking, "unknown-bridge-entry", rel, "tool-bridges contains an entry not produced by the governed bridge manager");
            continue;
        }
        if (!entry.isFile() || entry.isSymbolicLink()) {
            reportBlock(blocking, "unsafe-bridge-entry", rel, "governed bridge recovery entry is not a regular file");
            continue;
        }
        try {
            const snapshot = await hashRegularFile(join(root, entry.name), rel);
            recoverable.push({
                path: rel,
                category: entry.name.endsWith(".bootstrap.json") ? "governed-bridge-bootstrap" : "governed-bridge-config",
                source: join(root, entry.name),
                snapshot,
            });
        }
        catch (error) {
            reportBlock(blocking, "unreadable-bridge-entry", rel, error.message);
        }
    }
}

async function inspectActiveWork(dataDir, blocking) {
    const path = join(dataDir, "tasks.json");
    const info = await statMaybe(path);
    if (!info)
        return [];
    if (!info.isFile() || info.isSymbolicLink()) {
        reportBlock(blocking, "tasks-unreadable", "tasks.json", "tasks.json is not a regular file");
        return [];
    }
    let tasks;
    try {
        tasks = JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        reportBlock(blocking, "tasks-unreadable", "tasks.json", "tasks.json is invalid JSON");
        return [];
    }
    if (!Array.isArray(tasks)) {
        reportBlock(blocking, "tasks-unreadable", "tasks.json", "tasks.json does not contain an array");
        return [];
    }
    return tasks
        .filter((task) => task && ACTIVE_TASK_STATUSES.has(task.status))
        .map((task) => {
            const rawId = String(task.id ?? "");
            return { id: TASK_ID.test(rawId) ? rawId : "unknown", status: task.status };
        });
}

async function policyTransactionInfo(dataDir) {
    const path = join(dataDir, "policy-versions", "transaction.json");
    const info = await statMaybe(path);
    if (!info)
        return { present: false };
    if (!info.isFile() || info.isSymbolicLink())
        return { present: true, structurallyReadable: false };
    try {
        const value = JSON.parse(await readFile(path, "utf8"));
        return {
            present: true,
            structurallyReadable: true,
            kind: typeof value?.kind === "string" ? value.kind : "unknown",
        };
    }
    catch {
        return { present: true, structurallyReadable: false };
    }
}

function publicReport({ recoverable, blocking, activeWork, policyTransaction }) {
    const safeRecoverable = recoverable
        .map((entry) => ({ path: entry.path, category: entry.category, size: entry.snapshot.size }))
        .sort((a, b) => a.path.localeCompare(b.path));
    const safeBlocking = [...blocking].sort((a, b) => `${a.path ?? ""}:${a.code}`.localeCompare(`${b.path ?? ""}:${b.code}`));
    return {
        schemaVersion: 1,
        recoverable: safeRecoverable,
        blockingUnrecoverable: safeBlocking,
        activeWork: [...activeWork].sort((a, b) => a.id.localeCompare(b.id)),
        policyTransaction,
        canAttemptApply: safeRecoverable.length > 0 && safeBlocking.length === 0 && activeWork.length === 0,
        note: "Apply is offline-only. Policy transaction markers are never moved and cleaned state must still pass startup preflight.",
    };
}

async function inspectCrashRecoveryDetailed(config) {
    const dataDir = resolve(config.dataDir);
    await assertNoSymlinkComponents(dataDir, "dataDir");
    const info = await statMaybe(dataDir);
    if (!info) {
        return { dataDir, recoverable: [], blocking: [], activeWork: [], policyTransaction: { present: false } };
    }
    if (!info.isDirectory() || info.isSymbolicLink())
        throw recoveryError("dataDir must be a normal non-symlink directory");
    try {
        await access(dataDir, constants.R_OK | constants.W_OK);
    }
    catch {
        throw recoveryError("dataDir must be readable and writable");
    }

    const recoverable = [];
    const blocking = [];
    for (const spec of CONTROLLED_SCANS)
        await scanControlledDirectory(dataDir, spec, recoverable, blocking);
    await scanToolBridges(dataDir, recoverable, blocking);
    const activeWork = await inspectActiveWork(dataDir, blocking);
    const policyTransaction = await policyTransactionInfo(dataDir);

    recoverable.sort((a, b) => a.path.localeCompare(b.path));
    const seen = new Set();
    for (const entry of recoverable) {
        const key = entry.path.normalize("NFC").toLowerCase();
        if (seen.has(key))
            reportBlock(blocking, "portable-path-collision", entry.path, "recovery plan paths collide on a case-insensitive filesystem");
        seen.add(key);
    }
    return { dataDir, recoverable, blocking, activeWork, policyTransaction };
}

export async function inspectCrashRecovery(config) {
    return publicReport(await inspectCrashRecoveryDetailed(config));
}

async function nearestExistingParent(path) {
    let candidate = resolve(path);
    while (true) {
        const info = await statMaybe(candidate);
        if (info)
            return { path: candidate, info };
        const parent = dirname(candidate);
        if (parent === candidate)
            return undefined;
        candidate = parent;
    }
}

async function prepareQuarantineTarget(dataDir, requested) {
    const generated = join(dirname(dataDir), `.${basename(dataDir)}.recovery-quarantine-${Date.now()}-${randomUUID()}`);
    const target = resolve(requested ?? generated);
    if (target === parse(target).root || isWithin(dataDir, target))
        throw recoveryError("quarantine must be outside dataDir and cannot be a filesystem root");
    await assertNoSymlinkComponents(target, "quarantine");
    if (await statMaybe(target))
        throw recoveryError("quarantine output already exists");

    const parentResult = await nearestExistingParent(dirname(target));
    if (!parentResult || !parentResult.info.isDirectory() || parentResult.info.isSymbolicLink())
        throw recoveryError("quarantine parent must resolve through a normal directory");
    try {
        await access(parentResult.path, constants.R_OK | constants.W_OK);
    }
    catch {
        throw recoveryError("quarantine parent must be readable and writable");
    }

    const dataInfo = await stat(dataDir);
    if (dataInfo.dev !== parentResult.info.dev)
        throw recoveryError("quarantine must be on the same filesystem as dataDir for atomic rename recovery");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await assertNoSymlinkComponents(dirname(target), "quarantine");
    const stage = `${target}.staging-${randomUUID()}`;
    await mkdir(stage, { mode: 0o700 });
    return { target, stage };
}

async function moveWithRetry(source, destination, renameFn) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await replaceFileWithRetry(source, destination, { renameFn });
}

async function verifySnapshot(path, expected, label) {
    const current = await hashRegularFile(path, label);
    if (!sameIdentity(current.identity, expected.identity) || current.sha256 !== expected.sha256)
        throw recoveryError(`${label} changed after the recovery plan was built`);
    return current;
}

async function rollbackMoved(moved, dataDir, stage, renameFn) {
    const failures = [];
    for (const entry of [...moved].reverse()) {
        const from = join(stage, ...entry.path.split("/"));
        const to = join(dataDir, ...entry.path.split("/"));
        try {
            if (await statMaybe(from))
                await moveWithRetry(from, to, renameFn);
        }
        catch (error) {
            failures.push(error);
        }
    }
    if (failures.length)
        throw new AggregateError(failures, "one or more quarantined artifacts could not be rolled back");
}

export async function applyCrashRecovery(config, { quarantine, renameFn = rename } = {}) {
    const detailed = await inspectCrashRecoveryDetailed(config);
    const report = publicReport(detailed);
    if (!detailed.recoverable.length)
        throw recoveryError("no recognized stale artifacts are available to quarantine");
    if (detailed.blocking.length)
        throw recoveryError("recovery plan contains blocking unrecognized/unsafe state; inspect before retrying");
    if (detailed.activeWork.length)
        throw recoveryError("accepted/running durable tasks are present; stop active work before applying offline recovery");

    const { target, stage } = await prepareQuarantineTarget(detailed.dataDir, quarantine);
    const moved = [];
    let published = false;
    try {
        for (const entry of detailed.recoverable) {
            await verifySnapshot(entry.source, entry.snapshot, entry.path);
            const destination = join(stage, ...entry.path.split("/"));
            await moveWithRetry(entry.source, destination, renameFn);
            moved.push(entry);
            const movedSnapshot = await hashRegularFile(destination, entry.path);
            if (movedSnapshot.size !== entry.snapshot.size || movedSnapshot.sha256 !== entry.snapshot.sha256)
                throw recoveryError(`${entry.path} changed while being quarantined`);
        }

        const manifest = {
            format: FORMAT,
            formatVersion: FORMAT_VERSION,
            createdAt: new Date().toISOString(),
            sourceVersion: await appVersion(),
            sourceDataDirName: basename(detailed.dataDir),
            files: moved.map((entry) => ({
                path: entry.path,
                category: entry.category,
                size: entry.snapshot.size,
                sha256: entry.snapshot.sha256,
            })),
            policyTransaction: detailed.policyTransaction,
            note: "Quarantine contains crash-recovery evidence. Contents may include sensitive durable/task or bridge bootstrap material.",
        };
        await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
        });
        await chmod(join(stage, "manifest.json"), 0o600).catch(() => undefined);

        await preflightRuntimeStartup(config);
        await replaceFileWithRetry(stage, target, { renameFn });
        published = true;
        return {
            applied: true,
            quarantine: target,
            moved: report.recoverable,
            policyTransaction: detailed.policyTransaction,
        };
    }
    catch (error) {
        if (!published) {
            try {
                await rollbackMoved(moved, detailed.dataDir, stage, renameFn);
            }
            catch (rollbackError) {
                throw new AggregateError([error, rollbackError], "crash recovery failed and artifact rollback also failed");
            }
            await rm(stage, { recursive: true, force: true }).catch(() => undefined);
        }
        throw error;
    }
}

export const CRASH_RECOVERY_QUARANTINE_FORMAT = FORMAT;
export const CRASH_RECOVERY_QUARANTINE_VERSION = FORMAT_VERSION;
