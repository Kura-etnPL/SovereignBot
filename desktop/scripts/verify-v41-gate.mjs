#!/usr/bin/env node
// Launcher for the verify-gate harness — run from worktree root:
//   node desktop/scripts/verify-v41-gate.mjs          # spawns Electron --verify-gate (15 min timeout)
//   node desktop/scripts/verify-v41-gate.mjs --quick  # shorter timeout for iteration
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKTREE_ROOT = join(DESKTOP_ROOT, "..");
const quick = process.argv.includes("--quick");
const TIMEOUT_MS = quick ? 3 * 60_000 : 12 * 60_000;

// Resolve electron binary (same as smoke harness)
import { existsSync } from "node:fs";
const electronBin = join(DESKTOP_ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
if (!existsSync(join(DESKTOP_ROOT, "node_modules", "electron", "package.json"))) {
  console.error("[verify-launcher] electron not installed (run `npm install` in desktop/)");
  process.exit(2);
}

console.error(`[verify-launcher] spawning Electron --verify-gate (timeout ${TIMEOUT_MS/1000}s)`);
const child = spawn(electronBin, [".", "--verify-gate"], {
  cwd: DESKTOP_ROOT,
  stdio: ["inherit","inherit","pipe"],
  env: process.env,
  shell: process.platform === "win32",
});

let done = false;
child.stderr?.on("data", d => { try { process.stderr.write(d); } catch {} });
child.stderr?.on("error", () => {}); // verify-gate launcher stderr: swallow EPIPE
const timer = setTimeout(() => {
  if (done) return;
  console.error(`[verify-launcher] timed out after ${TIMEOUT_MS/1000}s — killing Electron`);
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
}, TIMEOUT_MS);

child.on("exit", (code, signal) => {
  done = true;
  clearTimeout(timer);
  console.error(`[verify-launcher] Electron exited code=${code} signal=${signal}`);
  process.exit(code ?? (signal ? 1 : 0));
});
child.on("error", (err) => {
  done = true;
  clearTimeout(timer);
  console.error(`[verify-launcher] spawn error: ${String(err?.stack ?? err)}`);
  process.exit(1);
});
