#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronExe = join(desktopRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
if (!existsSync(electronExe)) { console.error("[verify-p39] local Electron binary is missing; refusing to install or download dependencies"); process.exit(2); }
const tempRoot = mkdtempSync(join(tmpdir(), "sovereign-p39-"));
const evidenceDir = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(desktopRoot, "..", "docs", "acceptance");
mkdirSync(evidenceDir, { recursive: true });
// Keep the host's forced accessibility debugging out of this large-DOM hidden gate.
const childEnv = { ...process.env, SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR: evidenceDir };
delete childEnv.ELECTRON_FORCE_RENDERER_ACCESSIBILITY;
const child = spawn(electronExe, ["--disable-gpu", "--user-data-dir=" + join(tempRoot, "electron-user-data"), "src/main/verify-p39-conversation-pagination-entry.js"], { cwd: desktopRoot, stdio: ["ignore", "pipe", "pipe"], env: childEnv, windowsHide: true });
let stderr = "";
child.stdout?.on("data", (chunk) => { try { process.stdout.write(chunk); } catch {} });
child.stderr?.on("data", (chunk) => { stderr += chunk; try { process.stderr.write(chunk); } catch {} });
let done = false;
const cleanup = () => { try { rmSync(tempRoot, { recursive: true, force: true }); } catch {} };
const timer = setTimeout(() => { if (done) return; console.error("[verify-p39] timed out; terminating Electron"); try { child.kill("SIGTERM"); } catch {} }, 4 * 60_000);
child.on("exit", (code, signal) => { done = true; clearTimeout(timer); cleanup(); console.error(`[verify-p39] Electron exited code=${code} signal=${signal}`); if ((code ?? 1) !== 0) console.error(stderr.slice(-8000)); process.exit((code ?? 1) === 0 ? 0 : (code ?? 1)); });
child.on("error", (error) => { done = true; clearTimeout(timer); cleanup(); console.error(`[verify-p39] spawn failed: ${String(error?.stack ?? error)}`); process.exit(1); });
