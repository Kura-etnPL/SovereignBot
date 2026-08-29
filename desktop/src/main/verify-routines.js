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
import { coworkerAgentId } from "./provider-roster.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = join(WORKTREE_ROOT, "_evidence_v42_2026-08-29");
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

export async function runVerifyRoutines({ app }) {
  const { dialog } = await import("electron");
  await mkdir(EVIDENCE_DIR, { recursive: true });
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
        "routine:create": (payload) => routines.create(payload),
        "routine:list": () => routines.list(),
        "routine:get": ({ routineId }) => routines.get(routineId),
        "routine:history": ({ routineId }) => routines.history(routineId),
        "routine:setEnabled": ({ routineId, enabled }) => routines.setEnabled(routineId, enabled),
        "routine:remove": ({ routineId }) => routines.remove(routineId),
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

    const jobCount = jobs.listJobs().jobs.length;
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

    const png = await win.webContents.capturePage();
    await writeFile(join(EVIDENCE_DIR, "verify-v42-routines.png"), png.toPNG());
    const summary = { at: new Date().toISOString(), dataDir, routineId: routine.id, jobId: job.id, checks, routine: routines.get(routine.id), job: jobs.getJob(job.id) };
    await writeFile(join(EVIDENCE_DIR, "verify-v42-routines.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await writeFile(join(EVIDENCE_DIR, "verify-v42-routines.log"), `${log.join("\n")}\n`, "utf8");

    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
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
