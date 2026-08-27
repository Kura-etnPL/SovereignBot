#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, freemem, hostname, platform, release, totalmem, uptime } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.SOVEREIGN_CONTROL_REPO || "Kura-etnPL/SovereignBot-Control";
const ISSUE = Number(process.env.SOVEREIGN_CONTROL_ISSUE || "1");
const AUTHOR = process.env.SOVEREIGN_CONTROL_AUTHOR || "Kura-etnPL";
const POLL_MS = Math.max(3000, Math.min(Number(process.env.SOVEREIGN_CONTROL_POLL_MS || "5000"), 60000));
const PROJECT = process.env.SOVEREIGNBOT_PROJECT || "E:\\Eternal\\Auto_Empire\\projects\\SovereignBot";
const STATE_DIR = process.env.SOVEREIGN_CONTROL_STATE_DIR || "E:\\Eternal\\Auto_Empire\\runtime\\sovereign-control";
const LIVE_WORKTREE = process.env.SOVEREIGNBOT_LIVE_WORKTREE || "E:\\Eternal\\Auto_Empire\\worktrees\\sovereign-v3-live";
const STATE_FILE = join(STATE_DIR, "state.json");
const DESKTOP_PROCESS_FILE = join(STATE_DIR, "desktop-process.json");
const DESKTOP_STDOUT = join(STATE_DIR, "desktop.stdout.log");
const DESKTOP_STDERR = join(STATE_DIR, "desktop.stderr.log");
const CAPTURE_SCRIPT = fileURLToPath(new URL("./capture-sovereign-window.ps1", import.meta.url));
const PROTOCOL = "sovereign-local/1";
const COMMAND_MARKER = "SOVEREIGN-LOCAL-COMMAND";
const RESULT_MARKER = "SOVEREIGN-LOCAL-RESULT";
const READY_MARKER = "SOVEREIGN-LOCAL-READY";
const MAX_BODY = 12000;
const MAX_RUN_OUTPUT = 18000;

const OPS = new Set([
  "bridge.health",
  "machine.info",
  "process.find",
  "repo.status",
  "repo.diff-summary",
  "sovereignbot.find",
  "recipe.prepare-main",
  "recipe.live-frame-test",
  "recipe.desktop-check",
  "recipe.desktop-start",
  "recipe.desktop-stop",
  "recipe.desktop-package-smoke",
  "recipe.desktop-capture",
]);

function redact(text) {
  return String(text ?? "")
    .replace(/\b(?:ghp|github_pat|sk|xox[baprs]|eyJ)[A-Za-z0-9_.-]{12,}\b/gi, "[REDACTED_SECRET]")
    .replace(/((?:api[_-]?key|token|bearer|authorization|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, MAX_RUN_OUTPUT);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    shell: false,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 20000,
    cwd: options.cwd,
    env: options.env ?? process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = redact(result.stderr || result.stdout || `${command} failed`);
    throw new Error(`${command} exited ${result.status}: ${detail.slice(-3500)}`);
  }
  return redact(result.stdout || "");
}

function ghJson(args) {
  const text = run("gh", args, { timeout: 30000 }).trim();
  return text ? JSON.parse(text) : undefined;
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, STATE_FILE);
}

function loadState() {
  try {
    const value = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return { lastCommentId: Number(value.lastCommentId || 0), commandIds: Array.isArray(value.commandIds) ? value.commandIds.slice(-500) : [] };
  } catch {
    return { lastCommentId: 0, commandIds: [] };
  }
}

function assertTransport() {
  if (process.platform !== "win32") throw new Error("Sovereign Local Control Bridge is Windows-only");
  run("gh", ["auth", "status"], { timeout: 15000 });
  const repo = ghJson(["api", `repos/${REPO}`]);
  if (!repo?.private) throw new Error(`control transport must be a dedicated private repository: ${REPO}`);
  const issue = ghJson(["api", `repos/${REPO}/issues/${ISSUE}`]);
  if (!issue || issue.pull_request) throw new Error(`control issue ${REPO}#${ISSUE} is unavailable`);
}

function post(body) {
  run("gh", ["api", `repos/${REPO}/issues/${ISSUE}/comments`, "-X", "POST", "-f", `body=${String(body).slice(0, 48000)}`], { timeout: 30000 });
}

function machineInfo() {
  const cpu = cpus()[0];
  return {
    hostname: hostname(), platform: platform(), release: release(), arch: arch(), node: process.version,
    cpu: cpu ? `${cpu.model} x${cpus().length}` : undefined,
    memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
    freeMemoryGiB: Number((freemem() / 1024 ** 3).toFixed(1)),
    uptimeSeconds: Math.floor(uptime()),
    projectPath: PROJECT,
    liveWorktree: LIVE_WORKTREE,
    bridgePid: process.pid,
  };
}

function processFind(pattern) {
  const value = String(pattern || "").trim();
  if (!value || value.length > 80) throw new Error("pattern must be 1-80 characters");
  const escaped = value.replaceAll("'", "''");
  const script = `$p='${escaped}'; Get-Process | Where-Object { $_.ProcessName -like \"*$p*\" -or $_.Path -like \"*$p*\" } | Select-Object -First 80 Id,ProcessName,Path | ConvertTo-Json -Compress`;
  const raw = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15000 }).trim();
  return raw ? JSON.parse(raw) : [];
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){'true'}else{'false'}`;
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 10000 }).trim() === "true";
}

function requireEmptyArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 0)
    throw new Error("this recipe accepts no arguments");
}

function gitHead(cwd) {
  return run("git", ["rev-parse", "HEAD"], { cwd, timeout: 15000 }).trim();
}

function ensureLiveWorktree() {
  if (!existsSync(PROJECT)) throw new Error(`SovereignBot project not found: ${PROJECT}`);
  run("git", ["fetch", "origin", "main"], { cwd: PROJECT, timeout: 120000 });
  mkdirSync(dirname(LIVE_WORKTREE), { recursive: true });

  if (!existsSync(LIVE_WORKTREE)) {
    run("git", ["worktree", "add", "--force", "--detach", LIVE_WORKTREE, "origin/main"], { cwd: PROJECT, timeout: 120000 });
  } else {
    const top = resolve(run("git", ["rev-parse", "--show-toplevel"], { cwd: LIVE_WORKTREE, timeout: 15000 }).trim());
    if (top.toLowerCase() !== resolve(LIVE_WORKTREE).toLowerCase())
      throw new Error(`live worktree path is not the expected Git root: ${top}`);
    const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: LIVE_WORKTREE, timeout: 15000 }).trim();
    if (dirty) throw new Error("managed live worktree has tracked local changes; refusing to overwrite it");
    run("git", ["reset", "--hard", "origin/main"], { cwd: LIVE_WORKTREE, timeout: 30000 });
  }
  return { worktree: LIVE_WORKTREE, head: gitHead(LIVE_WORKTREE) };
}

function desktopDir() {
  return join(LIVE_WORKTREE, "desktop");
}

function ensureDesktopDependencies() {
  const dir = desktopDir();
  const electron = join(dir, "node_modules", "electron", "package.json");
  if (!existsSync(electron)) {
    run("npm.cmd", ["ci", "--no-audit", "--no-fund"], { cwd: dir, timeout: 600000 });
  }
}

function startDesktop() {
  const prepared = ensureLiveWorktree();
  ensureDesktopDependencies();
  mkdirSync(STATE_DIR, { recursive: true });

  try {
    const existing = JSON.parse(readFileSync(DESKTOP_PROCESS_FILE, "utf8"));
    if (processExists(Number(existing.pid)))
      return { alreadyRunning: true, pid: existing.pid, ...prepared };
  } catch {}

  writeFileSync(DESKTOP_STDOUT, "", "utf8");
  writeFileSync(DESKTOP_STDERR, "", "utf8");
  const stdoutFd = openSync(DESKTOP_STDOUT, "a");
  const stderrFd = openSync(DESKTOP_STDERR, "a");
  let child;
  try {
    child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd start"], {
      cwd: desktopDir(),
      env: process.env,
      shell: false,
      detached: true,
      windowsHide: false,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    child.unref();
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  if (!child?.pid) throw new Error("Desktop start did not return a process id");
  const record = { pid: child.pid, startedAt: new Date().toISOString(), head: prepared.head, worktree: LIVE_WORKTREE };
  writeFileSync(DESKTOP_PROCESS_FILE, JSON.stringify(record, null, 2) + "\n", "utf8");
  return { started: true, logs: { stdout: DESKTOP_STDOUT, stderr: DESKTOP_STDERR }, ...record };
}

function stopDesktop() {
  let record;
  try { record = JSON.parse(readFileSync(DESKTOP_PROCESS_FILE, "utf8")); }
  catch { return { stopped: false, reason: "no managed Desktop process record" }; }
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("managed Desktop process record is invalid");
  if (processExists(pid)) run("taskkill.exe", ["/PID", String(pid), "/T"], { timeout: 30000 });
  rmSync(DESKTOP_PROCESS_FILE, { force: true });
  return { stopped: true, pid };
}

function desktopLogTail() {
  const tail = (path) => {
    try { return redact(readFileSync(path, "utf8")).slice(-5000); }
    catch { return ""; }
  };
  return { stdout: tail(DESKTOP_STDOUT), stderr: tail(DESKTOP_STDERR) };
}

function captureDesktop() {
  if (!existsSync(CAPTURE_SCRIPT)) throw new Error("SovereignBot QA capture script is missing");
  const raw = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", CAPTURE_SCRIPT], { timeout: 30000 }).trim();
  const frame = JSON.parse(raw);
  if (frame.mimeType !== "image/jpeg" || typeof frame.data !== "string" || frame.data.length > 36000)
    throw new Error("SovereignBot QA capture returned an invalid frame");
  return frame;
}

function runRecipe(op, args) {
  requireEmptyArgs(args);
  switch (op) {
    case "recipe.prepare-main":
      return ensureLiveWorktree();
    case "recipe.live-frame-test": {
      const prepared = ensureLiveWorktree();
      const output = run("node", ["--test", "tests/live-frame.test.js"], { cwd: LIVE_WORKTREE, timeout: 120000 });
      return { ...prepared, output };
    }
    case "recipe.desktop-check": {
      const prepared = ensureLiveWorktree();
      ensureDesktopDependencies();
      const output = run("npm.cmd", ["run", "check"], { cwd: desktopDir(), timeout: 300000 });
      return { ...prepared, output };
    }
    case "recipe.desktop-start":
      return startDesktop();
    case "recipe.desktop-stop":
      return stopDesktop();
    case "recipe.desktop-package-smoke": {
      const prepared = ensureLiveWorktree();
      ensureDesktopDependencies();
      const packageOutput = run("npm.cmd", ["run", "package"], { cwd: desktopDir(), timeout: 600000 });
      const smokeOutput = run("npm.cmd", ["run", "smoke:packaged"], { cwd: desktopDir(), timeout: 300000 });
      return { ...prepared, packageOutput, smokeOutput };
    }
    case "recipe.desktop-capture":
      return captureDesktop();
    default:
      throw new Error(`unsupported recipe: ${op}`);
  }
}

function parse(body) {
  if (typeof body !== "string" || body.length > MAX_BODY || !body.includes(COMMAND_MARKER)) return undefined;
  const match = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match) return undefined;
  let value;
  try { value = JSON.parse(match[1]); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (Object.keys(value).sort().join(",") !== "args,id,op,protocol") return undefined;
  if (value.protocol !== PROTOCOL || typeof value.id !== "string" || !/^cmd_[A-Za-z0-9_-]{8,80}$/.test(value.id)) return undefined;
  if (!OPS.has(value.op) || !value.args || typeof value.args !== "object" || Array.isArray(value.args)) return undefined;
  return value;
}

function execute(command) {
  if (command.op.startsWith("recipe.")) return runRecipe(command.op, command.args);
  switch (command.op) {
    case "bridge.health": return { protocol: PROTOCOL, repo: REPO, issue: ISSUE, capabilities: [...OPS].sort(), logs: desktopLogTail(), ...machineInfo() };
    case "machine.info": return machineInfo();
    case "process.find": return { pattern: command.args.pattern, processes: processFind(command.args.pattern) };
    case "repo.status": {
      if (!existsSync(PROJECT)) throw new Error(`SovereignBot project not found: ${PROJECT}`);
      return { project: PROJECT, status: run("git", ["status", "--short", "--branch"], { cwd: PROJECT, timeout: 15000 }).trim() };
    }
    case "repo.diff-summary": {
      if (!existsSync(PROJECT)) throw new Error(`SovereignBot project not found: ${PROJECT}`);
      return { project: PROJECT, diffStat: run("git", ["diff", "--stat", "--", "."], { cwd: PROJECT, timeout: 15000 }).trim() };
    }
    case "sovereignbot.find": return { processes: processFind("SovereignBot"), managedDesktop: (() => { try { return JSON.parse(readFileSync(DESKTOP_PROCESS_FILE, "utf8")); } catch { return undefined; } })(), logs: desktopLogTail() };
    default: throw new Error(`unsupported operation: ${command.op}`);
  }
}

function fetchComments() {
  const pages = ghJson(["api", `repos/${REPO}/issues/${ISSUE}/comments?per_page=100`, "--paginate", "--slurp"]);
  return (Array.isArray(pages) ? pages.flat() : []).sort((a, b) => Number(a.id) - Number(b.id));
}

async function main() {
  assertTransport();
  const state = loadState();
  if (!existsSync(STATE_FILE)) {
    const current = fetchComments();
    state.lastCommentId = current.reduce((max, item) => Math.max(max, Number(item.id || 0)), 0);
    saveState(state);
  }

  post(`${READY_MARKER}\n\n\`\`\`json\n${JSON.stringify({ protocol: PROTOCOL, status: "ready", at: new Date().toISOString(), machine: machineInfo(), capabilities: [...OPS].sort() }, null, 2)}\n\`\`\``);
  process.stdout.write(`[sovereign-local] ready ${REPO}#${ISSUE} pid=${process.pid}\n`);

  for (;;) {
    try {
      for (const item of fetchComments()) {
        const commentId = Number(item.id || 0);
        if (!commentId || commentId <= state.lastCommentId) continue;
        state.lastCommentId = commentId;
        const command = item.user?.login === AUTHOR ? parse(item.body) : undefined;
        if (!command) { saveState(state); continue; }
        if (state.commandIds.includes(command.id)) { saveState(state); continue; }
        state.commandIds.push(command.id);
        state.commandIds = state.commandIds.slice(-500);
        saveState(state);
        let payload;
        try {
          payload = { protocol: PROTOCOL, commandId: command.id, op: command.op, status: "ok", at: new Date().toISOString(), result: execute(command) };
        } catch (error) {
          payload = { protocol: PROTOCOL, commandId: command.id, op: command.op, status: "error", at: new Date().toISOString(), error: redact(error.message) };
        }
        post(`${RESULT_MARKER}\n\n\`\`\`json\n${redact(JSON.stringify(payload, null, 2))}\n\`\`\``);
      }
    } catch (error) {
      process.stderr.write(`[sovereign-local] poll error: ${redact(error.message)}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

main().catch((error) => {
  process.stderr.write(`[sovereign-local] fatal: ${redact(error.stack || error.message)}\n`);
  process.exitCode = 1;
});
