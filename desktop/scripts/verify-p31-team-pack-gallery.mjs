#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 4 * 60_000;
const electronBin = join(DESKTOP_ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const electronExe = join(DESKTOP_ROOT, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
if (!existsSync(electronExe)) {
  console.error("[verify-p31] local Electron binary is missing; refusing to install or download dependencies");
  process.exit(2);
}

const configuredTempRoot = process.env.SOVEREIGNBOT_TEAM_PACK_TEMP_ROOT;
if (configuredTempRoot) mkdirSync(configuredTempRoot, { recursive: true });
const tempRoot = mkdtempSync(join(configuredTempRoot ?? tmpdir(), "sovereign-p31-"));
const evidenceDir = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(DESKTOP_ROOT, "..", "_evidence_p31_2026-09-03");
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(join(tempRoot, "electron-user-data"), { recursive: true });
const childEnv = { ...process.env, SOVEREIGNBOT_V49_TEMP_ROOT: tempRoot, SOVEREIGNBOT_TEAM_PACK_TEMP_ROOT: tempRoot, SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR: evidenceDir };
delete childEnv.ELECTRON_FORCE_RENDERER_ACCESSIBILITY;
console.error(`[verify-p31] spawning hidden Team Pack gallery gate (timeout ${TIMEOUT_MS / 1000}s)`);
const child = spawn(electronBin, ["--disable-gpu", `--user-data-dir=${join(tempRoot, "electron-user-data")}`, "src/main/verify-p31-team-pack-gallery-entry.js"], {
  cwd: DESKTOP_ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: childEnv,
  shell: process.platform === "win32",
  windowsHide: true,
});
let stderr = "";
child.stdout?.on("data", (chunk) => { try { process.stdout.write(chunk); } catch {} });
child.stderr?.on("data", (chunk) => { stderr += chunk; try { process.stderr.write(chunk); } catch {} });
child.stdout?.on("error", () => {});
child.stderr?.on("error", () => {});
let done = false;
const cleanup = () => { try { rmSync(tempRoot, { recursive: true, force: true }); } catch {} };
const timer = setTimeout(() => {
  if (done) return;
  console.error("[verify-p31] timed out; terminating Electron");
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
}, TIMEOUT_MS);
child.on("exit", (code, signal) => {
  done = true;
  clearTimeout(timer);
  cleanup();
  console.error(`[verify-p31] Electron exited code=${code} signal=${signal}`);
  if ((code ?? 1) !== 0) {
    console.error(stderr.slice(-6000));
    process.exit(code ?? 1);
  }
  process.exit(0);
});
child.on("error", (error) => {
  done = true;
  clearTimeout(timer);
  cleanup();
  console.error(`[verify-p31] spawn failed: ${String(error?.stack ?? error)}`);
  process.exit(1);
});
