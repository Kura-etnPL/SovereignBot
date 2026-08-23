import { createHash, randomUUID } from "node:crypto";
import {
    lstat,
    mkdir,
    readFile,
    readdir,
    rename,
    unlink,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { replaceFileWithRetry } from "./fs-util.js";

const MIGRATION_SCHEMA_VERSION = 1;
const MIGRATION_KIND = "computer-registry-v1-to-v2";
const MIGRATION_ID = /^computermig_[0-9a-f-]{36}$/;
const HASH = /^[0-9a-f]{64}$/;
const MIGRATION_STAGE = /^state\.json\.migration-(computermig_[0-9a-f-]{36})$/;

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

export function computerIdentityKey(agentId) {
    return Buffer.from(String(agentId), "utf8").toString("base64url");
}

export function computerLegacySegment(agentId) {
    return encodeURIComponent(agentId).replace(/%/g, "_");
}

export function computerV2StateDocument(value) {
    return value?.version === 2 && value.agents && typeof value.agents === "object" && !Array.isArray(value.agents);
}

function agentIdsSorted(agentIds) {
    return [...new Set([...agentIds].map(String))].sort((a, b) => a.localeCompare(b));
}

export function computerAgentSetHash(agentIds) {
    return sha256(Buffer.from(JSON.stringify(agentIdsSorted(agentIds))));
}

function exactStateText(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function legacyStateDocument(value) {
    return value && typeof value === "object" && !Array.isArray(value) && !Object.hasOwn(value, "version");
}

function validateLegacyState(value, agentIds) {
    if (!legacyStateDocument(value))
        throw new Error("computer migration source state is not a supported legacy document");
    const allowed = new Set(agentIdsSorted(agentIds));
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            throw new Error("legacy computer state contains an agent that is absent from current config");
        const record = value[key];
        if (!record || typeof record !== "object" || Array.isArray(record))
            throw new Error("legacy computer state contains an invalid agent record");
    }
    return value;
}

function legacyToV2(value, agentIds) {
    validateLegacyState(value, agentIds);
    const agents = {};
    for (const agentId of agentIdsSorted(agentIds)) {
        if (Object.hasOwn(value, agentId))
            agents[computerIdentityKey(agentId)] = value[agentId];
    }
    return { version: 2, agents };
}

async function statMaybe(path, statFn = lstat) {
    try {
        return await statFn(path);
    }
    catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR")
            return undefined;
        throw error;
    }
}

async function readFileMaybe(path, readFileFn = readFile) {
    try {
        return await readFileFn(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}

async function fileHash(path, io) {
    const info = await statMaybe(path, io.lstat);
    if (!info || !info.isFile() || info.isSymbolicLink())
        throw new Error("computer migration file must be a regular non-symlink file");
    return sha256(await io.readFile(path));
}

function validateMarker(value, agentIds) {
    if (!value || value.schemaVersion !== MIGRATION_SCHEMA_VERSION || value.kind !== MIGRATION_KIND)
        throw new Error("computer migration marker is invalid or unsupported");
    if (!MIGRATION_ID.test(value.migrationId ?? ""))
        throw new Error("computer migration marker id is invalid");
    if (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt)))
        throw new Error("computer migration marker timestamp is invalid");
    if (!HASH.test(value.sourceStateSha256 ?? "") || !HASH.test(value.targetStateSha256 ?? ""))
        throw new Error("computer migration marker state hash is invalid");
    if (!HASH.test(value.agentSetSha256 ?? "") || value.agentSetSha256 !== computerAgentSetHash(agentIds))
        throw new Error("computer migration marker does not match the current configured agent set");
    return value;
}

function migrationStageName(migrationId) {
    return `state.json.migration-${migrationId}`;
}

function directoryPlan(agentIds) {
    const ids = agentIdsSorted(agentIds);
    const legacyOwners = new Map();
    for (const agentId of ids) {
        const legacyName = computerLegacySegment(agentId);
        const owners = legacyOwners.get(legacyName) ?? [];
        owners.push(agentId);
        legacyOwners.set(legacyName, owners);
    }
    return ids.map((agentId) => ({
        agentId,
        legacyName: computerLegacySegment(agentId),
        currentName: computerIdentityKey(agentId),
        legacyOwners: legacyOwners.get(computerLegacySegment(agentId)) ?? [],
    }));
}

async function inspectDirectories(root, agentIds, io) {
    const result = [];
    for (const entry of directoryPlan(agentIds)) {
        if (entry.legacyName === entry.currentName) {
            const currentInfo = await statMaybe(join(root, entry.currentName), io.lstat);
            if (currentInfo && (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()))
                throw new Error("computer identity directory is unsafe");
            result.push({ ...entry, legacyExists: false, currentExists: Boolean(currentInfo), sameName: true });
            continue;
        }
        const legacyInfo = await statMaybe(join(root, entry.legacyName), io.lstat);
        const currentInfo = await statMaybe(join(root, entry.currentName), io.lstat);
        if (legacyInfo && (!legacyInfo.isDirectory() || legacyInfo.isSymbolicLink()))
            throw new Error("legacy computer directory is unsafe");
        if (currentInfo && (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()))
            throw new Error("computer identity directory is unsafe");
        if (legacyInfo && currentInfo)
            throw new Error("both legacy and current computer directories exist for one agent");
        if (legacyInfo && entry.legacyOwners.length > 1)
            throw new Error("legacy computer directory mapping is ambiguous across configured agents");
        result.push({
            ...entry,
            legacyExists: Boolean(legacyInfo),
            currentExists: Boolean(currentInfo),
            sameName: false,
        });
    }
    return result;
}

function buildTargetState(stateValue, stateKind, agentIds) {
    if (stateKind === "legacy")
        return legacyToV2(stateValue, agentIds);
    if (stateKind === "v2")
        return stateValue;
    throw new Error("computer migration cannot build a target from missing/unsupported state");
}

function parseState(raw) {
    if (raw === undefined)
        return { kind: "missing", value: undefined };
    let value;
    try {
        value = JSON.parse(raw.toString("utf8"));
    }
    catch {
        throw new Error("computer state is invalid JSON");
    }
    if (computerV2StateDocument(value))
        return { kind: "v2", value };
    if (legacyStateDocument(value))
        return { kind: "legacy", value };
    throw new Error("computer state has an unsupported schema/version");
}

function defaultIo(overrides = {}) {
    return {
        mkdir: overrides.mkdir ?? mkdir,
        readFile: overrides.readFile ?? readFile,
        writeFile: overrides.writeFile ?? writeFile,
        rename: overrides.rename ?? rename,
        unlink: overrides.unlink ?? unlink,
        readdir: overrides.readdir ?? readdir,
        lstat: overrides.lstat ?? lstat,
    };
}

export async function inspectComputerMigration(root, agentIds, overrides = {}) {
    const io = defaultIo(overrides);
    const rootInfo = await statMaybe(root, io.lstat);
    if (!rootInfo)
        return { status: "none", rootExists: false, marker: undefined, directories: [] };
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw new Error("computer registry root is not a normal directory");

    const names = await io.readdir(root);
    const migrationStageNames = names.filter((name) => MIGRATION_STAGE.test(name));
    const markerPath = join(root, "migration.json");
    const markerRaw = await readFileMaybe(markerPath, io.readFile);
    let marker;
    if (markerRaw !== undefined) {
        let parsed;
        try {
            parsed = JSON.parse(markerRaw.toString("utf8"));
        }
        catch {
            throw new Error("computer migration marker is invalid JSON");
        }
        marker = validateMarker(parsed, agentIds);
    }
    if (!marker && migrationStageNames.length)
        throw new Error("computer migration staged state exists without a transaction marker");
    if (marker) {
        const expectedStageName = migrationStageName(marker.migrationId);
        if (migrationStageNames.some((name) => name !== expectedStageName))
            throw new Error("computer registry contains migration stage files not owned by the active marker");
    }

    const statePath = join(root, "state.json");
    const stateRaw = await readFileMaybe(statePath, io.readFile);
    const state = parseState(stateRaw);
    if (state.kind === "legacy")
        validateLegacyState(state.value, agentIds);
    const directories = await inspectDirectories(root, agentIds, io);
    const hasLegacyDirectories = directories.some((entry) => entry.legacyExists);

    if (!marker) {
        if (state.kind === "missing")
            return { status: hasLegacyDirectories ? "directory-migration-without-state" : "none", rootExists: true, state, marker: undefined, directories };
        if (state.kind === "legacy") {
            const targetState = buildTargetState(state.value, state.kind, agentIds);
            return {
                status: "needs-migration",
                rootExists: true,
                state,
                marker: undefined,
                directories,
                sourceStateSha256: sha256(stateRaw),
                targetState: targetState,
                targetStateText: exactStateText(targetState),
            };
        }
        if (hasLegacyDirectories) {
            return {
                status: "needs-directory-migration",
                rootExists: true,
                state,
                marker: undefined,
                directories,
                sourceStateSha256: sha256(stateRaw),
                targetState: state.value,
                targetStateText: stateRaw.toString("utf8"),
            };
        }
        return { status: "current", rootExists: true, state, marker: undefined, directories };
    }

    if (state.kind === "missing")
        throw new Error("computer migration marker exists but state.json is missing");
    let targetState;
    let targetStateText;
    if (state.kind === "legacy") {
        if (sha256(stateRaw) !== marker.sourceStateSha256)
            throw new Error("legacy computer state changed after migration transaction creation");
        targetState = buildTargetState(state.value, "legacy", agentIds);
        targetStateText = exactStateText(targetState);
        if (sha256(Buffer.from(targetStateText)) !== marker.targetStateSha256)
            throw new Error("computer migration marker target hash does not match deterministic v2 state");
    }
    else {
        if (sha256(stateRaw) !== marker.targetStateSha256)
            throw new Error("committed computer state does not match migration target hash");
        targetState = state.value;
        targetStateText = stateRaw.toString("utf8");
    }

    const stageName = migrationStageName(marker.migrationId);
    const stagePath = join(root, stageName);
    const stageRaw = await readFileMaybe(stagePath, io.readFile);
    if (stageRaw !== undefined) {
        const stageInfo = await statMaybe(stagePath, io.lstat);
        if (!stageInfo?.isFile() || stageInfo.isSymbolicLink())
            throw new Error("computer migration staged state is not a regular file");
        if (sha256(stageRaw) !== marker.targetStateSha256)
            throw new Error("computer migration staged state hash mismatch");
    }

    return {
        status: state.kind === "v2" && !hasLegacyDirectories ? "committed-marker" : "in-progress",
        rootExists: true,
        state,
        marker,
        directories,
        stageName,
        stagePath,
        stageExists: stageRaw !== undefined,
        targetState,
        targetStateText,
    };
}

function buildMarker(sourceStateRaw, targetStateText, agentIds) {
    return {
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        kind: MIGRATION_KIND,
        migrationId: `computermig_${randomUUID()}`,
        startedAt: new Date().toISOString(),
        sourceStateSha256: sha256(sourceStateRaw),
        targetStateSha256: sha256(Buffer.from(targetStateText)),
        agentSetSha256: computerAgentSetHash(agentIds),
    };
}

async function writePrivateExclusive(io, path, text) {
    await io.writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function unlinkIfPresent(io, path) {
    try {
        await io.unlink(path);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
}

async function rollbackDirectories(root, moved, io) {
    const failures = [];
    for (const entry of [...moved].reverse()) {
        try {
            await io.rename(join(root, entry.currentName), join(root, entry.legacyName));
        }
        catch (error) {
            failures.push(error);
        }
    }
    if (failures.length)
        throw new AggregateError(failures, "computer migration directory rollback failed");
}

async function executeExistingTransaction(root, agentIds, inspection, io, { newlyCreated = false } = {}) {
    const markerPath = join(root, "migration.json");
    const stagePath = inspection.stagePath ?? join(root, migrationStageName(inspection.marker.migrationId));
    const movedThisRun = [];
    let stateCommitted = inspection.state.kind === "v2";
    try {
        if (!inspection.stageExists && !stateCommitted)
            await writePrivateExclusive(io, stagePath, inspection.targetStateText);

        const refreshed = await inspectComputerMigration(root, agentIds, io);
        for (const entry of refreshed.directories) {
            if (entry.sameName || !entry.legacyExists)
                continue;
            await io.rename(join(root, entry.legacyName), join(root, entry.currentName));
            movedThisRun.push(entry);
        }

        if (!stateCommitted) {
            const beforeCommit = await inspectComputerMigration(root, agentIds, io);
            if (beforeCommit.directories.some((entry) => entry.legacyExists))
                throw new Error("computer migration could not commit while legacy directories remain");
            await replaceFileWithRetry(stagePath, join(root, "state.json"), { renameFn: io.rename });
            stateCommitted = true;
        }
        else if (await statMaybe(stagePath, io.lstat)) {
            await unlinkIfPresent(io, stagePath);
        }

        const committed = await inspectComputerMigration(root, agentIds, io);
        if (committed.state.kind !== "v2" || committed.directories.some((entry) => entry.legacyExists))
            throw new Error("computer migration committed state/directory verification failed");
        await unlinkIfPresent(io, markerPath);
        return { migrated: true, recovered: !newlyCreated, migrationId: inspection.marker.migrationId };
    }
    catch (error) {
        if (!stateCommitted && newlyCreated) {
            try {
                await rollbackDirectories(root, movedThisRun, io);
                await unlinkIfPresent(io, stagePath);
                await unlinkIfPresent(io, markerPath);
            }
            catch (rollbackError) {
                throw new AggregateError([error, rollbackError], "computer migration failed and rollback also failed");
            }
        }
        throw error;
    }
}

export async function migrateComputerRegistry(root, agentIds, overrides = {}) {
    const io = defaultIo(overrides);
    await io.mkdir(root, { recursive: true });
    let inspection = await inspectComputerMigration(root, agentIds, io);
    if (["current", "none"].includes(inspection.status))
        return { migrated: false, recovered: false };
    if (inspection.status === "directory-migration-without-state")
        throw new Error("legacy computer directories exist without state.json; refusing ambiguous migration");
    if (inspection.marker)
        return executeExistingTransaction(root, agentIds, inspection, io, { newlyCreated: false });

    const stateRaw = await io.readFile(join(root, "state.json"));
    const targetStateText = inspection.targetStateText;
    const marker = buildMarker(stateRaw, targetStateText, agentIds);
    const markerPath = join(root, "migration.json");
    const stagePath = join(root, migrationStageName(marker.migrationId));
    let markerCreated = false;
    try {
        await writePrivateExclusive(io, markerPath, `${JSON.stringify(marker, null, 2)}\n`);
        markerCreated = true;
        await writePrivateExclusive(io, stagePath, targetStateText);
        inspection = await inspectComputerMigration(root, agentIds, io);
        return await executeExistingTransaction(root, agentIds, inspection, io, { newlyCreated: true });
    }
    catch (error) {
        if (markerCreated) {
            const current = await inspectComputerMigration(root, agentIds, io).catch(() => undefined);
            if (current?.state?.kind !== "v2" && !current?.directories?.some((entry) => entry.currentExists && !entry.sameName)) {
                await unlinkIfPresent(io, stagePath).catch(() => undefined);
                await unlinkIfPresent(io, markerPath).catch(() => undefined);
            }
        }
        throw error;
    }
}

export const COMPUTER_MIGRATION_KIND = MIGRATION_KIND;
export const COMPUTER_MIGRATION_SCHEMA_VERSION = MIGRATION_SCHEMA_VERSION;
