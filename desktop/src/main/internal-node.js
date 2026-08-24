import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInternalNodeResolver } from "./lib/internal-node-resolve.js";

const DESKTOP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MANIFEST_PATH = join(DESKTOP_ROOT, "resources", "node-runtime.manifest.json");

function sha256File(path) {
    const hash = createHash("sha256");
    hash.update(readFileSync(path));
    return hash.digest("hex");
}

function readManifest() {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

const resolveInternalNode = createInternalNodeResolver({
    env: process.env,
    isPackaged: !process.defaultApp,
    resourcesPath: process.resourcesPath ?? "",
    desktopRoot: DESKTOP_ROOT,
    execPathBasename: basename(process.execPath),
    processExecPath: process.execPath,
    exists: (path) => existsSync(path) && statSync(path).isFile(),
    sha256File,
    readManifest,
});

// Resolves the pinned interpreter and exports it for Core child-process launches. Called once
// during RuntimeHost startup; failures abort startup fail-closed.
export function prepareInternalNode() {
    const resolved = resolveInternalNode();
    process.env.SOVEREIGNBOT_INTERNAL_NODE = resolved.path;
    return resolved;
}
