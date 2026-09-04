#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 4 * 60_000;
const electronExe = join(DESKTOP_ROOT, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
if (!existsSync(electronExe)) { console.error("[verify-p15] local Electron binary is missing; refusing to install or download dependencies"); process.exit(2); }
console.error(`[verify-p15] spawning hidden Project Command Center gate (timeout ${TIMEOUT_MS / 1000}s)`);
const child = spawn(electronExe, ["src/main/verify-p15-project-command-center-entry.js"], { cwd: DESKTOP_ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env, windowsHide: true });
let stderr = ""; child.stdout?.on("data", (chunk) => { try { process.stdout.write(chunk); } catch {} }); child.stderr?.on("data", (chunk) => { stderr += chunk; try { process.stderr.write(chunk); } catch {} });
let done = false; const timer = setTimeout(() => { if (done) return; console.error("[verify-p15] timed out; terminating Electron"); try { child.kill("SIGTERM"); } catch {} setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000); }, TIMEOUT_MS);
child.on("exit", (code, signal) => { done = true; clearTimeout(timer); console.error(`[verify-p15] Electron exited code=${code} signal=${signal}`); if ((code ?? 1) !== 0) { console.error(stderr.slice(-8000)); process.exit(code ?? 1); } process.exit(0); });
child.on("error", (error) => { done = true; clearTimeout(timer); console.error(`[verify-p15] spawn failed: ${String(error?.stack ?? error)}`); process.exit(1); });
