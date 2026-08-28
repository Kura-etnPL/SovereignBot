#!/usr/bin/env node
// Launcher for the verify-gate harness — run from worktree root:
//   node desktop/scripts/verify-v41-gate.mjs          # spawns Electron --verify-gate (12 min timeout)
//   node desktop/scripts/verify-v41-gate.mjs --quick  # shorter timeout for iteration/CI
import { spawn, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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
let fatalStartup = false;
let forcedTermination = false;

function terminateTree(reason) {
  if (done || forcedTermination) return;
  forcedTermination = true;
  console.error(`[verify-launcher] ${reason} — terminating Electron process tree`);
  if (process.platform === "win32" && child.pid) {
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {}
  }
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref?.();
}

child.stderr?.on("data", d => {
  const text = String(d);
  try { process.stderr.write(d); } catch {}
  // In verify mode an app-level startup failure is terminal. The normal app intentionally
  // shows an error dialog, but a headless CI runner cannot dismiss it, so fail fast here
  // instead of burning the entire watchdog timeout.
  if (!fatalStartup && text.includes("[sovereignbot] failed to start:")) {
    fatalStartup = true;
    terminateTree("detected verify-gate startup failure");
  }
});
child.stderr?.on("error", () => {}); // verify-gate launcher stderr: swallow EPIPE
const timer = setTimeout(() => {
  if (done) return;
  terminateTree(`timed out after ${TIMEOUT_MS/1000}s`);
}, TIMEOUT_MS);

child.on("exit", (code, signal) => {
  done = true;
  clearTimeout(timer);
  console.error(`[verify-launcher] Electron exited code=${code} signal=${signal}`);
  process.exit(fatalStartup ? 1 : (code ?? (signal ? 1 : 0)));
});
child.on("error", (err) => {
  done = true;
  clearTimeout(timer);
  console.error(`[verify-launcher] spawn error: ${String(err?.stack ?? err)}`);
  process.exit(1);
});
