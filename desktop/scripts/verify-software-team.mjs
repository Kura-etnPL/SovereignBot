#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = join(fileURLToPath(new URL("../", import.meta.url)));
const CONTROL_ROOT = join(DESKTOP_ROOT, "..", "..", "..", "runtime", "sovereign-control");
const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(CONTROL_ROOT, "v45-software-team");
const RUN_DIR = join(EVIDENCE_DIR, "run");
// Task persistence includes private provider continuity needed for safe resume. Keep it
// outside the public evidence directory; only redacted screenshots/diagnostics belong there.
const PRIVATE_RUNTIME_DIR = process.env.SOVEREIGNBOT_PRODUCT_RUNTIME_DIR ?? join(CONTROL_ROOT, "v45-software-team-private-runtime");
const DATA_DIR = process.env.SOVEREIGNBOT_DESKTOP_DATA_DIR ?? join(PRIVATE_RUNTIME_DIR, "desktop-data");
const ELECTRON_USER_DATA_DIR = process.env.SOVEREIGNBOT_ELECTRON_USER_DATA_DIR ?? join(PRIVATE_RUNTIME_DIR, "electron-user-data");
const TRANSCRIPT = join(RUN_DIR, "fake-provider-transcript.jsonl");
const ELECTRON = process.platform === "win32"
    ? join(DESKTOP_ROOT, "node_modules", "electron", "dist", "electron.exe")
    : join(DESKTOP_ROOT, "node_modules", ".bin", "electron");
const INTERNAL_NODE = join(DESKTOP_ROOT, "resources", "node", "node.exe");
const FAKE_DIR = join(DESKTOP_ROOT, "e2e", "fixtures");
const TIMEOUT_MS = 180_000;
const ELECTRON_ARGS = process.env.SOVEREIGNBOT_ELECTRON_DISABLE_GPU === "1" ? ["--disable-gpu"] : [];

await mkdir(RUN_DIR, { recursive: true });
await rm(DATA_DIR, { recursive: true, force: true });
await rm(TRANSCRIPT, { force: true });
if (!existsSync(ELECTRON)) throw new Error(`Electron binary missing: ${ELECTRON}`);
if (!existsSync(INTERNAL_NODE)) throw new Error(`internal Node binary missing: ${INTERNAL_NODE}`);

const env = {
    ...process.env,
    SOVEREIGNBOT_DESKTOP_DATA_DIR: DATA_DIR,
    SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR: EVIDENCE_DIR,
    FAKE_PROVIDER_NODE: INTERNAL_NODE,
    FAKE_PROVIDER_DIR: FAKE_DIR,
    FAKE_PROVIDER_TRANSCRIPT: TRANSCRIPT,
    FAKE_PROVIDER_TEAM_CANARY: "1",
    FAKE_PROVIDER_INCLUDE_CWD: "0",
};
for (const key of Object.keys(env)) {
    if (/^(OPENAI|ANTHROPIC|AZURE|AWS|GITHUB|GH)_.*/i.test(key) || /(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|COOKIE|PRIVATE_KEY)/i.test(key))
        delete env[key];
}
// Keep host automation flags out of the product canary environment; they are not
// part of the SovereignBot renderer contract.
delete env.ELECTRON_FORCE_RENDERER_ACCESSIBILITY;

console.error(`[software-team] spawning production Electron canary (${TIMEOUT_MS / 1000}s)`);
const child = spawn(ELECTRON, [...ELECTRON_ARGS, `--user-data-dir=${ELECTRON_USER_DATA_DIR}`, "src/main/index.js", "--verify-software-team"], {
    cwd: DESKTOP_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
});
let stdout = "";
let stderr = "";
child.stdout?.on("data", (chunk) => { stdout += String(chunk); process.stdout.write(chunk); });
child.stderr?.on("data", (chunk) => { stderr += String(chunk); process.stderr.write(chunk); });
const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3_000);
        reject(new Error(`software team canary timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code ?? 1); });
});

const jsonLines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
const result = jsonLines.length ? JSON.parse(jsonLines.at(-1)) : { ok: false, error: "no JSON result", stdout: stdout.slice(-4_000) };
if (stderr.trim()) console.error(`[software-team] stderr tail:\n${stderr.slice(-2_000)}`);
console.log(JSON.stringify({ ok: Boolean(result.ok), checks: result.checks, screenshots: result.screenshots }));
if (exitCode !== 0 || !result.ok)
    process.exit(1);
