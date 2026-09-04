#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = join(fileURLToPath(new URL("../", import.meta.url)));
const CONTROL_ROOT = join(DESKTOP_ROOT, "..", "..", "..", "runtime", "sovereign-control", "live-codex-dogfood");
const EVIDENCE_DIR = join(CONTROL_ROOT, "evidence");
const PRIVATE_RUNTIME_DIR = join(CONTROL_ROOT, "private-runtime");
const DATA_DIR = join(PRIVATE_RUNTIME_DIR, "desktop-data");
const ELECTRON_USER_DATA_DIR = join(PRIVATE_RUNTIME_DIR, "electron-user-data");
const ELECTRON = process.platform === "win32"
    ? join(DESKTOP_ROOT, "node_modules", "electron", "dist", "electron.exe")
    : join(DESKTOP_ROOT, "node_modules", ".bin", "electron");
const TIMEOUT_MS = 360_000;
const ELECTRON_ARGS = process.env.SOVEREIGNBOT_ELECTRON_DISABLE_GPU === "1" ? ["--disable-gpu"] : [];

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(DATA_DIR, { recursive: true, force: true });
await rm(ELECTRON_USER_DATA_DIR, { recursive: true, force: true });

if (!existsSync(ELECTRON)) throw new Error(`Electron binary missing: ${ELECTRON}`);

const env = {
    ...process.env,
    SOVEREIGNBOT_DESKTOP_DATA_DIR: DATA_DIR,
    SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR: EVIDENCE_DIR,
};

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
    process.exit(code ?? 0);
});
