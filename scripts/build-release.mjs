#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutDir = join(repoRoot, "dist");
const SHIPPED_ROOTS = ["src", "sidecars", "ui", "docs", "examples"];
const SHIPPED_FILES = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "SECURITY.md"];
const STANDALONE_INSTALLERS = [
    "install/portable-install.mjs",
    "install/install.ps1",
    "install/install.sh",
];
const TAR_BLOCK = 512;

function toPosix(path) {
    return path.split(sep).join("/");
}

function sha256(buffer) {
    return createHash("sha256").update(buffer).digest("hex");
}

async function walk(path) {
    const entries = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const absolute = join(path, entry.name);
        if (entry.isDirectory())
            entries.push(...await walk(absolute));
        else if (entry.isFile())
            entries.push(toPosix(relative(repoRoot, absolute)));
        else
            throw new Error(`release payload does not support non-file entry: ${absolute}`);
    }
    return entries;
}

async function releasePaths() {
    const paths = [];
    for (const root of SHIPPED_ROOTS) {
        const absolute = join(repoRoot, root);
        const info = await stat(absolute).catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        if (info?.isDirectory())
            paths.push(...await walk(absolute));
    }
    for (const file of SHIPPED_FILES) {
        const absolute = join(repoRoot, file);
        const info = await stat(absolute).catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        if (!info?.isFile())
            throw new Error(`required release file is missing: ${file}`);
        paths.push(file);
    }
    return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

function writeString(header, offset, length, value) {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length > length)
        throw new Error(`tar field is too long: ${value}`);
    bytes.copy(header, offset);
}

function writeOctal(header, offset, length, value) {
    const text = Math.trunc(value).toString(8).padStart(length - 1, "0");
    if (text.length > length - 1)
        throw new Error(`tar numeric field overflow: ${value}`);
    writeString(header, offset, length, `${text}\0`);
}

function splitTarPath(path) {
    if (Buffer.byteLength(path) <= 100)
        return { name: path, prefix: "" };
    const segments = path.split("/");
    for (let index = segments.length - 1; index > 0; index -= 1) {
        const prefix = segments.slice(0, index).join("/");
        const name = segments.slice(index).join("/");
        if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155)
            return { name, prefix };
    }
    throw new Error(`release path cannot be represented in ustar: ${path}`);
}

function tarHeader(path, size) {
    const header = Buffer.alloc(TAR_BLOCK, 0);
    const { name, prefix } = splitTarPath(path);
    writeString(header, 0, 100, name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, size);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    writeString(header, 265, 32, "root");
    writeString(header, 297, 32, "root");
    writeString(header, 345, 155, prefix);
    let checksum = 0;
    for (const byte of header)
        checksum += byte;
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    return header;
}

function tarFile(path, content) {
    const header = tarHeader(path, content.length);
    const padding = (TAR_BLOCK - (content.length % TAR_BLOCK)) % TAR_BLOCK;
    return Buffer.concat([header, content, Buffer.alloc(padding, 0)]);
}

async function buildTar(paths, rootName) {
    const chunks = [];
    const fileManifest = [];
    for (const path of paths) {
        const content = await readFile(join(repoRoot, path));
        fileManifest.push({ path, sha256: sha256(content), bytes: content.length });
        chunks.push(tarFile(posix.join(rootName, path), content));
    }
    chunks.push(Buffer.alloc(TAR_BLOCK * 2, 0));
    return { tar: Buffer.concat(chunks), fileManifest };
}

async function buildInstallerAssets(outDir) {
    const installers = [];
    for (const source of STANDALONE_INSTALLERS) {
        const content = await readFile(join(repoRoot, source));
        const file = basename(source);
        await writeFile(join(outDir, file), content);
        installers.push({ file, sha256: sha256(content), bytes: content.length });
    }
    return installers;
}

function valueAfter(args, flag) {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
}

export async function buildRelease({ outDir = defaultOutDir } = {}) {
    const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version))
        throw new Error(`package version is not release-compatible: ${packageJson.version}`);
    await mkdir(outDir, { recursive: true });

    const paths = await releasePaths();
    const rootName = "sovereignbot";
    const { tar, fileManifest } = await buildTar(paths, rootName);
    const archive = gzipSync(tar, { level: 9, mtime: 0 });
    const archiveName = `sovereignbot-${packageJson.version}.tar.gz`;
    const archiveHash = sha256(archive);
    const installers = await buildInstallerAssets(outDir);
    const manifest = {
        schemaVersion: 1,
        name: packageJson.name,
        version: packageJson.version,
        node: { minimumMajor: 22 },
        archive: {
            file: archiveName,
            format: "tar.gz",
            root: rootName,
            sha256: archiveHash,
            bytes: archive.length,
        },
        installers,
        files: fileManifest,
    };

    await writeFile(join(outDir, archiveName), archive);
    await writeFile(join(outDir, `${archiveName}.sha256`), `${archiveHash}  ${archiveName}\n`, "utf8");
    await writeFile(join(outDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { outDir, archiveName, archiveHash, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const outDir = valueAfter(process.argv.slice(2), "--out") ?? defaultOutDir;
    const result = await buildRelease({ outDir: resolve(outDir) });
    console.log(JSON.stringify({
        outDir: result.outDir,
        archive: result.archiveName,
        sha256: result.archiveHash,
        files: result.manifest.files.length,
        installers: result.manifest.installers.map((entry) => entry.file),
    }, null, 2));
}
