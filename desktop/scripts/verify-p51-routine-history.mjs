#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = 4 * 60_000;
const electronBin = join(desktopRoot, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const electronExe = join(desktopRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
if (!existsSync(electronExe)) { console.error("[verify-p51] local Electron binary is missing; refusing to install or download dependencies"); process.exit(2); }
const configuredTempRoot = process.env.SOVEREIGNBOT_ROUTINE_HISTORY_TEMP_ROOT;
if (configuredTempRoot) mkdirSync(configuredTempRoot, { recursive: true });
const tempRoot = mkdtempSync(join(configuredTempRoot ?? tmpdir(), "sovereign-p51-"));
const evidenceDir = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(desktopRoot, "..", "docs", "acceptance");
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(join(tempRoot, "electron-user-data"), { recursive: true });
console.error(`[verify-p51] spawning hidden Routine History gate (timeout ${timeoutMs / 1000}s)`);
const child = spawn(electronBin, ["--disable-gpu", "--user-data-dir=" + join(tempRoot, "electron-user-data"), "src/main/verify-p51-routine-history-entry.js"], { cwd: desktopRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR: evidenceDir }, shell: process.platform === "win32", windowsHide: true });
let stderr = "";
child.stdout?.on("data", (chunk) => { try { process.stdout.write(chunk); } catch {} });
child.stderr?.on("data", (chunk) => { stderr += chunk; try { process.stderr.write(chunk); } catch {} });
let done = false;
const cleanup = () => { try { rmSync(tempRoot, { recursive: true, force: true }); } catch {} };
const timer = setTimeout(() => { if (done) return; console.error("[verify-p51] timed out; terminating Electron"); try { child.kill("SIGTERM"); } catch {} setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000); }, timeoutMs);
child.on("exit", (code, signal) => { done = true; clearTimeout(timer); cleanup(); console.error(`[verify-p51] Electron exited code=${code} signal=${signal}`); if ((code ?? 1) !== 0) { console.error(stderr.slice(-8000)); process.exit(code ?? 1); } process.exit(0); });
child.on("error", (error) => { done = true; clearTimeout(timer); cleanup(); console.error(`[verify-p51] spawn failed: ${String(error?.stack ?? error)}`); process.exit(1); });
