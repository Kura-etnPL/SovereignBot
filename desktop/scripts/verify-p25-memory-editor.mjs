#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(DESKTOP_ROOT, "..", "_evidence_p25_2026-09-03");
const electronBin = join(DESKTOP_ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const electronExe = join(DESKTOP_ROOT, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
if (!existsSync(electronExe)) { console.error("[verify-p25] local Electron binary is missing; refusing to install or download dependencies"); process.exit(2); }
mkdirSync(evidenceDir, { recursive: true });
console.error("[verify-p25] spawning hidden Memory editor gate (timeout 240s)");
const child = spawn(electronBin, ["src/main/verify-p25-memory-editor-entry.js"], { cwd: DESKTOP_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SOVEREIGNBOT_MEMORY_EDITOR_EVIDENCE_DIR: evidenceDir }, shell: process.platform === "win32", windowsHide: true });
let stderr = "";
child.stdout?.on("data", (chunk) => { try { process.stdout.write(chunk); } catch {} });
child.stderr?.on("data", (chunk) => { stderr += chunk; try { process.stderr.write(chunk); } catch {} });
let done = false;
const timer = setTimeout(() => { if (done) return; console.error("[verify-p25] timed out; terminating Electron"); try { child.kill("SIGTERM"); } catch {} }, 240_000);
child.on("exit", (code, signal) => { done = true; clearTimeout(timer); console.error(`[verify-p25] Electron exited code=${code} signal=${signal}`); if ((code ?? 1) !== 0) { console.error(stderr.slice(-6000)); process.exit(code ?? 1); } process.exit(0); });
child.on("error", (error) => { done = true; clearTimeout(timer); console.error(`[verify-p25] spawn failed: ${String(error?.stack ?? error)}`); process.exit(1); });
