// Packages the Desktop with Forge (--build flag), flips+verifies fuses, then runs the packaged
// executable in --desktop-smoke mode and asserts the machine-readable result. Without --build
// it consumes the existing out/ artifact so CI can keep build and acceptance as separate,
// individually readable steps. Never talks to real providers.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const DESKTOP_ROOT = process.cwd();
const OUT_DIR = join(DESKTOP_ROOT, "out");
const TIMEOUT_MS = 180_000;

function runStep(name, command, args, opts = {}) {
    console.error(`[smoke] ${name}`);
    const result = spawnSync(command, args, {
        stdio: "inherit",
        shell: process.platform === "win32" && command === "npm",
        ...opts,
    });
    if (result.status !== 0)
        throw new Error(`step failed (${name}): exit ${result.status}`);
}

function findPackagedExe(outDir) {
    const appDir = readdirSync(outDir, { withFileTypes: true })
        .find((entry) => entry.isDirectory() && entry.name.endsWith("-win32-x64"));
    if (!appDir)
        throw new Error(`packaged app directory not found under ${outDir}`);
    const pkg = JSON.parse(readFileSync(join(DESKTOP_ROOT, "package.json"), "utf8"));
    const exeName = pkg.executableName ?? "SovereignBot";
    const exe = join(outDir, appDir.name, `${exeName}.exe`);
    if (!existsSync(exe))
        throw new Error(`packaged executable not found: ${exe}`);
    return exe;
}

async function main() {
    if (process.argv.includes("--build")) {
        runStep("sync core payload", "npm", ["run", "sync-core"], { cwd: DESKTOP_ROOT });
        runStep("forge package", "npx", ["electron-forge", "package", "--platform", "win32", "--arch", "x64"], { cwd: DESKTOP_ROOT });
    }
    else if (!existsSync(OUT_DIR)) {
        throw new Error(`no packaged build found at ${OUT_DIR}; run "npm run package" first or pass --build`);
    }
    runStep("apply + verify fuses", "node", ["scripts/apply-and-verify-fuses.mjs"], { cwd: DESKTOP_ROOT });

    const exe = findPackagedExe(OUT_DIR);
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-packaged-smoke-"));
    try {
        const child = spawn(exe, ["--desktop-smoke"], {
            env: { ...process.env, SOVEREIGNBOT_DESKTOP_SMOKE_DATA_DIR: dataDir },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));

        const exitCode = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`packaged smoke timed out after ${TIMEOUT_MS}ms`));
            }, TIMEOUT_MS);
            child.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.once("close", (code) => {
                clearTimeout(timer);
                resolve(code);
            });
        });

        if (stderr.trim())
            console.error(`[smoke] stderr:\n${stderr.slice(-4000)}`);

        const jsonLines = stdout.split(/\r?\n/).filter((line) => line.startsWith("{"));
        if (!jsonLines.length)
            throw new Error(`packaged smoke produced no JSON result. stdout:\n${stdout.slice(-4000)}`);
        const result = JSON.parse(jsonLines[jsonLines.length - 1]);
        if (exitCode !== 0 || result.smoke !== "ok") {
            throw new Error(`packaged smoke failed: exit=${exitCode} result=${JSON.stringify(result)}`);
        }

        const pngPath = join(dataDir, "smoke-home.png");
        const pngBytes = existsSync(pngPath) ? (await readFile(pngPath)).length : 0;
        console.log(JSON.stringify({ smoke: "ok", exe, checks: result.checks, screenshotBytes: pngBytes }));
        if (pngBytes < 10_000)
            throw new Error(`home screenshot missing or implausibly small (${pngBytes} bytes)`);
    }
    finally {
        await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
}

main().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exit(1);
});
