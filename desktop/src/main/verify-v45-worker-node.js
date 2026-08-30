// V4.5 real Windows vertical gate. This intentionally exercises the production
// BrowserWindow, app:// protocol, sandboxed preload, main IPC, Desktop RuntimeHost,
// a separate pinned-Node Worker Node process, and the real loopback HTTP client.
// The only model process is the repository's deterministic fake provider.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopVersion } from "./lib/desktop-version.js";
import { createDesktopServices } from "./services.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createSkillStore } from "./skill-store.js";
import { createOperatorBridge } from "./operator-bridge.js";
import { createJobController } from "./job-controller.js";
import { createRoutineController } from "./routine-controller.js";
import { createEventTriggerController } from "./event-trigger-controller.js";
import { createChiefLoop } from "./chief-loop.js";
import { startRuntimeHost } from "./runtime-host.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";
import { prepareInternalNode } from "./internal-node.js";
import { createWorkerNodeStore } from "./worker-node-store.js";
import {
  createWorkerNodeClient,
} from "../../vendor/core/src/worker-node-client.js";
import {
  WORKER_NODE_PROTOCOL,
  validateLoopbackEndpoint,
  validatePairingBundle,
} from "../../vendor/core/src/worker-node-protocol.js";
import { readWorkerNodeIdentity } from "../../vendor/core/src/worker-node-identity.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DESKTOP_ROOT = join(WORKTREE_ROOT, "desktop");
const CONTROL_ROOT = join(WORKTREE_ROOT, "..", "..", "runtime", "sovereign-control");
const EVIDENCE_DIR = process.env.SOVEREIGNBOT_V45_EVIDENCE_DIR ?? join(CONTROL_ROOT, "v45-worker-node");
const FAKE_PROVIDER = join(DESKTOP_ROOT, "e2e", "fixtures", "fake-provider-codex.mjs");
const FILE_BODY_CANARY = "V45_FILE_BODY_MUST_NEVER_CROSS_PROTOCOL";
const CANCEL_HOLD_MARKER = "V45_CANCEL_HOLD";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function redactText(value, secrets) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length)
      text = text.split(secret).join("[REDACTED]");
  }
  return text;
}

function containsSensitive(value, secrets) {
  const text = String(value ?? "").toLowerCase();
  return secrets.filter((secret) => typeof secret === "string" && secret.length)
    .some((secret) => text.includes(secret.toLowerCase()));
}

function probeWindowsIntegrity() {
  if (process.platform !== "win32")
    return { level: "non-windows", noAdmin: false };
  try {
    const output = execFileSync("whoami.exe", ["/groups"], { encoding: "utf8", windowsHide: true });
    const medium = /S-1-16-8192/i.test(output);
    const elevated = /S-1-16-(12288|16384)/i.test(output);
    return { level: medium && !elevated ? "Medium" : elevated ? "High-or-system" : "unknown", noAdmin: medium && !elevated };
  }
  catch {
    return { level: "unknown", noAdmin: false };
  }
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("could not reserve a loopback port for Worker Node gate");
  return port;
}

function cleanChildEnv({ nodeExecutable, transcriptPath, delayMs = "15000" }) {
  const env = {
    ...process.env,
    SOVEREIGNBOT_INTERNAL_NODE: nodeExecutable,
    SOVEREIGNBOT_WORKER_NODE_GATE: "1",
    FAKE_PROVIDER_NODE: nodeExecutable,
    FAKE_PROVIDER_DIR: join(DESKTOP_ROOT, "e2e", "fixtures"),
    FAKE_PROVIDER_TRANSCRIPT: transcriptPath,
    FAKE_PROVIDER_DELAY_MS: delayMs,
  };
  for (const key of Object.keys(env)) {
    if (/^(OPENAI|ANTHROPIC|AZURE|AWS|GITHUB|GH)_.*/i.test(key) || /(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|COOKIE|PRIVATE_KEY)/i.test(key))
      delete env[key];
  }
  return env;
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-32_000); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_000); });
    child.once("error", (error) => {
      if (!settled) { settled = true; reject(error); }
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function startWorkerProcess({ nodeExecutable, configPath, transcriptPath, onOutput }) {
  const child = spawn(nodeExecutable, [
    join(WORKTREE_ROOT, "src", "cli.js"),
    "worker-node",
    "serve",
    "--config",
    configPath,
  ], {
    cwd: WORKTREE_ROOT,
    env: cleanChildEnv({ nodeExecutable, transcriptPath }),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let exitResolve;
  const exitPromise = new Promise((resolve) => { exitResolve = resolve; });
  child.stdout?.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-32_000);
    onOutput?.(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-32_000);
    onOutput?.(chunk);
  });
  child.once("exit", (code, signal) => exitResolve({ code, signal }));

  const url = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Worker Node did not become ready within 20 seconds")), 20_000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const inspect = () => {
      const match = stdout.match(/Worker Node listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) finish(undefined, match[1]);
    };
    child.stdout?.on("data", inspect);
    child.once("error", () => finish(new Error("Worker Node process failed to spawn")));
    child.once("exit", (code) => finish(new Error(`Worker Node process exited before ready (${code ?? "signal"})`)));
    inspect();
  });
  return { child, url, exitPromise, stdout: () => stdout, stderr: () => stderr };
}

async function stopWorkerProcess(worker) {
  if (!worker?.child) return true;
  const child = worker.child;
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGTERM"); } catch {}
    await Promise.race([worker.exitPromise, sleep(5_000)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32" && child.pid) {
      try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
    }
    else {
      try { child.kill("SIGKILL"); } catch {}
    }
    await Promise.race([worker.exitPromise, sleep(3_000)]);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

function collectTextFiles(dir) {
  if (!existsSync(dir)) return [];
  const output = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...collectTextFiles(full));
    else if (entry.isFile()) {
      try { output.push(readFileSync(full, "utf8")); } catch {}
    }
  }
  return output;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readTranscript(path) {
  try {
    return (await readFile(path, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  catch {
    return [];
  }
}

async function captureVisualEvidence(win) {
  const attempts = [];
  try {
    win.show();
    await sleep(250);
    const image = await win.capturePage(undefined, { stayAwake: true });
    if (!image || image.isEmpty()) throw new Error("BrowserWindow.capturePage returned an empty image");
    return { image, method: "BrowserWindow.capturePage", attempts };
  }
  catch (error) {
    attempts.push({ method: "BrowserWindow.capturePage", error: String(error?.message ?? error).slice(0, 300) });
  }
  try {
    const { desktopCapturer } = await import("electron");
    const bounds = win.getBounds();
    const sourceId = win.getMediaSourceId();
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) },
      fetchWindowIcons: false,
    });
    const source = sources.find((entry) => entry.id === sourceId) ?? sources.find((entry) => entry.name === win.getTitle());
    if (!source?.thumbnail || source.thumbnail.isEmpty()) throw new Error("desktopCapturer returned no BrowserWindow thumbnail");
    return { image: source.thumbnail, method: "desktopCapturer.window", attempts };
  }
  catch (error) {
    attempts.push({ method: "desktopCapturer.window", error: String(error?.message ?? error).slice(0, 300) });
    return { image: undefined, method: undefined, attempts };
  }
}

export async function runVerifyV45WorkerNode({ app }) {
  const { dialog } = await import("electron");
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const log = [];
  const checks = {};
  const redactionSecrets = [];
  const note = (line) => {
    const safe = redactText(line, redactionSecrets);
    log.push(safe);
    try { process.stderr.write(`${safe}\n`); } catch {}
  };
  const check = (name, ok, detail = "") => {
    checks[name] = Boolean(ok);
    note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${redactText(JSON.stringify(detail), redactionSecrets)}` : ""}`);
  };

  let runDir;
  let desktopDataDir;
  let nodeDataDir;
  let nodeWorkspace;
  let nodeConfigPath;
  let pairingPath;
  let transcriptPath;
  let nodeExecutable;
  let nodeEndpoint;
  let nodeId;
  let nodeWorkspaceId = "ws_node";
  let pairingToken;
  let worker;
  let client;
  let identityBefore;
  let host;
  let services;
  let coworkerStore;
  let conversationStore;
  let skillStore;
  let workerNodeStore;
  let jobs;
  let routines;
  let eventTriggers;
  let chiefLoop;
  let win;
  let unbind;
  let uninstallProtocol;
  let fatal;
  let visualNodes = { method: undefined, attempts: [], captured: false };
  let visualJob = { method: undefined, attempts: [], captured: false };
  let firstJob;
  let firstDesktopTask;
  let firstRemoteTaskId;
  let firstSessionId;
  let firstTranscriptCount = 0;
  let cancelJob;
  let disabledJob;
  let publicSurface;
  let integrity;

  const renderer = async (script) => await win.webContents.executeJavaScript(script);

  async function waitFor(label, predicate, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await predicate();
        if (last) return last;
      }
      catch (error) {
        last = { error: String(error?.message ?? error).slice(0, 300) };
      }
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${label}: ${redactText(JSON.stringify(last), redactionSecrets)}`);
  }

  async function desktopTaskFor(jobId) {
    const tasks = await host.runtime.orchestrator.listTasks();
    return tasks.find((task) => task.input?.jobId === jobId && task.executionContext?.kind === "worker-node");
  }

  async function waitForRemoteBinding(jobId, { active = false } = {}) {
    return await waitFor(`remote task binding for ${jobId}`, async () => {
      const task = await desktopTaskFor(jobId);
      const remoteTaskId = task?.harnessState?.remoteTaskId;
      if (!remoteTaskId) return false;
      const status = await client.getTask(remoteTaskId).catch(() => undefined);
      if (!status) return false;
      if (active && !["accepted", "running"].includes(status.status)) return false;
      return { task, remoteTaskId, status };
    }, 45_000);
  }

  async function jobFromRenderer(jobId) {
    return await renderer(`window.sovereignbot.jobs.getStatus(${JSON.stringify({ jobId })})`);
  }

  try {
    integrity = probeWindowsIntegrity();
    check("WINDOWS_INTEGRITY_MEDIUM", integrity.level === "Medium", integrity);
    check("NO_WINDOWS_ADMIN", integrity.noAdmin, integrity);
    check("NO_DOWNGRADE", !process.argv.some((arg) => /no-sandbox|disable-sandbox|insecure/i.test(arg)), process.argv);

    runDir = await mkdtemp(join(EVIDENCE_DIR, "tmp-"));
    desktopDataDir = join(runDir, "desktop-data");
    nodeDataDir = join(runDir, "node-data");
    nodeWorkspace = join(runDir, "node-workspace");
    nodeConfigPath = join(runDir, "worker-node-config.json");
    pairingPath = join(runDir, "pairing-bundle.json");
    // This is gate-only diagnostic output, not Worker Node state. Keeping it
    // beside (not inside) nodeDataDir also proves restart preflight rejects no
    // unsupported files while the transcript remains available for assertions.
    transcriptPath = join(runDir, "fake-provider-transcript.jsonl");
    redactionSecrets.push(runDir, desktopDataDir, nodeDataDir, nodeWorkspace, nodeConfigPath, pairingPath, transcriptPath);
    await mkdir(desktopDataDir, { recursive: true });
    await mkdir(nodeDataDir, { recursive: true });
    await mkdir(nodeWorkspace, { recursive: true });

    const internalNode = prepareInternalNode();
    nodeExecutable = internalNode.path;
    check("SEPARATE_NODE_PROCESS", process.platform === "win32" && existsSync(nodeExecutable) && nodeExecutable.toLowerCase().endsWith("node.exe"), { source: internalNode.source });

    const port = await freeLoopbackPort();
    const workerConfig = {
      dataDir: nodeDataDir,
      name: "V4.5 Local Worker",
      bindHost: "127.0.0.1",
      port,
      supervisorAgentId: "worker-node-supervisor",
      workerAgentId: "worker-node-worker",
      workspaces: [{ id: nodeWorkspaceId, name: "V4.5 Node Workspace", path: nodeWorkspace }],
      agents: [
        {
          id: "worker-node-supervisor",
          name: "Worker Node Supervisor",
          role: "supervisor",
          capabilities: ["planning"],
          harness: { kind: "echo" },
        },
        {
          id: "worker-node-worker",
          name: "Worker Node Worker",
          role: "worker",
          capabilities: ["general", "coding"],
          harness: { kind: "codex", command: nodeExecutable, prefixArgs: [FAKE_PROVIDER], timeoutMs: 60_000, skipGitRepoCheck: true },
        },
      ],
      policy: {
        repeatWindowMs: 180_000,
        repeatMaxActiveFingerprints: 10_000,
        rules: [
          { id: "deny-runaway-loop", effect: "deny", match: { category: "harness", operation: "run", repeatAtLeast: 10 } },
          { id: "allow-worker-node-worker", effect: "allow", match: { category: "harness", operation: "run", agentId: "worker-node-worker" } },
        ],
      },
    };
    await writeFile(nodeConfigPath, `${JSON.stringify(workerConfig, null, 2)}\n`, "utf8");
    worker = await startWorkerProcess({
      nodeExecutable,
      configPath: nodeConfigPath,
      transcriptPath,
      onOutput: (chunk) => note(`[worker] ${String(chunk).trim()}`),
    });
    nodeEndpoint = validateLoopbackEndpoint(worker.url);
    check("LOOPBACK_ONLY_BIND", worker.url.startsWith("http://127.0.0.1:") && worker.url === `http://127.0.0.1:${port}`, worker.url);
    check("LOOPBACK_ONLY_ENDPOINT", nodeEndpoint === worker.url, nodeEndpoint);

    identityBefore = await readWorkerNodeIdentity(nodeDataDir);
    nodeId = identityBefore.nodeId;
    pairingToken = identityBefore.token;
    redactionSecrets.push(pairingToken);
    client = createWorkerNodeClient({ endpoint: nodeEndpoint, token: pairingToken });
    const health = await client.health();
    const healthText = JSON.stringify(health);
    check("NODE_PUBLIC_HEALTH_READY", health.ready === true && health.protocol === WORKER_NODE_PROTOCOL && health.node?.id === nodeId, { protocol: health.protocol, ready: health.ready });
    check("HEALTH_REDACTED", !containsSensitive(healthText, [pairingToken, nodeWorkspace, "provider-session", "sessionId"]), { fields: Object.keys(health) });

    process.env.SOVEREIGNBOT_DESKTOP_DATA_DIR = desktopDataDir;
    const desktopDialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
    const pairDialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [pairingPath] }) };
    services = createDesktopServices({ dataDir: desktopDataDir, dialog: desktopDialog });
    coworkerStore = createCoworkerStore({ persistPath: join(desktopDataDir, "desktop-state", "coworkers.json") });
    coworkerStore.ensureDefaults();
    conversationStore = createConversationStore({ persistPath: join(desktopDataDir, "desktop-state", "conversations.json"), coworkerStore });
    skillStore = createSkillStore({ persistPath: join(desktopDataDir, "desktop-state", "skills.json") });
    workerNodeStore = createWorkerNodeStore({ dataDir: desktopDataDir });
    host = await startRuntimeHost({
      dataDir: desktopDataDir,
      getSettings: () => services.getSettings(),
      getCoworkers: () => coworkerStore.list().coworkers,
      workerNodeClientResolver: (id) => workerNodeStore.client(id),
    });
    const roster = host.rosterSummary();
    check("LOCAL_ORCHESTRATOR_GOVERNOR", host.mode === "provider" && roster.ready === true && roster.agents.length >= 5 && roster.agents.every((agent) => agent.harnessKind !== "echo"), { mode: host.mode, ready: roster.ready, agentCount: roster.agents.length });
    check("NO_PAID_API", process.env.FAKE_PROVIDER_NODE && process.env.FAKE_PROVIDER_DIR && roster.providers?.codex?.usable === true, { fake: true });

    jobs = createJobController({
      dataDir: desktopDataDir,
      runtime: host.runtime,
      roster: () => host.rosterSummary(),
      coworkerStore,
      services,
      skillStore,
      supervisorAgentId: host.plannerAgentId,
      readiness: () => ({ allowed: true }),
      workerNodeStore,
    });
    routines = createRoutineController({ dataDir: desktopDataDir, jobController: jobs, coworkerStore, skillStore, services });
    eventTriggers = createEventTriggerController({ dataDir: desktopDataDir, routineController: routines, services });
    chiefLoop = createChiefLoop({ jobController: jobs, roster: () => host.rosterSummary() });
    routines.start();
    eventTriggers.start();
    chiefLoop.start();
    const bridge = createOperatorBridge(host.runtime);
    const coworkers = coworkerStore.list().coworkers;
    const ownerId = coworkers.find((entry) => /chief of staff/i.test(entry.name))?.id ?? coworkers[0]?.id;
    if (!ownerId) throw new Error("gate could not find a default coworker");

    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow();
    try { win.setBounds({ x: 40, y: 40, width: 1280, height: 840 }); } catch {}
    try { win.webContents.on("console-message", (_event, level, message) => note(`[renderer:${level}] ${String(message).slice(0, 400)}`)); } catch {}
    unbind = bindIpcChannels({
      win,
      handlers: {
        ...bridge.handlers,
        "app:handshake": () => ({ ok: true, version: desktopVersion(), platform: process.platform, locale: "en-US", language: services.getSettings().language }),
        "firstrun:getStatus": () => ({ browsers: [], providers: {}, roster: host.rosterSummary(), workspaces: services.listWorkspaces(), settings: services.getSettings() }),
        "computer:browserStatus": () => [],
        "computer:provisionDriver": () => ({ ok: false, reason: "not exercised by Worker Node gate" }),
        "workspace:list": () => services.listWorkspaces(),
        "workspace:addViaDialog": () => ({ added: false }),
        "workspace:setDefault": ({ id }) => ({ ok: services.setDefaultWorkspace(id) }),
        "workspace:remove": ({ id }) => ({ removed: services.removeWorkspace(id) }),
        "settings:get": () => services.getSettings(),
        "settings:update": (patch) => services.updateSettings(patch),
        "provider:getRoster": () => host.rosterSummary(),
        "provider:refresh": () => ({ applied: false, reason: "gate keeps the fixed fake roster", roster: host.rosterSummary() }),
        "provider:openLogin": ({ provider }) => ({ login: { provider }, refresh: { applied: false, roster: host.rosterSummary() } }),
        "provider:setRoleAssignment": () => host.rosterSummary(),
        "coworker:list": ({ includeArchived }) => coworkerStore.list({ includeArchived }),
        "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
        "coworker:create": ({ coworker }) => coworkerStore.create(coworker),
        "coworker:update": ({ coworkerId, patch }) => coworkerStore.update(coworkerId, patch),
        "coworker:archive": ({ coworkerId }) => coworkerStore.archive(coworkerId),
        "coworker:restore": ({ coworkerId }) => coworkerStore.restore(coworkerId),
        "conversation:list": () => conversationStore.list(),
        "conversation:get": ({ conversationId }) => conversationStore.get(conversationId),
        "conversation:createDirect": ({ coworkerId }) => conversationStore.createDirect(coworkerId),
        "conversation:createTeam": ({ title, coworkerIds }) => conversationStore.createTeam({ title, coworkerIds }),
        "skill:list": ({ includeArchived }) => skillStore.list({ includeArchived }),
        "skill:get": ({ skillId }) => skillStore.get(skillId),
        "artifact:list": () => ({ artifacts: [] }),
        "artifact:get": () => undefined,
        "artifact:preview": () => undefined,
        "artifact:attachViaDialog": () => ({ canceled: true, artifacts: [] }),
        "artifact:reveal": () => ({ ok: true }),
        "goal:list": () => ({ goals: [] }),
        "job:submit": (payload) => jobs.submitJob(payload),
        "job:list": () => jobs.listJobs(),
        "job:getStatus": ({ jobId }) => jobs.getJob(jobId),
        "job:getConversation": ({ jobId }) => jobs.getConversation(jobId),
        "job:cancel": async ({ jobId }) => await jobs.cancel(jobId),
        "job:pause": async ({ jobId }) => await jobs.pause(jobId),
        "job:resume": async ({ jobId }) => await jobs.resume(jobId),
        "job:approve": async ({ jobId }) => await jobs.approve(jobId),
        "job:dismiss": async ({ jobId }) => await jobs.dismiss(jobId),
        "job:attention": () => jobs.attentionJobs(),
        "routine:create": (payload) => routines.create(payload),
        "routine:list": () => routines.list(),
        "routine:get": ({ routineId }) => routines.get(routineId),
        "routine:history": ({ routineId }) => routines.history(routineId),
        "routine:setEnabled": ({ routineId, enabled }) => routines.setEnabled(routineId, enabled),
        "routine:remove": ({ routineId }) => routines.remove(routineId),
        "eventTrigger:create": (payload) => eventTriggers.create(payload),
        "eventTrigger:list": () => eventTriggers.list(),
        "eventTrigger:get": ({ triggerId }) => eventTriggers.get(triggerId),
        "eventTrigger:setEnabled": ({ triggerId, enabled }) => eventTriggers.setEnabled(triggerId, enabled),
        "eventTrigger:remove": ({ triggerId }) => eventTriggers.remove(triggerId),
        "workerNode:pairViaDialog": () => workerNodeStore.pairViaDialog(win, pairDialog),
        "workerNode:list": () => workerNodeStore.list(),
        "workerNode:get": ({ nodeId: id }) => workerNodeStore.get(id),
        "workerNode:refresh": ({ nodeId: id }) => workerNodeStore.refresh(id),
        "workerNode:setEnabled": ({ nodeId: id, enabled }) => workerNodeStore.setEnabled(id, enabled),
        "workerNode:remove": ({ nodeId: id }) => workerNodeStore.remove(id),
      },
    });
    await win.loadURL(appOrigin());
    await renderer("document.readyState === 'complete' ? true : new Promise((resolve) => window.addEventListener('load', () => resolve(true), { once: true }))");
    await sleep(1_000);

    const surface = await renderer(`({
      protocol: location.protocol,
      work: !!document.getElementById('nav-work') && !!document.getElementById('view-work') && !!document.getElementById('work-list'),
      attention: !!document.getElementById('nav-attention') && !!document.getElementById('view-attention'),
      routines: !!document.getElementById('nav-routines') && !!document.getElementById('view-routines'),
      triggers: !!document.getElementById('nav-triggers') && !!document.getElementById('view-triggers'),
      settings: !!document.getElementById('nav-settings') && !!document.getElementById('view-settings'),
      nodes: !!document.getElementById('nav-worker-nodes') && !!document.getElementById('view-worker-nodes') && !!window.sovereignbot.workerNodes,
      jobDialog: !!document.getElementById('job-dialog') && !!document.getElementById('job-form'),
      preload: typeof window.sovereignbot.workerNodes.pairViaDialog === 'function'
    })`);
    check("WORKER_NODES_UI_SURFACE", surface.protocol === "sovereignbot:" && Object.values(surface).every(Boolean), surface);

    const pairingOutput = await runProcess(nodeExecutable, [
      join(WORKTREE_ROOT, "src", "cli.js"),
      "worker-node",
      "pairing-bundle",
      "--config",
      nodeConfigPath,
      "--endpoint",
      nodeEndpoint,
    ], { cwd: WORKTREE_ROOT, env: cleanChildEnv({ nodeExecutable, transcriptPath, delayMs: "0" }) });
    if (pairingOutput.code !== 0) throw new Error("Worker Node pairing-bundle CLI failed");
    const pairingBundle = validatePairingBundle(JSON.parse(pairingOutput.stdout.trim()));
    await writeFile(pairingPath, `${JSON.stringify(pairingBundle, null, 2)}\n`, "utf8");
    check("PAIRING_BUNDLE", JSON.stringify(Object.keys(pairingBundle).sort()) === JSON.stringify(["endpoint", "name", "nodeId", "protocol", "token"]) && pairingBundle.nodeId === nodeId && pairingBundle.endpoint === nodeEndpoint, { protocol: pairingBundle.protocol, nodeId: pairingBundle.nodeId });
    check("PUBLIC_CONTEXT_SMUGGLING_REJECTED", await renderer(`(async()=>{try{await window.sovereignbot.jobs.submit(${JSON.stringify({ title: "reject authority", objective: "must be rejected", ownerCoworkerId: ownerId, executionTarget: { kind: "local", cwd: "C:\\authority" } })});return false}catch(error){return /unexpected|field|executionTarget/i.test(String(error?.message??error))}})()`), "renderer job schema");

    await renderer("document.getElementById('nav-worker-nodes')?.click(); true");
    await renderer("document.getElementById('worker-node-pair')?.click(); true");
    const pairedView = await waitFor("renderer-to-main Worker Node pairing", async () => {
      const state = await renderer(`(async()=>({
        result: document.getElementById('worker-node-result')?.textContent || '',
        nodes: (await window.sovereignbot.workerNodes.list({})).nodes || [],
        cards: document.querySelectorAll('.worker-node-card').length
      }))()`);
      return state.nodes.length === 1 && state.nodes[0].nodeId === nodeId && state.nodes[0].status === "online" ? state : false;
    });
    const pairedPublic = pairedView.nodes[0];
    check("PAIRING_CREDENTIAL_PRIVATE", pairedView.result.includes("paired") && pairedPublic && !Object.hasOwn(pairedPublic, "token") && !Object.hasOwn(pairedPublic, "credentials"), { result: pairedView.result, fields: Object.keys(pairedPublic ?? {}) });
    const publicPath = join(desktopDataDir, "desktop-state", "worker-nodes.json");
    const privatePath = join(desktopDataDir, "desktop-state", "worker-node-credentials.json");
    const publicState = await readJson(publicPath);
    const privateState = await readJson(privatePath);
    const publicStateText = JSON.stringify(publicState);
    check("NODE_PUBLIC_METADATA_REDACTED", !containsSensitive(publicStateText, [pairingToken, nodeWorkspace]) && publicState.nodes?.length === 1, { schema: publicState.schema });
    check("NODE_WORKSPACE_PATH_PRIVATE", !containsSensitive(publicStateText, [nodeWorkspace]) && !containsSensitive(JSON.stringify(pairedPublic), [nodeWorkspace]), { publicFields: Object.keys(pairedPublic ?? {}) });
    check("PRIVATE_CREDENTIAL_STORE", privateState.credentials?.[0]?.token === pairingToken && !containsSensitive(publicStateText, [pairingToken]), { credentialCount: privateState.credentials?.length });
    await rm(pairingPath, { force: true });

    const englishNodeView = await renderer(`({ lang: document.documentElement.lang, visible: !document.getElementById('view-worker-nodes')?.classList.contains('hidden'), body: document.getElementById('view-worker-nodes')?.innerText || '', active: [...document.querySelectorAll('.utility-nav.active')].map((entry) => entry.id) })`);
    check("EN", englishNodeView.lang === "en" && englishNodeView.visible && englishNodeView.active.includes("nav-worker-nodes") && englishNodeView.body.includes("Worker Nodes") && englishNodeView.body.includes("online") && englishNodeView.body.includes("Loopback only in V4.5"), { lang: englishNodeView.lang, active: englishNodeView.active });
    visualNodes = await captureVisualEvidence(win);
    if (visualNodes.image && !visualNodes.image.isEmpty()) {
      await writeFile(join(EVIDENCE_DIR, "v45-worker-nodes.png"), visualNodes.image.toPNG());
      visualNodes.captured = true;
      delete visualNodes.image;
    }
    check("VISUAL_EVIDENCE_NODES", visualNodes.captured, { method: visualNodes.method, attempts: visualNodes.attempts });

    await renderer("document.getElementById('nav-work')?.click(); true");
    await renderer("document.getElementById('work-new')?.click(); true");
    const formSurface = await waitFor("remote New Job selector", async () => {
      const state = await renderer(`({
        open: document.getElementById('job-dialog')?.open === true,
        execution: !!document.getElementById('job-execution'),
        options: [...(document.getElementById('job-execution')?.options || [])].map((option) => option.textContent),
        nodes: [...(document.getElementById('job-node')?.options || [])].map((option) => option.value),
        workspaces: [...(document.getElementById('job-node-workspace')?.options || [])].map((option) => option.value),
        owner: [...(document.getElementById('job-owner')?.options || [])].map((option) => option.value)
      })`);
      return state.open && state.execution && state.nodes.includes(nodeId) && state.workspaces.includes(nodeWorkspaceId) ? state : false;
    });
    check("NEW_JOB_EXECUTION_SELECTOR", formSurface.options.some((value) => /Worker Node/i.test(value)) && formSurface.nodes.includes(nodeId) && formSurface.workspaces.includes(nodeWorkspaceId), { options: formSurface.options });

    const submitRemoteForm = async (title, objective) => {
      await renderer(`(()=>{
        const execution = document.getElementById('job-execution');
        const node = document.getElementById('job-node');
        const workspace = document.getElementById('job-node-workspace');
        execution.value = 'worker-node'; execution.dispatchEvent(new Event('change', { bubbles: true }));
        node.value = ${JSON.stringify(nodeId)}; node.dispatchEvent(new Event('change', { bubbles: true }));
        workspace.value = ${JSON.stringify(nodeWorkspaceId)};
        document.getElementById('job-title').value = ${JSON.stringify(title)};
        document.getElementById('job-objective').value = ${JSON.stringify(objective)};
        document.getElementById('job-owner').value = ${JSON.stringify(ownerId)};
        document.getElementById('job-form').requestSubmit();
        return true;
      })()`);
    };
    await submitRemoteForm("Remote Worker Node review", "Execute a bounded manual Job on the paired Worker Node.");
    firstJob = await waitFor("remote Job submission", async () => {
      const result = await renderer("window.sovereignbot.jobs.list({})");
      return result.jobs?.find((job) => job.title === "Remote Worker Node review") ?? false;
    });
    await waitFor("completed remote Job", async () => {
      const job = await jobFromRenderer(firstJob.id);
      return job.status === "completed" ? job : false;
    }, 60_000);
    await jobs.flush();
    firstJob = await jobFromRenderer(firstJob.id);
    const firstBinding = await waitForRemoteBinding(firstJob.id);
    firstRemoteTaskId = firstBinding.remoteTaskId;
    firstDesktopTask = firstBinding.task;
    const remoteStatus = await client.getTask(firstRemoteTaskId);
    const transcript = await readTranscript(transcriptPath);
    firstTranscriptCount = transcript.length;
    firstSessionId = transcript.find((entry) => entry.sessionId)?.sessionId;
    const desktopTaskText = JSON.stringify(firstDesktopTask);
    const desktopPublicStateText = JSON.stringify(await renderer(`(async()=>({
      job: await window.sovereignbot.jobs.getStatus(${JSON.stringify({ jobId: firstJob.id })}),
      nodes: await window.sovereignbot.workerNodes.list({}),
      overview: await window.sovereignbot.operator.getOverview({}),
      audit: await window.sovereignbot.operator.getAudit({ limit: 50 })
    }))()`));
    publicSurface = JSON.parse(desktopPublicStateText);
    const desktopStateText = collectTextFiles(join(desktopDataDir, "desktop-state"))
      .filter((text) => !text.includes(pairingToken))
      .join("\n");
    const forbiddenTransfer = [pairingToken, nodeWorkspace, firstSessionId, FILE_BODY_CANARY];
    check("MANUAL_JOB_REMOTE_TARGET", firstJob.status === "completed" && firstJob.executionTarget?.kind === "worker-node" && firstJob.executionTarget.nodeId === nodeId && firstJob.executionTarget.workspaceId === nodeWorkspaceId, { status: firstJob.status, target: firstJob.executionTarget });
    check("WORKER_NODE_HARNESS", firstDesktopTask.executionContext?.kind === "worker-node" && firstDesktopTask.executionContext.nodeId === nodeId && firstDesktopTask.executionContext.workspaceId === nodeWorkspaceId && !Object.hasOwn(firstDesktopTask.executionContext, "cwd"), { contextKeys: Object.keys(firstDesktopTask.executionContext ?? {}) });
    check("NODE_ORCHESTRATOR_GOVERNOR", remoteStatus.status === "completed" && transcript.length === 1 && transcript[0]?.phase === "work" && transcript[0]?.cwd?.toLowerCase() === nodeWorkspace.toLowerCase(), { status: remoteStatus.status, providerEntries: transcript.length });
    check("NO_PROVIDER_CREDENTIAL_TRANSFER", !containsSensitive(`${desktopTaskText}\n${desktopPublicStateText}\n${desktopStateText}\n${JSON.stringify(remoteStatus)}`, [pairingToken]), { publicKeys: Object.keys(publicSurface) });
    check("NO_PROVIDER_SESSION_TRANSFER", Boolean(firstSessionId) && !containsSensitive(`${desktopTaskText}\n${desktopPublicStateText}\n${desktopStateText}\n${JSON.stringify(remoteStatus)}`, [firstSessionId]), { sessionGenerated: Boolean(firstSessionId) });
    check("NO_ABSOLUTE_PATH_TRANSFER", !containsSensitive(`${desktopTaskText}\n${desktopPublicStateText}\n${desktopStateText}\n${JSON.stringify(remoteStatus)}`, [nodeWorkspace]) && !String(remoteStatus.result ?? "").includes(nodeWorkspace), { resultRedacted: remoteStatus.result });
    check("NO_ARBITRARY_COMMAND_ENV_CWD", !["command", "env", "cwd", "endpoint", "token"].some((key) => Object.hasOwn(firstDesktopTask.input ?? {}, key)) && Object.keys(firstDesktopTask.executionContext ?? {}).sort().join(",") === "kind,nodeId,workspaceId", { inputKeys: Object.keys(firstDesktopTask.input ?? {}).sort(), contextKeys: Object.keys(firstDesktopTask.executionContext ?? {}).sort() });
    check("PUBLIC_SURFACES_REDACTED", !containsSensitive(`${desktopPublicStateText}\n${desktopStateText}`, forbiddenTransfer), { jobStatus: firstJob.status });
    check("PAIRING_TOKEN_CANARY_REDACTED", !containsSensitive(desktopPublicStateText, [pairingToken]), { tokenLength: pairingToken.length });
    check("FILE_BODY_CANARY_REDACTED", !containsSensitive(`${desktopPublicStateText}\n${desktopStateText}`, [FILE_BODY_CANARY]), { bodyCanary: FILE_BODY_CANARY });
    check("IDEMPOTENCY", firstRemoteTaskId && (await client.dispatch({
      protocol: WORKER_NODE_PROTOCOL,
      requestId: firstDesktopTask.input.requestId,
      jobId: firstDesktopTask.input.jobId,
      title: firstDesktopTask.title,
      instruction: firstDesktopTask.input.instruction,
      workspaceId: firstDesktopTask.executionContext.workspaceId,
      requiredCapabilities: firstDesktopTask.input.requiredCapabilities,
      attempt: firstDesktopTask.input.attempt,
      createdAt: firstDesktopTask.createdAt,
    })).duplicate === true, { sameRemoteTask: firstRemoteTaskId });
    let conflict = false;
    try {
      await client.dispatch({
        protocol: WORKER_NODE_PROTOCOL,
        requestId: firstDesktopTask.input.requestId,
        jobId: firstDesktopTask.input.jobId,
        title: firstDesktopTask.title,
        instruction: `${firstDesktopTask.input.instruction} changed`,
        workspaceId: firstDesktopTask.executionContext.workspaceId,
        requiredCapabilities: firstDesktopTask.input.requiredCapabilities,
        attempt: firstDesktopTask.input.attempt,
        createdAt: firstDesktopTask.createdAt,
      });
    }
    catch (error) { conflict = /conflicts|different request body/i.test(String(error?.message ?? error)); }
    check("DUPLICATE_CONFLICT_REJECTED", conflict, { sameRemoteTask: firstRemoteTaskId });

    await renderer("document.getElementById('nav-work')?.click(); true");
    await sleep(300);
    visualJob = await captureVisualEvidence(win);
    if (visualJob.image && !visualJob.image.isEmpty()) {
      await writeFile(join(EVIDENCE_DIR, "v45-worker-job.png"), visualJob.image.toPNG());
      visualJob.captured = true;
      delete visualJob.image;
    }
    check("VISUAL_EVIDENCE_JOB", visualJob.captured, { method: visualJob.method, attempts: visualJob.attempts });

    await stopWorkerProcess(worker);
    worker = undefined;
    let interrupted = false;
    try { await client.getTask(firstRemoteTaskId); }
    catch (error) { interrupted = error?.code === "WORKER_NODE_TRANSPORT" || /transport/i.test(String(error?.message ?? error)); }
    worker = await startWorkerProcess({ nodeExecutable, configPath: nodeConfigPath, transcriptPath, onOutput: (chunk) => note(`[worker-restart] ${String(chunk).trim()}`) });
    const identityAfter = await readWorkerNodeIdentity(nodeDataDir);
    const restartHealth = await client.health();
    const restartStatus = await client.getTask(firstRemoteTaskId);
    const transcriptAfterRestart = await readTranscript(transcriptPath);
    check("NODE_IDENTITY_DURABLE", identityAfter.nodeId === identityBefore.nodeId && identityAfter.token === identityBefore.token, { nodeId: identityAfter.nodeId });
    check("RECONNECT", interrupted && restartStatus.remoteTaskId === firstRemoteTaskId && restartStatus.status === "completed", { interrupted, status: restartStatus.status });
    check("NODE_RESTART_NO_REPLAY", restartHealth.ready === true && restartStatus.status === "completed" && transcriptAfterRestart.length === firstTranscriptCount, { status: restartStatus.status, providerEntries: transcriptAfterRestart.length });
    await renderer(`window.sovereignbot.workerNodes.refresh(${JSON.stringify({ nodeId })})`);
    await waitFor("paired Worker Node after restart", async () => {
      const list = await renderer("window.sovereignbot.workerNodes.list({})");
      return list.nodes?.[0]?.status === "online" ? list : false;
    });

    await renderer("document.getElementById('nav-work')?.click(); true");
    await renderer("document.getElementById('work-new')?.click(); true");
    await waitFor("cancel Job form", async () => {
      const state = await renderer(`({ open: document.getElementById('job-dialog')?.open === true, node: [...(document.getElementById('job-node')?.options || [])].map((option) => option.value), workspace: [...(document.getElementById('job-node-workspace')?.options || [])].map((option) => option.value) })`);
      return state.open && state.node.includes(nodeId) && state.workspace.includes(nodeWorkspaceId) ? state : false;
    });
    await submitRemoteForm("Remote Worker Node cancellation", `${CANCEL_HOLD_MARKER}: hold this manual Worker Node Job for confirmed cancellation.`);
    cancelJob = await waitFor("cancel Job submission", async () => {
      const result = await renderer("window.sovereignbot.jobs.list({})");
      return result.jobs?.find((job) => job.title === "Remote Worker Node cancellation") ?? false;
    });
    const cancellationBinding = await waitForRemoteBinding(cancelJob.id, { active: true });
    const cancelResult = await renderer(`window.sovereignbot.jobs.cancel(${JSON.stringify({ jobId: cancelJob.id })})`);
    await jobs.flush();
    const cancelledJob = await waitFor("confirmed cancelled Job", async () => {
      const job = await jobFromRenderer(cancelJob.id);
      return job.status === "cancelled" ? job : false;
    });
    cancelJob = cancelledJob;
    const cancelledRemote = await client.getTask(cancellationBinding.remoteTaskId);
    const transcriptAfterCancel = await readTranscript(transcriptPath);
    check("CANCEL_CONFIRMED", cancelResult.status === "cancelled" && cancelledJob.status === "cancelled" && cancelledRemote.status === "cancelled", { job: cancelledJob.status, remote: cancelledRemote.status });
    check("CANCEL_NO_DUPLICATE_PROVIDER", transcriptAfterCancel.length === firstTranscriptCount, { providerEntries: transcriptAfterCancel.length });

    await renderer(`window.sovereignbot.workerNodes.setEnabled(${JSON.stringify({ nodeId, enabled: false })})`);
    const beforeDisabledTasks = (await host.runtime.orchestrator.listTasks()).length;
    const beforeDisabledTranscript = (await readTranscript(transcriptPath)).length;
    disabledJob = await renderer(`window.sovereignbot.jobs.submit(${JSON.stringify({ title: "Disabled Worker Node must stop", objective: "This selected node must fail closed.", ownerCoworkerId: ownerId, executionTarget: { kind: "worker-node", nodeId, workspaceId: nodeWorkspaceId } })})`);
    disabledJob = await waitFor("disabled-node Job attention", async () => {
      const job = await jobFromRenderer(disabledJob.id);
      return job.status === "needs_attention" ? job : false;
    });
    await jobs.flush();
    const afterDisabledTasks = (await host.runtime.orchestrator.listTasks()).length;
    const afterDisabledTranscript = (await readTranscript(transcriptPath)).length;
    check("NO_LOCAL_FALLBACK", disabledJob.status === "needs_attention" && /unavailable|disabled|fallback/i.test(disabledJob.error ?? "") && afterDisabledTasks === beforeDisabledTasks && afterDisabledTranscript === beforeDisabledTranscript, { status: disabledJob.status, tasksBefore: beforeDisabledTasks, tasksAfter: afterDisabledTasks });
    check("DISABLE_BLOCKS_DISPATCH", (await renderer("window.sovereignbot.workerNodes.list({})")).nodes?.[0]?.status === "blocked", { status: (await renderer("window.sovereignbot.workerNodes.list({})")).nodes?.[0]?.status });

    await renderer(`window.sovereignbot.workerNodes.setEnabled(${JSON.stringify({ nodeId, enabled: true })})`);
    await renderer(`window.sovereignbot.workerNodes.refresh(${JSON.stringify({ nodeId })})`);
    await waitFor("Worker Node re-enable", async () => {
      const list = await renderer("window.sovereignbot.workerNodes.list({})");
      return list.nodes?.[0]?.status === "online" ? list : false;
    });

    await renderer("document.getElementById('nav-worker-nodes')?.click(); true");
    await waitFor("Worker Node card before remove", async () => await renderer("document.querySelectorAll('.worker-node-card').length === 1"));
    await renderer("document.getElementById('setting-language').value='zh-CN'; document.getElementById('setting-language').dispatchEvent(new Event('change',{bubbles:true})); true");
    await sleep(500);
    await renderer("document.getElementById('nav-worker-nodes')?.click(); true");
    await sleep(250);
    const chineseNodeCardView = await renderer(`({ lang: document.documentElement.lang, body: document.getElementById('view-worker-nodes')?.innerText || '' })`);
    check("ZH_CN_WORKER_NODE_CARD", chineseNodeCardView.lang === "zh-CN" && chineseNodeCardView.body.includes("工作节点") && chineseNodeCardView.body.includes("回环") && chineseNodeCardView.body.includes("移除"), { lang: chineseNodeCardView.lang });
    await renderer("document.getElementById('setting-language').value='en'; document.getElementById('setting-language').dispatchEvent(new Event('change',{bubbles:true})); true");
    await sleep(400);
    await renderer("document.getElementById('nav-worker-nodes')?.click(); true");
    await waitFor("Worker Node card before remove", async () => await renderer("document.querySelectorAll('.worker-node-card').length === 1"));
    await renderer("document.querySelector('.worker-node-card .worker-node-actions button:last-child')?.click(); true");
    const removedView = await waitFor("renderer-to-main Worker Node removal", async () => {
      const list = await renderer("window.sovereignbot.workerNodes.list({})");
      return list.nodes?.length === 0 ? list : false;
    });
    check("REMOVE_CREDENTIAL_AND_PUBLIC_RECORD", removedView.nodes.length === 0 && !existsSync(publicPath) && !existsSync(privatePath), { nodes: removedView.nodes.length });

    const routineTriggerScope = await renderer(`(async()=>({
      routines: JSON.stringify(await window.sovereignbot.routines.list({})),
      triggers: JSON.stringify(await window.sovereignbot.eventTriggers.list({})),
      routineText: document.getElementById('routine-dialog')?.innerText || '',
      triggerText: document.getElementById('trigger-dialog')?.innerText || ''
    }))()`);
    check("NO_ROUTINE_TRIGGER_REMOTE_SCOPE", !/worker-node|Worker Node|工作节点/i.test(JSON.stringify(routineTriggerScope)), { routines: routineTriggerScope.routines, triggers: routineTriggerScope.triggers });

    await renderer("document.getElementById('setting-language').value='zh-CN'; document.getElementById('setting-language').dispatchEvent(new Event('change',{bubbles:true})); true");
    await sleep(500);
    await renderer("document.getElementById('nav-worker-nodes')?.click(); true");
    await sleep(250);
    const chineseNodeView = await renderer(`({ lang: document.documentElement.lang, body: document.getElementById('view-worker-nodes')?.innerText || '' })`);
    check("ZH_CN", chineseNodeView.lang === "zh-CN" && chineseNodeView.body.includes("工作节点") && chineseNodeView.body.includes("回环"), { lang: chineseNodeView.lang });
    await renderer("document.getElementById('setting-language').value='en'; document.getElementById('setting-language').dispatchEvent(new Event('change',{bubbles:true})); true");
    await sleep(400);

    const scroll = await renderer(`(async()=>{
      for (const id of ['nav-work','nav-attention','nav-routines','nav-triggers','nav-worker-nodes','nav-settings']) { document.getElementById(id)?.click(); await new Promise((resolve)=>setTimeout(resolve,180)); }
      return { window: window.scrollY, document: document.scrollingElement?.scrollTop, active: [...document.querySelectorAll('.utility-nav.active')].map((entry)=>entry.id), work: !!document.getElementById('view-work'), attention: !!document.getElementById('view-attention'), routines: !!document.getElementById('view-routines'), triggers: !!document.getElementById('view-triggers'), settings: !!document.getElementById('view-settings') };
    })()`);
    check("ROOT_SCROLL", scroll.window === 0 && scroll.document === 0 && scroll.active.length === 1 && scroll.active[0] === "nav-settings" && scroll.work && scroll.attention && scroll.routines && scroll.triggers && scroll.settings, scroll);
  }
  catch (error) {
    fatal = error;
    try {
      const failureSnapshot = {
        job: firstJob?.id ? await jobFromRenderer(firstJob.id).catch(() => undefined) : undefined,
        tasks: host?.runtime?.orchestrator ? await host.runtime.orchestrator.listTasks().catch(() => undefined) : undefined,
        transcript: transcriptPath ? await readTranscript(transcriptPath) : undefined,
        workerStdout: worker?.stdout?.(),
        workerStderr: worker?.stderr?.(),
      };
      note(`[failure-snapshot] ${JSON.stringify(failureSnapshot)}`);
    }
    catch (snapshotError) {
      note(`[failure-snapshot-error] ${String(snapshotError?.message ?? snapshotError)}`);
    }
    check("V4.5_REAL_ELECTRON_GATE_COMPLETED", false, String(error?.message ?? error));
    note(`[fatal] ${String(error?.stack ?? error)}`);
  }

  try { await rm(pairingPath, { force: true }); } catch {}
  try { await stopWorkerProcess(worker); } catch (error) { note(`[cleanup worker] ${String(error?.message ?? error)}`); }
  worker = undefined;
  try { eventTriggers?.stop(); } catch {}
  try { routines?.stop(); } catch {}
  try { chiefLoop?.stop(); } catch {}
  try { await Promise.race([jobs?.flush?.() ?? Promise.resolve(), sleep(5_000)]); } catch {}
  try { await host?.close?.(); } catch {}
  try { unbind?.(); } catch {}
  try { uninstallProtocol?.(); } catch {}
  try { win?.destroy(); } catch {}
  try { await rm(runDir, { recursive: true, force: true }); } catch {}

  const tempIsolated = Boolean(runDir) && !existsSync(runDir);
  check("TEMP_ISOLATION_AND_CLEAN_SHUTDOWN", tempIsolated && !worker, { tempIsolated, workerStopped: !worker });
  const summary = {
    schema: "sovereignbot.v4.5.worker-node-gate.v1",
    at: new Date().toISOString(),
    evidenceDir: EVIDENCE_DIR,
    checks,
    protocol: WORKER_NODE_PROTOCOL,
    nodeId,
    nodeWorkspaceId,
    endpoint: nodeEndpoint,
    host: { integrity: integrity?.level, noAdmin: integrity?.noAdmin, internalNodeSource: nodeExecutable ? "pinned" : undefined },
    firstJob: firstJob ? { id: firstJob.id, status: firstJob.status, executionTarget: firstJob.executionTarget } : undefined,
    cancelJob: cancelJob ? { id: cancelJob.id, status: cancelJob.status } : undefined,
    disabledJob: disabledJob ? { id: disabledJob.id, status: disabledJob.status } : undefined,
    remoteTask: firstRemoteTaskId ? { id: firstRemoteTaskId, providerEntries: firstTranscriptCount, providerSessionGenerated: Boolean(firstSessionId) } : undefined,
    publicSurfaceKeys: publicSurface ? Object.keys(publicSurface) : [],
    visualEvidence: {
      nodes: { captured: visualNodes.captured, method: visualNodes.method, attempts: visualNodes.attempts },
      job: { captured: visualJob.captured, method: visualJob.method, attempts: visualJob.attempts },
    },
    tempIsolation: tempIsolated,
    fatal: fatal ? redactText(String(fatal?.message ?? fatal), redactionSecrets) : undefined,
  };
  const evidenceText = `${JSON.stringify(summary, null, 2)}\n`;
  const evidenceSafe = !containsSensitive(evidenceText, [pairingToken, nodeWorkspace, firstSessionId]);
  checks.EVIDENCE_REDACTED = evidenceSafe;
  note(`${evidenceSafe ? "PASS" : "FAIL"} EVIDENCE_REDACTED`);
  await writeFile(join(EVIDENCE_DIR, "verify-v45-worker-node.json"), `${JSON.stringify({ ...summary, checks }, null, 2)}\n`, "utf8");
  await writeFile(join(EVIDENCE_DIR, "verify-v45-worker-node.log"), `${log.join("\n")}\n`, "utf8");

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
  if (fatal || failed.length)
    throw new Error(`V4.5 Worker Node gate failed: ${failed.join(", ") || fatal?.message}`);
  app.exit(0);
}
