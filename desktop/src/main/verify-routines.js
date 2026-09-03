// V4.2 Routines vertical gate. Runs in a real Electron window with isolated state,
// deterministic Job execution, real IPC/preload/UI, and an injected clock so the system
// clock is never changed. Triggered only by the dedicated verify-routines entrypoint.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopVersion } from "./lib/desktop-version.js";
import { createDesktopServices } from "./services.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createSkillStore } from "./skill-store.js";
import { createJobController } from "./job-controller.js";
import { createChiefLoop } from "./chief-loop.js";
import { createRoutineController } from "./routine-controller.js";
import { EVENT_TRIGGERS_SCHEMA } from "./event-trigger-controller.js";
import { coworkerAgentId } from "./provider-roster.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(WORKTREE_ROOT, "_evidence_v42_2026-08-29");
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
            task.result = { text: `routine gate completed: ${task.title}` };
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

export async function runVerifyRoutines({ app, routineActionsGate = false }) {
  const { dialog } = await import("electron");
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const evidenceBase = routineActionsGate ? "verify-p30-routine-actions" : "verify-v42-routines";
  const log = [];
  const checks = {};
  const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
  const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-v42-"));
  process.env.SOVEREIGNBOT_DESKTOP_DATA_DIR = dataDir;
  const workspacePath = join(dataDir, "gate-workspace");
  await mkdir(workspacePath, { recursive: true });

  const services = createDesktopServices({ dataDir, dialog });
  const workspaceResult = services.addWorkspacePath(workspacePath);
  const workspaceId = workspaceResult.workspace?.id;
  const coworkerStore = createCoworkerStore({ persistPath: join(dataDir, "desktop-state", "coworkers.json") });
  coworkerStore.ensureDefaults();
  const coworkers = coworkerStore.list().coworkers;
  const chief = coworkers.find((entry) => /chief of staff/i.test(entry.name)) ?? coworkers[0];
  const conversationStore = createConversationStore({ persistPath: join(dataDir, "desktop-state", "conversations.json"), coworkerStore });
  const skillStore = createSkillStore({ persistPath: join(dataDir, "desktop-state", "skills.json") });
  const fake = fakeRuntime();
  const roster = {
    ready: true,
    mode: "provider",
    roles: { planner: "gate-supervisor" },
    agents: [],
    providers: { codex: { usable: true, present: true, version: "gate" } },
    coworkerBindings: Object.fromEntries(coworkers.map((entry) => [entry.id, { ready: true, agentId: coworkerAgentId(entry.id), provider: "codex" }])),
  };
  const persistPath = join(dataDir, "desktop-state", "routines.json");
  const clock = { value: new Date(2026, 7, 29, 10, 20, 0, 0).getTime() };
  const jobs = createJobController({
    dataDir,
    runtime: fake.runtime,
    roster: () => roster,
    coworkerStore,
    services,
    skillStore,
    supervisorAgentId: "gate-supervisor",
    readiness: () => ({ allowed: true }),
  });
  let routines = createRoutineController({ dataDir, jobController: jobs, coworkerStore, skillStore, services, persistPath, now: () => clock.value });
  const chiefLoop = createChiefLoop({ jobController: jobs, goalController: { listGoals: () => ({ goals: [] }) }, roster: () => roster });

  const uninstallProtocol = installAppProtocolHandler();
  const win = createMainWindow();
  let routineRunCalls = 0;
  let routineRestoreCalls = 0;
  let unbind;
  try {
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
        "team:list": () => ({ teams: [], playbooks: [] }),
        "project:list": () => ({ projects: [] }),
        "skill:list": ({ includeArchived }) => skillStore.list({ includeArchived }),
        "skill:get": ({ skillId }) => skillStore.get(skillId),
        "artifact:list": () => ({ artifacts: [] }),
        "artifact:attachViaDialog": () => ({ canceled: true, artifacts: [] }),
        "job:list": () => jobs.listJobs(),
        "job:getStatus": ({ jobId }) => jobs.getJob(jobId),
        "job:getConversation": ({ jobId }) => jobs.getConversation(jobId),
        "job:cancel": ({ jobId }) => jobs.cancel(jobId),
        "job:pause": ({ jobId }) => jobs.pause(jobId),
        "job:resume": ({ jobId }) => jobs.resume(jobId),
        "job:approve": ({ jobId }) => jobs.approve(jobId),
        "job:dismiss": ({ jobId }) => jobs.dismiss(jobId),
        "job:attention": () => jobs.attentionJobs(),
        "notification:list": () => ({ notifications: [] }),
        "data:status": () => ({ backups: [] }),
        "data:listBackups": () => ({ backups: [] }),
        "update:status": () => ({ available: false }),
        "connectedApps:list": () => ({ apps: [] }),
        "workerNode:list": () => ({ nodes: [] }),
        "memory:list": () => ({ memory: [], suggestions: [] }),
        "memory:listSuggestions": () => ({ suggestions: [] }),
        "routine:create": (payload) => routines.create(payload),
        "routine:list": (payload) => routines.list(payload),
        "routine:get": ({ routineId }) => routines.get(routineId),
        "routine:history": ({ routineId }) => routines.history(routineId),
        "routine:runNow": async ({ routineId }) => { routineRunCalls += 1; if (routineActionsGate) await sleep(120); return routines.runNow(routineId); },
        "routine:archive": ({ routineId }) => routines.archive(routineId),
        "routine:restore": async ({ routineId }) => { routineRestoreCalls += 1; if (routineActionsGate) await sleep(120); return routines.restore(routineId); },
        "routine:setEnabled": ({ routineId, enabled }) => routines.setEnabled(routineId, enabled),
        "routine:remove": ({ routineId }) => routines.remove(routineId),
        // The V4.2 harness does not instantiate the V4.4 controller, but the
        // shared renderer now hydrates this read-only surface on startup.
        "eventTrigger:list": () => ({ schema: EVENT_TRIGGERS_SCHEMA, triggers: [] }),
      },
    });

    await win.loadURL(appOrigin());
    await win.webContents.executeJavaScript("(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()");
    await sleep(600);

    const minute = (new Date(clock.value).getMinutes() + 1) % 60;
    const routine = await win.webContents.executeJavaScript(`window.sovereignbot.routines.create(${JSON.stringify({
      name: "V4.2 gate hourly",
      coworkerId: chief.id,
      instruction: "Write a harmless V4.2 routine gate result.",
      workspaceId,
      schedule: { type: "hourly", minute },
    })})`);
    check("routine created through renderer IPC", /^routine_/.test(routine.id));
    const firstDue = Date.parse(routine.nextRunAt);
    const scheduledFor = routine.nextRunAt;
    clock.value = firstDue + 1000;
    await routines.tickNow();
    const afterRoutineTick = jobs.listJobs().jobs;
    check("due routine creates exactly one Job", afterRoutineTick.length === 1, `jobs=${afterRoutineTick.length}`);
    check("Routine never executes provider directly", fake.tasks.length === 0, `tasks=${fake.tasks.length}`);
    check("Job carries Routine identity", afterRoutineTick[0]?.routineId === routine.id);
    check("Job remains queued until existing Chief path wakes it", afterRoutineTick[0]?.status === "queued", afterRoutineTick[0]?.status);
    const advanced = routines.get(routine.id).nextRunAt;
    check("nextRunAt pre-advanced past now", Date.parse(advanced) > clock.value, advanced);

    await chiefLoop.tickNow();
    await jobs.flush();
    const job = jobs.listJobs().jobs[0];
    check("Chief loop executes existing Job path", job?.status === "completed", job?.status);
    const delegatedTask = fake.tasks[0];
    check(
      "trusted Routine workspace reaches delegateTrusted execution context",
      delegatedTask?.executionContext?.workspaceId === workspaceId && delegatedTask?.executionContext?.cwd === workspacePath,
      JSON.stringify({ workspaceId: delegatedTask?.executionContext?.workspaceId, cwd: delegatedTask?.executionContext?.cwd }),
    );
    check(
      "Routine metadata reaches governed Job task",
      delegatedTask?.input?.routineId === routine.id && delegatedTask?.input?.scheduledFor === scheduledFor,
      JSON.stringify({ routineId: delegatedTask?.input?.routineId, scheduledFor: delegatedTask?.input?.scheduledFor }),
    );
    const historyAfter = routines.history(routine.id).history;
    check("Routine history links completed Job", historyAfter.length === 1 && historyAfter[0].jobId === job.id && historyAfter[0].status === "completed");

    let jobCount = jobs.listJobs().jobs.length;
    routines.stop();
    routines = createRoutineController({ dataDir, jobController: jobs, coworkerStore, skillStore, services, persistPath, now: () => clock.value });
    await routines.tickNow();
    check("restart does not duplicate prior firing", jobs.listJobs().jobs.length === jobCount, `jobs=${jobs.listJobs().jobs.length}`);

    await win.webContents.executeJavaScript(`window.sovereignbot.routines.setEnabled({routineId:${JSON.stringify(routine.id)},enabled:false})`);
    clock.value = Date.parse(advanced) + 8 * 3600_000;
    await routines.tickNow();
    check("disabled routine does not fire", jobs.listJobs().jobs.length === jobCount);
    const reenabled = await win.webContents.executeJavaScript(`window.sovereignbot.routines.setEnabled({routineId:${JSON.stringify(routine.id)},enabled:true})`);
    check("re-enable schedules future occurrence", Date.parse(reenabled.nextRunAt) > clock.value, reenabled.nextRunAt);

    if (routineActionsGate) {
      await win.webContents.executeJavaScript("document.getElementById('nav-routines').click()");
      await sleep(250);
      const createRoutineViaUi = (name, targetWorkspaceId) => win.webContents.executeJavaScript(`window.sovereignbot.routines.create(${JSON.stringify({
        name,
        coworkerId: chief.id,
        instruction: `P30 ${name} bounded action fixture.`,
        workspaceId: targetWorkspaceId,
        schedule: { type: "custom", intervalMinutes: 60 },
      })})`);
      const refreshRoutineCards = async () => { await win.webContents.executeJavaScript("window.SovereignJobsUI.refreshRoutines()"); await sleep(120); };
      const cardAction = (name, label, doubleClick = false) => win.webContents.executeJavaScript(`(async()=>{
        const card=[...document.querySelectorAll('#routine-list .job-card')].find((entry)=>entry.querySelector('strong')?.textContent===${JSON.stringify(name)});
        const button=card?[...card.querySelectorAll('button')].find((entry)=>entry.textContent.includes(${JSON.stringify(label)})):undefined;
        if(!button) return {found:false};
        button.click();
        if(${doubleClick ? "true" : "false"}) button.click();
        await new Promise((resolve)=>setTimeout(resolve,0));
        const current=[...document.querySelectorAll('#routine-list .job-card')].find((entry)=>entry.querySelector('strong')?.textContent===${JSON.stringify(name)});
        const pendingButton=current?[...current.querySelectorAll('button')].find((entry)=>entry.textContent.includes(${JSON.stringify(label)})||entry.textContent.includes('Starting')||entry.textContent.includes('Restoring')):undefined;
        return {found:true,disabled:pendingButton?.disabled === true,text:current?.textContent||''};
      })()`);

      const runnableName = "P30 UI runnable";
      const runnable = await createRoutineViaUi(runnableName, workspaceId);
      await refreshRoutineCards();
      const runnableJobsBefore = jobs.listJobs().jobs.length;
      const runClicks = await cardAction(runnableName, "Run now / 立即运行");
      await sleep(350);
      const runnableCard = await win.webContents.executeJavaScript(`(()=>{const card=[...document.querySelectorAll('#routine-list .job-card')].find((entry)=>entry.querySelector('strong')?.textContent===${JSON.stringify(runnableName)}); return { text:card?.textContent||'', runButtonDisabled:[...card?.querySelectorAll('button')||[]].find((entry)=>entry.textContent.includes('Run now / 立即运行'))?.disabled };})()`);
      check("real Routines UI Run now creates one governed Job and visible success", runClicks.found && jobs.listJobs().jobs.length === runnableJobsBefore + 1 && routineRunCalls === 1 && runnableCard.text.includes("Routine started") && runnableCard.runButtonDisabled === false, JSON.stringify({ runClicks, jobs: jobs.listJobs().jobs.length - runnableJobsBefore, routineRunCalls, card: runnableCard }));
      check("Run now success remains bound to the selected Routine after refresh", routines.history(runnable.id).history.length === 1 && routines.history(runnable.id).history[0].source === "manual", JSON.stringify(routines.history(runnable.id).history[0]));

      const duplicateRunName = "P30 UI duplicate run";
      const duplicateRun = await createRoutineViaUi(duplicateRunName, workspaceId);
      await refreshRoutineCards();
      const duplicateJobsBefore = jobs.listJobs().jobs.length;
      const duplicateRunClicks = await cardAction(duplicateRunName, "Run now / 立即运行", true);
      await sleep(350);
      check("Run now disables pending card and suppresses duplicate clicks", duplicateRunClicks.found && duplicateRunClicks.disabled === true && jobs.listJobs().jobs.length === duplicateJobsBefore + 1 && routineRunCalls === 2, JSON.stringify({ duplicateRunClicks, jobs: jobs.listJobs().jobs.length - duplicateJobsBefore, routineRunCalls }));

      const disabledName = "P30 UI disabled";
      const disabled = await createRoutineViaUi(disabledName, workspaceId);
      await win.webContents.executeJavaScript(`window.sovereignbot.routines.setEnabled({routineId:${JSON.stringify(disabled.id)},enabled:false})`);
      await refreshRoutineCards();
      const disabledCard = await win.webContents.executeJavaScript(`(()=>{const card=[...document.querySelectorAll('#routine-list .job-card')].find((entry)=>entry.querySelector('strong')?.textContent===${JSON.stringify(disabledName)}); return { text:card?.textContent||'', runDisabled:[...card?.querySelectorAll('button')||[]].find((entry)=>entry.textContent.includes('Run now / 立即运行'))?.disabled };})()`);
      check("disabled Routine remains visibly fail-closed", disabledCard.runDisabled === true && routines.get(disabled.id).runState === "disabled", JSON.stringify(disabledCard));

      const failureWorkspacePath = join(dataDir, "p30-failure-workspace");
      await mkdir(failureWorkspacePath, { recursive: true });
      const failureWorkspaceId = services.addWorkspacePath(failureWorkspacePath).workspace?.id;
      const runFailureName = "P30 UI unavailable run";
      const runFailure = await createRoutineViaUi(runFailureName, failureWorkspaceId);
      await refreshRoutineCards();
      services.removeWorkspace(failureWorkspaceId);
      const failedJobsBefore = jobs.listJobs().jobs.length;
      const runFailureClicks = await cardAction(runFailureName, "Run now / 立即运行");
      await sleep(220);
      const runFailureCard = await win.webContents.executeJavaScript(`(()=>{const card=[...document.querySelectorAll('#routine-list .job-card')].find((entry)=>entry.querySelector('strong')?.textContent===${JSON.stringify(runFailureName)}); return {text:card?.textContent||'',error:card?.querySelector('.routine-action-feedback')?.textContent||''};})()`);
      check("unavailable Run now stays in-card with sanitized failure and no Job", runFailureClicks.found && jobs.listJobs().jobs.length === failedJobsBefore && runFailureCard.error.includes("Routine Job could not be created") && !runFailureCard.error.match(/(?:token|secret|session|cwd|workspacePath|provider)/i), JSON.stringify({ runFailureClicks, jobs: jobs.listJobs().jobs.length - failedJobsBefore, card: runFailureCard }));

      const restoreName = "P30 UI restore";
      const restoreTarget = await createRoutineViaUi(restoreName, workspaceId);
      await win.webContents.executeJavaScript(`window.sovereignbot.routines.archive({routineId:${JSON.stringify(restoreTarget.id)}})`);
      await refreshRoutineCards();
      const restoreJobsBefore = jobs.listJobs().jobs.length;
      const restoreCallsBefore = routineRestoreCalls;
      const restoreClicks = await cardAction(restoreName, "Restore / 恢复");
      await sleep(350);
      const restored = routines.get(restoreTarget.id);
      const restoreCard = await win.webContents.executeJavaScript(`(()=>{const card=[...document.querySelectorAll('#routine-list .job-card')].find((entry)=>entry.querySelector('strong')?.textContent===${JSON.stringify(restoreName)}); return {text:card?.textContent||''};})()`);
      check("real Routines UI Restore reactivates the Routine without a Job", restoreClicks.found && jobs.listJobs().jobs.length === restoreJobsBefore && routineRestoreCalls === restoreCallsBefore + 1 && restored.state === "active" && restored.enabled === true && Boolean(restored.nextRunAt) && restoreCard.text.includes("Routine restored"), JSON.stringify({ restoreClicks, jobs: jobs.listJobs().jobs.length - restoreJobsBefore, restoreCalls: routineRestoreCalls - restoreCallsBefore, restored, card: restoreCard }));

      const duplicateRestoreName = "P30 UI duplicate restore";
      const duplicateRestore = await createRoutineViaUi(duplicateRestoreName, workspaceId);
      await win.webContents.executeJavaScript(`window.sovereignbot.routines.archive({routineId:${JSON.stringify(duplicateRestore.id)}})`);
      await refreshRoutineCards();
      const duplicateRestoreCallsBefore = routineRestoreCalls;
      const duplicateRestoreClicks = await cardAction(duplicateRestoreName, "Restore / 恢复", true);
      await sleep(350);
      check("Restore disables pending card and suppresses duplicate clicks", duplicateRestoreClicks.found && duplicateRestoreClicks.disabled === true && routines.get(duplicateRestore.id).state === "active" && routineRestoreCalls === duplicateRestoreCallsBefore + 1, JSON.stringify({ duplicateRestoreClicks, restoreCalls: routineRestoreCalls - duplicateRestoreCallsBefore }));

      const restoreFailureWorkspacePath = join(dataDir, "p30-restore-failure-workspace");
      await mkdir(restoreFailureWorkspacePath, { recursive: true });
      const restoreFailureWorkspaceId = services.addWorkspacePath(restoreFailureWorkspacePath).workspace?.id;
      const restoreFailureName = "P30 UI unavailable restore";
      const restoreFailure = await createRoutineViaUi(restoreFailureName, restoreFailureWorkspaceId);
      await win.webContents.executeJavaScript(`window.sovereignbot.routines.archive({routineId:${JSON.stringify(restoreFailure.id)}})`);
      await refreshRoutineCards();
      services.removeWorkspace(restoreFailureWorkspaceId);
      const restoreFailureClicks = await cardAction(restoreFailureName, "Restore / 恢复");
      await sleep(220);
      const restoreFailureState = routines.get(restoreFailure.id);
      const restoreFailureCard = await win.webContents.executeJavaScript(`(()=>{const card=[...document.querySelectorAll('#routine-list .job-card')].find((entry)=>entry.querySelector('strong')?.textContent===${JSON.stringify(restoreFailureName)}); return {text:card?.textContent||'',error:card?.querySelector('.routine-action-feedback')?.textContent||''};})()`);
      check("unavailable Restore stays archived with in-card sanitized failure", restoreFailureClicks.found && restoreFailureState.state === "archived" && restoreFailureState.enabled === false && restoreFailureCard.error.includes("unknown trusted workspace") && !restoreFailureCard.error.match(/(?:token|secret|session|cwd|workspacePath|provider)/i), JSON.stringify({ restoreFailureClicks, state: restoreFailureState, card: restoreFailureCard }));

      const staleName = "P30 UI stale";
      const stale = await createRoutineViaUi(staleName, workspaceId);
      await refreshRoutineCards();
      routines.remove(stale.id);
      const staleJobsBefore = jobs.listJobs().jobs.length;
      const staleClicks = await cardAction(staleName, "Run now / 立即运行");
      await sleep(220);
      const staleCard = await win.webContents.executeJavaScript(`(()=>{const card=[...document.querySelectorAll('#routine-list .job-card')].find((entry)=>entry.querySelector('strong')?.textContent===${JSON.stringify(staleName)}); return {text:card?.textContent||'',error:card?.querySelector('.routine-action-feedback')?.textContent||''};})()`);
      check("stale Routine card fails closed without creating a Job", staleClicks.found && jobs.listJobs().jobs.length === staleJobsBefore && staleCard.text.includes("unknown routine id"), JSON.stringify({ staleClicks, jobs: jobs.listJobs().jobs.length - staleJobsBefore, card: staleCard }));

      jobCount = jobs.listJobs().jobs.length;
      routines.stop();
      routines = createRoutineController({ dataDir, jobController: jobs, coworkerStore, skillStore, services, persistPath, now: () => clock.value });
      await win.webContents.executeJavaScript("window.SovereignJobsUI.refreshRoutines()");
      await sleep(150);
      const afterActionRestart = await win.webContents.executeJavaScript(`(()=>({
        restored:[...document.querySelectorAll('#routine-list .job-card')].find((entry)=>entry.querySelector('strong')?.textContent===${JSON.stringify(restoreName)})?.textContent||'',
        archived:[...document.querySelectorAll('#routine-list .job-card')].find((entry)=>entry.querySelector('strong')?.textContent===${JSON.stringify(restoreFailureName)})?.textContent||''
      }))()`);
      check("Routine action states and Job count remain isolated after controller restart", jobs.listJobs().jobs.length === jobCount && routines.get(restoreTarget.id).state === "active" && routines.get(restoreFailure.id).state === "archived" && afterActionRestart.restored.includes("Routine restored") && afterActionRestart.archived.includes(restoreFailureName) && !afterActionRestart.archived.includes(`Routine restored: ${restoreName}`), JSON.stringify({ jobs: jobs.listJobs().jobs.length, jobCount, ui: afterActionRestart }));
    }

    const failedRoutineName = "V4.2 gate one-time failure";
    const failedRoutine = await win.webContents.executeJavaScript(`window.sovereignbot.routines.create(${JSON.stringify({
      name: failedRoutineName,
      coworkerId: chief.id,
      instruction: "This run must fail closed before provider execution.",
      workspaceId,
      schedule: { type: "one-time", at: new Date(clock.value - 1000).toISOString() },
    })})`);
    services.removeWorkspace(workspaceId);
    const tasksBeforeFailedRun = fake.tasks.length;
    await routines.tickNow();
    const failedState = routines.get(failedRoutine.id);
    const failedHistory = routines.history(failedRoutine.id).history;
    check("invalid trusted workspace fails Routine before Job creation", jobs.listJobs().jobs.length === jobCount && fake.tasks.length === tasksBeforeFailedRun, `jobs=${jobs.listJobs().jobs.length} tasks=${fake.tasks.length}`);
    check("failed Routine history is durable and explicit", failedHistory.length === 1 && failedHistory[0].status === "failed" && !failedHistory[0].jobId && failedState.failureCount === 1, JSON.stringify({ status: failedHistory[0]?.status, failureCount: failedState.failureCount }));
    check("failed one-time Routine is consumed", failedState.enabled === false && failedState.nextRunAt === undefined);
    const reenableRejected = await win.webContents.executeJavaScript(`window.sovereignbot.routines.setEnabled({routineId:${JSON.stringify(failedRoutine.id)},enabled:true}).then(()=>false,()=>true)`);
    check("consumed one-time Routine cannot be re-enabled", reenableRejected === true);
    const failedButtons = await win.webContents.executeJavaScript(`(async()=>{await window.SovereignJobsUI.refreshRoutines(); const card=[...document.querySelectorAll('#routine-list .job-card')].find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(failedRoutineName)}); return card?[...card.querySelectorAll('button')].map(b=>b.textContent.trim()):[]})()`);
    check("consumed one-time UI offers no Enable action", !failedButtons.includes("Enable"), JSON.stringify(failedButtons));

    await win.webContents.executeJavaScript(`document.getElementById('setting-language').value='zh-CN'; document.getElementById('setting-language').dispatchEvent(new Event('change',{bubbles:true}))`);
    await sleep(250);
    await win.webContents.executeJavaScript(`document.getElementById('nav-routines').click()`);
    await sleep(250);
    const zh = await win.webContents.executeJavaScript(`({lang:document.documentElement.lang,nav:document.getElementById('nav-routines')?.innerText,title:document.querySelector('#view-routines h1')?.innerText,body:document.getElementById('view-routines')?.innerText})`);
    check("zh-CN Routines UI", zh.lang === "zh-CN" && /例行任务/.test(`${zh.nav} ${zh.title} ${zh.body}`), JSON.stringify({ lang: zh.lang, nav: zh.nav, title: zh.title }));

    await win.webContents.executeJavaScript(`document.getElementById('setting-language').value='en'; document.getElementById('setting-language').dispatchEvent(new Event('change',{bubbles:true}))`);
    await sleep(250);
    const en = await win.webContents.executeJavaScript(`({lang:document.documentElement.lang,nav:document.getElementById('nav-routines')?.innerText,title:document.querySelector('#view-routines h1')?.innerText})`);
    check("English Routines UI", en.lang === "en" && /Routines/.test(`${en.nav} ${en.title}`), JSON.stringify(en));

    const surface = await win.webContents.executeJavaScript(`({
      work: !!document.getElementById('nav-work'),
      attention: !!document.getElementById('nav-attention'),
      routines: !!document.getElementById('nav-routines'),
      settings: !!document.getElementById('nav-settings'),
      routinesVisible: document.getElementById('view-routines')?.classList.contains('hidden') === false,
      title: document.querySelector('#view-routines h1')?.textContent?.trim()
    })`);
    check("real product window keeps V4.1 navigation and opens Routines", surface.work && surface.attention && surface.routines && surface.settings && surface.routinesVisible && surface.title === "Routines", JSON.stringify(surface));

    const editor = await win.webContents.executeJavaScript(`(async()=>{
      document.getElementById('routine-new')?.click();
      await new Promise((resolve)=>setTimeout(resolve,150));
      const dialog=document.getElementById('routine-dialog');
      const type=document.getElementById('routine-type');
      const hidden=(id)=>document.getElementById(id)?.classList.contains('hidden');
      const states={};
      for(const value of ['one-time','hourly','daily','weekly']){
        type.value=value;
        type.dispatchEvent(new Event('change',{bubbles:true}));
        states[value]={at:hidden('routine-field-at'),minute:hidden('routine-field-minute'),time:hidden('routine-field-time'),weekday:hidden('routine-field-weekday')};
      }
      const result={
        open:!!dialog?.open,
        options:[...type.options].map((entry)=>entry.value),
        fields:['routine-name','routine-instruction','routine-owner','routine-skill','routine-workspace','routine-type','routine-at','routine-minute','routine-time','routine-weekday'].every((id)=>!!document.getElementById(id)),
        states
      };
      dialog?.close();
      return result;
    })()`);
    const scheduleEditorOk = editor.open
      && editor.fields
      && JSON.stringify(editor.options) === JSON.stringify(routineActionsGate ? ["one-time", "hourly", "daily", "weekly", "custom"] : ["one-time", "hourly", "daily", "weekly"])
      && editor.states["one-time"]?.at === false && editor.states["one-time"]?.minute === true && editor.states["one-time"]?.time === true && editor.states["one-time"]?.weekday === true
      && editor.states.hourly?.at === true && editor.states.hourly?.minute === false && editor.states.hourly?.time === true && editor.states.hourly?.weekday === true
      && editor.states.daily?.at === true && editor.states.daily?.minute === true && editor.states.daily?.time === false && editor.states.daily?.weekday === true
      && editor.states.weekly?.at === true && editor.states.weekly?.minute === true && editor.states.weekly?.time === false && editor.states.weekly?.weekday === false;
    check("real Routines editor exposes only supported schedules and fields", scheduleEditorOk, JSON.stringify(editor));

    const visual = await captureVisualEvidence(win);
    check("real window visual evidence captured", Boolean(visual.image) && !visual.image.isEmpty(), JSON.stringify({ method: visual.method, attempts: visual.attempts }));
    if (visual.image && !visual.image.isEmpty()) await writeFile(join(EVIDENCE_DIR, `${evidenceBase}.png`), visual.image.toPNG());

    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
    const summary = {
      at: new Date().toISOString(),
      dataDir,
      routineId: routine.id,
      failedRoutineId: failedRoutine.id,
      jobId: job.id,
      checks,
      visualEvidence: { method: visual.method, attempts: visual.attempts, captured: Boolean(visual.image) && !visual.image.isEmpty() },
      productSurface: surface,
      routineEditor: editor,
      routine: routines.get(routine.id),
      failedRoutine: routines.get(failedRoutine.id),
      job: jobs.getJob(job.id),
    };
    await writeFile(join(EVIDENCE_DIR, `${evidenceBase}.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await writeFile(join(EVIDENCE_DIR, `${evidenceBase}.log`), `${log.join("\n")}\n`, "utf8");

    if (failed.length) throw new Error(`V4.2 routine gate failed: ${failed.join(", ")}`);
  } finally {
    try { routines.stop(); } catch {}
    try { chiefLoop.stop(); } catch {}
    try { unbind?.(); } catch {}
    try { uninstallProtocol(); } catch {}
    try { win.destroy(); } catch {}
  }
  app.exit(0);
}
