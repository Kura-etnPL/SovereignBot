// Copies the reviewed Core payload from the repo root into desktop/vendor/core and records a
// SHA-256 manifest (vendor/core/core-manifest.json). RuntimeHost re-verifies every file at
// startup, so a stale or tampered copy fails closed instead of silently running old Core code.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENDOR = join(DESKTOP_ROOT, "vendor", "core");

const CORE_COPY_DIRS = ["src", "sidecars"];
const CORE_COPY_FILES = ["package.json"];

function sha256Buffer(buffer) {
    return createHash("sha256").update(buffer).digest("hex");
}

function listFilesRecursive(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory())
            out.push(...listFilesRecursive(full));
        else if (entry.isFile())
            out.push(full);
    }
    return out;
}

function main() {
    for (const dir of CORE_COPY_DIRS) {
        if (!statSync(join(REPO_ROOT, dir)).isDirectory())
            throw new Error(`missing core directory: ${dir}`);
    }
    for (const file of CORE_COPY_FILES) {
        if (!existsSync(join(REPO_ROOT, file)))
            throw new Error(`missing core file: ${file}`);
    }

    rmSync(VENDOR, { recursive: true, force: true });
    mkdirSync(VENDOR, { recursive: true });
    for (const dir of CORE_COPY_DIRS)
        cpSync(join(REPO_ROOT, dir), join(VENDOR, dir), { recursive: true });
    for (const file of CORE_COPY_FILES)
        cpSync(join(REPO_ROOT, file), join(VENDOR, file));

    const files = {};
    for (const full of listFilesRecursive(VENDOR)) {
        const rel = relative(VENDOR, full).replaceAll("\\", "/");
        files[rel] = sha256Buffer(readFileSync(full));
    }
    const manifest = {
        schema: "sovereignbot.desktop.vendor-core.v1",
        fileCount: Object.keys(files).length,
        files,
    };
    writeFileSync(join(VENDOR, "core-manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`, "utf8");
    console.log(JSON.stringify({ syncCore: "ok", fileCount: manifest.fileCount }));
}

main();
