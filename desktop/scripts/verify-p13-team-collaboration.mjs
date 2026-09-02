#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = join(fileURLToPath(new URL("../", import.meta.url)));
const TIMEOUT_MS = 4 * 60_000;
const electronExe = join(DESKTOP_ROOT, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
if (!existsSync(electronExe)) {
    console.error("[verify-p13] local Electron binary is missing; refusing to install or download dependencies");
    process.exit(2);
}
const tempRoot = mkdtempSync(join(tmpdir(), "sovereign-p13-"));
mkdirSync(join(tempRoot, "electron-user-data"), { recursive: true });
console.error(`[verify-p13] spawning hidden Team collaboration gate (timeout ${TIMEOUT_MS / 1000}s)`);
const child = spawn(electronExe, [`--user-data-dir=${join(tempRoot, "electron-user-data")}`, "src/main/verify-p13-team-collaboration-entry.js"], {
    cwd: DESKTOP_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SOVEREIGNBOT_V51_TEMP_ROOT: tempRoot },
    shell: false,
    windowsHide: true,
});
let stderr = "";
child.stdout?.on("data", (chunk) => { try { process.stdout.write(chunk); } catch {} });
child.stderr?.on("data", (chunk) => { stderr += chunk; try { process.stderr.write(chunk); } catch {} });
child.stdout?.on("error", () => {}); child.stderr?.on("error", () => {});
let done = false;
const cleanup = () => { try { rmSync(tempRoot, { recursive: true, force: true }); } catch {} };
const timer = setTimeout(() => {
    if (done) return;
    console.error("[verify-p13] timed out; terminating Electron");
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
}, TIMEOUT_MS);
child.on("exit", (code, signal) => {
    done = true; clearTimeout(timer); cleanup(); console.error(`[verify-p13] Electron exited code=${code} signal=${signal}`);
    if ((code ?? 1) !== 0) { console.error(stderr.slice(-6000)); process.exit(code ?? 1); }
    process.exit(0);
});
child.on("error", (error) => { done = true; clearTimeout(timer); cleanup(); console.error(`[verify-p13] spawn failed: ${String(error?.stack ?? error)}`); process.exit(1); });
