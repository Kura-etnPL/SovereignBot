// Installer end-to-end: silently installs the Squirrel Setup.exe produced by
// `electron-forge make`, asserts the installed tree, then runs the INSTALLED executable
// in --desktop-smoke mode against a temp data dir and requires the machine-readable ok.
// This proves the shipping artifact — not merely the developer packaging output — boots,
// verifies its vendored Core, and drives the governed runtime.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
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

function runChild(command, args, { timeoutMs, onData, env }) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { shell: false, windowsHide: true, env: { ...process.env, ...env } });
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

// Classic Squirrel layout: the install root holds Update.exe plus an app-<version>/
// directory containing the actual application tree. Wait for that directory to appear
// AND its key files to reach a stable total size before launching smoke.
async function waitForInstalledApp(installRoot) {
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    let lastTotal = -1;
    let lastAppDir;
    while (Date.now() < deadline) {
        try {
            const entries = readdirSync(installRoot, { withFileTypes: true });
            const appDirs = entries.filter((entry) => entry.isDirectory() && /^app-.+$/.test(entry.name)
                && existsSync(join(installRoot, entry.name, "SovereignBot.exe")));
            if (appDirs.length === 1) {
                const appDir = join(installRoot, appDirs[0].name);
                const required = [
                    join(appDir, "SovereignBot.exe"),
                    join(appDir, "resources", "app.asar"),
                    join(installRoot, "Update.exe"),
                ];
                let total = 0;
                let complete = true;
                for (const file of required) {
                    try {
                        total += statSync(file).size;
                    }
                    catch {
                        complete = false;
                    }
                }
                if (complete && total > 0 && total === lastTotal && appDir === lastAppDir)
                    return { appDir, exe: join(appDir, "SovereignBot.exe") };
                lastTotal = total;
                lastAppDir = appDir;
            }
            else {
                lastTotal = -1;
                lastAppDir = undefined;
            }
        }
        catch {
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    fail(`installation never completed under ${installRoot}. installed tree: ${dumpTree(installRoot).slice(0, 2000)}`);
}

async function main() {
    const installer = findInstallerDir();
    SQUIRREL_DIR = installer.dir;
    assertReleaseSet();
    const setupExe = installer.setupExe;
    const hostInstallRoot = join(process.env.LOCALAPPDATA ?? "", "sovereignbot");
    // Squirrel Setup.exe resolves SpecialFolder.LocalApplicationData internally; merely
    // overriding the child environment is not a reliable isolation boundary on Windows.
    // Refuse to touch a host install unless an external disposable Windows profile has
    // explicitly proven that special-folder resolution is redirected.
    if (existsSync(hostInstallRoot) || process.env.SOVEREIGNBOT_ALLOW_HOST_SQUIRREL_INSTALL !== "1")
        fail(`SKIP: Squirrel Setup.exe cannot be proven isolated from ${hostInstallRoot}; use a disposable Windows profile and set SOVEREIGNBOT_ALLOW_HOST_SQUIRREL_INSTALL=1 only for that profile`);
    await mkdir(join(DESKTOP_ROOT, "temp"), { recursive: true });
    const isolatedRoot = await mkdtemp(join(DESKTOP_ROOT, "temp", "p6-installer-e2e-"));
    const isolatedLocalAppData = join(isolatedRoot, "LOCALAPPDATA");
    const isolatedDataDir = join(isolatedRoot, "product-data");
    await mkdir(isolatedLocalAppData, { recursive: true });
    const isolatedEnv = { LOCALAPPDATA: isolatedLocalAppData, SOVEREIGNBOT_DESKTOP_DATA_DIR: isolatedDataDir };
    console.error(`[installer-e2e] silent install: ${setupExe}`);

    // Squirrel's --silent runs per-user without UI. The Setup.exe may exit while a
    // background installer process finishes, hence the install-root poll below.
    const setupResult = await runChild(setupExe, ["--silent"], { timeoutMs: INSTALL_TIMEOUT_MS, env: isolatedEnv });
    if (!setupResult.ok && !existsSync(join(isolatedLocalAppData, "sovereignbot", "SovereignBot.exe")))
        fail(`installer failed: ${setupResult.reason ?? `exit ${setupResult.code}`}`);

    const installRoot = join(isolatedLocalAppData, "sovereignbot");
    const { appDir, exe: installedExe } = await waitForInstalledApp(installRoot);
    console.error(`[installer-e2e] installed app at ${appDir}`);

    const smokeDataDir = join(isolatedRoot, "smoke-data");
    await mkdir(smokeDataDir, { recursive: true });
    let smokeJson;
    try {
        const result = await runChild(installedExe, ["--desktop-smoke"], {
            timeoutMs: SMOKE_TIMEOUT_MS,
            env: { ...isolatedEnv, SOVEREIGNBOT_DESKTOP_SMOKE_DATA_DIR: smokeDataDir },
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

    // The installed binary, not a developer process, owns this migration canary. A
    // marker-less fixture is the supported V3 shape; the first run must create a backup
    // before committing V4, and the second run must be idempotent.
    const migrationDataDir = join(isolatedRoot, "migration-data");
    await mkdir(join(migrationDataDir, "desktop-state"), { recursive: true });
    await writeFile(join(migrationDataDir, "desktop-state", "settings.json"), JSON.stringify({ schema: "sovereignbot.desktop.settings.v1", theme: "system", language: "en" }));
    const migrationEnv = { ...isolatedEnv, SOVEREIGNBOT_DESKTOP_DATA_DIR: migrationDataDir };
    const migration = await runChild(installedExe, ["--desktop-migration-check"], { timeoutMs: SMOKE_TIMEOUT_MS, env: migrationEnv });
    const migrationLines = migration.stdout.split(/\r?\n/).filter((line) => line.startsWith("{"));
    if (migration.code !== 0 || !migrationLines.length || JSON.parse(migrationLines.at(-1)).migration !== "ok") fail(`installed V3→V4 migration failed: ${migration.stdout}`);
    const marker = JSON.parse(await readFile(join(migrationDataDir, "desktop-state", "lifecycle.json"), "utf8"));
    if (marker.stateVersion !== 4 || !marker.backupId || !existsSync(join(`${migrationDataDir}.backups`, marker.backupId, "manifest.json"))) fail("migration did not leave a pre-migration backup");
    const secondMigration = await runChild(installedExe, ["--desktop-migration-check"], { timeoutMs: SMOKE_TIMEOUT_MS, env: migrationEnv });
    if (secondMigration.code !== 0) fail(`migration restart resume failed: ${secondMigration.stdout}`);

    // Re-running the same local Setup.exe proves the upgrade path without touching the
    // user's real LOCALAPPDATA or product state.
    const upgrade = await runChild(setupExe, ["--silent"], { timeoutMs: INSTALL_TIMEOUT_MS, env: isolatedEnv });
    if (!upgrade.ok && upgrade.code !== 0) fail(`isolated upgrade failed: ${upgrade.reason ?? upgrade.code}`);

    const rollbackDataDir = join(isolatedRoot, "rollback-data");
    const rollback = await runChild(installedExe, ["--desktop-migration-check"], { timeoutMs: SMOKE_TIMEOUT_MS, env: { ...isolatedEnv, SOVEREIGNBOT_DESKTOP_DATA_DIR: rollbackDataDir, SOVEREIGNBOT_INJECT_MIGRATION_FAILURE: "1" } });
    if (rollback.code === 0 || !existsSync(join(rollbackDataDir, "desktop-state", "attention.json")) || existsSync(join(rollbackDataDir, "desktop-state", "lifecycle.json"))) fail("injected migration failure did not preserve the V3 marker and record Attention");

    const pkg = JSON.parse(readFileSync(join(DESKTOP_ROOT, "package.json"), "utf8"));
    console.log(JSON.stringify({
        installerE2e: "ok",
        setupExe: setupExe.split("\\").pop(),
        appDir,
        version: pkg.version,
        smokeChecks: smokeJson.checks,
        isolatedLocalAppData,
        migration: "v3-fixture-backup-restart-rollback-ok",
    }));
    await rm(isolatedRoot, { recursive: true, force: true });
}

main().catch((error) => fail(String(error?.stack ?? error)));
