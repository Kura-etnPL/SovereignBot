#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 4 * 60_000;
const electronExe = join(DESKTOP_ROOT, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
if (!existsSync(electronExe)) { console.error("[verify-p33] local Electron binary is missing; refusing to install or download dependencies"); process.exit(2); }
const tempRoot = mkdtempSync(join(tmpdir(), "sovereign-p33-"));
const evidenceDir = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(DESKTOP_ROOT, "..", "_evidence_p33_2026-09-03");
mkdirSync(evidenceDir, { recursive: true });
console.error(`[verify-p33] spawning hidden Search/Command Palette gate (timeout ${TIMEOUT_MS / 1000}s)`);
const child = spawn(electronExe, ["--disable-gpu", "--user-data-dir=" + join(tempRoot, "electron-user-data"), "src/main/verify-p33-search-palette-entry.js"], { cwd: DESKTOP_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR: evidenceDir }, shell: false, windowsHide: true });
let stderr = "";
child.stdout?.on("data", (chunk) => { try { process.stdout.write(chunk); } catch {} });
child.stderr?.on("data", (chunk) => { stderr += chunk; try { process.stderr.write(chunk); } catch {} });
let done = false;
const cleanup = () => { try { rmSync(tempRoot, { recursive: true, force: true }); } catch {} };
const timer = setTimeout(() => { if (done) return; console.error("[verify-p33] timed out; terminating Electron"); try { child.kill("SIGTERM"); } catch {} setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000); }, TIMEOUT_MS);
child.on("exit", (code, signal) => { done = true; clearTimeout(timer); cleanup(); console.error(`[verify-p33] Electron exited code=${code} signal=${signal}`); if ((code ?? 1) !== 0) console.error(stderr.slice(-8000)); process.exit((code ?? 1) === 0 ? 0 : (code ?? 1)); });
child.on("error", (error) => { done = true; clearTimeout(timer); cleanup(); console.error(`[verify-p33] spawn failed: ${String(error?.stack ?? error)}`); process.exit(1); });
