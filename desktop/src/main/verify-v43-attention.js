// V4.3 Attention Center vertical gate. It deliberately drives the real
// BrowserWindow, preload, IPC, renderer DOM, and the existing governed Job
// runtime with isolated durable state and a deterministic fake provider.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopVersion } from "./lib/desktop-version.js";
import { createDesktopServices } from "./services.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createSkillStore } from "./skill-store.js";
import { createJobController, JOBS_SCHEMA } from "./job-controller.js";
import { createRoutineController } from "./routine-controller.js";
import { EVENT_TRIGGERS_SCHEMA } from "./event-trigger-controller.js";
import { coworkerAgentId } from "./provider-roster.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = join(WORKTREE_ROOT, "_evidence_v43_2026-08-30");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeRuntime() {
  let planSeq = 0;
  let taskSeq = 0;
  const tasks = [];
  return {
    tasks,
    runtime: {
      orchestrator: {
        async createPlan(input) { return { id: `plan_${++planSeq}`, ...input }; },
        async delegateTrusted(planId, spec, executionContext, supervisorId) {
          const task = { id: `task_${++taskSeq}`, planId, status: "queued", input: spec.input, title: spec.title, executionContext, supervisorId };
          tasks.push(task);
          return structuredClone(task);
        },
        async runUntilIdle() {
          for (const task of tasks) {
            if (task.status !== "queued") continue;
            task.status = "completed";
            task.result = { text: `V4.3 Attention gate completed: ${task.title}` };
          }
        },
        async listTasks() { return structuredClone(tasks); },
        async aggregatePlan(planId) { return { planId, status: "completed" }; },
        async cancel(taskId) { const task = tasks.find((entry) => entry.id === taskId); if (task) task.status = "cancelled"; },
      },
    },
  };
}

function seedJob({ id, title, ownerCoworkerId, status, priority = "normal", routineId, attentionState, updatedAt, createdAt }) {
  return {
    id,
    title,
    objective: `V4.3 gate objective for ${title}`,
    ownerCoworkerId,
    status,
    priority,
    workspaceId: undefined,
    requestedWorkspaceId: undefined,
    routineId,
    skillId: undefined,
    scheduledFor: undefined,
    conversationId: `job-conv-${id}`,
    planId: undefined,
    taskIds: [],
    parentJobId: undefined,
    childJobIds: [],
    attempt: 0,
    nextActionAt: undefined,
    attentionState,
    outcomeSummary: status === "completed" ? "Existing non-attention job." : undefined,
    error: undefined,
    createdAt,
    updatedAt: updatedAt ?? createdAt,
    conversation: { messages: [{ at: createdAt, role: "system", kind: "seed", text: `seed ${id}` }] },
  };
}

async function captureVisualEvidence(win) {
  const attempts = [];
  const fail = (method, error) => attempts.push({ method, error: String(error?.message ?? error).slice(0, 500) });
  try {
    win.show();
    await sleep(200);
    const image = await win.capturePage(undefined, { stayAwake: true });
    if (!image || image.isEmpty()) throw new Error("BrowserWindow.capturePage returned an empty image");
    return { image, method: "BrowserWindow.capturePage", attempts };
  } catch (error) {
    fail("BrowserWindow.capturePage", error);
  }
  try {
    const { desktopCapturer } = await import("electron");
    win.show();
    await sleep(200);
    const bounds = win.getBounds();
    const sourceId = win.getMediaSourceId();
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) },
      fetchWindowIcons: false,
    });
    const handle = sourceId.split(":")[1];
    const source = sources.find((entry) => entry.id === sourceId)
      ?? sources.find((entry) => entry.id.split(":")[1] === handle)
      ?? sources.find((entry) => entry.name === win.getTitle());
    if (!source) throw new Error(`desktopCapturer could not find BrowserWindow source ${sourceId}`);
    if (!source.thumbnail || source.thumbnail.isEmpty()) throw new Error("desktopCapturer returned an empty BrowserWindow thumbnail");
    return { image: source.thumbnail, method: "desktopCapturer.window", attempts };
  } catch (error) {
    fail("desktopCapturer.window", error);
  }
  return { image: undefined, method: undefined, attempts };
}

export async function runVerifyV43Attention({ app }) {
  const { dialog } = await import("electron");
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const log = [];
  const checks = {};
  const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
  const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };

  let dataDir;
  let win;
  let unbind;
  let uninstallProtocol;
  let routines;
  let jobs;
  let visual = { method: undefined, attempts: [], image: undefined };
  let fatal;
  let surface;
  let english;
  let chinese;
  let retryState;
  let dismissState;
  let restartState;
  let runtime;

  try {
    dataDir = await mkdtemp(join(tmpdir(), "sovereign-v43-"));
    process.env.SOVEREIGNBOT_DESKTOP_DATA_DIR = dataDir;
    const stateDir = join(dataDir, "desktop-state");
    await mkdir(stateDir, { recursive: true });

    const services = createDesktopServices({ dataDir, dialog });
    const coworkerStore = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
    coworkerStore.ensureDefaults();
    const coworkers = coworkerStore.list().coworkers;
    const chief = coworkers.find((entry) => /chief of staff/i.test(entry.name)) ?? coworkers[0];
    const skillStore = createSkillStore({ persistPath: join(stateDir, "skills.json") });
    const conversationStore = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore });
    const runtimeHarness = fakeRuntime();
    runtime = runtimeHarness;
    const roster = {
      ready: true,
      mode: "provider",
      roles: { planner: "v43-gate-supervisor" },
      agents: [],
      providers: { codex: { usable: true, present: true, version: "v43-gate" } },
      coworkerBindings: Object.fromEntries(coworkers.map((entry) => [entry.id, { ready: true, agentId: coworkerAgentId(entry.id), provider: "fake" }])),
    };

    const routineAttentionId = "job-attention-routine";
    const manualAttentionId = "job-attention-manual";
    const initialJobs = [
      seedJob({ id: routineAttentionId, title: "Routine-linked attention", ownerCoworkerId: chief.id, status: "needs_attention", priority: "high", routineId: "routine_v43_gate", attentionState: { reason: "Routine needs an operator decision.", at: "2026-08-30T08:00:00.000Z" }, createdAt: "2026-08-30T07:55:00.000Z" }),
      seedJob({ id: manualAttentionId, title: "Manual attention", ownerCoworkerId: chief.id, status: "needs_attention", priority: "normal", attentionState: { reason: "Manual job needs an operator decision.", at: "2026-08-30T09:00:00.000Z" }, createdAt: "2026-08-30T08:55:00.000Z" }),
      seedJob({ id: "job-not-attention", title: "Completed non-attention job", ownerCoworkerId: chief.id, status: "completed", createdAt: "2026-08-30T06:00:00.000Z" }),
    ];
    await writeFile(join(stateDir, "jobs.json"), `${JSON.stringify({ schema: JOBS_SCHEMA, jobs: initialJobs }, null, 2)}\n`, "utf8");

    const createJobs = () => createJobController({
      dataDir,
      runtime: runtimeHarness.runtime,
      roster: () => roster,
      coworkerStore,
      services,
      skillStore,
      supervisorAgentId: "v43-gate-supervisor",
      readiness: () => ({ allowed: true }),
    });
    jobs = createJobs();
    routines = createRoutineController({ dataDir, jobController: jobs, coworkerStore, skillStore, services, persistPath: join(stateDir, "routines.json") });

    const hydrated = jobs.attentionJobs().jobs;
    check("hydration preserves two Attention Jobs", hydrated.length === 2 && hydrated.every((job) => job.status === "needs_attention"), JSON.stringify(hydrated.map((job) => ({ id: job.id, status: job.status }))));
    check("Attention projection sorts high priority first", hydrated[0]?.id === routineAttentionId && hydrated[1]?.id === manualAttentionId, JSON.stringify(hydrated.map((job) => ({ id: job.id, priority: job.priority }))));

    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow();
    unbind = bindIpcChannels({
      win,
      handlers: {
        "app:handshake": () => ({ ok: true, version: desktopVersion(), platform: process.platform, locale: "en-US", language: services.getSettings().language }),
        "firstrun:getStatus": () => ({ browsers: [] }),
        "workspace:list": () => services.listWorkspaces(),
        "workspace:addViaDialog": () => ({ added: false }),
        "workspace:setDefault": ({ id }) => ({ ok: services.setDefaultWorkspace(id) }),
        "workspace:remove": ({ id }) => ({ removed: services.removeWorkspace(id) }),
        "settings:get": () => services.getSettings(),
        "settings:update": (patch) => services.updateSettings(patch),
        "provider:getRoster": () => roster,
        "provider:refresh": () => ({ applied: false, roster }),
        "provider:openLogin": () => ({ login: { provider: "gate" }, refresh: roster }),
        "provider:setRoleAssignment": () => roster,
        "coworker:list": ({ includeArchived }) => coworkerStore.list({ includeArchived }),
        "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
        "conversation:list": () => conversationStore.list(),
        "conversation:get": ({ conversationId }) => conversationStore.get(conversationId),
        "conversation:createDirect": ({ coworkerId }) => conversationStore.createDirect(coworkerId),
        "conversation:createTeam": ({ title, coworkerIds }) => conversationStore.createTeam({ title, coworkerIds }),
        "skill:list": ({ includeArchived }) => skillStore.list({ includeArchived }),
        "skill:get": ({ skillId }) => skillStore.get(skillId),
        "artifact:list": () => ({ artifacts: [] }),
        "artifact:attachViaDialog": () => ({ canceled: true, artifacts: [] }),
        "job:submit": (payload) => jobs.submitJob(payload),
        "job:list": () => jobs.listJobs(),
        "job:getStatus": ({ jobId }) => jobs.getJob(jobId),
        "job:getConversation": ({ jobId }) => jobs.getConversation(jobId),
        "job:cancel": ({ jobId }) => jobs.cancel(jobId),
        "job:pause": ({ jobId }) => jobs.pause(jobId),
        "job:resume": ({ jobId }) => jobs.resume(jobId),
        "job:approve": ({ jobId }) => jobs.approve(jobId),
        "job:dismiss": ({ jobId }) => jobs.dismiss(jobId),
        "job:attention": () => jobs.attentionJobs(),
        "routine:create": (payload) => routines.create(payload),
        "routine:list": () => routines.list(),
        "routine:get": ({ routineId }) => routines.get(routineId),
        "routine:history": ({ routineId }) => routines.history(routineId),
        "routine:setEnabled": ({ routineId, enabled }) => routines.setEnabled(routineId, enabled),
        "routine:remove": ({ routineId }) => routines.remove(routineId),
        // The V4.3 harness does not instantiate the V4.4 controller, but the
        // shared renderer now hydrates this read-only surface on startup.
        "eventTrigger:list": () => ({ schema: EVENT_TRIGGERS_SCHEMA, triggers: [] }),
      },
    });

    await win.loadURL(appOrigin());
    await win.webContents.executeJavaScript("(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()");
    await sleep(800);

    surface = await win.webContents.executeJavaScript(`({
      work: !!document.getElementById('nav-work'),
      attention: !!document.getElementById('nav-attention'),
      routines: !!document.getElementById('nav-routines'),
      settings: !!document.getElementById('nav-settings'),
      attentionView: !!document.getElementById('view-attention'),
      workView: !!document.getElementById('view-work'),
      routinesView: !!document.getElementById('view-routines'),
      settingsView: !!document.getElementById('view-settings')
    })`);
    check("dedicated Attention surface exists with V4.1/V4.2 navigation", Object.values(surface).every(Boolean), JSON.stringify(surface));

    await win.webContents.executeJavaScript("document.getElementById('nav-work')?.click()");
    await sleep(250);
    await win.webContents.executeJavaScript("document.getElementById('nav-attention')?.click()");
    await sleep(500);
    english = await win.webContents.executeJavaScript(`({
      lang: document.documentElement.lang,
      attentionVisible: document.getElementById('view-attention')?.classList.contains('hidden') === false,
      workHidden: document.getElementById('view-work')?.classList.contains('hidden') === true,
      badge: document.getElementById('attention-badge')?.textContent?.trim(),
      active: [...document.querySelectorAll('.utility-nav.active')].map((entry)=>entry.id),
      cards: [...document.querySelectorAll('#attention-list .job-card')].map((card)=>({ id: card.dataset.jobId, text: card.innerText, buttons: [...card.querySelectorAll('button')].map((button)=>button.textContent.trim()) })),
      body: document.getElementById('view-attention')?.innerText || ''
    })`);
    const requiredEnglish = ["Reason", "Priority", "Source", "Raised", "Retry", "Dismiss", "Open job"];
    check("dedicated Attention view is visible and Work is hidden", english.attentionVisible && english.workHidden && english.active.length === 1 && english.active[0] === "nav-attention");
    check("Attention badge is driven by job:attention projection", english.badge === "2");
    check("Attention list contains only projection Jobs", english.cards.length === 2 && !english.cards.some((card) => card.id === "job-not-attention"));
    check("Attention cards expose operator fields and single-item actions", requiredEnglish.every((label) => english.body.includes(label)) && english.cards.every((card) => JSON.stringify(card.buttons) === JSON.stringify(["Open job", "Retry", "Dismiss"])), JSON.stringify(english.cards));
    check("Routine-linked Attention identifies Routine source", english.cards.find((card) => card.id === routineAttentionId)?.text.includes("Source: Routine"));
    check("Manual Attention identifies Job source", english.cards.find((card) => card.id === manualAttentionId)?.text.includes("Source: Job"));
    check("Attention UI has no batch or permission actions", !/(Retry all|Dismiss all|Approve all|Always allow|Grant permission|Allow forever|Remember this decision)/.test(english.body));

    visual = await captureVisualEvidence(win);
    check("real Attention window visual evidence captured", Boolean(visual.image) && !visual.image.isEmpty(), JSON.stringify({ method: visual.method, attempts: visual.attempts }));
    if (visual.image && !visual.image.isEmpty()) await writeFile(join(EVIDENCE_DIR, "verify-v43-attention.png"), visual.image.toPNG());

    const opened = await win.webContents.executeJavaScript(`(()=>{const card=document.querySelector('#attention-list .job-card[data-job-id="${routineAttentionId}"]'); card?.querySelector('button')?.click(); return true})()`);
    await sleep(250);
    const detail = await win.webContents.executeJavaScript("({ open: !!document.getElementById('job-detail-dialog')?.open, title: document.getElementById('job-detail-title')?.textContent })");
    check("Open job reuses existing Job detail", opened && detail.open && detail.title === "Routine-linked attention", JSON.stringify(detail));
    await win.webContents.executeJavaScript("document.getElementById('job-detail-dialog')?.close()");

    await win.webContents.executeJavaScript("document.getElementById('setting-language').value='zh-CN'; document.getElementById('setting-language').dispatchEvent(new Event('change',{bubbles:true}))");
    await sleep(350);
    await win.webContents.executeJavaScript("document.getElementById('nav-attention')?.click()");
    await sleep(300);
    chinese = await win.webContents.executeJavaScript(`({ lang: document.documentElement.lang, body: document.getElementById('view-attention')?.innerText || '', buttons: [...document.querySelectorAll('#attention-list .job-card button')].map((button)=>button.textContent.trim()) })`);
    const requiredChinese = ["需关注", "原因", "优先级", "来源", "需要关注时间", "重试", "忽略", "打开任务"];
    check("zh-CN Attention UI", chinese.lang === "zh-CN" && requiredChinese.every((label) => chinese.body.includes(label)) && chinese.buttons.includes("重试") && chinese.buttons.includes("忽略"), JSON.stringify({ lang: chinese.lang, buttons: chinese.buttons }));

    await win.webContents.executeJavaScript("document.getElementById('setting-language').value='en'; document.getElementById('setting-language').dispatchEvent(new Event('change',{bubbles:true}))");
    await sleep(350);
    await win.webContents.executeJavaScript("document.getElementById('nav-attention')?.click()");
    await sleep(300);

    await win.webContents.executeJavaScript(`document.querySelector('#attention-list .job-card[data-job-id="${routineAttentionId}"] button:nth-of-type(2)')?.click()`);
    await sleep(150);
    await jobs.flush();
    await sleep(500);
    retryState = await win.webContents.executeJavaScript(`({
      badge: document.getElementById('attention-badge')?.textContent?.trim(),
      cards: [...document.querySelectorAll('#attention-list .job-card')].map((card)=>card.dataset.jobId),
      active: [...document.querySelectorAll('.utility-nav.active')].map((entry)=>entry.id)
    })`);
    const retriedJob = jobs.getJob(routineAttentionId);
    const retriedConversation = jobs.getConversation(routineAttentionId);
    check("Retry uses existing governed Job path", retriedJob.status === "completed" && runtime.tasks.length === 1 && runtime.tasks[0]?.executionContext && runtime.tasks[0]?.supervisorId === "v43-gate-supervisor", JSON.stringify({ status: retriedJob.status, tasks: runtime.tasks.length }));
    check("Retry removes resolved item and synchronizes badge", retryState.badge === "1" && retryState.cards.length === 1 && retryState.cards[0] === manualAttentionId, JSON.stringify(retryState));
    check("Retry leaves durable operator decision message", retriedConversation.messages.some((message) => message.text === "Attention retried by operator."));

    await win.webContents.executeJavaScript(`document.querySelector('#attention-list .job-card[data-job-id="${manualAttentionId}"] button:nth-of-type(3)')?.click()`);
    await sleep(300);
    dismissState = await win.webContents.executeJavaScript(`({ badge: document.getElementById('attention-badge')?.textContent?.trim(), list: document.getElementById('attention-list')?.innerText || '' })`);
    const dismissedJob = jobs.getJob(manualAttentionId);
    const dismissedConversation = jobs.getConversation(manualAttentionId);
    check("Dismiss resolves needs_attention to failed", dismissedJob.status === "failed" && dismissedJob.attentionState?.dismissedAt, JSON.stringify({ status: dismissedJob.status, attentionState: dismissedJob.attentionState }));
    check("Dismiss removes final item and clears badge", dismissState.badge === "0" && /Nothing needs your attention\./.test(dismissState.list), JSON.stringify(dismissState));
    check("Dismiss leaves durable operator decision message", dismissedConversation.messages.some((message) => message.text === "Attention dismissed by operator."));

    jobs = createJobs();
    restartState = {
      attention: jobs.attentionJobs().jobs,
      retried: jobs.getJob(routineAttentionId),
      dismissed: jobs.getJob(manualAttentionId),
    };
    check("resolved Attention Jobs stay out of inbox after restart", restartState.attention.length === 0 && restartState.retried.status === "completed" && restartState.dismissed.status === "failed");
    await win.webContents.executeJavaScript("window.SovereignJobsUI.refreshAttention()");
    await sleep(250);
    const afterRestartUi = await win.webContents.executeJavaScript("({ badge: document.getElementById('attention-badge')?.textContent?.trim(), cards: document.querySelectorAll('#attention-list .job-card').length })");
    check("renderer projection remains empty after controller recreation", afterRestartUi.cards === 0 && afterRestartUi.badge === "0", JSON.stringify(afterRestartUi));

    const scroll = await win.webContents.executeJavaScript(`(async()=>{
      for (const id of ['nav-work','nav-attention','nav-routines','nav-settings']) {
        document.getElementById(id)?.click();
        await new Promise((resolve)=>setTimeout(resolve,180));
      }
      return { window: window.scrollY, document: document.scrollingElement?.scrollTop, active: [...document.querySelectorAll('.utility-nav.active')].map((entry)=>entry.id) };
    })()`);
    check("navigation keeps one active utility and root scroll at top", scroll.window === 0 && scroll.document === 0 && scroll.active.length === 1 && scroll.active[0] === "nav-settings", JSON.stringify(scroll));

    await win.webContents.executeJavaScript("document.getElementById('nav-attention')?.click()");
    await sleep(250);
  } catch (error) {
    fatal = error;
    note(`[fatal] ${String(error?.stack ?? error)}`);
    check("V4.3 gate runner completed", false, String(error?.message ?? error));
  }

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
  const summary = {
    at: new Date().toISOString(),
    dataDir,
    checks,
    visualEvidence: { method: visual.method, attempts: visual.attempts, captured: Boolean(visual.image) && !visual.image.isEmpty() },
    productSurface: surface,
    english,
    chinese,
    retry: retryState,
    dismiss: dismissState,
    restart: restartState ? { attention: restartState.attention, retried: restartState.retried, dismissed: restartState.dismissed } : undefined,
    runtimeTasks: runtime?.tasks ?? [],
    fatal: fatal ? String(fatal?.message ?? fatal) : undefined,
  };
  await writeFile(join(EVIDENCE_DIR, "verify-v43-attention.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(join(EVIDENCE_DIR, "verify-v43-attention.log"), `${log.join("\n")}\n`, "utf8");

  try { routines?.stop(); } catch {}
  try { unbind?.(); } catch {}
  try { uninstallProtocol?.(); } catch {}
  try { win?.destroy(); } catch {}

  if (fatal || failed.length) throw new Error(`V4.3 Attention gate failed: ${failed.join(", ") || String(fatal?.message ?? fatal)}`);
  app.exit(0);
}
