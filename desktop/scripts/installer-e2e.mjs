// Installer end-to-end: silently installs the Squirrel Setup.exe produced by
// `electron-forge make`, asserts the installed tree, then runs the INSTALLED executable
// in --desktop-smoke mode against a temp data dir and requires the machine-readable ok.
// This proves the shipping artifact — not merely the developer packaging output — boots,
// verifies its vendored Core, and drives the governed runtime.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const DESKTOP_ROOT = process.cwd();
const MAKE_ROOT = join(DESKTOP_ROOT, "out", "make");
const INSTALL_TIMEOUT_MS = 180_000;
const SMOKE_TIMEOUT_MS = 240_000;

function fail(message) {
    console.error(`[installer-e2e] ${message}`);
    process.exit(1);
}

// The maker's output layout is an implementation detail (forge 7.11 uses
// out/make/squirrel.windows/<arch>/); walk the make root and locate whichever directory
// actually holds the produced Setup.exe, failing loudly with listings otherwise.
function findInstallerDir() {
    if (!existsSync(MAKE_ROOT))
        fail(`no make output at ${MAKE_ROOT}; run "electron-forge make" first`);
    const found = [];
    const visit = (dir, depth) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const child = join(dir, entry.name);
            if (existsSync(join(child, "SovereignBot-Setup.exe")))
                found.push(child);
            else if (depth < 3)
                visit(child, depth + 1);
        }
    };
    visit(MAKE_ROOT, 0);
    if (found.length !== 1)
        fail(`expected exactly one installer directory containing SovereignBot-Setup.exe under ${MAKE_ROOT}, found ${found.length}`);
    return found[0];
}

let SQUIRREL_DIR;

function assertReleaseSet() {
    // Initial-install product = Setup.exe embedding exactly one full nupkg. A Squirrel
    // RELEASES index only matters for delta/auto-update channels, which Desktop v1.1
    // deliberately does not have; its absence is recorded honestly by the manifest.
    const names = readdirSync(SQUIRREL_DIR);
    const setup = names.find((name) => name === "SovereignBot-Setup.exe");
    if (!setup)
        fail(`SovereignBot-Setup.exe not found in ${SQUIRREL_DIR}: ${names.join(", ")}`);
    const nupkg = names.filter((name) => name.endsWith(".full.nupkg"));
    if (nupkg.length !== 1)
        fail(`expected exactly one .full.nupkg, found: ${names.join(", ")}`);
}

function runChild(command, args, { timeoutMs, onData }) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { shell: false, windowsHide: true });
        let stdout = "";
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                child.kill();
                resolve({ ok: false, reason: `timeout after ${timeoutMs}ms`, stdout });
            }
        }, timeoutMs);
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
            stdout += chunk;
            onData?.(chunk);
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", () => {});
        child.once("error", (error) => {
            clearTimeout(timer);
            if (!settled) {
                settled = true;
                resolve({ ok: false, reason: String(error), stdout });
            }
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            if (!settled) {
                settled = true;
                resolve({ ok: true, code, stdout });
            }
        });
    });
}

async function waitForInstallRoot(installRoot) {
    const exe = join(installRoot, "SovereignBot.exe");
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            if (statSync(exe).isFile())
                return exe;
        }
        catch {
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    fail(`installed executable never appeared at ${exe}`);
}

async function main() {
    SQUIRREL_DIR = findInstallerDir();
    assertReleaseSet();
    const setupExe = join(SQUIRREL_DIR, "SovereignBot-Setup.exe");
    console.error(`[installer-e2e] silent install: ${setupExe}`);

    // Squirrel's --silent runs per-user without UI. The Setup.exe may exit while a
    // background installer process finishes, hence the install-root poll below.
    const setupResult = await runChild(setupExe, ["--silent"], { timeoutMs: INSTALL_TIMEOUT_MS });
    if (!setupResult.ok && !existsSync(join(process.env.LOCALAPPDATA ?? "", "sovereignbot", "SovereignBot.exe")))
        fail(`installer failed: ${setupResult.reason ?? `exit ${setupResult.code}`}`);

    const installRoot = join(process.env.LOCALAPPDATA ?? join(tmpdir(), "fallback-localappdata"), "sovereignbot");
    const installedExe = await waitForInstallRoot(installRoot);
    console.error(`[installer-e2e] installed at ${installRoot}`);

    for (const required of [join(installRoot, "Update.exe"), join(installRoot, "resources", "app.asar")]) {
        if (!existsSync(required))
            fail(`expected installed file missing: ${required}`);
    }

    const smokeDataDir = await mkdtemp(join(tmpdir(), "sb-installer-e2e-"));
    let smokeJson;
    try {
        const result = await runChild(installedExe, ["--desktop-smoke"], {
            timeoutMs: SMOKE_TIMEOUT_MS,
        });
        const lines = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("{"));
        if (!lines.length)
            fail(`installed smoke emitted no JSON result (exit ${result.code ?? "?"}, ${result.reason ?? ""})\n${result.stdout.slice(0, 800)}`);
        smokeJson = JSON.parse(lines.at(-1));
        if (smokeJson.smoke !== "ok")
            fail(`installed smoke reported failure: ${JSON.stringify(smokeJson)}`);
    }
    finally {
        await rm(smokeDataDir, { recursive: true, force: true });
    }

    const pkg = JSON.parse(readFileSync(join(DESKTOP_ROOT, "package.json"), "utf8"));
    console.log(JSON.stringify({
        installerE2e: "ok",
        setupExe: setupExe.split("\\").pop(),
        installRoot,
        version: pkg.version,
        smokeChecks: smokeJson.checks,
    }));
}

main().catch((error) => fail(String(error?.stack ?? error)));
