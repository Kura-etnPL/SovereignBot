#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 4 * 60_000;
const electronExe = join(DESKTOP_ROOT, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
if (!existsSync(electronExe)) {
  console.error("[verify-p11] local Electron binary is missing; refusing to install or download dependencies");
  process.exit(2);
}

const configuredTempRoot = process.env.SOVEREIGNBOT_TEAM_PACK_TEMP_ROOT;
if (configuredTempRoot) mkdirSync(configuredTempRoot, { recursive: true });
const tempRoot = mkdtempSync(join(configuredTempRoot ?? tmpdir(), "sovereign-p11-"));
mkdirSync(join(tempRoot, "electron-user-data"), { recursive: true });
console.error(`[verify-p11] spawning hidden Team Pack gate (timeout ${TIMEOUT_MS / 1000}s)`);
const child = spawn(electronExe, [`--user-data-dir=${join(tempRoot, "electron-user-data")}`, "src/main/verify-p11-team-packs-entry.js"], {
  cwd: DESKTOP_ROOT,
  stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SOVEREIGNBOT_V49_TEMP_ROOT: tempRoot, SOVEREIGNBOT_TEAM_PACK_TEMP_ROOT: tempRoot, SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR: join(DESKTOP_ROOT, "..", "_evidence_v20_2026-09-03") },
  shell: false,
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
  console.error("[verify-p11] timed out; terminating Electron");
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
}, TIMEOUT_MS);
child.on("exit", (code, signal) => {
  done = true;
  clearTimeout(timer);
  cleanup();
  console.error(`[verify-p11] Electron exited code=${code} signal=${signal}`);
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
  console.error(`[verify-p11] spawn failed: ${String(error?.stack ?? error)}`);
  process.exit(1);
});
