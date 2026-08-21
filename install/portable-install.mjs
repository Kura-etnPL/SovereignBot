#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_MANIFEST_URL = "https://github.com/Kura-etnPL/SovereignBot/releases/latest/download/release-manifest.json";
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

function valueAfter(args, flag) {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
}

function defaultInstallDir() {
    if (process.platform === "win32")
        return join(process.env.LOCALAPPDATA ?? homedir(), "SovereignBot");
    return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "sovereignbot");
}

function assertNodeVersion(minimumMajor) {
    const current = Number(process.versions.node.split(".")[0]);
    if (!Number.isInteger(current) || current < minimumMajor)
        throw new Error(`SovereignBot requires Node.js ${minimumMajor}+; current Node is ${process.versions.node}`);
}

function sha256(buffer) {
    return createHash("sha256").update(buffer).digest("hex");
}

function isHttps(value) {
    try {
        return new URL(value).protocol === "https:";
    }
    catch {
        return false;
    }
}

async function fetchBytes(url, maxBytes) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:")
        throw new Error(`remote installer sources must use HTTPS: ${url}`);
    const response = await fetch(parsed, { redirect: "follow", cache: "no-store" });
    if (!response.ok)
        throw new Error(`download failed (${response.status}): ${url}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > maxBytes)
        throw new Error(`download is larger than allowed (${length} bytes)`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes)
        throw new Error(`download is larger than allowed (${bytes.length} bytes)`);
    return bytes;
}

async function loadManifest(source) {
    if (isHttps(source)) {
        const bytes = await fetchBytes(source, MAX_MANIFEST_BYTES);
        return { manifest: JSON.parse(bytes.toString("utf8")), remoteUrl: new URL(source) };
    }
    const path = resolve(source);
    const bytes = await readFile(path);
    if (bytes.length > MAX_MANIFEST_BYTES)
        throw new Error("release manifest is too large");
    return { manifest: JSON.parse(bytes.toString("utf8")), localPath: path };
}

function safeRelativePath(value, label) {
    if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0"))
        throw new Error(`${label} contains an invalid path`);
    if (isAbsolute(value) || value.startsWith("/") || value.split("/").some((segment) => segment === ".." || segment === "." || !segment))
        throw new Error(`${label} must be a clean relative path`);
    return value;
}

function validateManifest(manifest) {
    if (!manifest || manifest.schemaVersion !== 1)
        throw new Error("release manifest schema is invalid or unsupported");
    if (manifest.name !== "sovereignbot")
        throw new Error("release manifest package name mismatch");
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? ""))
        throw new Error("release manifest version is invalid");
    if (!Number.isInteger(manifest.node?.minimumMajor) || manifest.node.minimumMajor < 1)
        throw new Error("release manifest Node requirement is invalid");
    if (!manifest.archive || manifest.archive.format !== "tar.gz")
        throw new Error("release manifest archive format is unsupported");
    safeRelativePath(manifest.archive.file, "archive.file");
    safeRelativePath(manifest.archive.root, "archive.root");
    if (basename(manifest.archive.file) !== manifest.archive.file)
        throw new Error("archive.file must be a file name, not a path");
    if (!/^[0-9a-f]{64}$/.test(manifest.archive.sha256 ?? ""))
        throw new Error("release manifest archive SHA-256 is invalid");
    if (!Number.isInteger(manifest.archive.bytes) || manifest.archive.bytes <= 0 || manifest.archive.bytes > MAX_ARCHIVE_BYTES)
        throw new Error("release manifest archive size is invalid");
    if (!Array.isArray(manifest.files) || !manifest.files.length)
        throw new Error("release manifest file list is empty");
    const seen = new Set();
    for (const file of manifest.files) {
        safeRelativePath(file.path, "manifest file path");
        if (seen.has(file.path))
            throw new Error(`release manifest contains duplicate file: ${file.path}`);
        seen.add(file.path);
        if (!/^[0-9a-f]{64}$/.test(file.sha256 ?? ""))
            throw new Error(`release manifest has invalid SHA-256 for ${file.path}`);
        if (!Number.isInteger(file.bytes) || file.bytes < 0)
            throw new Error(`release manifest has invalid size for ${file.path}`);
    }
    return manifest;
}

async function obtainArchive({ manifest, remoteUrl, localPath, stageDir }) {
    const destination = join(stageDir, manifest.archive.file);
    if (remoteUrl) {
        const archiveUrl = new URL(manifest.archive.file, remoteUrl);
        const bytes = await fetchBytes(archiveUrl.toString(), MAX_ARCHIVE_BYTES);
        await writeFile(destination, bytes, { flag: "wx" });
    }
    else {
        const source = join(dirname(localPath), manifest.archive.file);
        await copyFile(source, destination);
    }
    const bytes = await readFile(destination);
    if (bytes.length !== manifest.archive.bytes)
        throw new Error(`release archive size mismatch: expected ${manifest.archive.bytes}, got ${bytes.length}`);
    const actual = sha256(bytes);
    if (actual !== manifest.archive.sha256)
        throw new Error(`release archive SHA-256 mismatch: expected ${manifest.archive.sha256}, got ${actual}`);
    return destination;
}

function runTar(args, options = {}) {
    const result = spawnSync("tar", args, { encoding: "utf8", windowsHide: true, ...options });
    if (result.error?.code === "ENOENT")
        throw new Error("system `tar` command is required to install the portable release");
    if (result.error)
        throw result.error;
    if (result.status !== 0)
        throw new Error(`tar failed (${result.status}): ${(result.stderr ?? result.stdout ?? "").trim().slice(-1200)}`);
    return result.stdout ?? "";
}

function validateArchiveListing(archivePath, root) {
    const listing = runTar(["-tzf", archivePath]);
    const entries = listing.split(/\r?\n/).filter(Boolean);
    if (!entries.length)
        throw new Error("release archive is empty");
    for (const raw of entries) {
        if (raw.includes("\\") || raw.startsWith("/") || raw.includes("\0"))
            throw new Error(`release archive contains unsafe entry: ${raw}`);
        const clean = raw.replace(/\/$/, "");
        const segments = clean.split("/");
        if (segments.some((segment) => segment === ".." || segment === "." || !segment))
            throw new Error(`release archive contains unsafe entry: ${raw}`);
        if (segments[0] !== root)
            throw new Error(`release archive entry escapes declared root ${root}: ${raw}`);
    }
}

async function verifyExtractedPayload(payloadRoot, manifest) {
    for (const file of manifest.files) {
        const path = join(payloadRoot, ...file.path.split("/"));
        const info = await lstat(path).catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        if (!info?.isFile() || info.isSymbolicLink())
            throw new Error(`release payload is missing a regular file: ${file.path}`);
        const bytes = await readFile(path);
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
            throw new Error(`release payload verification failed: ${file.path}`);
    }
}

function preflightCli(payloadRoot) {
    const cli = join(payloadRoot, "src", "cli.js");
    const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", windowsHide: true });
    if (result.error)
        throw result.error;
    if (result.status !== 0 || !/SovereignBot/.test(result.stdout ?? ""))
        throw new Error(`installed CLI preflight failed: ${(result.stderr ?? result.stdout ?? "").trim().slice(-1200)}`);
}

async function rejectSymlinkIfPresent(path, label) {
    const info = await lstat(path).catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (info?.isSymbolicLink())
        throw new Error(`${label} must not be a symbolic link: ${path}`);
}

async function writeLaunchers(installDir) {
    const binDir = join(installDir, "bin");
    await mkdir(binDir, { recursive: true });
    await rejectSymlinkIfPresent(binDir, "installer bin directory");
    if (process.platform === "win32") {
        const launcher = "@echo off\r\nnode \"%~dp0..\\app\\src\\cli.js\" %*\r\n";
        await writeFile(join(binDir, "sovereignbot.cmd"), launcher, "utf8");
    }
    else {
        const launcher = "#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nexec node \"$SCRIPT_DIR/../app/src/cli.js\" \"$@\"\n";
        const path = join(binDir, "sovereignbot");
        await writeFile(path, launcher, "utf8");
        await chmod(path, 0o755);
    }
}

async function installPayload({ installDir, payloadRoot, manifest, manifestSource }) {
    const root = resolve(installDir);
    if (root === parse(root).root)
        throw new Error("refusing to use a filesystem root as the install directory");
    await mkdir(root, { recursive: true });
    await rejectSymlinkIfPresent(root, "install directory");

    const stageDir = dirname(payloadRoot);
    const appDir = join(root, "app");
    const backupDir = join(stageDir, "old-app");
    await rejectSymlinkIfPresent(appDir, "existing app directory");
    let movedOld = false;
    try {
        const existing = await lstat(appDir).catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        if (existing) {
            if (!existing.isDirectory())
                throw new Error(`existing app path is not a directory: ${appDir}`);
            await rename(appDir, backupDir);
            movedOld = true;
        }
        await rename(payloadRoot, appDir);
        await writeLaunchers(root);
        await writeFile(join(root, "install-manifest.json"), `${JSON.stringify({
            ...manifest,
            installedFrom: isHttps(manifestSource) ? "github-release" : "local-manifest",
        }, null, 2)}\n`, "utf8");
    }
    catch (error) {
        const newApp = await lstat(appDir).catch((problem) => problem.code === "ENOENT" ? undefined : Promise.reject(problem));
        if (newApp && movedOld)
            await rm(appDir, { recursive: true, force: true }).catch(() => undefined);
        if (movedOld) {
            const old = await lstat(backupDir).catch((problem) => problem.code === "ENOENT" ? undefined : Promise.reject(problem));
            if (old)
                await rename(backupDir, appDir).catch(() => undefined);
        }
        throw error;
    }
    if (movedOld)
        await rm(backupDir, { recursive: true, force: true });
}

export async function installPortable({ installDir = defaultInstallDir(), manifestSource = DEFAULT_MANIFEST_URL } = {}) {
    const { manifest: rawManifest, ...location } = await loadManifest(manifestSource);
    const manifest = validateManifest(rawManifest);
    assertNodeVersion(manifest.node.minimumMajor);

    const root = resolve(installDir);
    await mkdir(root, { recursive: true });
    await rejectSymlinkIfPresent(root, "install directory");
    const stagingBase = join(root, ".staging");
    await mkdir(stagingBase, { recursive: true });
    await rejectSymlinkIfPresent(stagingBase, "installer staging directory");
    const stageDir = join(stagingBase, randomUUID());
    const extractDir = join(stageDir, "extract");
    await mkdir(extractDir, { recursive: true });

    try {
        const archivePath = await obtainArchive({ manifest, ...location, stageDir });
        validateArchiveListing(archivePath, manifest.archive.root);
        runTar(["-xzf", archivePath, "-C", extractDir]);
        const payloadRoot = join(extractDir, ...manifest.archive.root.split("/"));
        await rejectSymlinkIfPresent(payloadRoot, "release payload root");
        await verifyExtractedPayload(payloadRoot, manifest);
        preflightCli(payloadRoot);
        await installPayload({ installDir: root, payloadRoot, manifest, manifestSource });
        return {
            installDir: root,
            version: manifest.version,
            binDir: join(root, "bin"),
            launcher: process.platform === "win32"
                ? join(root, "bin", "sovereignbot.cmd")
                : join(root, "bin", "sovereignbot"),
        };
    }
    finally {
        await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)))) {
    // The URL-path comparison above is only for direct execution; imported tests call installPortable.
    const args = process.argv.slice(2);
    const result = await installPortable({
        installDir: valueAfter(args, "--install-dir") ?? defaultInstallDir(),
        manifestSource: valueAfter(args, "--manifest") ?? DEFAULT_MANIFEST_URL,
    });
    console.log(`SovereignBot ${result.version} installed at ${result.installDir}`);
    console.log(`Launcher: ${result.launcher}`);
    console.log("No PATH or shell profile changes were made.");
}
