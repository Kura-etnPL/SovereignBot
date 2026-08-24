// Shared Electron fuse logic for packaging. Used by two entry points that must agree
// exactly: the CLI (scripts/apply-and-verify-fuses.mjs) and the Forge postPackage hook
// wired in forge.config.js so installer payloads are fused BEFORE Squirrel packs them
// into the .nupkg (Squirrel verifies package hashes later, so post-hoc edits break it).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
    FuseV1Options,
    FuseVersion,
    FuseState,
    flipFuses,
    getCurrentFuseWire,
} from "@electron/fuses";

// flipFuses consumes booleans; getCurrentFuseWire reports ASCII wire codes
// (DISABLE=48/ENABLE=49/REMOVED=114). Keep the two vocabularies separate.
export const FLIP_V1_BOOLEANS = {
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: false,
};

export const EXPECTED_V1 = new Map([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
    [FuseV1Options.WasmTrapHandlers, FuseState.DISABLE],
]);

// A removed fuse can report REMOVED instead of DISABLE; both satisfy a disable expectation
// because neither leaves the behavior enabled.
export function stateSatisfies(actual, expected) {
    if (expected === FuseState.ENABLE)
        return actual === FuseState.ENABLE;
    return actual === FuseState.DISABLE || actual === FuseState.REMOVED;
}

export function findPackagedExe(outDir) {
    const appDir = readdirSync(outDir, { withFileTypes: true })
        .find((entry) => entry.isDirectory() && entry.name.endsWith("-win32-x64"));
    if (!appDir)
        throw new Error(`packaged app directory not found under ${outDir}`);
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const exeName = pkg.executableName ?? "SovereignBot";
    const exe = join(outDir, appDir.name, `${exeName}.exe`);
    if (!existsSync(exe))
        throw new Error(`packaged executable not found: ${exe}`);
    return exe;
}

export async function flipFusesOn(exePath) {
    await flipFuses(exePath, {
        version: FuseVersion.V1,
        // Force every known fuse to be defined explicitly so a newly added fuse in an
        // Electron upgrade cannot silently ship in its inherited/default state.
        strictlyRequireAllFuses: true,
        ...FLIP_V1_BOOLEANS,
    });
}

export async function verifyFusesOn(exePath) {
    const wire = await getCurrentFuseWire(exePath);
    if (!wire)
        throw new Error("could not read fuse wire");
    for (const [fuse, expected] of EXPECTED_V1) {
        const actual = wire[fuse];
        if (!stateSatisfies(actual, expected)) {
            throw new Error(`fuse ${Number(fuse)} state mismatch: expected ${expected}, got ${String(actual)}`);
        }
    }
}
