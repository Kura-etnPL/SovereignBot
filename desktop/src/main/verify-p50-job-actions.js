// P50 hidden real-Electron gate for Work/Job action reliability and safe identity labels.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationStore } from "./conversation-store.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createJobController, JOBS_SCHEMA } from "./job-controller.js";
import { createSkillStore } from "./skill-store.js";
import { desktopVersion } from "./lib/desktop-version.js";
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
        async createPlan(input) { return { id: `p50-plan-${++planSeq}`, ...input }; },
        async delegateTrusted(planId, spec, executionContext, supervisorId) {
          const task = { id: `p50-task-${++taskSeq}`, planId, status: "queued", input: spec.input, title: spec.title, executionContext, supervisorId };
          tasks.push(task);
          return structuredClone(task);
        },
        async runUntilIdle() { for (const task of tasks) if (task.status === "queued") { task.status = "completed"; task.result = { text: `P50 completed: ${task.title}` }; } },
        async listTasks() { return structuredClone(tasks); },
        async aggregatePlan(planId) { return { planId, status: "completed" }; },
        async cancel(taskId) { const task = tasks.find((entry) => entry.id === taskId); if (task) task.status = "cancelled"; },
      },
    },
  };
}

function seedJob({ id, title, ownerCoworkerId, status, workspaceId, executionTarget = { kind: "local" }, workerNodeName, workerWorkspaceName, attentionState, nextActionAt }) {
  const createdAt = "2026-09-03T00:00:00.000Z";
  return {
    id, title, objective: `P50 bounded objective for ${title}`, ownerCoworkerId, status, priority: "normal", workspaceId,
    requestedWorkspaceId: workspaceId, executionTarget, workerNodeName, workerWorkspaceName, routineId: undefined, skillId: undefined,
    scheduledFor: undefined, conversationId: `p50-conversation-${id}`, planId: undefined, taskIds: [], parentJobId: undefined, childJobIds: [],
    attempt: 0, workerNodeReconnectAttempts: 0, nextActionAt, attentionState, outcomeSummary: status === "completed" ? "P50 completed fixture job." : undefined,
    error: undefined, createdAt, updatedAt: createdAt, conversation: { messages: [{ at: createdAt, role: "system", kind: "seed", text: `P50 fixture for ${title}` }] },
  };
}

function makeHandlers({ services, coworkerStore, conversationStore, skillStore, jobs, roster, failures, counts, ids }) {
  const attention = (jobId, method) => async () => {
    counts[method] += 1;
    if (method === "approve" && jobId === ids.cardRetry && failures.approve) { failures.approve = false; throw new Error("Injected P50 retry failure; safe to retry."); }
    return jobs[method](jobId);
  };
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
    "job:approve": ({ jobId }) => attention(jobId, "approve")(),
    "job:dismiss": ({ jobId }) => attention(jobId, "dismiss")(),
    "job:pause": ({ jobId }) => attention(jobId, "pause")(),
    "job:resume": ({ jobId }) => attention(jobId, "resume")(),
    "job:snooze": ({ jobId, minutes }) => jobs.snooze(jobId, minutes),
    "job:cancel": ({ jobId }) => jobs.cancel(jobId),
    "routine:list": () => ({ routines: [] }),
    "routine:get": () => undefined,
    "routine:history": () => ({ runs: [] }),
    "job:submit": (payload) => jobs.submitJob({ ...payload, internalContext: { deferSchedule: true } }),
    "update:status": () => ({ channel: "stable", currentVersion: desktopVersion(), available: false }),
    "thisPc:list": () => ({ items: [] }),
  };
}

async function loadWindow(win) {
  await win.loadURL(appOrigin());
  await win.webContents.executeJavaScript("(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()");
  await sleep(900);
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

export async function runVerifyP50JobActions({ app }) {
  const checks = {};
  const notes = [];
  const check = (name, ok, detail = "") => { const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`; checks[name] = Boolean(ok); notes.push(line); try { process.stdout.write(`${line}\n`); } catch {} };
  let dataDir;
  let win;
  let unbind;
  let uninstallProtocol;
  try {
    dataDir = await mkdtemp(join(tmpdir(), "sovereign-p50-jobs-"));
    const stateDir = join(dataDir, "desktop-state");
    mkdirSync(stateDir, { recursive: true });
    const services = createDesktopServices({ dataDir, dialog: {} });
    const workspace = services.createManagedWorkspace({ label: "P50 Trusted Workspace", kind: "shared-project", idHint: "p50-gate" }).workspace;
    const coworkerStore = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
    coworkerStore.ensureDefaults();
    const coworkers = coworkerStore.list({}).coworkers;
    const owner = coworkers.find((entry) => entry.name === "Coding Lead") ?? coworkers.find((entry) => entry.name !== "Chief of Staff");
    const peer = coworkers.find((entry) => entry.id !== owner.id && entry.name !== "Chief of Staff") ?? coworkers.find((entry) => entry.id !== owner.id);
    const conversationStore = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore });
    const skillStore = createSkillStore({ persistPath: join(stateDir, "skills.json") });
    const runtimeHarness = fakeRuntime();
    const roster = { ready: true, mode: "p50-local-fixture", roles: { planner: "p50-supervisor" }, agents: [], providers: { fake: { usable: true, present: true, version: "p50" } }, coworkerBindings: Object.fromEntries(coworkers.map((entry) => [entry.id, { ready: true, agentId: `p50-agent-${entry.id}`, provider: "fake" }])) };
    const ids = { cardRetry: "job-p50-card-retry", cardPeer: "job-p50-card-peer", detailApprove: "job-p50-detail-approve", detailDismiss: "job-p50-detail-dismiss", detailPause: "job-p50-detail-pause", detailResume: "job-p50-detail-resume", worker: "job-p50-worker-label" };
    const attentionState = { reason: "A bounded operator retry is required.", category: "real-blocker", at: "2026-09-03T00:00:00.000Z" };
    const workerNodeId = "worker_0123456789abcdef";
    const initialJobs = [
      seedJob({ id: ids.cardRetry, title: "P50 Card Retry", ownerCoworkerId: owner.id, status: "needs_attention", workspaceId: workspace.id, attentionState }),
      seedJob({ id: ids.cardPeer, title: "P50 Peer Dismiss", ownerCoworkerId: peer.id, status: "needs_attention", workspaceId: workspace.id, attentionState }),
      seedJob({ id: ids.detailApprove, title: "P50 Detail Approve", ownerCoworkerId: owner.id, status: "needs_attention", workspaceId: workspace.id, attentionState }),
      seedJob({ id: ids.detailDismiss, title: "P50 Detail Dismiss", ownerCoworkerId: owner.id, status: "needs_attention", workspaceId: workspace.id, attentionState }),
      seedJob({ id: ids.detailPause, title: "P50 Detail Pause", ownerCoworkerId: owner.id, status: "working", workspaceId: workspace.id }),
      seedJob({ id: ids.detailResume, title: "P50 Detail Resume", ownerCoworkerId: owner.id, status: "waiting", workspaceId: workspace.id, nextActionAt: "2099-01-01T00:00:00.000Z" }),
      seedJob({ id: ids.worker, title: "P50 Worker Label", ownerCoworkerId: peer.id, status: "completed", workspaceId: workspace.id, executionTarget: { kind: "worker-node", nodeId: workerNodeId, workspaceId: workspace.id }, workerNodeName: "Remote Builder", workerWorkspaceName: "Builder workspace" }),
    ];
    await writeFile(join(stateDir, "jobs.json"), `${JSON.stringify({ schema: JOBS_SCHEMA, jobs: initialJobs }, null, 2)}\n`, "utf8");
    const jobs = createJobController({ dataDir, runtime: runtimeHarness.runtime, roster: () => roster, coworkerStore, services, skillStore, supervisorAgentId: "p50-supervisor", readiness: () => ({ allowed: true }) });
    const failures = { approve: true };
    const counts = { approve: 0, dismiss: 0, pause: 0, resume: 0 };
    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    unbind = bindIpcChannels({ win, handlers: makeHandlers({ services, coworkerStore, conversationStore, skillStore, jobs, roster, failures, counts, ids }) });
    await loadWindow(win);
    await invoke(win, `async()=>{document.getElementById("nav-work")?.click(); return true}`);
    await waitForRenderer(win, `async()=>document.querySelector("#view-work:not(.hidden)") !== null && document.querySelectorAll("#work-list .job-card").length >= 7`, "Work job cards");
    const identity = await invoke(win, `async()=>{const body=document.querySelector("#work-list")?.textContent||""; const workerCard=document.querySelector('[data-job-id="${ids.worker}"]')?.textContent||""; return {body,workerCard,worker:workerCard.includes("Remote Builder")&&workerCard.includes("Builder workspace"),owner:body.includes("Coding Lead")||body.includes("编程主管"),workspace:body.includes("P50 Trusted Workspace"),ids:workerCard.includes("${workspace.id}")||workerCard.includes("${workerNodeId}")}}`);
    check("Work cards use human-readable owner/workspace/Worker labels without opaque IDs", identity.worker && identity.owner && identity.workspace && !identity.ids, JSON.stringify({ worker: identity.worker, owner: identity.owner, workspace: identity.workspace, ids: identity.ids, workerCard: identity.workerCard }));
    await invoke(win, `async()=>{const card=document.querySelector('[data-job-id="${ids.cardRetry}"]'); const retry=[...card.querySelectorAll("button")].find((button)=>button.textContent.includes("Retry")); retry?.click(); retry?.click(); return Boolean(retry)}`);
    await waitForRenderer(win, `async()=>{const card=document.querySelector('[data-job-id="${ids.cardRetry}"]'); const feedback=card?.querySelector('[data-job-feedback]'); const retry=[...card?.querySelectorAll("button")||[]].find((button)=>button.textContent.includes("Retry")); return Boolean(feedback?.textContent.includes("Action failed") && retry && !retry.disabled)}`, "failed Work card retry feedback");
    const retryFailure = await invoke(win, `async()=>{const a=document.querySelector('[data-job-id="${ids.cardRetry}"] [data-job-feedback]')?.textContent||""; const b=document.querySelector('[data-job-id="${ids.cardPeer}"] [data-job-feedback]')?.textContent||""; return {failed:a.includes("Action failed"),cross:b.includes("Injected P50"),button:[...document.querySelectorAll('[data-job-id="${ids.cardRetry}"] button')].find((entry)=>entry.textContent.includes("Retry"))?.disabled}}`);
    check("Work Retry failure is visible, retryable, single-call, and isolated to its Job", retryFailure.failed && !retryFailure.button && !retryFailure.cross && counts.approve === 1, JSON.stringify({ ...retryFailure, approveCalls: counts.approve }));
    await invoke(win, `async()=>{const retry=[...document.querySelector('[data-job-id="${ids.cardRetry}"]').querySelectorAll("button")].find((button)=>button.textContent.includes("Retry")); retry?.click(); return true}`);
    await waitForRenderer(win, `async()=>Boolean(document.querySelector('[data-job-id="${ids.cardRetry}"] [data-job-feedback]')?.textContent.includes("Retry requested"))`, "retry success feedback");
    check("Work Retry succeeds through existing Job authority after retry", counts.approve === 2 && jobs.getJob(ids.cardRetry).status !== "needs_attention", JSON.stringify({ approveCalls: counts.approve, status: jobs.getJob(ids.cardRetry).status }));
    await invoke(win, `async()=>{const card=document.querySelector('[data-job-id="${ids.cardPeer}"]'); const dismiss=[...card.querySelectorAll("button")].find((button)=>button.textContent.includes("Dismiss attention")); dismiss?.click(); return Boolean(dismiss)}`);
    await sleep(250);
    check("Work Dismiss clearly clears Attention without affecting another Job", jobs.getJob(ids.cardPeer).status === "failed" && counts.dismiss === 1, JSON.stringify({ status: jobs.getJob(ids.cardPeer).status, dismissCalls: counts.dismiss }));
    const detailAction = async (jobId, title, buttonId, label, feedbackText) => {
      await invoke(win, `async()=>{document.getElementById("job-detail-dialog")?.close(); return true}`);
      await invoke(win, `async()=>{const card=document.querySelector('[data-job-id="${jobId}"]'); const open=[...card.querySelectorAll("button")].find((button)=>button.textContent.includes("Open")); open?.click(); return Boolean(open)}`);
      await waitForRenderer(win, `async()=>document.getElementById("job-detail-dialog")?.open===true && document.getElementById("job-detail-title")?.textContent===${JSON.stringify(title)} && !document.getElementById("${buttonId}")?.classList.contains("hidden") && document.getElementById("${buttonId}")?.disabled===false`, `${label} detail open`);
      await invoke(win, `async()=>{document.getElementById("${buttonId}")?.click(); return true}`);
      await waitForRenderer(win, `async()=>Boolean(document.getElementById("job-detail-feedback")?.textContent.includes(${JSON.stringify(feedbackText)}))`, `${label} detail feedback`);
      await invoke(win, `async()=>{document.getElementById("job-detail-dialog")?.close(); return true}`);
    };
    await detailAction(ids.detailApprove, "P50 Detail Approve", "job-detail-approve", "Approve", "Retry requested");
    check("Job Details Approve uses the shared pending action path", counts.approve === 3 && jobs.getJob(ids.detailApprove).status !== "needs_attention", JSON.stringify({ approveCalls: counts.approve, status: jobs.getJob(ids.detailApprove).status }));
    await detailAction(ids.detailPause, "P50 Detail Pause", "job-detail-pause", "Pause", "Job paused");
    check("Job Details Pause is available only for a legal working state", counts.pause === 1 && jobs.getJob(ids.detailPause).status === "waiting", JSON.stringify({ pauseCalls: counts.pause, status: jobs.getJob(ids.detailPause).status }));
    await detailAction(ids.detailResume, "P50 Detail Resume", "job-detail-resume", "Resume", "Job resumed");
    check("Job Details Resume is available only for a legal waiting state", counts.resume === 1 && jobs.getJob(ids.detailResume).status !== "waiting", JSON.stringify({ resumeCalls: counts.resume, status: jobs.getJob(ids.detailResume).status }));
    await detailAction(ids.detailDismiss, "P50 Detail Dismiss", "job-detail-dismiss", "Dismiss", "Attention dismissed");
    check("Job Details Dismiss clears Attention with scoped feedback", counts.dismiss === 2 && jobs.getJob(ids.detailDismiss).status === "failed", JSON.stringify({ dismissCalls: counts.dismiss, status: jobs.getJob(ids.detailDismiss).status }));
    const detailText = await invoke(win, `async()=>({meta:document.getElementById("job-detail-meta")?.textContent||"",feedback:document.getElementById("job-detail-feedback")?.textContent||"",body:document.getElementById("job-detail-body")?.textContent||""})`);
    check("Job Details feedback and identity text contain no opaque IDs or internal authority", ![owner.id, peer.id, workspace.id, "node-p50-internal", "provider", "session", "credential", "raw path"].some((value)=>String(detailText.meta + detailText.feedback + detailText.body).toLowerCase().includes(String(value).toLowerCase())), JSON.stringify(detailText));
    check("Work/Job renderer uses no native prompt or confirm", !/window\.(?:prompt|confirm)\s*\(/.test(await invoke(win, `async()=>String(document.body.innerHTML)`)), "native dialogs absent");
  } catch (error) {
    check("P50 hidden Work/Job gate completes", false, String(error?.message ?? error));
    try { process.stderr.write(`${error?.stack ?? error}\n`); } catch {}
  }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  const result = { schema: "sovereignbot.desktop.p50-job-actions.v1", checks, failed, notes, fixtureBoundary: "LOCAL_FIXTURE", publishEligible: false, externalActions: [], ok: failed.length === 0 };
  let evidenceError;
  try {
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(join(evidenceDir, "verify-p50-job-actions.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
      await writeFile(join(evidenceDir, "verify-p50-job-actions.log"), `${notes.join("\n")}\n${result.ok ? "PASS" : "FAIL"} P50 Work/Job gate summary ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} checks passed\n`, "utf8");
    }
  } catch (error) {
    evidenceError = error;
    try { process.stderr.write(`P50 evidence write failed: ${error?.stack ?? error}\n`); } catch {}
  }
  const finalFailed = evidenceError ? [...failed, "P50 evidence write"] : failed;
  const exitCode = finalFailed.length ? 1 : 0;
  try { process.stdout.write(`${exitCode ? "FAIL" : "PASS"} P50 Work/Job gate summary ${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length} checks passed\n`); } catch {}
  try { unbind?.(); } catch {}
  try { uninstallProtocol?.(); } catch {}
  if (dataDir) try { await rm(dataDir, { recursive: true, force: true }); } catch {}
  const finalResult = { ...result, failed: finalFailed, ok: exitCode === 0 };
  if (app?.exit) {
    if (exitCode) { app.exit(1); return finalResult; }
    app.exit(0);
    return { ok: true, checks };
  }
  try { win?.destroy(); } catch {}
  if (exitCode) throw new Error(`P50 Work/Job gate failed: ${finalFailed.join(", ")}`);
  return finalResult;
}
