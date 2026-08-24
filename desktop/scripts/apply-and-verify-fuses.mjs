// Flips the reviewed Electron fuse set on a packaged executable and verifies the resulting
// wire fail-closed. Run after `electron-forge package`, before any packaged artifact is used.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
    FuseV1Options,
    FuseVersion,
    flipFuses,
    getCurrentFuseWire,
} from "@electron/fuses";

const EXPECTED_V1 = new Map([
    [FuseV1Options.RunAsNode, false],
    [FuseV1Options.EnableCookieEncryption, true],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
    [FuseV1Options.EnableNodeCliInspectArguments, false],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true],
    [FuseV1Options.OnlyLoadAppFromAsar, true],
]);

// Deprecated fuses can report "removed"/"inert" instead of false; both satisfy a `false`
// expectation because neither leaves the behavior enabled.
function stateSatisfies(actual, expected) {
    if (expected === true)
        return actual === true;
    return actual === false || actual === "removed" || actual === "inert";
}

function findPackagedExe(outDir) {
    const appDir = readdirSync(outDir, { withFileTypes: true })
        .find((entry) => entry.isDirectory() && entry.name.endsWith("-win32-x64"));
    if (!appDir)
        throw new Error(`packaged app directory not found under ${outDir}`);
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const exeName = pkg.executableName ?? pkg.name ?? "app";
    for (const candidate of [`${exeName}.exe`, "SovereignBot.exe"]) {
        const exe = join(outDir, appDir.name, candidate);
        if (existsSync(exe))
            return exe;
    }
    throw new Error(`packaged executable not found under ${join(outDir, appDir.name)}`);
}

async function main() {
    const exePath = findPackagedExe(join(process.cwd(), "out"));

    await flipFuses(exePath, {
        version: FuseVersion.V1,
        ...Object.fromEntries(EXPECTED_V1),
    });

    const wire = await getCurrentFuseWire(exePath);
    if (!wire || wire.version !== FuseVersion.V1)
        throw new Error("unexpected fuse wire after flipping");
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
