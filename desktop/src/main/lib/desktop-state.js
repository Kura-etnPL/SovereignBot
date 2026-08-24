import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Desktop-owned durable state (workspaces, settings, driver records) lives under
// <coreDataDir>/desktop-state/, written atomically (temp + rename) and read back with schema
// checks so corruption fails closed instead of producing undefined behavior.

function atomicWrite(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    const staging = `${path}.tmp`;
    rmSync(staging, { force: true });
    writeFileSync(staging, text, "utf8");
    renameSync(staging, path);
}

export function loadJsonState(path, fallback) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return structuredClone(fallback);
    }
}

export function saveJsonState(path, value) {
    atomicWrite(path, `${JSON.stringify(value, null, 1)}\n`);
}

export function desktopStateDir(dataDir) {
    return join(dataDir, "desktop-state");
}
