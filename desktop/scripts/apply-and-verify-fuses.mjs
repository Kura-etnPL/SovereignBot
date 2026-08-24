// Flips the reviewed Electron fuse set on a packaged executable and verifies the resulting
// wire fail-closed. Run after `electron-forge package`, before any packaged artifact is used.
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

const EXPECTED_V1 = new Map([
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
function stateSatisfies(actual, expected) {
    if (expected === FuseState.ENABLE)
        return actual === FuseState.ENABLE;
    return actual === FuseState.DISABLE || actual === FuseState.REMOVED;
}

function findPackagedExe(outDir) {
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

async function main() {
    const exePath = findPackagedExe(join(process.cwd(), "out"));

    await flipFuses(exePath, {
        version: FuseVersion.V1,
        // Force every known fuse to be defined explicitly so a newly added fuse in an
        // Electron upgrade cannot silently ship in its inherited/default state.
        strictlyRequireAllFuses: true,
        ...Object.fromEntries(EXPECTED_V1),
    });

    const wire = await getCurrentFuseWire(exePath);
    if (!wire)
        throw new Error("could not read fuse wire after flipping");
    for (const [fuse, expected] of EXPECTED_V1) {
        const actual = wire[fuse];
        if (!stateSatisfies(actual, expected)) {
            throw new Error(`fuse ${Number(fuse)} state mismatch after flip: expected ${expected}, got ${String(actual)}`);
        }
    }
    console.log(JSON.stringify({ fuses: "verified", exe: exePath }));
}

main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(1);
});
