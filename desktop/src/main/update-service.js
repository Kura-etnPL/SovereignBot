import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, basename } from "node:path";
import { spawn } from "node:child_process";

export const UPDATE_CHANNELS = Object.freeze(["stable", "preview", "off"]);
export const UPDATE_METADATA_SCHEMA = "sovereignbot.desktop.update-metadata.v1";
const STATE_SCHEMA = "sovereignbot.desktop.update-state.v1";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

function versionParts(value) {
    const match = SEMVER.exec(String(value));
    if (!match) throw new Error(`invalid update SemVer: ${String(value).slice(0, 80)}`);
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""];
}
function compareVersions(left, right) {
    const a = versionParts(left), b = versionParts(right);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    if (!a[3] && b[3]) return 1;
    if (a[3] && !b[3]) return -1;
    return a[3].localeCompare(b[3]);
}
function inside(root, target) {
    const rel = relative(resolve(root), resolve(target));
    return rel && rel !== ".." && !rel.startsWith(`..${requireSep()}`) && !rel.includes("\0");
}
function requireSep() { return process.platform === "win32" ? "\\" : "/"; }
function publicArtifact(artifact) { return { name: artifact.name, size: artifact.size, sha256: artifact.sha256 }; }

async function atomicJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.staging-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
}

async function readJson(path, fallback) {
    try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

export function validateUpdateMetadata(metadata, { currentVersion, channel, feedRoot } = {}) {
    if (!metadata || metadata.schema !== UPDATE_METADATA_SCHEMA) throw new Error("update metadata schema mismatch");
    if (!UPDATE_CHANNELS.includes(metadata.channel) || metadata.channel === "off") throw new Error("update metadata channel is invalid");
    if (channel !== metadata.channel) throw new Error("update metadata channel mismatch");
    if (compareVersions(metadata.version, currentVersion) <= 0) throw new Error("update is a downgrade or not newer than current version");
    versionParts(metadata.minCurrentVersion);
    if (compareVersions(currentVersion, metadata.minCurrentVersion) < 0) throw new Error("current version is below update minimum");
    if (metadata.requiresBackup !== true) throw new Error("update metadata must require a pre-update backup");
    if (!metadata.artifact || typeof metadata.artifact !== "object") throw new Error("update artifact is missing");
    if (typeof metadata.artifact.path !== "string" || metadata.artifact.path.length > 240 || metadata.artifact.path.includes("\0")) throw new Error("update artifact path is invalid");
    if (!/^[0-9a-f]{64}$/i.test(metadata.artifact.sha256) || !Number.isSafeInteger(metadata.artifact.size) || metadata.artifact.size < 1) throw new Error("update artifact hash or size is invalid");
    if (!metadata.signature || !["signed", "unsigned"].includes(metadata.signature.status) || typeof metadata.signature.verified !== "boolean") throw new Error("update signature status is invalid");
    if (metadata.channel === "stable" && (metadata.signature.status !== "signed" || metadata.signature.verified !== true)) throw new Error("unsigned or unverified stable update rejected");
    const artifactPath = resolve(feedRoot, metadata.artifact.path);
    if (!inside(feedRoot, artifactPath) || basename(artifactPath) !== metadata.artifact.path.split(/[\\/]/).pop() || !existsSync(artifactPath) || !lstatSync(artifactPath).isFile()) throw new Error("update artifact is outside the trusted local feed");
    return { ...metadata, artifact: { ...metadata.artifact, path: metadata.artifact.path } };
}

export async function verifyUpdateArtifact(metadata, feedRoot) {
    const path = resolve(feedRoot, metadata.artifact.path);
    const bytes = await readFile(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== metadata.artifact.size || sha256 !== metadata.artifact.sha256.toLowerCase()) throw new Error("update artifact hash or size mismatch");
    return { path, bytes: bytes.length, sha256 };
}

export function createSquirrelUpdateExecutor({ updateExe, feedRoot } = {}) {
    return async ({ artifactPath }) => {
        const executable = resolve(updateExe ?? "");
        if (!updateExe || !existsSync(executable) || !lstatSync(executable).isFile()) throw new Error("Squirrel Update.exe is unavailable");
        if (!inside(feedRoot, artifactPath)) throw new Error("staged update is outside the trusted local feed");
        // The only permitted child process is the installed Squirrel primitive, with fixed
        // arguments. It is reached only from the explicit Apply action.
        await new Promise((resolvePromise, reject) => {
            const child = spawn(executable, ["--update", feedRoot], { detached: true, windowsHide: true, stdio: "ignore" });
            child.once("error", reject);
            child.once("spawn", () => { child.unref(); resolvePromise(); });
        });
        return { requested: true, restartRequired: true };
    };
}

export function createUpdateService({ dataDir, currentVersion, getChannel, setChannel, dataLifecycle, audit, feedRoot = process.env.SOVEREIGNBOT_UPDATE_FEED_DIR, updateExecutor } = {}) {
    if (!dataDir || !currentVersion) throw new Error("update service requires dataDir and currentVersion");
    const statePath = join(resolve(dataDir), "desktop-state", "update-state.json");
    let state = { schema: STATE_SCHEMA, channel: getChannel?.() ?? "stable", lastCheckAt: null, available: null, staged: null, attention: null };
    const load = readJson(statePath, state).then((value) => { if (value?.schema === STATE_SCHEMA && UPDATE_CHANNELS.includes(value.channel)) state = { ...state, ...value }; return state; });
    async function save() { await atomicJson(statePath, state); }
    async function fail(reason, error) { state.attention = { reason, message: String(error?.message ?? error).slice(0, 240), at: new Date().toISOString() }; await save(); try { await audit?.append({ type: "desktop.update.attention", actor: "system", subject: "update", data: { reason, error: state.attention.message } }); } catch {} throw error; }
    async function status() { await load; return { currentVersion, channel: state.channel, lastCheckAt: state.lastCheckAt, available: state.available ? { ...state.available, artifact: publicArtifact(state.available.artifact) } : null, staged: state.staged ? { version: state.staged.version, backupId: state.staged.backupId, verified: true } : null, signature: state.available?.signature ?? null, attention: state.attention }; }
    return {
        status,
        async setChannel(channel) { await load; if (!UPDATE_CHANNELS.includes(channel)) throw new Error("update channel is invalid"); state.channel = channel; state.available = null; state.staged = null; state.attention = null; setChannel?.(channel); await save(); return status(); },
        async check() {
            await load;
            if (state.channel === "off") return status();
            if (!feedRoot) return fail("check-unavailable", new Error("local update feed is not configured"));
            try {
                const metadata = JSON.parse(await readFile(join(resolve(feedRoot), "update.json"), "utf8"));
                const valid = validateUpdateMetadata(metadata, { currentVersion, channel: state.channel, feedRoot });
                const artifact = await verifyUpdateArtifact(valid, feedRoot);
                state.available = { ...valid, artifact: { ...valid.artifact, size: artifact.bytes, sha256: artifact.sha256 } };
                state.lastCheckAt = new Date().toISOString(); state.attention = null; await save(); return status();
            } catch (error) { state.lastCheckAt = new Date().toISOString(); await save(); return fail("check-failed", error); }
        },
        async stage() {
            await load;
            if (!state.available) throw new Error("check for an update before staging");
            try {
                const backup = await dataLifecycle.backup({ id: `pre-update-${Date.now()}` });
                const artifact = await verifyUpdateArtifact(state.available, feedRoot);
                state.staged = { version: state.available.version, artifactPath: artifact.path, backupId: backup.id, stagedAt: new Date().toISOString() }; await save(); return status();
            } catch (error) { return fail("stage-failed", error); }
        },
        async apply() {
            await load;
            if (!state.staged) throw new Error("stage an update before applying");
            try {
                if (!updateExecutor) throw new Error("Squirrel Update.exe executor is unavailable");
                const result = await updateExecutor({ artifactPath: state.staged.artifactPath, version: state.staged.version });
                state.staged = { ...state.staged, appliedAt: new Date().toISOString(), restartRequired: true }; await save(); return { ...result, restartRequired: true, version: state.staged.version };
            } catch (error) { return fail("apply-failed", error); }
        },
    };
}
