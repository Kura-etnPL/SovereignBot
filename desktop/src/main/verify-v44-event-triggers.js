// V4.4 real-Electron vertical gate. It drives the production renderer IPC/UI and
// production fs.watch controller against a deterministic fake runtime. No provider
// account, network request, shell, or file-content read is used by the trigger path.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopVersion } from "./lib/desktop-version.js";
import { createDesktopServices } from "./services.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createSkillStore } from "./skill-store.js";
import { createJobController } from "./job-controller.js";
import { createRoutineController } from "./routine-controller.js";
import { createEventTriggerController } from "./event-trigger-controller.js";
import { createChiefLoop } from "./chief-loop.js";
import { coworkerAgentId } from "./provider-roster.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = process.env.SOVEREIGNBOT_V44_EVIDENCE_DIR ?? join(WORKTREE_ROOT, "_evidence_v44_2026-08-30");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FILE_BODY_CANARY = "V44_FILE_BODY_MUST_NEVER_REACH_PROVIDER";

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
          const task = { id: `task_${++taskSeq}`, planId, status: "queued", title: spec.title, input: spec.input, executionContext, supervisorId };
          tasks.push(task);
          return structuredClone(task);
        },
        async runUntilIdle() {
          for (const task of tasks) {
            if (task.status !== "queued") continue;
            task.status = "completed";
            task.result = { text: `V4.4 gate completed: ${task.title}` };
          }
        },
        async listTasks() { return structuredClone(tasks); },
        async aggregatePlan(planId) { return { planId, status: "completed" }; },
        async cancel(taskId) { const task = tasks.find((entry) => entry.id === taskId); if (task) task.status = "cancelled"; },
      },
    },
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

function projectTrigger(trigger) {
  if (!trigger) return undefined;
  return {
    id: trigger.id,
    name: trigger.name,
    enabled: trigger.enabled,
    routineId: trigger.routineId,
    workspaceId: trigger.workspaceId,
    pathPrefix: trigger.pathPrefix,
    lastEventAt: trigger.lastEventAt,
    lastRelativePath: trigger.lastRelativePath,
    lastStatus: trigger.lastStatus,
    lastError: trigger.lastError,
    failureCount: trigger.failureCount,
  };
}

function projectRoutine(routine) {
  return routine ? {
    id: routine.id,
    enabled: routine.enabled,
    workspaceId: routine.workspaceId,
    nextRunAt: routine.nextRunAt,
    history: (routine.history ?? []).map((run) => ({
      id: run.id,
      source: run.source,
      triggerId: run.triggerId,
      eventId: run.eventId,
      relativePath: run.relativePath,
      eventType: run.eventType,
      workspaceId: run.workspaceId,
      observedAt: run.observedAt,
      scheduledFor: run.scheduledFor,
      jobId: run.jobId,
      status: run.status,
    })),
  } : undefined;
}

export async function runVerifyV44EventTriggers({ app }) {
  const { dialog } = await import("electron");
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const log = [];
  const checks = {};
  const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
  const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };

  let dataDir;
  let trustedWorkspace;
  let workspaceId;
  let win;
  let unbind;
  let uninstallProtocol;
  let routines;
  let eventTriggers;
  let jobs;
  let chiefLoop;
  let runtimeHarness;
  let surface;
  let english;
  let chinese;
  let visual = { method: undefined, attempts: [], image: undefined };
  let fatal;
  let routine;
  let trigger;
  let stormRoutine;
  let stormTrigger;
  let eventJobIds = [];
  let restartState;
  let disabledRoutineState;
  let removedWorkspaceState;
  let stormState;
  let watcherErrorState;

  async function renderer(script) {
    return await win.webContents.executeJavaScript(script);
  }

  async function waitFor(label, predicate, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await predicate();
      if (last) return last;
      await sleep(150);
    }
    let diagnostics;
    try {
      diagnostics = {
        last,
        watcher: eventTriggers?.diagnostics?.(),
        trigger: eventTriggers?.list?.().triggers?.map(projectTrigger),
        routineHistoryCount: routine ? routines?.get(routine.id)?.history?.length : undefined,
        jobIds: jobs?.listJobs?.().jobs?.map((job) => job.id),
      };
    } catch (error) {
      diagnostics = { last, diagnosticsError: String(error?.message ?? error) };
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(diagnostics)}`);
  }

  async function drainChief() {
    await eventTriggers.flush();
    await chiefLoop.tickNow();
    await jobs.flush();
  }

  async function waitForCompletedJob(jobId) {
    await waitFor(`completed Job ${jobId}`, async () => {
      await drainChief();
      const job = jobs.getJob(jobId);
      return job.status === "completed" ? job : false;
    });
  }

  function eventHistory(routineId) {
    return routines.get(routineId).history.filter((entry) => entry.source === "event");
  }

  function snapshotRunIds(routineId) {
    return new Set(eventHistory(routineId).map((entry) => entry.id));
  }

  function snapshotJobIds() {
    return new Set(jobs.listJobs().jobs.map((job) => job.id));
  }

  async function waitForNewEventRun(routineId, relativePath, priorRunIds, priorJobIds, label = "new event Job") {
    return await waitFor(label, async () => {
      await eventTriggers.flush();
      const run = eventHistory(routineId).find((entry) => entry.relativePath === relativePath && !priorRunIds.has(entry.id) && entry.jobId && !priorJobIds.has(entry.jobId));
      return run?.jobId ?? false;
    });
  }

  async function waitForWatcherReady(triggerId, label = "watcher installed") {
    await waitFor(label, async () => {
      const diagnostics = eventTriggers.diagnostics();
      const current = eventTriggers.get(triggerId);
      return diagnostics.watchers.some((entry) => entry.workspaceId === workspaceId) && current?.enabled === true && !["blocked", "error", "disabled"].includes(current?.lastStatus);
    });
    await sleep(750);
  }

  async function writeEvent(relativePath, value = FILE_BODY_CANARY) {
    const target = join(trustedWorkspace, ...relativePath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value, "utf8");
  }

  async function writeBurst(relativePath, values = ["one", "two", "three"]) {
    const target = join(trustedWorkspace, ...relativePath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    for (const value of values) {
      await writeFile(target, value, "utf8");
      await sleep(140);
    }
    await sleep(1000);
  }

  try {
    dataDir = process.env.SOVEREIGNBOT_DESKTOP_DATA_DIR ?? await mkdtemp(join(tmpdir(), "sovereign-v44-"));
    await mkdir(dataDir, { recursive: true });
    process.env.SOVEREIGNBOT_DESKTOP_DATA_DIR = dataDir;
    const stateDir = join(dataDir, "desktop-state");
    await mkdir(stateDir, { recursive: true });
    trustedWorkspace = join(dataDir, "trusted-workspace");
    await mkdir(join(trustedWorkspace, "inbox"), { recursive: true });
    await mkdir(join(trustedWorkspace, "outside"), { recursive: true });
    await mkdir(join(trustedWorkspace, "storm"), { recursive: true });

    const services = createDesktopServices({ dataDir, dialog });
    const registered = services.addWorkspacePath(trustedWorkspace);
    workspaceId = registered.workspace?.id;
    check("isolated trusted workspace registered through services", Boolean(workspaceId) && services.workspacePath(workspaceId) === trustedWorkspace, JSON.stringify({ workspaceId }));

    const coworkerStore = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
    coworkerStore.ensureDefaults();
    const coworkers = coworkerStore.list().coworkers;
    const chief = coworkers.find((entry) => /chief of staff/i.test(entry.name)) ?? coworkers[0];
    const skillStore = createSkillStore({ persistPath: join(stateDir, "skills.json") });
    const conversationStore = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore });
    runtimeHarness = fakeRuntime();
    const roster = {
      ready: true,
      mode: "provider",
      roles: { planner: "v44-gate-supervisor" },
      agents: [],
      providers: { codex: { usable: true, present: true, version: "v44-gate" } },
      coworkerBindings: Object.fromEntries(coworkers.map((entry) => [entry.id, { ready: true, agentId: coworkerAgentId(entry.id), provider: "fake" }])) ,
    };

    jobs = createJobController({
      dataDir,
      runtime: runtimeHarness.runtime,
      roster: () => roster,
      coworkerStore,
      services,
      skillStore,
      supervisorAgentId: "v44-gate-supervisor",
      readiness: () => ({ allowed: true }),
    });
    routines = createRoutineController({ dataDir, jobController: jobs, coworkerStore, skillStore, services, persistPath: join(stateDir, "routines.json") });
    // The production default is ten fires per ten minutes. The gate injects a smaller
    // deterministic threshold so storm protection is proven without waiting for a quota.
    eventTriggers = createEventTriggerController({ dataDir, routineController: routines, services, maxFires: 3 });
    chiefLoop = createChiefLoop({ jobController: jobs, goalController: undefined, roster: () => roster });
    routines.start();
    eventTriggers.start();
    chiefLoop.start();

    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow();
    unbind = bindIpcChannels({
      win,
      handlers: {
        "app:handshake": () => ({ ok: true, version: desktopVersion(), platform: process.platform, locale: "en-US", language: services.getSettings().language }),
        "firstrun:getStatus": () => ({ browsers: [], providers: {} }),
        "workspace:list": () => services.listWorkspaces(),
        "workspace:addViaDialog": () => ({ added: false }),
        "workspace:setDefault": ({ id }) => ({ ok: services.setDefaultWorkspace(id) }),
        "workspace:remove": ({ id }) => { const removed = services.removeWorkspace(id); eventTriggers?.reconcile(); return { removed }; },
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
        "routine:setEnabled": ({ routineId, enabled }) => { const result = routines.setEnabled(routineId, enabled); eventTriggers?.reconcile(); return result; },
        "routine:remove": ({ routineId }) => { const result = routines.remove(routineId); eventTriggers?.reconcile(); return result; },
        "eventTrigger:create": (payload) => eventTriggers.create(payload),
        "eventTrigger:list": () => eventTriggers.list(),
        "eventTrigger:get": ({ triggerId }) => eventTriggers.get(triggerId),
        "eventTrigger:setEnabled": ({ triggerId, enabled }) => eventTriggers.setEnabled(triggerId, enabled),
        "eventTrigger:remove": ({ triggerId }) => eventTriggers.remove(triggerId),
      },
    });

    await win.loadURL(appOrigin());
    await renderer("(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()");
    await sleep(900);
    surface = await renderer(`({
      work: !!document.getElementById('nav-work'),
      attention: !!document.getElementById('nav-attention'),
      routines: !!document.getElementById('nav-routines'),
      triggers: !!document.getElementById('nav-triggers'),
      settings: !!document.getElementById('nav-settings'),
      workView: !!document.getElementById('view-work'),
      attentionView: !!document.getElementById('view-attention'),
      routinesView: !!document.getElementById('view-routines'),
      triggersView: !!document.getElementById('view-triggers'),
      settingsView: !!document.getElementById('view-settings'),
      chiefConversation: !!document.getElementById('view-conversation') && !!document.getElementById('conversation-messages'),
      triggerApi: typeof window.sovereignbot?.eventTriggers?.create === 'function'
    })`);
    check("real renderer exposes V4.4 surface without removing Chief/Work/Routines/Attention", Object.values(surface).every(Boolean), JSON.stringify(surface));

    const routineFromRenderer = await renderer(`window.sovereignbot.routines.create(${JSON.stringify({
      name: "Inbox review",
      coworkerId: chief.id,
      instruction: "Review the changed workspace item through the governed Job path.",
      workspaceId,
      schedule: { type: "daily", time: "23:59" },
    })})`);
    routine = routineFromRenderer;
    const nextRunAtBeforeEvent = routine.nextRunAt;
    check("enabled recurring Routine created through real renderer IPC", routine.enabled && routine.schedule.type === "daily" && routine.workspaceId === workspaceId, JSON.stringify({ id: routine.id, schedule: routine.schedule }));

    // Pre-create the target before installing the watcher so Windows reports the
    // verification writes as file changes rather than an initial file-create event.
    await writeFile(join(trustedWorkspace, "inbox", "order.json"), "baseline", "utf8");

    await renderer("document.getElementById('nav-triggers')?.click()");
    await sleep(300);
    await renderer("document.getElementById('triggers-new')?.click()");
    await waitFor("Triggers create dialog", async () => await renderer("document.getElementById('trigger-dialog')?.open === true"));
    await renderer(`(()=>{
      document.getElementById('trigger-name').value='Inbox file changes';
      document.getElementById('trigger-routine').value=${JSON.stringify(routine.id)};
      document.getElementById('trigger-workspace').value=${JSON.stringify(workspaceId)};
      document.getElementById('trigger-prefix').value='inbox/order.json';
      document.getElementById('trigger-form').requestSubmit();
      return true;
    })()`);
    await waitFor("trigger creation through renderer form", async () => {
      const result = await renderer("window.sovereignbot.eventTriggers.list({})");
      return result?.triggers?.find((entry) => entry.name === "Inbox file changes");
    });
    const triggerList = await renderer("window.sovereignbot.eventTriggers.list({})");
    trigger = triggerList.triggers.find((entry) => entry.name === "Inbox file changes");
    check("trigger created through dedicated UI and exact IPC", trigger?.enabled && trigger.routineId === routine.id && trigger.workspaceId === workspaceId && trigger.pathPrefix === "inbox/order.json", JSON.stringify(projectTrigger(trigger)));
    check("trigger state persists only bounded metadata", trigger && !Object.keys(trigger).some((key) => /content|token|cookie|secret|shell|command|provider/i.test(key)), JSON.stringify(Object.keys(trigger ?? {})));
    await waitForWatcherReady(trigger.id);

    const firstPriorRunIds = snapshotRunIds(routine.id);
    const firstPriorJobIds = snapshotJobIds();
    const jobsBeforeEvent = jobs.listJobs().jobs.length;
    await writeBurst("inbox/order.json", [FILE_BODY_CANARY, "V4.4 trailing debounce second write", "V4.4 trailing debounce final write"]);
    const firstEventJobId = await waitForNewEventRun(routine.id, "inbox/order.json", firstPriorRunIds, firstPriorJobIds, "first real event Job");
    const firstEventRun = routines.get(routine.id).history.find((entry) => entry.jobId === firstEventJobId);
    await waitForCompletedJob(firstEventJobId);
    await eventTriggers.flush();
    const firstRunCount = eventHistory(routine.id).filter((entry) => !firstPriorRunIds.has(entry.id)).length;
    eventJobIds = eventHistory(routine.id).map((entry) => entry.jobId);
    const firstJob = jobs.getJob(firstEventJobId);
    const firstTask = runtimeHarness.tasks.find((entry) => firstJob.taskIds?.includes(entry.id));
    check("real fs.watch trailing-debounce burst creates exactly one event Routine run and Job", firstRunCount === 1 && jobs.listJobs().jobs.length === jobsBeforeEvent + 1, JSON.stringify({ firstRunCount, jobs: jobs.listJobs().jobs.length, diagnostics: eventTriggers.diagnostics() }));
    check("event Job uses the existing governed Chief/Job path", firstJob.status === "completed" && firstJob.routineId === routine.id && firstJob.workspaceId === workspaceId && firstTask?.supervisorId === "v44-gate-supervisor" && firstTask?.executionContext?.workspaceId === workspaceId, JSON.stringify({ job: { id: firstJob.id, status: firstJob.status, routineId: firstJob.routineId, workspaceId: firstJob.workspaceId }, task: firstTask && { id: firstTask.id, supervisorId: firstTask.supervisorId, executionContext: firstTask.executionContext } }));
    const firstRoutineAfter = routines.get(routine.id);
    check("Routine history links event source, path, workspace, and Job", firstEventRun.source === "event" && firstEventRun.triggerId === trigger.id && firstEventRun.workspaceId === workspaceId && firstEventRun.jobId === firstJob.id && firstEventRun.eventType === "change" && firstEventRun.observedAt, JSON.stringify(projectRoutine(firstRoutineAfter)));
    check("event run leaves recurring nextRunAt unchanged", firstRoutineAfter.nextRunAt === nextRunAtBeforeEvent, JSON.stringify({ before: nextRunAtBeforeEvent, after: firstRoutineAfter.nextRunAt }));

    const delegatedInstruction = firstTask?.input?.instruction ?? "";
    const eventBlockMatch = delegatedInstruction.match(/<untrusted_event_data>([\s\S]*?)<\/untrusted_event_data>/);
    let delegatedMetadata;
    try { delegatedMetadata = eventBlockMatch ? JSON.parse(eventBlockMatch[1]) : undefined; } catch {}
    check("delegated instruction carries exact untrusted event metadata", delegatedMetadata && Object.keys(delegatedMetadata).sort().join(",") === "eventId,observedAt,relativePath,source,triggerId" && delegatedMetadata.source === "workspace-file-change" && delegatedMetadata.triggerId === trigger.id && delegatedMetadata.relativePath === "inbox/order.json" && delegatedMetadata.observedAt === firstEventRun.observedAt, JSON.stringify({ delegatedMetadata }));
    check("event body canary and absolute workspace path never reach provider-facing instruction", !firstJob.objective.includes(FILE_BODY_CANARY) && !delegatedInstruction.includes(FILE_BODY_CANARY) && !delegatedInstruction.includes(trustedWorkspace), JSON.stringify({ objective: firstJob.objective, delegatedInstruction }));
    check("event body canary is absent from trigger state and Routine history", !JSON.stringify(projectTrigger(trigger)).includes(FILE_BODY_CANARY) && !JSON.stringify(firstRoutineAfter.history).includes(FILE_BODY_CANARY), JSON.stringify({ trigger: projectTrigger(trigger), history: projectRoutine(firstRoutineAfter) }));

    await writeEvent("outside/ignored.json", "outside path");
    await sleep(1000);
    await eventTriggers.flush();
    check("outside path prefix creates no Job", jobs.listJobs().jobs.length === jobsBeforeEvent + 1, JSON.stringify({ jobs: jobs.listJobs().jobs.length }));

    // Prove the cancellation race against the real renderer/controller path: wait
    // until fs.watch has delivered a pending event, then disable before quiet expiry.
    const jobsBeforePendingDisable = jobs.listJobs().jobs.length;
    const historyBeforePendingDisable = snapshotRunIds(routine.id);
    await writeEvent("inbox/order.json", "pending event must be cancelled");
    await waitFor("pending event before disable", async () => eventTriggers.diagnostics().pending.some((entry) => entry.triggerId === trigger.id));
    await renderer(`window.sovereignbot.eventTriggers.setEnabled(${JSON.stringify({ triggerId: trigger.id, enabled: false })})`);
    await eventTriggers.flush();
    check("disable during pending cancels the event without a Job", jobs.listJobs().jobs.length === jobsBeforePendingDisable && !eventHistory(routine.id).some((entry) => !historyBeforePendingDisable.has(entry.id)), JSON.stringify({ jobs: jobs.listJobs().jobs.length, history: eventHistory(routine.id) }));

    await renderer(`window.sovereignbot.eventTriggers.setEnabled(${JSON.stringify({ triggerId: trigger.id, enabled: true })})`);
    await waitForWatcherReady(trigger.id, "watcher after explicit re-enable");
    const reenabledPriorRunIds = snapshotRunIds(routine.id);
    const reenabledPriorJobIds = snapshotJobIds();
    await writeEvent("inbox/order.json", "future event after re-enable");
    const reenabledRun = await waitForNewEventRun(routine.id, "inbox/order.json", reenabledPriorRunIds, reenabledPriorJobIds, "re-enabled event Job");
    await waitForCompletedJob(reenabledRun);
    check("re-enabled trigger resumes future events", eventHistory(routine.id).filter((entry) => !firstPriorRunIds.has(entry.id)).length === 2, JSON.stringify(projectRoutine(routines.get(routine.id))));

    const jobsBeforeRestart = jobs.listJobs().jobs.length;
    const restartPriorRunIds = snapshotRunIds(routine.id);
    const restartPriorJobIds = snapshotJobIds();
    eventTriggers.stop();
    eventTriggers = createEventTriggerController({ dataDir, routineController: routines, services, maxFires: 3 });
    eventTriggers.start();
    await waitForWatcherReady(trigger.id, "watcher after controller restart");
    check("controller restart restores durable trigger without replay", jobs.listJobs().jobs.length === jobsBeforeRestart && eventTriggers.get(trigger.id).enabled === true && snapshotRunIds(routine.id).size === restartPriorRunIds.size, JSON.stringify({ jobs: jobs.listJobs().jobs.length, trigger: projectTrigger(eventTriggers.get(trigger.id)), diagnostics: eventTriggers.diagnostics() }));
    await writeEvent("inbox/order.json", "post-restart event");
    const restartJobId = await waitForNewEventRun(routine.id, "inbox/order.json", restartPriorRunIds, restartPriorJobIds, "post-restart event Job");
    await waitForCompletedJob(restartJobId);
    restartState = { jobs: jobs.listJobs().jobs.length, history: projectRoutine(routines.get(routine.id)) };
    check("restored watcher handles only future OS events", restartState.history.history.filter((entry) => entry.source === "event").length === 3, JSON.stringify(restartState));

    // Exercise the production watcher's fatal-error handler through its internal
    // gate-only diagnostic hook; the watcher itself is the real Windows fs.watch.
    const watcherBeforeError = eventTriggers.diagnostics();
    const watcherErrorTarget = watcherBeforeError.watchers.find((entry) => entry.workspaceId === workspaceId);
    watcherErrorTarget?.emitError(new Error("V4.4 gate watcher failure"));
    await eventTriggers.flush();
    const watcherAfterError = eventTriggers.diagnostics();
    const latchedTrigger = eventTriggers.get(trigger.id);
    const installsAfterErrorInspection = watcherAfterError.watcherInstallCount;
    eventTriggers.list();
    eventTriggers.get(trigger.id);
    eventTriggers.reconcile();
    watcherErrorState = { trigger: projectTrigger(eventTriggers.get(trigger.id)), before: watcherBeforeError, after: eventTriggers.diagnostics() };
    check("watcher failure latches the trigger as blocked and cancels the watcher", Boolean(watcherErrorTarget) && latchedTrigger.enabled === false && latchedTrigger.lastStatus === "blocked" && /workspace watcher failed/.test(latchedTrigger.lastError ?? "") && latchedTrigger.failureCount >= 1 && watcherAfterError.watchers.length === 0, JSON.stringify(watcherErrorState));
    check("list/get/reconcile do not auto-reopen a watcher failure latch", eventTriggers.diagnostics().watcherInstallCount === installsAfterErrorInspection && eventTriggers.diagnostics().watchers.length === 0, JSON.stringify(eventTriggers.diagnostics()));
    await renderer(`window.sovereignbot.eventTriggers.setEnabled(${JSON.stringify({ triggerId: trigger.id, enabled: true })})`);
    await waitForWatcherReady(trigger.id, "watcher after fatal-error re-enable");
    check("explicit re-enable clears the watcher failure latch and rebuilds", eventTriggers.get(trigger.id).enabled === true && eventTriggers.get(trigger.id).lastStatus !== "blocked", JSON.stringify({ trigger: projectTrigger(eventTriggers.get(trigger.id)), diagnostics: eventTriggers.diagnostics() }));

    await renderer(`window.sovereignbot.routines.setEnabled(${JSON.stringify({ routineId: routine.id, enabled: false })})`);
    await sleep(900);
    const jobsBeforeDisabledRoutine = jobs.listJobs().jobs.length;
    await writeEvent("inbox/order.json", "event while linked Routine disabled");
    await sleep(1000);
    await eventTriggers.flush();
    disabledRoutineState = { trigger: projectTrigger(eventTriggers.get(trigger.id)), jobs: jobs.listJobs().jobs.length };
    check("disabled linked Routine fails closed", disabledRoutineState.trigger.lastStatus === "blocked" && disabledRoutineState.jobs === jobsBeforeDisabledRoutine, JSON.stringify(disabledRoutineState));
    await renderer(`window.sovereignbot.routines.setEnabled(${JSON.stringify({ routineId: routine.id, enabled: true })})`);
    await sleep(900);
    await waitForWatcherReady(trigger.id, "watcher after linked Routine re-enable");
    const resumedPriorRunIds = snapshotRunIds(routine.id);
    const resumedPriorJobIds = snapshotJobIds();
    await writeEvent("inbox/order.json", "future event after Routine re-enable");
    const resumedJobId = await waitForNewEventRun(routine.id, "inbox/order.json", resumedPriorRunIds, resumedPriorJobIds, "resumed Routine event Job");
    await waitForCompletedJob(resumedJobId);
    check("Routine re-enable restores future trigger events", routines.get(routine.id).history.filter((entry) => entry.source === "event").length === 4, JSON.stringify(projectRoutine(routines.get(routine.id))));

    stormRoutine = await renderer(`window.sovereignbot.routines.create(${JSON.stringify({
      name: "Storm review",
      coworkerId: chief.id,
      instruction: "Record bounded event storm metadata.",
      workspaceId,
      schedule: { type: "hourly", minute: 17 },
    })})`);
    const stormPaths = ["storm-a.json", "storm-b.json", "storm-c.json", "storm-d.json"];
    for (const path of stormPaths) await writeEvent(path, "storm baseline");
    // An empty prefix deliberately exercises the documented whole-workspace mode.
    // Keep the storm fixtures at the workspace root so Windows recursive fs.watch
    // cannot collapse nested-directory callbacks into one parent-directory event.
    stormTrigger = await renderer(`window.sovereignbot.eventTriggers.create(${JSON.stringify({ name: "Storm guard", routineId: stormRoutine.id, workspaceId, pathPrefix: "" })})`);
    check("second trigger uses the same trusted workspace watcher domain", stormTrigger.enabled && stormTrigger.pathPrefix === "", JSON.stringify(projectTrigger(stormTrigger)));
    await waitForWatcherReady(stormTrigger.id, "watcher for storm trigger");
    const jobsBeforeStorm = jobs.listJobs().jobs.length;
    for (const path of stormPaths.slice(0, 3)) {
      const stormPriorRunIds = snapshotRunIds(stormRoutine.id);
      const stormPriorJobIds = snapshotJobIds();
      await writeEvent(path, "storm metadata only");
      const stormJobId = await waitForNewEventRun(stormRoutine.id, path, stormPriorRunIds, stormPriorJobIds, `storm event ${path}`);
      await waitForCompletedJob(stormJobId);
    }
    check("trailing debounce permits one governed storm fire per quiet expiry", jobs.listJobs().jobs.length === jobsBeforeStorm + 3 && eventHistory(stormRoutine.id).length === 3, JSON.stringify({ jobs: jobs.listJobs().jobs.length, history: projectRoutine(routines.get(stormRoutine.id)) }));

    const stormRestartPriorRunIds = snapshotRunIds(stormRoutine.id);
    const stormRestartPriorJobIds = snapshotJobIds();
    eventTriggers.stop();
    eventTriggers = createEventTriggerController({ dataDir, routineController: routines, services, maxFires: 3 });
    eventTriggers.start();
    await waitForWatcherReady(stormTrigger.id, "watcher after storm accounting restart");
    check("storm accounting restart does not replay prior events", snapshotRunIds(stormRoutine.id).size === stormRestartPriorRunIds.size && snapshotJobIds().size === stormRestartPriorJobIds.size, JSON.stringify({ history: projectRoutine(routines.get(stormRoutine.id)), diagnostics: eventTriggers.diagnostics() }));

    const fourthStormPriorRunIds = snapshotRunIds(stormRoutine.id);
    const fourthStormPriorJobIds = snapshotJobIds();
    await writeEvent(stormPaths[3], "storm metadata only fourth");
    await waitFor("event storm protection", async () => {
      await eventTriggers.flush();
      const current = eventTriggers.get(stormTrigger.id);
      return current.enabled === false && current.lastStatus === "blocked" ? current : false;
    }, 15_000);
    stormState = { trigger: projectTrigger(eventTriggers.get(stormTrigger.id)), jobs: jobs.listJobs().jobs.length, history: projectRoutine(routines.get(stormRoutine.id)), diagnostics: eventTriggers.diagnostics() };
    check("event storm protection disables trigger and records reason", stormState.trigger.enabled === false && stormState.trigger.lastStatus === "blocked" && /event storm protection/.test(stormState.trigger.lastError ?? "") && stormState.jobs === jobsBeforeStorm + 3 && snapshotRunIds(stormRoutine.id).size === fourthStormPriorRunIds.size && snapshotJobIds().size === fourthStormPriorJobIds.size, JSON.stringify(stormState));

    const jobsBeforeWorkspaceRemoval = jobs.listJobs().jobs.length;
    services.removeWorkspace(workspaceId);
    eventTriggers.reconcile();
    await writeEvent("inbox/order.json");
    await sleep(1000);
    await eventTriggers.flush();
    removedWorkspaceState = { trigger: projectTrigger(eventTriggers.get(trigger.id)), jobs: jobs.listJobs().jobs.length };
    check("removed trusted Workspace fails closed", removedWorkspaceState.trigger.lastStatus === "blocked" && removedWorkspaceState.jobs === jobsBeforeWorkspaceRemoval, JSON.stringify(removedWorkspaceState));

    await renderer("document.getElementById('nav-triggers')?.click()");
    await sleep(300);
    english = await renderer(`({ lang: document.documentElement.lang, visible: document.getElementById('view-triggers')?.classList.contains('hidden') === false, body: document.getElementById('view-triggers')?.innerText || '', dialog: document.getElementById('trigger-dialog')?.innerText || '', active: [...document.querySelectorAll('.utility-nav.active')].map((entry)=>entry.id) })`);
    const requiredEnglish = ["Triggers", "Run an enabled recurring Routine", "Events are observed only while SovereignBot is running.", "File contents are never read automatically.", "Last event", "Path", "Status", "Failures", "Disable", "Remove"];
    check("English Triggers UI shows explicit event state and controls", english.lang === "en" && english.visible && english.active.length === 1 && english.active[0] === "nav-triggers" && requiredEnglish.every((label) => english.body.includes(label)), JSON.stringify({ lang: english.lang, active: english.active }));
    check("storm-protected trigger card is visibly Blocked with failure state", english.body.includes("Blocked") && english.body.includes("Failures"), JSON.stringify({ body: english.body }));
    check("Triggers form exposes only governed fields", ["Name", "Routine", "Trusted workspace", "Path prefix"].every((label) => english.dialog.includes(label)) && !/(webhook|cron|shell|script|manual authority|provider session)/i.test(`${english.body}\n${english.dialog}`), JSON.stringify({ dialog: english.dialog }));

    visual = await captureVisualEvidence(win);
    check("real Triggers window visual evidence captured", Boolean(visual.image) && !visual.image.isEmpty(), JSON.stringify({ method: visual.method, attempts: visual.attempts }));
    if (visual.image && !visual.image.isEmpty()) await writeFile(join(EVIDENCE_DIR, "verify-v44-event-triggers.png"), visual.image.toPNG());

    await renderer("document.getElementById('setting-language').value='zh-CN'; document.getElementById('setting-language').dispatchEvent(new Event('change',{bubbles:true}))");
    await sleep(450);
    await renderer("document.getElementById('nav-triggers')?.click()");
    await sleep(300);
    chinese = await renderer(`({ lang: document.documentElement.lang, body: document.getElementById('view-triggers')?.innerText || '', dialog: document.getElementById('trigger-dialog')?.innerText || '' })`);
    const requiredChinese = ["触发器", "仅在 SovereignBot 运行时观察新事件。", "系统不会自动读取文件内容。", "最近事件", "路径", "状态", "失败次数", "已阻断", "名称", "例行任务", "受信任工作区", "路径前缀"];
    check("zh-CN Triggers UI", chinese.lang === "zh-CN" && requiredChinese.every((label) => `${chinese.body}\n${chinese.dialog}`.includes(label)), JSON.stringify({ lang: chinese.lang, requiredChinese }));
    check("zh-CN storm-protected trigger card is visibly 已阻断", chinese.body.includes("已阻断"), JSON.stringify({ body: chinese.body }));
    await renderer("document.getElementById('setting-language').value='en'; document.getElementById('setting-language').dispatchEvent(new Event('change',{bubbles:true}))");
    await sleep(350);

    const scroll = await renderer(`(async()=>{
      for (const id of ['nav-work','nav-attention','nav-routines','nav-triggers','nav-settings']) {
        document.getElementById(id)?.click();
        await new Promise((resolve)=>setTimeout(resolve,180));
      }
      return { window: window.scrollY, document: document.scrollingElement?.scrollTop, active: [...document.querySelectorAll('.utility-nav.active')].map((entry)=>entry.id), chief: !!document.getElementById('view-conversation'), work: !!document.getElementById('view-work'), routines: !!document.getElementById('view-routines'), attention: !!document.getElementById('view-attention') };
    })()`);
    check("Work/Routines/Attention/Chief navigation and root scroll remain intact", scroll.window === 0 && scroll.document === 0 && scroll.active.length === 1 && scroll.active[0] === "nav-settings" && scroll.chief && scroll.work && scroll.routines && scroll.attention, JSON.stringify(scroll));
  } catch (error) {
    fatal = error;
    note(`[fatal] ${String(error?.stack ?? error)}`);
    check("V4.4 real Electron event trigger gate completed", false, String(error?.message ?? error));
  }

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
  const triggerProjection = eventTriggers ? eventTriggers.list().triggers.map(projectTrigger) : undefined;
  const routineProjection = routine ? projectRoutine(routines?.get(routine.id)) : undefined;
  const jobProjection = jobs ? jobs.listJobs().jobs.map((job) => ({ id: job.id, status: job.status, routineId: job.routineId, requestedWorkspaceId: job.requestedWorkspaceId, workspaceId: job.workspaceId, scheduledFor: job.scheduledFor })) : undefined;
  const summary = {
    at: new Date().toISOString(),
    dataDir,
    evidenceDir: EVIDENCE_DIR,
    checks,
    visualEvidence: { method: visual.method, attempts: visual.attempts, captured: Boolean(visual.image) && !visual.image.isEmpty() },
    productSurface: surface,
    english: english ? { lang: english.lang, visible: english.visible, active: english.active } : undefined,
    chinese: chinese ? { lang: chinese.lang } : undefined,
    trigger: triggerProjection,
    routine: routineProjection,
    storm: stormState,
    watcherError: watcherErrorState,
    restart: restartState,
    disabledRoutine: disabledRoutineState,
    removedWorkspace: removedWorkspaceState,
    eventJobIds,
    jobs: jobProjection,
    runtimeTasks: runtimeHarness?.tasks?.map((task) => ({ id: task.id, planId: task.planId, status: task.status, title: task.title, input: task.input, supervisorId: task.supervisorId, executionContext: task.executionContext })) ?? [],
    fatal: fatal ? String(fatal?.message ?? fatal) : undefined,
  };
  await writeFile(join(EVIDENCE_DIR, "verify-v44-event-triggers.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(join(EVIDENCE_DIR, "verify-v44-event-triggers.log"), `${log.join("\n")}\n`, "utf8");

  try { eventTriggers?.stop(); } catch {}
  try { routines?.stop(); } catch {}
  try { chiefLoop?.stop(); } catch {}
  try { await eventTriggers?.flush?.(); } catch {}
  try { unbind?.(); } catch {}
  try { uninstallProtocol?.(); } catch {}
  try { win?.destroy(); } catch {}

  if (fatal || failed.length) throw new Error(`V4.4 Event Trigger gate failed: ${failed.join(", ") || String(fatal?.message ?? fatal)}`);
  app.exit(0);
}
