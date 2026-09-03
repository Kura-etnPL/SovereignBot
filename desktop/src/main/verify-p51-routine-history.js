// P51 hidden real-Electron gate for Routine History Retry reliability.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationStore } from "./conversation-store.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createJobController, JOBS_SCHEMA } from "./job-controller.js";
import { createSkillStore } from "./skill-store.js";
import { createRoutineController } from "./routine-controller.js";
import { desktopVersion } from "./lib/desktop-version.js";
import { coworkerAgentId } from "./provider-roster.js";
import { createDesktopServices } from "./services.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";
import { EVENT_TRIGGERS_SCHEMA } from "./event-trigger-controller.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidenceDir = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR;

function fakeRuntime() {
  let planSeq = 0;
  let taskSeq = 0;
  const tasks = [];
  return {
    runtime: {
      orchestrator: {
        async createPlan(input) { return { id: `p51-plan-${++planSeq}`, ...input }; },
        async delegateTrusted(planId, spec, executionContext, supervisorId) {
          const task = { id: `p51-task-${++taskSeq}`, planId, status: "queued", input: spec.input, title: spec.title, executionContext, supervisorId };
          tasks.push(task);
          return structuredClone(task);
        },
        async runUntilIdle() {
          for (const task of tasks) if (task.status === "queued") { task.status = "completed"; task.result = { text: `P51 completed: ${task.title}` }; }
        },
        async listTasks() { return structuredClone(tasks); },
        async aggregatePlan(planId) { return { planId, status: "completed" }; },
        async cancel(taskId) { const task = tasks.find((entry) => entry.id === taskId); if (task) task.status = "cancelled"; },
      },
    },
  };
}

function makeHandlers({ services, coworkerStore, conversationStore, skillStore, jobs, routines, roster, failures, counts }) {
  return {
    "app:handshake": () => ({ ok: true, version: desktopVersion(), platform: process.platform, locale: "en-US", language: services.getSettings().language }),
    "firstrun:getStatus": () => ({ browsers: [] }),
    "settings:get": () => services.getSettings(),
    "settings:update": (patch) => services.updateSettings(patch),
    "workspace:list": () => services.listWorkspaces(),
    "workspace:addViaDialog": () => ({ added: false }),
    "workspace:setDefault": ({ id }) => ({ ok: services.setDefaultWorkspace(id) }),
    "workspace:remove": ({ id }) => ({ removed: services.removeWorkspace(id) }),
    "provider:getRoster": () => roster,
    "provider:refresh": () => ({ applied: false, roster }),
    "coworker:list": (payload) => coworkerStore.list(payload),
    "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
    "conversation:list": () => conversationStore.list(),
    "conversation:get": ({ conversationId }) => conversationStore.get(conversationId),
    "conversation:createDirect": ({ coworkerId }) => conversationStore.createDirect(coworkerId),
    "conversation:createTeam": ({ title, coworkerIds }) => conversationStore.createTeam({ title, coworkerIds }),
    "conversation:acknowledge": () => ({ ok: true }),
    "team:list": () => ({ teams: [] }),
    "team:activity": () => ({ events: [] }),
    "channel:list": () => ({ channels: [] }),
    "project:list": () => ({ projects: [] }),
    "artifact:list": () => ({ artifacts: [] }),
    "connectedApps:list": () => ({ apps: [] }),
    "connectedApps:search": () => ({ apps: [] }),
    "skill:list": (payload) => skillStore.list(payload),
    "eventTrigger:list": () => ({ schema: EVENT_TRIGGERS_SCHEMA, triggers: [] }),
    "notification:list": () => ({ notifications: [], totalCount: 0, unreadCount: 0 }),
    "data:status": () => ({ backups: [] }),
    "data:listBackups": () => ({ backups: [] }),
    "memory:list": () => ({ memories: [], suggestions: [] }),
    "memory:listSuggestions": () => ({ suggestions: [] }),
    "job:list": () => jobs.listJobs(),
    "job:getStatus": ({ jobId }) => jobs.getJob(jobId),
    "job:getConversation": ({ jobId }) => jobs.getConversation(jobId),
    "job:attention": (payload) => jobs.attentionJobs(payload),
    "job:approve": ({ jobId }) => jobs.approve(jobId),
    "job:dismiss": ({ jobId }) => jobs.dismiss(jobId),
    "job:pause": ({ jobId }) => jobs.pause(jobId),
    "job:resume": ({ jobId }) => jobs.resume(jobId),
    "job:snooze": ({ jobId, minutes }) => jobs.snooze(jobId, minutes),
    "job:cancel": ({ jobId }) => jobs.cancel(jobId),
    "routine:list": (payload) => routines.list(payload),
    "routine:get": ({ routineId }) => routines.get(routineId),
    "routine:history": ({ routineId }) => routines.history(routineId),
    "routine:create": (payload) => routines.create(payload),
    "routine:runNow": ({ routineId }) => routines.runNow(routineId),
    "routine:setEnabled": ({ routineId, enabled }) => routines.setEnabled(routineId, enabled),
    "routine:archive": ({ routineId }) => routines.archive(routineId),
    "routine:restore": ({ routineId }) => routines.restore(routineId),
    "routine:remove": ({ routineId }) => routines.remove(routineId),
    "routine:retry": async ({ routineId, runId }) => {
      counts.retry += 1;
      if (routineId === failures.routineId && runId === failures.runId && failures.retry) {
        failures.retry = false;
        await sleep(160);
        throw new Error("Injected P51 history retry failure; safe to retry.");
      }
      return routines.retry(routineId, runId);
    },
    "update:status": () => ({ channel: "stable", currentVersion: desktopVersion(), available: false }),
    "thisPc:list": () => ({ items: [] }),
  };
}

async function invoke(win, expression) { return win.webContents.executeJavaScript(`(${expression})()`); }

async function waitForRenderer(win, expression, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await invoke(win, expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function runVerifyP51RoutineHistory({ app }) {
  const checks = {};
  const notes = [];
  const check = (name, ok, detail = "") => { const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`; checks[name] = Boolean(ok); notes.push(line); try { process.stdout.write(`${line}\n`); } catch {} };
  let dataDir;
  let win;
  let unbind;
  let uninstallProtocol;
  try {
    dataDir = await mkdtemp(join(tmpdir(), "sovereign-p51-routine-history-"));
    const stateDir = join(dataDir, "desktop-state");
    await mkdir(stateDir, { recursive: true });
    const services = createDesktopServices({ dataDir, dialog: {} });
    const workspace = services.createManagedWorkspace({ label: "P51 Trusted Workspace", kind: "shared-project", idHint: "p51-history" }).workspace;
    const coworkerStore = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
    coworkerStore.ensureDefaults();
    const coworkers = coworkerStore.list({}).coworkers;
    const owner = coworkers.find((entry) => entry.name === "Coding Lead") ?? coworkers.find((entry) => entry.name !== "Chief of Staff");
    const conversationStore = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore });
    const skillStore = createSkillStore({ persistPath: join(stateDir, "skills.json") });
    const runtimeHarness = fakeRuntime();
    const roster = { ready: true, mode: "p51-local-fixture", roles: { planner: "p51-supervisor" }, agents: [], providers: { fake: { usable: true, present: true, version: "p51" } }, coworkerBindings: Object.fromEntries(coworkers.map((entry) => [entry.id, { ready: true, agentId: coworkerAgentId(entry.id), provider: "fake" }])) };
    const jobs = createJobController({ dataDir, runtime: runtimeHarness.runtime, roster: () => roster, coworkerStore, services, skillStore, supervisorAgentId: "p51-supervisor", readiness: () => ({ allowed: true }) });
    const routines = createRoutineController({ dataDir, jobController: jobs, coworkerStore, skillStore, services, persistPath: join(stateDir, "routines.json") });
    const routineA = routines.create({ name: "P51 Retry Alpha", instruction: "P51 bounded retry fixture Alpha.", coworkerId: owner.id, workspaceId: workspace.id, schedule: { type: "custom", intervalMinutes: 60 } });
    const routineB = routines.create({ name: "P51 Peer Beta", instruction: "P51 bounded retry fixture Beta.", coworkerId: owner.id, workspaceId: workspace.id, schedule: { type: "custom", intervalMinutes: 60 } });
    const runA = routines.runNow(routineA.id);
    const runB = routines.runNow(routineB.id);
    await jobs.pause(runA.job.id);
    await jobs.pause(runB.job.id);
    const failures = { routineId: routineA.id, runId: runA.run.id, retry: true };
    const counts = { retry: 0 };
    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    unbind = bindIpcChannels({ win, handlers: makeHandlers({ services, coworkerStore, conversationStore, skillStore, jobs, routines, roster, failures, counts }) });
    await win.loadURL(appOrigin());
    await sleep(900);
    await invoke(win, `async()=>{document.getElementById("nav-routines")?.click(); return true}`);
    await waitForRenderer(win, `async()=>!document.getElementById("view-routines")?.classList.contains("hidden") && document.querySelectorAll("#routine-list .job-card").length>=2`, "Routine list");
    await invoke(win, `async()=>{const card=[...document.querySelectorAll("#routine-list .job-card")].find((entry)=>entry.querySelector("strong")?.textContent===${JSON.stringify(routineA.name)}); const button=[...card?.querySelectorAll("button")||[]].find((entry)=>entry.textContent.includes("History")); button?.click(); return Boolean(button)}`);
    await waitForRenderer(win, `async()=>document.getElementById("routine-detail-dialog")?.open===true && document.getElementById("routine-detail-title")?.textContent===${JSON.stringify(routineA.name)}`, "Alpha Routine History");
    await waitForRenderer(win, `async()=>document.querySelector("[data-routine-history-retry]")?.disabled===false`, "Alpha retry button");
    await invoke(win, `async()=>{const button=document.querySelector("[data-routine-history-retry]"); button?.click(); button?.click(); return Boolean(button)}`);
    await waitForRenderer(win, `async()=>document.querySelector("[data-routine-history-retry]")?.disabled===true`, "pending Alpha retry");
    const pending = await invoke(win, `async()=>{const cards=[...document.querySelectorAll("#routine-list .job-card")]; const card=(name)=>cards.find((entry)=>entry.querySelector("strong")?.textContent===name); const alpha=card(${JSON.stringify(routineA.name)}); const beta=card(${JSON.stringify(routineB.name)}); return {alphaDisabled:[...alpha?.querySelectorAll("button")||[]].every((button)=>button.disabled),betaHistoryDisabled:[...beta?.querySelectorAll("button")||[]].find((button)=>button.textContent.includes("History"))?.disabled===true}}`);
    check("same Routine lifecycle controls lock while a history retry is pending", pending.alphaDisabled && !pending.betaHistoryDisabled, JSON.stringify(pending));
    await waitForRenderer(win, `async()=>document.querySelector("[data-routine-run-feedback]")?.textContent.includes("Injected P51 history retry failure") && document.querySelector("[data-routine-history-retry]")?.disabled===false`, "failed Alpha retry feedback");
    const failure = await invoke(win, `async()=>({feedback:document.querySelector("[data-routine-run-feedback]")?.textContent||"",retryDisabled:document.querySelector("[data-routine-history-retry]")?.disabled===true})`);
    check("injected History Retry failure is visible, single-call, and retryable", failure.feedback.includes("Injected P51 history retry failure") && !failure.retryDisabled && counts.retry === 1, JSON.stringify({ ...failure, retryCalls: counts.retry }));
    await invoke(win, `async()=>{document.getElementById("routine-detail-dialog")?.close(); return true}`);
    await invoke(win, `async()=>{const card=[...document.querySelectorAll("#routine-list .job-card")].find((entry)=>entry.querySelector("strong")?.textContent===${JSON.stringify(routineB.name)}); const button=[...card?.querySelectorAll("button")||[]].find((entry)=>entry.textContent.includes("History")); button?.click(); return Boolean(button)}`);
    await waitForRenderer(win, `async()=>document.getElementById("routine-detail-dialog")?.open===true && document.getElementById("routine-detail-title")?.textContent===${JSON.stringify(routineB.name)}`, "Beta Routine History");
    const peer = await invoke(win, `async()=>({text:document.getElementById("routine-history")?.textContent||"",feedback:document.querySelector("[data-routine-run-feedback]")?.textContent||"",retryDisabled:document.querySelector("[data-routine-history-retry]")?.disabled===true})`);
    check("another Routine has no cross-routine retry feedback or lock", !peer.text.includes("Injected P51 history retry failure") && !peer.feedback.includes("Injected P51") && !peer.retryDisabled, JSON.stringify(peer));
    await invoke(win, `async()=>{document.getElementById("routine-detail-dialog")?.close(); const card=[...document.querySelectorAll("#routine-list .job-card")].find((entry)=>entry.querySelector("strong")?.textContent===${JSON.stringify(routineA.name)}); const button=[...card?.querySelectorAll("button")||[]].find((entry)=>entry.textContent.includes("History")); button?.click(); return Boolean(button)}`);
    await waitForRenderer(win, `async()=>document.getElementById("routine-detail-dialog")?.open===true && document.getElementById("routine-detail-title")?.textContent===${JSON.stringify(routineA.name)}`, "Alpha retry detail reopen");
    await invoke(win, `async()=>{const button=document.querySelector("[data-routine-history-retry]"); button?.click(); return true}`);
    await waitForRenderer(win, `async()=>document.querySelector("[data-routine-run-feedback]")?.textContent.includes("Routine run retry requested") && document.querySelector("[data-routine-history-retry]")?.disabled===false`, "successful Alpha retry feedback");
    check("History Retry succeeds on the second attempt with one additional call", counts.retry === 2, JSON.stringify({ retryCalls: counts.retry }));
    await jobs.flush();
    await invoke(win, `async()=>{document.getElementById("routine-detail-dialog")?.close(); document.dispatchEvent(new CustomEvent("sovereignbot:open-routine", { detail: { routineId: ${JSON.stringify(routineA.id)} } })); return true}`);
    await waitForRenderer(win, `async()=>document.getElementById("routine-detail-dialog")?.open===true && document.getElementById("routine-detail-title")?.textContent===${JSON.stringify(routineA.name)} && document.querySelector("[data-routine-history-card]")?.textContent.includes("completed")`, "completed Alpha history refresh");
    const completed = routines.history(routineA.id).history[0];
    check("successful retry refreshes History and reaches a completed Job", completed?.status === "completed" && jobs.getJob(runA.job.id).status === "completed", JSON.stringify({ runStatus: completed?.status, jobStatus: jobs.getJob(runA.job.id).status }));
    const routineText = await invoke(win, `async()=>({history:document.getElementById("routine-history")?.textContent||"",list:document.getElementById("routine-list")?.textContent||""})`);
    check("Routine History public text contains no opaque IDs or internal authority", !/(routine_[a-f0-9]{16}|run_[a-f0-9]{16}|job_[a-f0-9]{16}|[A-Za-z]:[\\/]|provider|session|credential|workspacePath)/i.test(routineText.history + routineText.list), JSON.stringify(routineText));
    const uiSource = await readFile(join(process.cwd(), "ui", "jobs-ui.js"), "utf8");
    check("Routine History renderer uses no native prompt or confirm", !/window\.(?:prompt|confirm)\s*\(/.test(uiSource), "native dialogs absent");
  } catch (error) {
    check("P51 hidden Routine History gate completes", false, String(error?.message ?? error));
    try { process.stderr.write(`${error?.stack ?? error}\n`); } catch {}
  }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  const result = { schema: "sovereignbot.desktop.p51-routine-history.v1", checks, failed, notes, fixtureBoundary: "LOCAL_FIXTURE", publishEligible: false, externalActions: [], ok: failed.length === 0 };
  let evidenceError;
  try {
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(join(evidenceDir, "verify-p51-routine-history.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
      await writeFile(join(evidenceDir, "verify-p51-routine-history.log"), `${notes.join("\n")}\n${result.ok ? "PASS" : "FAIL"} P51 Routine History gate summary ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} checks passed\n`, "utf8");
    }
  } catch (error) {
    evidenceError = error;
    try { process.stderr.write(`P51 evidence write failed: ${error?.stack ?? error}\n`); } catch {}
  }
  const finalFailed = evidenceError ? [...failed, "P51 evidence write"] : failed;
  const exitCode = finalFailed.length ? 1 : 0;
  try { process.stdout.write(`${exitCode ? "FAIL" : "PASS"} P51 Routine History gate summary ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} checks passed\n`); } catch {}
  try { unbind?.(); } catch {}
  try { uninstallProtocol?.(); } catch {}
  if (dataDir) try { await rm(dataDir, { recursive: true, force: true }); } catch {}
  if (app?.exit) { app.exit(exitCode); return exitCode ? { ok: false, checks } : { ok: true, checks }; }
  try { win?.destroy(); } catch {}
  if (exitCode) throw new Error(`P51 Routine History gate failed: ${finalFailed.join(", ")}`);
  return result;
}
