#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 2 * 60_000;
const electronBin = join(DESKTOP_ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
if (!existsSync(join(DESKTOP_ROOT, "node_modules", "electron", "package.json"))) {
  console.error("[verify-v42] electron not installed (run `npm ci` in desktop/)");
  process.exit(2);
}

console.error(`[verify-v42] spawning isolated Routine gate (timeout ${TIMEOUT_MS/1000}s)`);
const child = spawn(electronBin, ["src/main/verify-routines-entry.js"], {
  cwd: DESKTOP_ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
  shell: process.platform === "win32",
});
let stdout = "";
let stderr = "";
child.stdout?.on("data", (chunk) => { stdout += chunk; try { process.stdout.write(chunk); } catch {} });
child.stderr?.on("data", (chunk) => { stderr += chunk; try { process.stderr.write(chunk); } catch {} });
child.stdout?.on("error", () => {});
child.stderr?.on("error", () => {});
let done = false;
const timer = setTimeout(() => {
  if (done) return;
  console.error("[verify-v42] timed out; terminating Electron");
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
}, TIMEOUT_MS);
child.on("exit", (code, signal) => {
  done = true;
  clearTimeout(timer);
  console.error(`[verify-v42] Electron exited code=${code} signal=${signal}`);
  if ((code ?? 1) !== 0) {
    console.error(stderr.slice(-4000));
    process.exit(code ?? 1);
  }
  process.exit(0);
});
child.on("error", (error) => {
  done = true;
  clearTimeout(timer);
  console.error(`[verify-v42] spawn failed: ${String(error?.stack ?? error)}`);
  process.exit(1);
});
