// Downloads the pinned bundled Node interpreter declared in resources/node-runtime.manifest.json
// and verifies its official SHA-256 before placing it. Fails closed on hash mismatch; never
// fetches "latest".
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(DESKTOP_ROOT, "resources", "node-runtime.manifest.json"), "utf8"));
const PLATFORM_KEY = `${process.platform}-${process.arch}`;
const ENTRY = MANIFEST.platforms[PLATFORM_KEY];
if (!ENTRY)
    throw new Error(`no pinned internal Node runtime declared for ${PLATFORM_KEY}`);

const TARGET_DIR = join(DESKTOP_ROOT, "resources", "node");
const TARGET = join(TARGET_DIR, ENTRY.file);

function sha256Buffer(buffer) {
    return createHash("sha256").update(buffer).digest("hex");
}

async function main() {
    if (existsSync(TARGET)) {
        const actual = sha256Buffer(readFileSync(TARGET));
        if (actual === ENTRY.sha256) {
            console.log(JSON.stringify({ fetchNode: "cached", path: TARGET, sha256: actual }));
            return;
        }
        console.error(`existing ${TARGET} has wrong hash (${actual}); re-downloading pinned ${MANIFEST.version}`);
        rmSync(TARGET, { force: true });
    }

    console.error(`downloading ${ENTRY.url}`);
    const response = await fetch(ENTRY.url);
    if (!response.ok)
        throw new Error(`download failed: HTTP ${response.status} for ${ENTRY.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256Buffer(bytes);
    if (actual !== ENTRY.sha256) {
        throw new Error(`pinned node runtime failed integrity check: expected ${ENTRY.sha256}, got ${actual}`);
    }

    mkdirSync(dirname(TARGET), { recursive: true });
    const staging = `${TARGET}.download`;
    writeFileSync(staging, bytes, { flag: "wx" });
    renameSync(staging, TARGET);
    console.log(JSON.stringify({ fetchNode: "downloaded", version: MANIFEST.version, path: TARGET, sha256: actual }));
}

main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(1);
});
