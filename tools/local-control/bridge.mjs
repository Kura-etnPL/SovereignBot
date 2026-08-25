#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { arch, cpus, freemem, hostname, platform, release, totalmem, uptime } from "node:os";
import { join } from "node:path";

const REPO = process.env.SOVEREIGN_CONTROL_REPO || "Kura-etnPL/SovereignBot-Control";
const ISSUE = Number(process.env.SOVEREIGN_CONTROL_ISSUE || "1");
const AUTHOR = process.env.SOVEREIGN_CONTROL_AUTHOR || "Kura-etnPL";
const POLL_MS = Math.max(3000, Math.min(Number(process.env.SOVEREIGN_CONTROL_POLL_MS || "5000"), 60000));
const PROJECT = process.env.SOVEREIGNBOT_PROJECT || "E:\\Eternal\\Auto_Empire\\projects\\SovereignBot";
const STATE_DIR = process.env.SOVEREIGN_CONTROL_STATE_DIR || "E:\\Eternal\\Auto_Empire\\runtime\\sovereign-control";
const STATE_FILE = join(STATE_DIR, "state.json");
const PROTOCOL = "sovereign-local/1";
const COMMAND_MARKER = "SOVEREIGN-LOCAL-COMMAND";
const RESULT_MARKER = "SOVEREIGN-LOCAL-RESULT";
const READY_MARKER = "SOVEREIGN-LOCAL-READY";
const MAX_BODY = 12000;

const OPS = new Set([
  "bridge.health",
  "machine.info",
  "process.find",
  "repo.status",
  "repo.diff-summary",
  "sovereignbot.find",
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    shell: false,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 20000,
    cwd: options.cwd,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${command} failed`).trim().slice(0, 1500));
  return result.stdout || "";
}

function ghJson(args) {
  const text = run("gh", args, { timeout: 30000 }).trim();
  return text ? JSON.parse(text) : undefined;
}

function redact(text) {
  return String(text ?? "")
    .replace(/\b(?:ghp|github_pat|sk|xox[baprs]|eyJ)[A-Za-z0-9_.-]{12,}\b/gi, "[REDACTED_SECRET]")
    .replace(/((?:api[_-]?key|token|bearer|authorization|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 20000);
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
    bridgePid: process.pid,
  };
}

function processFind(pattern) {
  const value = String(pattern || "").trim();
  if (!value || value.length > 80) throw new Error("pattern must be 1-80 characters");
  const escaped = value.replaceAll("'", "''");
  const script = `$p='${escaped}'; Get-Process | Where-Object { $_.ProcessName -like "*$p*" -or $_.Path -like "*$p*" } | Select-Object -First 80 Id,ProcessName,Path | ConvertTo-Json -Compress`;
  const raw = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15000 }).trim();
  return raw ? JSON.parse(raw) : [];
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
  switch (command.op) {
    case "bridge.health": return { protocol: PROTOCOL, repo: REPO, issue: ISSUE, capabilities: [...OPS].sort(), ...machineInfo() };
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
    case "sovereignbot.find": return { processes: processFind("SovereignBot") };
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
  // First boot starts at the current mailbox tail so stale commands can never replay.
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
