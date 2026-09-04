#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = 4 * 60_000;
const electronExe = join(desktopRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
if (!existsSync(electronExe)) {
  console.error("[verify-p36] local Electron binary is missing; refusing to install or download dependencies");
  process.exit(2);
}
const tempRoot = mkdtempSync(join(tmpdir(), "sovereign-p36-"));
const evidenceDir = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(desktopRoot, "..", "docs", "acceptance");
mkdirSync(evidenceDir, { recursive: true });
console.error(`[verify-p36] spawning hidden first-run gate (timeout ${timeoutMs / 1000}s)`);
const child = spawn(electronExe, ["--disable-gpu", "--user-data-dir=" + join(tempRoot, "electron-user-data"), "src/main/verify-p36-first-run-entry.js"], {
  cwd: desktopRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR: evidenceDir },
  windowsHide: true,
});
let stderr = "";
child.stdout?.on("data", (chunk) => { try { process.stdout.write(chunk); } catch {} });
child.stderr?.on("data", (chunk) => { stderr += chunk; try { process.stderr.write(chunk); } catch {} });
let done = false;
const cleanup = () => { try { rmSync(tempRoot, { recursive: true, force: true }); } catch {} };
const timer = setTimeout(() => {
  if (done) return;
  console.error("[verify-p36] timed out; terminating Electron");
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
}, timeoutMs);
child.on("exit", (code, signal) => {
  done = true;
  clearTimeout(timer);
  cleanup();
  console.error(`[verify-p36] Electron exited code=${code} signal=${signal}`);
  if ((code ?? 1) !== 0) console.error(stderr.slice(-8000));
  process.exit((code ?? 1) === 0 ? 0 : (code ?? 1));
});
child.on("error", (error) => {
  done = true;
  clearTimeout(timer);
  cleanup();
  console.error(`[verify-p36] spawn failed: ${String(error?.stack ?? error)}`);
  process.exit(1);
});
