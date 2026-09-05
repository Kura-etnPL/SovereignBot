#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = join(fileURLToPath(new URL("../", import.meta.url)));
const TEMP_ROOT = join(DESKTOP_ROOT, "..", "temp");
await mkdir(TEMP_ROOT, { recursive: true });
const resumeAt = process.argv.indexOf("--resume-run");
const CONTROL_ROOT = resumeAt < 0 ? await mkdtemp(join(TEMP_ROOT, "live-luna-")) : resolve(process.argv[resumeAt + 1] ?? "");
if (!CONTROL_ROOT.startsWith(resolve(TEMP_ROOT) + sep) || !basename(CONTROL_ROOT).startsWith("live-luna-")) throw new Error("Live run must stay inside the project test directory");
const EVIDENCE_DIR = join(CONTROL_ROOT, "evidence");
const PRIVATE_RUNTIME_DIR = join(CONTROL_ROOT, "private-runtime");
const DATA_DIR = join(PRIVATE_RUNTIME_DIR, "desktop-data");
const inspectInterrupted = process.argv.includes("--inspect-interrupted");
const redirectRecovered = process.argv.includes("--redirect-recovered");
if (redirectRecovered && !inspectInterrupted) throw new Error("Recovered redirect requires interrupted inspection");
if (inspectInterrupted && resumeAt < 0) throw new Error("Interrupted inspection requires an existing run");
const priorTasks = inspectInterrupted ? JSON.parse(readFileSync(join(DATA_DIR, "tasks.json"), "utf8")) : undefined;
const ELECTRON_USER_DATA_DIR = join(PRIVATE_RUNTIME_DIR, "electron-user-data");
const ELECTRON = process.platform === "win32"
    ? join(DESKTOP_ROOT, "node_modules", "electron", "dist", "electron.exe")
    : join(DESKTOP_ROOT, "node_modules", ".bin", "electron");
const TIMEOUT_MS = 600_000;
const ELECTRON_ARGS = process.env.SOVEREIGNBOT_ELECTRON_DISABLE_GPU === "1" ? ["--disable-gpu"] : [];

await mkdir(EVIDENCE_DIR, { recursive: true });
await mkdir(DATA_DIR, { recursive: true });
await mkdir(ELECTRON_USER_DATA_DIR, { recursive: true });

if (!existsSync(ELECTRON)) throw new Error(`Electron binary missing: ${ELECTRON}`);

const env = {
    ...process.env,
    SOVEREIGNBOT_DESKTOP_DATA_DIR: DATA_DIR,
    SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR: EVIDENCE_DIR,
    SOVEREIGNBOT_LIVE_LUNA_ONLY: "1",
    SOVEREIGNBOT_LIVE_RESTART_CHECK: resumeAt >= 0 ? "1" : "0",
    SOVEREIGNBOT_INSPECT_INTERRUPTED: inspectInterrupted ? "1" : "0",
    SOVEREIGNBOT_REDIRECT_RECOVERED: redirectRecovered ? "1" : "0",
    SOVEREIGNBOT_EXPECTED_TASK_COUNT: inspectInterrupted ? String((Array.isArray(priorTasks) ? priorTasks : priorTasks.tasks).length) : "",
};
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith("FAKE_PROVIDER")) delete env[key];

console.error(`[live-codex-dogfood] Spawning production Electron with real Codex provider (${TIMEOUT_MS / 1000}s timeout)...`);
console.error(`[live-codex-dogfood] Evidence directory: ${EVIDENCE_DIR}`);

const child = spawn(ELECTRON, [...ELECTRON_ARGS, `--user-data-dir=${ELECTRON_USER_DATA_DIR}`, "src/main/index.js", "--live-codex-dogfood"], {
    cwd: DESKTOP_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: false,
});

let stdout = "";
let stderr = "";
child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
    process.stdout.write(chunk);
});
child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    process.stderr.write(chunk);
});

const timer = setTimeout(() => {
    console.error(`[live-codex-dogfood] Process timed out after ${TIMEOUT_MS / 1000}s`);
    try { child.kill(); } catch {}
}, TIMEOUT_MS);

child.on("close", (code) => {
    clearTimeout(timer);
    console.error(`[live-codex-dogfood] Electron process exited with code ${code}`);
    let gate;
    for (const line of stdout.split(/\r?\n/)) { try { const value = JSON.parse(line); if (value.schema === "sovereignbot.desktop.live-codex-dogfood.v1") gate = value; } catch {} }
    process.exit(code === 0 && gate && Object.values(gate.checks ?? {}).every(check => check.ok === true) ? 0 : 1);
});
