#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTROL_ROOT = join(DESKTOP_ROOT, "..", "..", "runtime", "sovereign-control");
const EVIDENCE_DIR = process.env.SOVEREIGNBOT_V45_EVIDENCE_DIR ?? join(CONTROL_ROOT, "v45-worker-node");
const TIMEOUT_MS = 5 * 60_000;
const electronBin = process.platform === "win32"
  ? join(DESKTOP_ROOT, "node_modules", "electron", "dist", "electron.exe")
  : join(DESKTOP_ROOT, "node_modules", ".bin", "electron");
if (!existsSync(electronBin)) {
  console.error("[verify-v45] electron not installed (run `npm ci` in desktop/)");
  process.exit(2);
}

const env = {
  ...process.env,
  SOVEREIGNBOT_V45_EVIDENCE_DIR: EVIDENCE_DIR,
  // CI supplies these exact fake-provider variables. The local default keeps the
  // gate runnable from a clean checkout without enabling a real provider account.
  FAKE_PROVIDER_NODE: process.env.FAKE_PROVIDER_NODE ?? process.execPath,
  FAKE_PROVIDER_DIR: process.env.FAKE_PROVIDER_DIR ?? join(DESKTOP_ROOT, "e2e", "fixtures"),
};

console.error(`[verify-v45] spawning isolated Worker Node gate (timeout ${TIMEOUT_MS / 1000}s)`);
const child = spawn(electronBin, ["src/main/verify-v45-worker-node-entry.js"], {
  cwd: DESKTOP_ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env,
  // Spawn the real Electron executable so its exit code reaches CI exactly;
  // invoking electron.cmd through cmd.exe can collapse app.exit(1) to code 0.
  shell: false,
});
let stderr = "";
child.stdout?.on("data", (chunk) => { try { process.stdout.write(chunk); } catch {} });
child.stderr?.on("data", (chunk) => { stderr += chunk; try { process.stderr.write(chunk); } catch {} });
child.stdout?.on("error", () => {});
child.stderr?.on("error", () => {});
let done = false;
const timer = setTimeout(() => {
  if (done) return;
  console.error("[verify-v45] timed out; terminating Electron");
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
}, TIMEOUT_MS);
child.on("exit", (code, signal) => {
  done = true;
  clearTimeout(timer);
  console.error(`[verify-v45] Electron exited code=${code} signal=${signal}`);
  if ((code ?? 1) !== 0) {
    console.error(stderr.slice(-8000));
    process.exit(code ?? 1);
  }
  process.exit(0);
});
child.on("error", (error) => {
  done = true;
  clearTimeout(timer);
  console.error(`[verify-v45] spawn failed: ${String(error?.stack ?? error)}`);
  process.exit(1);
});
