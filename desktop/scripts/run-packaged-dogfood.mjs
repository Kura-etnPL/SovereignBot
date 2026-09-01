// Runs the actual packaged executable through the same isolated, hidden production
// services used by the dogfood gate. Provider calls are replaced only at the provider
// boundary by the checked-in local fixture; no network or installer is involved.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DESKTOP_ROOT = process.cwd();
const OUT_DIR = join(DESKTOP_ROOT, "out");
const TIMEOUT_MS = 180_000;

function findPackagedExe() {
  const appDir = readdirSync(OUT_DIR, { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name.endsWith("-win32-x64"));
  if (!appDir) throw new Error(`packaged app directory not found under ${OUT_DIR}`);
  const exe = join(OUT_DIR, appDir.name, "SovereignBot.exe");
  if (!existsSync(exe)) throw new Error(`packaged executable not found: ${exe}`);
  return exe;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function main() {
  const exe = findPackagedExe();
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-packaged-dogfood-"));
  const transcriptPath = `${dataDir}-fake-provider-transcript.jsonl`;
  const evidenceDir = `${dataDir}-evidence`;
  const electronUserDataDir = `${dataDir}-electron-userdata`;
  const child = spawn(exe, ["--disable-gpu", `--user-data-dir=${electronUserDataDir}`, "--verify-software-team"], {
    env: {
      ...process.env,
      SOVEREIGNBOT_DESKTOP_SMOKE_DATA_DIR: dataDir,
      SOVEREIGNBOT_DESKTOP_DATA_DIR: dataDir,
      SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR: evidenceDir,
      SOVEREIGNBOT_PRODUCT_RUNTIME_DIR: join(dataDir, "private-runtime"),
      SOVEREIGNBOT_VERIFY_SOFTWARE_TEAM: "1",
      FAKE_PROVIDER_NODE: process.env.FAKE_PROVIDER_NODE ?? join(DESKTOP_ROOT, "resources", "node", "node.exe"),
      FAKE_PROVIDER_DIR: process.env.FAKE_PROVIDER_DIR ?? join(DESKTOP_ROOT, "e2e", "fixtures"),
      FAKE_PROVIDER_TRANSCRIPT: transcriptPath,
      FAKE_PROVIDER_TEAM_CANARY: "1",
      FAKE_PROVIDER_FANOUT_CANARY: "1",
      FAKE_PROVIDER_P1_CANARY: "1",
      FAKE_PROVIDER_INCLUDE_CWD: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error(`packaged dogfood timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolve(code); });
    });
    const jsonLines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
    const result = jsonLines.length ? JSON.parse(jsonLines.at(-1)) : undefined;
    if (exitCode !== 0 || !result?.checks) throw new Error(`packaged dogfood failed: exit=${exitCode} stderr=${stderr.slice(-2000)}`);
    const checks = Object.fromEntries(Object.entries(result.checks).map(([name, value]) => [name, value?.ok === true]));
    if (Object.values(checks).some((value) => value !== true)) throw new Error(`packaged dogfood checks failed: ${JSON.stringify(checks)}`);
    const artifacts = {};
    for (const file of readdirSync(evidenceDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".png"))) {
      const bytes = await readFile(join(evidenceDir, file.name));
      artifacts[file.name] = { sha256: sha256(bytes), bytes: bytes.length };
    }
    if (Object.keys(artifacts).length < 3) throw new Error("packaged dogfood did not produce the expected redacted screenshots");
    console.log(JSON.stringify({ dogfood: "ok", fixtureBoundary: "LOCAL_FIXTURE", checks, artifactHashes: artifacts }));
  }
  finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await rm(evidenceDir, { recursive: true, force: true }).catch(() => {});
    await rm(electronUserDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(transcriptPath, { force: true }).catch(() => {});
  }
}

main().catch((error) => { console.error(String(error?.message ?? error)); process.exit(1); });
