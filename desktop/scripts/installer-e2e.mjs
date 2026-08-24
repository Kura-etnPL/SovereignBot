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
function dumpTree(root) {
    const lines = [];
    const walk = (dir, prefix) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            lines.push(`${prefix}${entry.isDirectory() ? entry.name + "/" : entry.name}`);
            if (entry.isDirectory())
                walk(join(dir, entry.name), `${prefix}${entry.name}/`);
        }
    };
    try {
        walk(root, "");
    }
    catch {
    }
    return lines.join(" | ");
}

// The maker's output layout/naming is an implementation detail (forge 7.11 writes
// out/make/squirrel.windows/<arch>/<name>-<version> Setup.exe); walk the make root,
// locate the unique Setup executable, and fail loudly with a tree dump otherwise.
function findInstallerDir() {
    if (!existsSync(MAKE_ROOT))
        fail(`no make output at ${MAKE_ROOT}; run "electron-forge make" first`);
    const found = [];
    const visit = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile() && /^SovereignBot.*Setup\.exe$/.test(entry.name))
                found.push({ setupExe: join(dir, entry.name), dir });
            else if (entry.isDirectory())
                visit(join(dir, entry.name));
        }
    };
    visit(MAKE_ROOT);
    if (found.length !== 1)
        fail(`expected exactly one SovereignBot*Setup.exe under ${MAKE_ROOT}, found ${found.length}. tree: ${dumpTree(MAKE_ROOT)}`);
    return found[0];
}

let SQUIRREL_DIR;

function assertReleaseSet() {
    // Initial-install product: versioned Setup.exe + exactly one full nupkg + the
    // Squirrel RELEASES index (confirmed produced by forge's squirrel maker).
    const names = readdirSync(SQUIRREL_DIR);
    if (!names.includes("RELEASES"))
        fail(`RELEASES index missing beside installer: ${names.join(", ")}`);
    const nupkg = names.filter((name) => name.endsWith("-full.nupkg"));
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

// Squirrel extracts the nupkg incrementally after Setup.exe returns; wait until every
// required file exists AND the required set's total size has stopped growing so the
// smoke run never races the tail of the extraction.
async function waitForInstallComplete(installRoot, requiredFiles) {
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    let lastTotal = -1;
    while (Date.now() < deadline) {
        let total = 0;
        let allExist = true;
        for (const file of requiredFiles) {
            try {
                total += statSync(file).size;
            }
            catch {
                allExist = false;
            }
        }
        if (allExist && total > 0 && total === lastTotal)
            return;
        lastTotal = allExist ? total : -1;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    fail(`installation never completed under ${installRoot} (required: ${requiredFiles.join(", ")})`);
}

async function main() {
    const installer = findInstallerDir();
    SQUIRREL_DIR = installer.dir;
    assertReleaseSet();
    const setupExe = installer.setupExe;
    console.error(`[installer-e2e] silent install: ${setupExe}`);

    // Squirrel's --silent runs per-user without UI. The Setup.exe may exit while a
    // background installer process finishes, hence the install-root poll below.
    const setupResult = await runChild(setupExe, ["--silent"], { timeoutMs: INSTALL_TIMEOUT_MS });
    if (!setupResult.ok && !existsSync(join(process.env.LOCALAPPDATA ?? "", "sovereignbot", "SovereignBot.exe")))
        fail(`installer failed: ${setupResult.reason ?? `exit ${setupResult.code}`}`);

    const installRoot = join(process.env.LOCALAPPDATA ?? join(tmpdir(), "fallback-localappdata"), "sovereignbot");
    const installedExe = join(installRoot, "SovereignBot.exe");
    console.error(`[installer-e2e] installed at ${installRoot}`);

    await waitForInstallComplete(installRoot, [
        installedExe,
        join(installRoot, "Update.exe"),
        join(installRoot, "resources", "app.asar"),
    ]);

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
