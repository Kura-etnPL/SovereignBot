// Flips (unless --verify-only) and verifies the reviewed Electron fuse set on the packaged
// executable. Run after `electron-forge package`/`make`; with --verify-only it asserts the
// wire without touching it, which is how CI checks the postPackage hook did its job before
// any artifact is consumed.
import { join } from "node:path";
import process from "node:process";
import { findPackagedExe, flipFusesOn, verifyFusesOn } from "./fuses-core.mjs";

async function main() {
    const verifyOnly = process.argv.includes("--verify-only");
    const exePath = findPackagedExe(join(process.cwd(), "out"));

    if (!verifyOnly)
        await flipFusesOn(exePath);
    await verifyFusesOn(exePath);
    console.log(JSON.stringify({ fuses: verifyOnly ? "verified" : "flipped+verified", exe: exePath }));
}

main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(1);
});
