import { constants } from "node:fs";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { AuditLog } from "./audit.js";
import { inspectComputerMigration } from "./computer-migration.js";
import { policyHash } from "./policy-version-store.js";

const SHA256 = /^[0-9a-f]{64}$/;
const POLICY_VERSION_ID = /^policy_[0-9a-f-]{36}$/;
const POLICY_VERSION_FILE = /^(policy_[0-9a-f-]{36})\.json$/;
const OPERATOR_SESSION_FILE = /^[0-9a-f]{64}\.json$/;
const CONTROL_MODES = new Set(["agent", "human", "requested"]);
const KNOWN_TOP_LEVEL = new Set([
    "tasks.json",
    "task-events.jsonl",
    "memory.jsonl",
    "audit.jsonl",
    "repeat-state.json",
    "policy-versions",
    "computers",
    "operator-sessions",
    "tool-bridges",
    "desktop-state",
    "artifacts",
]);

function fail(message) {
    throw new Error(`startup preflight failed: ${message}`);
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

function validDate(value) {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

async function assertNoUnsafePathComponents(path, label) {
    const absolute = resolve(path);
    const parsed = parse(absolute);
    const parts = relative(parsed.root, absolute).split(sep).filter(Boolean);
    let current = parsed.root;
    for (let index = 0; index < parts.length; index += 1) {
        current = join(current, parts[index]);
        const info = await statMaybe(current);
        if (!info)
            continue;
        if (info.isSymbolicLink())
            fail(`${label} traverses a symbolic-link/junction component`);
        if (index < parts.length - 1 && !info.isDirectory())
            fail(`${label} traverses a non-directory path component`);
    }
}

async function validateDataDirBoundary(dataDir) {
    const absolute = resolve(dataDir);
    if (absolute === parse(absolute).root)
        fail("dataDir cannot be a filesystem root");
    await assertNoUnsafePathComponents(absolute, "dataDir");
    const info = await statMaybe(absolute);
    if (info) {
        if (!info.isDirectory() || info.isSymbolicLink())
            fail("dataDir must be a normal directory");
        try {
            await access(absolute, constants.R_OK | constants.W_OK);
        }
        catch {
            fail("dataDir must be readable and writable");
        }
        return { dataDir: absolute, exists: true };
    }

    let parent = dirname(absolute);
    while (true) {
        const parentInfo = await statMaybe(parent);
        if (parentInfo) {
            if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
                fail("dataDir nearest existing parent must be a normal directory");
            try {
                await access(parent, constants.R_OK | constants.W_OK);
            }
            catch {
                fail("dataDir nearest existing parent must be readable and writable");
            }
            return { dataDir: absolute, exists: false };
        }
        const next = dirname(parent);
        if (next === parent)
            fail("dataDir has no usable existing parent");
        parent = next;
    }
}

async function regularFile(path, label, { optional = true } = {}) {
    const info = await statMaybe(path);
    if (!info) {
        if (optional)
            return undefined;
        fail(`${label} is missing`);
    }
    if (!info.isFile() || info.isSymbolicLink())
        fail(`${label} must be a regular non-symlink file`);
    return info;
}

async function normalDirectory(path, label, { optional = true } = {}) {
    const info = await statMaybe(path);
    if (!info) {
        if (optional)
            return undefined;
        fail(`${label} is missing`);
    }
    if (!info.isDirectory() || info.isSymbolicLink())
        fail(`${label} must be a normal non-symlink directory`);
    return info;
}

async function readJsonRegular(path, label, { optional = true } = {}) {
    if (!await regularFile(path, label, { optional }))
        return undefined;
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        fail(`${label} is invalid JSON`);
    }
}

async function readJsonlRegular(path, label, validateRow) {
    if (!await regularFile(path, label))
        return [];
    let raw;
    try {
        raw = await readFile(path, "utf8");
    }
    catch {
        fail(`${label} is unreadable`);
    }
    const rows = [];
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        let row;
        try {
            row = JSON.parse(line);
        }
        catch {
            fail(`${label} contains invalid JSONL`);
        }
        validateRow?.(row, rows.length);
        rows.push(row);
    }
    return rows;
}

async function validateTopLevel(dataDir) {
    for (const name of await readdir(dataDir)) {
        if (KNOWN_TOP_LEVEL.has(name))
            continue;
        if (runtimeScratchName(name))
            fail(`stale runtime scratch requires recovery before startup: ${name}`);
        fail(`dataDir contains unsupported state path: ${name}`);
    }
}

async function validateTasks(dataDir) {
    const path = join(dataDir, "tasks.json");
    const tasks = await readJsonRegular(path, "tasks.json");
    if (tasks === undefined)
        return;
    if (!Array.isArray(tasks))
        fail("tasks.json must contain an array");
    const ids = new Set();
    for (const task of tasks) {
        if (!task || typeof task !== "object" || Array.isArray(task))
            fail("tasks.json contains a non-object task");
        if (typeof task.id !== "string" || !task.id)
            fail("tasks.json contains a task without a valid id");
        if (ids.has(task.id))
            fail(`tasks.json contains duplicate task id: ${task.id}`);
        ids.add(task.id);
        if (typeof task.status !== "string" || !task.status)
            fail(`task ${task.id} has an invalid status`);
    }
}

async function validateMemory(dataDir) {
    await readJsonlRegular(join(dataDir, "memory.jsonl"), "memory.jsonl", (record) => {
        if (!record || typeof record !== "object" || Array.isArray(record))
            fail("memory.jsonl contains a non-object record");
        if (typeof record.id !== "string" || !record.id || !validDate(record.at))
            fail("memory.jsonl contains invalid record identity/timestamp metadata");
        if (typeof record.scope !== "string" || typeof record.key !== "string")
            fail("memory.jsonl contains invalid scope/key metadata");
        if (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== "string")))
            fail("memory.jsonl contains invalid tags");
    });
}

async function validateTaskEvents(dataDir) {
    const ids = new Set();
    const expectedSeq = new Map();
    await readJsonlRegular(join(dataDir, "task-events.jsonl"), "task-events.jsonl", (event) => {
        if (!event || typeof event !== "object" || Array.isArray(event))
            fail("task-events.jsonl contains a non-object event");
        if (typeof event.id !== "string" || !event.id || ids.has(event.id))
            fail("task-events.jsonl contains a missing/duplicate event id");
        ids.add(event.id);
        if (typeof event.taskId !== "string" || !event.taskId || typeof event.type !== "string" || !event.type)
            fail(`task event ${event.id} has invalid task/type metadata`);
        if (!Number.isInteger(event.seq) || event.seq <= 0 || !validDate(event.at))
            fail(`task event ${event.id} has invalid sequence/timestamp metadata`);
        const expected = expectedSeq.get(event.taskId) ?? 1;
        if (event.seq !== expected)
            fail(`task ${event.taskId} event sequence is non-contiguous: expected ${expected}, got ${event.seq}`);
        expectedSeq.set(event.taskId, expected + 1);
    });
}

async function validateRepeat(dataDir) {
    const value = await readJsonRegular(join(dataDir, "repeat-state.json"), "repeat-state.json");
    if (value === undefined)
        return;
    if (!value || value.version !== 1 || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries))
        fail("repeat-state.json is invalid or unsupported");
    for (const [fingerprint, timestamps] of Object.entries(value.entries)) {
        if (!SHA256.test(fingerprint) || !Array.isArray(timestamps) || timestamps.some((at) => !Number.isFinite(at)))
            fail("repeat-state.json contains an invalid fingerprint/timestamp entry");
    }
}

async function validateAudit(dataDir) {
    const path = join(dataDir, "audit.jsonl");
    if (!await regularFile(path, "audit.jsonl"))
        return { present: false, records: [] };
    let integrity;
    const audit = new AuditLog(path);
    try {
        integrity = await audit.verify();
    }
    catch {
        fail("audit.jsonl could not be parsed/verified");
    }
    if (!integrity.ok)
        fail(`audit hash chain is invalid at sequence ${integrity.seq ?? "unknown"}`);
    return { present: true, records: await audit.readAll() };
}

function safePolicyVersionId(value, label) {
    if (typeof value !== "string" || !POLICY_VERSION_ID.test(value))
        fail(`${label} has an invalid policy version id`);
    return value;
}

function validatePolicyVersionDocument(value, expectedId) {
    if (!value || value.schemaVersion !== 1 || value.id !== expectedId)
        fail(`policy version ${expectedId} has an invalid schema/id`);
    safePolicyVersionId(value.id, `policy version ${expectedId}`);
    if (!SHA256.test(value.hash ?? "") || !validDate(value.createdAt))
        fail(`policy version ${expectedId} has invalid hash/timestamp metadata`);
    if (value.parentVersionId !== undefined && value.parentVersionId !== null)
        safePolicyVersionId(value.parentVersionId, `policy version ${expectedId}`);
    if (value.label !== undefined && typeof value.label !== "string")
        fail(`policy version ${expectedId} has an invalid label`);
    let actual;
    try {
        actual = policyHash(value.policy);
    }
    catch {
        fail(`policy version ${expectedId} contains an invalid policy document`);
    }
    if (actual !== value.hash)
        fail(`policy version ${expectedId} hash mismatch`);
    return value;
}

function validatePolicyPointer(value) {
    if (!value || value.schemaVersion !== 1)
        fail("active policy pointer is invalid or unsupported");
    safePolicyVersionId(value.versionId, "active policy pointer");
    if (!SHA256.test(value.hash ?? "") || !validDate(value.activatedAt))
        fail("active policy pointer has invalid hash/timestamp metadata");
    return value;
}

function validatePolicyTransaction(value) {
    if (!value || value.schemaVersion !== 1 || !["bootstrap", "activation"].includes(value.kind))
        fail("policy transaction marker is invalid or unsupported");
    if (typeof value.transactionId !== "string" || !value.transactionId.startsWith("policytx_"))
        fail("policy transaction marker has an invalid transaction id");
    safePolicyVersionId(value.toVersionId, "policy transaction marker");
    if (value.fromVersionId !== undefined && value.fromVersionId !== null)
        safePolicyVersionId(value.fromVersionId, "policy transaction marker");
    if (!SHA256.test(value.toHash ?? ""))
        fail("policy transaction marker has an invalid target hash");
    return value;
}

async function validatePolicy(dataDir, config, auditState) {
    const root = join(dataDir, "policy-versions");
    if (!await normalDirectory(root, "policy-versions"))
        return;

    const allowedRoot = new Set(["active.json", "versions", "transaction.json"]);
    for (const name of await readdir(root)) {
        if (allowedRoot.has(name))
            continue;
        if (runtimeScratchName(name))
            fail(`stale policy scratch requires recovery before startup: ${name}`);
        fail(`policy-versions contains unsupported state path: ${name}`);
    }

    const versionsDir = join(root, "versions");
    const versions = new Map();
    if (await normalDirectory(versionsDir, "policy versions directory")) {
        for (const name of await readdir(versionsDir)) {
            if (runtimeScratchName(name))
                fail(`stale policy version scratch requires recovery before startup: ${name}`);
            const match = POLICY_VERSION_FILE.exec(name);
            if (!match)
                fail(`policy versions directory contains unsupported file: ${name}`);
            const value = await readJsonRegular(join(versionsDir, name), `policy version ${name}`, { optional: false });
            versions.set(match[1], validatePolicyVersionDocument(value, match[1]));
        }
    }

    const activeRaw = await readJsonRegular(join(root, "active.json"), "active policy pointer");
    const active = activeRaw === undefined ? undefined : validatePolicyPointer(activeRaw);
    const transactionRaw = await readJsonRegular(join(root, "transaction.json"), "policy transaction marker");
    const transaction = transactionRaw === undefined ? undefined : validatePolicyTransaction(transactionRaw);

    if (!transaction) {
        if (!active && versions.size)
            fail("policy versions exist but active.json is missing");
        if (active) {
            const version = versions.get(active.versionId);
            if (!version || version.hash !== active.hash)
                fail("active policy pointer/version mismatch");
        }
        return;
    }

    const target = versions.get(transaction.toVersionId);
    if (target && target.hash !== transaction.toHash)
        fail("policy transaction target version hash mismatch");

    if (transaction.kind === "bootstrap") {
        let configHash;
        try {
            configHash = policyHash(config.policy);
        }
        catch {
            fail("config policy is invalid for bootstrap recovery");
        }
        if (configHash !== transaction.toHash)
            fail("incomplete policy bootstrap does not match current config");
        if (active && (active.versionId !== transaction.toVersionId || active.hash !== transaction.toHash))
            fail("policy bootstrap marker conflicts with active policy pointer");
        return;
    }

    if (!auditState.present)
        fail("policy activation recovery requires an existing verified audit log");
    const committed = auditState.records.some((record) =>
        ["policy.activated", "policy.rolled_back"].includes(record.type)
        && record.subject === transaction.toVersionId
        && record.data?.transactionId === transaction.transactionId,
    );
    if (!committed)
        fail(`incomplete policy activation ${transaction.transactionId} is not durably committed in audit`);
    if (!active || active.versionId !== transaction.toVersionId || active.hash !== transaction.toHash)
        fail("committed policy activation marker does not match active pointer");
    if (!target || target.hash !== transaction.toHash)
        fail("committed policy activation marker does not match an immutable target version");
}

function identityKey(agentId) {
    return Buffer.from(String(agentId), "utf8").toString("base64url");
}

function legacySegment(agentId) {
    return encodeURIComponent(agentId).replace(/%/g, "_");
}

function validateControlState(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        fail(`${label} must be an object`);
    if (value.control !== undefined) {
        if (!value.control || typeof value.control !== "object" || Array.isArray(value.control) || !CONTROL_MODES.has(value.control.mode))
            fail(`${label} contains invalid computer control state`);
        if (value.control.updatedAt !== undefined && !validDate(value.control.updatedAt))
            fail(`${label} contains invalid control timestamp`);
    }
    if (value.secretRequest !== undefined && (!value.secretRequest || typeof value.secretRequest !== "object" || Array.isArray(value.secretRequest)))
        fail(`${label} contains invalid secret-request state`);
}

async function validateToken(path, label) {
    if (!await regularFile(path, label))
        return;
    const token = (await readFile(path, "utf8")).trim();
    if (!token)
        fail(`${label} is empty`);
}

async function validateComputerIdentityDir(path, label) {
    if (!await normalDirectory(path, label))
        return false;
    for (const rootName of ["profile", "workspace"]) {
        const child = join(path, rootName);
        const info = await statMaybe(child);
        if (info && (!info.isDirectory() || info.isSymbolicLink()))
            fail(`${label}/${rootName} must be a normal non-symlink directory`);
    }
    await validateToken(join(path, "token"), `${label}/token`);
    return true;
}

async function validateComputers(dataDir, agents) {
    const root = join(dataDir, "computers");
    if (!await normalDirectory(root, "computers"))
        return;

    const rootEntries = await readdir(root, { withFileTypes: true });
    for (const entry of rootEntries) {
        if (entry.isSymbolicLink())
            fail(`computers/${entry.name} is a symbolic-link/junction`);
        if (!entry.isDirectory() && !entry.isFile())
            fail(`computers/${entry.name} is a special file`);
    }

    const agentIdList = agents.map((agent) => String(agent.id));
    let migration;
    try {
        migration = await inspectComputerMigration(root, agentIdList);
    }
    catch (error) {
        fail(error instanceof Error ? error.message : "computer migration state is invalid");
    }

    const allowedRootFiles = new Set(["state.json", "operator-token"]);
    if (migration.marker) {
        allowedRootFiles.add("migration.json");
        if (migration.stageName)
            allowedRootFiles.add(migration.stageName);
    }
    for (const entry of rootEntries) {
        if (!entry.isFile() || allowedRootFiles.has(entry.name))
            continue;
        if (runtimeScratchName(entry.name))
            fail(`stale computer-registry scratch requires recovery before startup: ${entry.name}`);
        fail(`computer registry contains unsupported file: ${entry.name}`);
    }

    await validateToken(join(root, "operator-token"), "computer operator token");
    const state = await readJsonRegular(join(root, "state.json"), "computer state");
    const agentIds = new Set(agentIdList);
    if (state !== undefined) {
        if (!state || typeof state !== "object" || Array.isArray(state))
            fail("computer state must be an object");
        if (Object.hasOwn(state, "version")) {
            if (state.version !== 2 || !state.agents || typeof state.agents !== "object" || Array.isArray(state.agents))
                fail("computer state has an unsupported version/schema");
            for (const [key, value] of Object.entries(state.agents))
                validateControlState(value, `computer state agent ${key}`);
        }
        else {
            for (const [agentId, value] of Object.entries(state)) {
                if (!agentIds.has(agentId))
                    fail(`legacy computer state contains unknown agent ${agentId}; refusing lossy migration`);
                validateControlState(value, `legacy computer state agent ${agentId}`);
            }
        }
    }

    const legacyOwners = new Map();
    for (const agent of agents) {
        const name = legacySegment(agent.id);
        const owners = legacyOwners.get(name) ?? [];
        owners.push(String(agent.id));
        legacyOwners.set(name, owners);
    }

    for (const agent of agents) {
        const currentName = identityKey(agent.id);
        const legacyName = legacySegment(agent.id);
        const currentPath = join(root, currentName);
        const legacyPath = join(root, legacyName);
        const currentExists = await validateComputerIdentityDir(currentPath, `computer ${agent.id}`);
        if (legacyName === currentName)
            continue;
        const legacyInfo = await statMaybe(legacyPath);
        if (!legacyInfo)
            continue;
        if (!legacyInfo.isDirectory() || legacyInfo.isSymbolicLink())
            fail(`legacy computer directory ${legacyName} is unsafe`);
        if (currentExists)
            fail(`both current and legacy computer directories exist for agent ${agent.id}`);
        const owners = legacyOwners.get(legacyName) ?? [];
        if (owners.length > 1)
            fail(`legacy computer directory ${legacyName} is ambiguous across agents ${owners.join(", ")}`);
        await validateComputerIdentityDir(legacyPath, `legacy computer ${agent.id}`);
    }
}

async function validateOperatorSessions(dataDir) {
    const root = join(dataDir, "operator-sessions");
    if (!await normalDirectory(root, "operator-sessions"))
        return;
    for (const name of await readdir(root)) {
        if (!OPERATOR_SESSION_FILE.test(name)) {
            if (runtimeScratchName(name))
                fail(`stale operator-session scratch requires recovery before startup: ${name}`);
            fail(`operator-sessions contains unsupported file: ${name}`);
        }
        const record = await readJsonRegular(join(root, name), `operator session ${name}`, { optional: false });
        if (!record || record.version !== 1 || !Number.isFinite(record.createdAt) || !Number.isFinite(record.expiresAt))
            fail(`operator session ${name} is invalid or unsupported`);
    }
}

async function validateToolBridges(dataDir) {
    const root = join(dataDir, "tool-bridges");
    if (!await normalDirectory(root, "tool-bridges"))
        return;
    const entries = await readdir(root);
    if (entries.length)
        fail("stale governed tool-bridge bootstrap state requires explicit recovery before startup");
}

export async function preflightRuntimeStartup(config) {
    if (!config || typeof config !== "object")
        fail("runtime config is required");
    const boundary = await validateDataDirBoundary(config.dataDir);
    if (!boundary.exists)
        return { ok: true, dataDir: boundary.dataDir, initialized: false };

    await validateTopLevel(boundary.dataDir);
    await validateTasks(boundary.dataDir);
    await validateMemory(boundary.dataDir);
    await validateTaskEvents(boundary.dataDir);
    await validateRepeat(boundary.dataDir);
    const auditState = await validateAudit(boundary.dataDir);
    await validatePolicy(boundary.dataDir, config, auditState);
    await validateComputers(boundary.dataDir, config.agents ?? []);
    await validateOperatorSessions(boundary.dataDir);
    await validateToolBridges(boundary.dataDir);

    return { ok: true, dataDir: boundary.dataDir, initialized: true };
}
