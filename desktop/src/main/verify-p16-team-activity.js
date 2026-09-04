// P16 hidden acceptance gate for the first-class Team Activity drawer.
// It uses the real hidden Electron renderer, sandboxed preload, validated IPC,
// TeamService ledger, stores, and managed workspace services. No provider or
// network runtime is started.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { desktopVersion } from "./lib/desktop-version.js";
import { createDesktopServices } from "./services.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createArtifactStore } from "./artifact-store.js";
import { createTeamService } from "./team-service.js";
import { coworkerAgentId } from "./provider-roster.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = join(WORKTREE_ROOT, "_evidence_v55_2026-09-03");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function localRoster() { return { ready: false, mode: "local-gate", roles: {}, agents: [], providers: {}, coworkerBindings: {} }; }

function makeFixture(dataDir) {
  const stateDir = join(dataDir, "desktop-state"); mkdirSync(stateDir, { recursive: true });
  const services = createDesktopServices({ dataDir, dialog: {} });
  const coworkerStore = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
  const names = [["P16 Alpha Owner", "Coordinate local Team work"], ["P16 Builder", "Build bounded changes"], ["P16 Reviewer", "Review bounded changes"], ["P16 Researcher", "Research bounded questions"]];
  for (const [name, role] of names) if (!coworkerStore.list({ includeArchived: true }).coworkers.some((entry) => entry.name === name)) coworkerStore.create({ name, role, instructions: "Return bounded local results." });
  const coworkers = coworkerStore.list({ includeArchived: true }).coworkers;
  const byName = (name) => coworkers.find((entry) => entry.name === name);
  const refs = { chief: byName("P16 Alpha Owner"), builder: byName("P16 Builder"), reviewer: byName("P16 Reviewer"), researcher: byName("P16 Researcher") };
  const conversationStore = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore });
  const teamService = createTeamService({ dataDir, coworkerStore, conversationStore, services });
  teamService.setRuntimeHandoffPreflight(({ conversationId, targetCoworkerId, workspaceId }) => ({ targetCoworkerId, agentId: coworkerAgentId(targetCoworkerId), workspaceId: workspaceId ?? teamService.workspaceIdForConversation(conversationId) }));
  conversationStore.setTeamRouteResolver((conversation) => teamService.currentOwnerForConversation(conversation.id));
  const artifactStore = createArtifactStore({ dataDir });
  return { services, coworkerStore, conversationStore, teamService, artifactStore, ...refs, activityRequests: [], delayNextAlpha: false, alphaConversationId: undefined };
}

function handlers(fixture) {
  const { services, coworkerStore, conversationStore, teamService, artifactStore } = fixture;
  return {
    "app:handshake": () => ({ ok: true, version: desktopVersion(), platform: process.platform, locale: "en-US", language: services.getSettings().language }),
    "firstrun:getStatus": () => ({ browsers: [] }),
    "workspace:list": () => services.listWorkspaces(),
    "workspace:addViaDialog": () => ({ added: false }),
    "settings:get": () => services.getSettings(),
    "settings:update": (patch) => services.updateSettings(patch),
    "provider:getRoster": () => localRoster(),
    "provider:refresh": () => ({ applied: false, roster: localRoster() }),
    "coworker:list": (payload) => coworkerStore.list(payload),
    "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
    "conversation:list": () => conversationStore.list(),
    "conversation:get": ({ conversationId }) => conversationStore.get(conversationId),
    "team:list": () => teamService.list(),
    "team:get": ({ teamId }) => teamService.get(teamId),
    "team:activity": async (payload) => {
      fixture.activityRequests.push(structuredClone(payload));
      if (fixture.delayNextAlpha && payload.conversationId === fixture.alphaConversationId) { fixture.delayNextAlpha = false; await sleep(500); }
      return teamService.activity(payload);
    },
    "team:requestCollaboration": (payload) => teamService.requestCollaboration(payload),
    "team:requestParallel": (payload) => teamService.requestParallelCollaboration(payload),
    "channel:list": (payload) => teamService.listChannels(payload),
    "channel:get": ({ channelId }) => teamService.getChannel(channelId),
    "artifact:list": (payload) => artifactStore.list(payload),
    "artifact:get": ({ artifactId }) => artifactStore.get(artifactId),
    "artifact:preview": ({ artifactId }) => artifactStore.previewText(artifactId),
    "artifact:hub": (payload) => artifactStore.list(payload),
    "artifact:history": ({ artifactId }) => artifactStore.history(artifactId),
    "computer:history": () => ({ history: [] }),
    "project:list": () => ({ projects: [] }),
    "skill:list": () => ({ skills: [] }),
    "playbook:list": () => ({ playbooks: [] }),
    "memory:list": () => ({ memories: [] }),
    "memory:listSuggestions": () => ({ suggestions: [] }),
    "connectedApps:list": () => ({ apps: [] }),
    "eventTrigger:list": () => ({ triggers: [] }),
    "job:list": () => ({ jobs: [] }),
    "job:attention": () => ({ jobs: [] }),
    "routine:list": () => ({ routines: [] }),
    "operator:getOverview": () => ({ agents: [], tasks: [] }),
    "operator:getAudit": () => ({ entries: [] }),
    "data:status": () => ({ backups: [] }),
    "data:listBackups": () => ({ backups: [] }),
    "update:status": () => ({ available: false }),
  };
}

function seedUserMessage(fixture, conversationId, text) {
  const message = fixture.conversationStore.postUserMessage(conversationId, { text });
  fixture.teamService.onMessageQueued({ conversation: fixture.conversationStore.get(conversationId), message });
  return message;
}

function collaborationContext(fixture, conversationId) { return fixture.teamService.collaborationContextForConversation(conversationId); }

function completeDirectedReview(fixture, conversationId, artifactId) {
  const { teamService, builder, reviewer } = fixture;
  const handoff = teamService.requestCollaboration({ conversationId, targetCoworkerId: builder.id, handoffType: "handoff", boundedTask: "Build the bounded local change.", reason: "Builder owns the implementation." });
  let context = collaborationContext(fixture, conversationId);
  teamService.acceptProtocol({ conversationId, targetCoworkerId: builder.id, proofId: teamService.pendingProtocolProof(conversationId).proofId, messageId: handoff.message.id, ...context, expectedVersion: context.version });
  context = collaborationContext(fixture, conversationId);
  teamService.claimStage({ conversationId, ownerId: builder.id, messageId: handoff.message.id, ...context, expectedVersion: context.version });
  context = collaborationContext(fixture, conversationId);
  teamService.submitProtocolResult({ conversationId, coworkerId: builder.id, messageId: handoff.message.id, artifactIds: [artifactId], ...context, expectedVersion: context.version });
  const review = teamService.requestCollaboration({ conversationId, targetCoworkerId: reviewer.id, handoffType: "review", boundedTask: "Review the bounded local change.", reason: "Quality needs to validate the result." });
  context = collaborationContext(fixture, conversationId);
  teamService.acceptProtocol({ conversationId, targetCoworkerId: reviewer.id, proofId: teamService.pendingProtocolProof(conversationId).proofId, messageId: review.message.id, ...context, expectedVersion: context.version });
  context = collaborationContext(fixture, conversationId);
  teamService.claimStage({ conversationId, ownerId: reviewer.id, messageId: review.message.id, ...context, expectedVersion: context.version });
  context = collaborationContext(fixture, conversationId);
  teamService.submitProtocolResult({ conversationId, coworkerId: reviewer.id, messageId: review.message.id, artifactIds: [artifactId], ...context, expectedVersion: context.version });
  context = collaborationContext(fixture, conversationId);
  teamService.recordReviewDecision({ conversationId, coworkerId: reviewer.id, messageId: review.message.id, decision: "approved", artifactIds: [artifactId], ...context, expectedVersion: context.version });
  context = collaborationContext(fixture, conversationId);
  teamService.recordCollaborationEvent({ conversationId, type: "run.completed", status: "completed", actorId: reviewer.id, ownerId: reviewer.id, stage: "complete", artifactIds: [artifactId], ...context, expectedVersion: context.version, flowPatch: { stage: "complete", ownerId: undefined, runStatus: "completed", activeProtocol: undefined }, idempotencyKey: "p16-alpha-completed" });
}

function completeParallelWork(fixture, conversationId, artifactId) {
  const { teamService, researcher, builder, reviewer } = fixture;
  const requested = teamService.requestParallelCollaboration({ conversationId, children: [{ targetCoworkerId: researcher.id, boundedTask: "Research the local acceptance." }, { targetCoworkerId: builder.id, boundedTask: "Inspect the local Team surface." }], reviewerCoworkerId: reviewer.id, reason: "Parallel local checks should complete before review." });
  const ownerMessageId = requested.message.id;
  for (const [index, coworker] of [[0, researcher], [1, builder]]) {
    const child = teamService.fanoutContextForConversation(conversationId).activeFanout.children.find((entry) => entry.coworkerId === coworker.id);
    const taskId = `task-p16-${index + 1}`;
    teamService.acceptFanoutChild({ conversationId, childKey: child.key, coworkerId: coworker.id, messageId: ownerMessageId, taskId, workspaceId: teamService.workspaceIdForConversation(conversationId) });
    teamService.completeFanoutChild({ conversationId, childKey: child.key, coworkerId: coworker.id, taskId, artifactIds: [artifactId], resultText: `P16 ${coworker.name} completed a bounded local check.` });
  }
  teamService.requestFanoutReview({ conversationId });
  const reviewMessageId = "p16-local-review-message";
  teamService.acceptFanoutReview({ conversationId, coworkerId: reviewer.id, messageId: reviewMessageId });
  teamService.completeFanoutReview({ conversationId, coworkerId: reviewer.id, decision: "approved", resultText: "The local Team Activity projection is approved." });
  const fanoutId = teamService.fanoutContextForConversation(conversationId).activeFanout.fanoutId;
  teamService.acceptFanoutJoin({ conversationId, coworkerId: fixture.chief.id, messageId: "p16-local-join-message" });
  teamService.completeFanoutJoin({ conversationId, coworkerId: fixture.chief.id, taskId: "task-p16-join", artifactIds: [artifactId], expectedFanoutId: fanoutId });
}

async function loadWindow(win) { await win.loadURL(appOrigin()); await win.webContents.executeJavaScript("(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()"); await sleep(950); }
async function invoke(win, expression) { return win.webContents.executeJavaScript(`(${expression})()`); }
async function waitFor(label, fn, timeoutMs = 20_000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await fn()) return; await sleep(80); } throw new Error(`timed out waiting for ${label}`); }
async function assertReject(win, expression, expected) { let rejected = false; try { await invoke(win, `async()=>${expression}`); } catch (error) { rejected = String(error?.message ?? error).includes(expected); } if (!rejected) throw new Error(`expected rejection containing ${expected}`); }

function safeVisibleActivity(value) {
  return !/(run_|request_|operation_|token_|workspace|provider|account|session|capability|grant|path|cwd|messageId|raw|audit)/i.test(value);
}

export async function runVerifyP16TeamActivity({ app }) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const checks = {}; const log = []; const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} }; const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };
  const tempRoot = process.env.SOVEREIGNBOT_V55_TEMP_ROOT;
  if (!tempRoot) throw new Error("V55 temp root is missing; refusing to use the default user profile");
  const dataDir = join(tempRoot, "data"); let fixture; let alpha; let beta; let win; let unbind; let uninstallProtocol; let fatal;
  try {
    fixture = makeFixture(dataDir);
    alpha = fixture.teamService.createTeam({ title: "P16 Alpha Team", coworkerIds: [fixture.chief.id, fixture.builder.id, fixture.reviewer.id], leadCoworkerId: fixture.chief.id });
    beta = fixture.teamService.createTeam({ title: "P16 Beta Team", coworkerIds: [fixture.chief.id, fixture.researcher.id, fixture.builder.id, fixture.reviewer.id], leadCoworkerId: fixture.chief.id });
    const alphaConversationId = alpha.conversation.id; const betaConversationId = beta.conversation.id; fixture.alphaConversationId = alphaConversationId;
    const alphaMessage = seedUserMessage(fixture, alphaConversationId, "Start Alpha local collaboration.");
    const betaMessage = seedUserMessage(fixture, betaConversationId, "Start Beta local parallel work.");
    const alphaWorkspacePath = fixture.services.workspacePath(alpha.team.sharedWorkspaceId); mkdirSync(alphaWorkspacePath, { recursive: true }); writeFileSync(join(alphaWorkspacePath, "alpha-report.md"), "P16 Alpha report\n", "utf8");
    const alphaArtifact = fixture.artifactStore.ingestWorkspaceFile({ workspaceId: alpha.team.sharedWorkspaceId, workspacePath: alphaWorkspacePath, relativePath: "alpha-report.md", title: "P16 Alpha report", createdByCoworkerId: fixture.builder.id, conversationId: alphaConversationId });
    const betaWorkspacePath = fixture.services.workspacePath(beta.team.sharedWorkspaceId); mkdirSync(betaWorkspacePath, { recursive: true }); writeFileSync(join(betaWorkspacePath, "beta-report.md"), "P16 Beta report\n", "utf8");
    const betaArtifact = fixture.artifactStore.ingestWorkspaceFile({ workspaceId: beta.team.sharedWorkspaceId, workspacePath: betaWorkspacePath, relativePath: "beta-report.md", title: "P16 Beta report", createdByCoworkerId: fixture.researcher.id, conversationId: betaConversationId });
    completeDirectedReview(fixture, alphaConversationId, alphaArtifact.id);
    completeParallelWork(fixture, betaConversationId, betaArtifact.id);
    let alphaContext = collaborationContext(fixture, alphaConversationId);
    fixture.teamService.recordCollaborationEvent({ conversationId: alphaConversationId, type: "work.failed", status: "attention", actorId: fixture.reviewer.id, ownerId: fixture.reviewer.id, targetCoworkerId: fixture.reviewer.id, stage: "complete", reason: "P16 attention navigation sample.", ...alphaContext, expectedVersion: alphaContext.version, flowPatch: { runStatus: "attention", attentionReason: "P16 attention navigation sample." }, idempotencyKey: "p16-alpha-attention" });
    uninstallProtocol = installAppProtocolHandler(); win = createMainWindow({ smoke: true }); unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
    check("hidden Electron window stays hidden", win.isVisible() === false); await loadWindow(win);
    const surface = await invoke(win, "async()=>({activity:typeof window.sovereignbot?.teams?.activity,drawer:!!document.getElementById('activity-drawer'),timeline:!!document.getElementById('team-activity-timeline'),selector:!!document.getElementById('activity-team-select')})");
    check("real preload exposes Team Activity and the drawer timeline", surface.activity === "function" && surface.drawer && surface.timeline && surface.selector, JSON.stringify(surface));
    await invoke(win, "async()=>{document.getElementById('nav-activity')?.click(); return true}");
    await waitFor("Team Activity selector", async () => await invoke(win, "async()=>document.querySelectorAll('#activity-team-select option').length===2"));
    const initialUi = await invoke(win, "async()=>({drawer:!document.getElementById('activity-drawer')?.classList.contains('hidden'),selectorDisabled:document.getElementById('activity-team-select')?.disabled,rows:document.querySelectorAll('#team-activity-timeline [role=listitem]').length,body:document.getElementById('activity-drawer')?.innerText||''})");
    check("uncontextual Activity offers a safe Team selector and bounded accessible rows", initialUi.drawer && initialUi.selectorDisabled === false && initialUi.rows > 0 && /Newest first|最新在前/.test(initialUi.body) && !/run_|request_|operation_|token_|workspacePath|sessionId|messageId/i.test(initialUi.body), JSON.stringify({ selectorDisabled: initialUi.selectorDisabled, rows: initialUi.rows }));
    await invoke(win, `async()=>{const select=document.getElementById('activity-team-select'); select.value=${JSON.stringify(beta.team.id)}; select.dispatchEvent(new Event('change',{bubbles:true})); return true}`);
    await waitFor("Beta Team activity", async () => await invoke(win, "async()=>{const context=document.getElementById('team-activity-context')?.innerText||''; const timeline=document.getElementById('team-activity-timeline')?.innerText||''; return context.includes('P16 Beta Team') && timeline.includes('Parallel work') && !timeline.includes('Attention') && !timeline.includes('P16 Alpha Team');}"));
    const betaUi = await invoke(win, "async()=>({body:document.getElementById('team-activity-timeline')?.innerText||'',context:document.getElementById('team-activity-context')?.innerText||'',rows:document.querySelectorAll('#team-activity-timeline [role=listitem]').length,requests:window.sovereignbot?.teams?'ok':'missing'})");
    check("Team selector isolates Beta history and shows parallel progress labels", betaUi.context.includes("P16 Beta Team") && betaUi.body.includes("Parallel work") && !betaUi.body.includes("P16 Alpha Team") && betaUi.rows >= 5, JSON.stringify({ rows: betaUi.rows }));
    await invoke(win, "async()=>{const button=document.querySelector('#team-list button'); if(button) button.click(); return true}");
    await waitFor("Alpha Team Channel", async () => await invoke(win, "function(){const node=document.getElementById('conversation-title'); return Boolean(node && node.textContent==='Project Channel');}"));
    await waitFor("contextual Alpha activity", async () => await invoke(win, "async()=>{const body=document.getElementById('activity-drawer')?.innerText||''; return body.includes('P16 Alpha Team') && body.includes('Handoff requested');}"));
    const alphaUi = await invoke(win, "async()=>({disabled:document.getElementById('activity-team-select')?.disabled,body:document.getElementById('team-activity-timeline')?.innerText||'',context:document.getElementById('team-activity-context')?.innerText||'',rows:document.querySelectorAll('#team-activity-timeline [role=listitem]').length})");
    check("selected Team Channel makes Activity contextual and keeps Alpha isolated", alphaUi.disabled === true && alphaUi.context.includes("P16 Alpha Team") && !alphaUi.body.includes("P16 Beta Team") && alphaUi.rows >= 8, JSON.stringify({ disabled: alphaUi.disabled, rows: alphaUi.rows }));
    const sourceOpened = await invoke(win, "async()=>{const button=[...document.querySelectorAll('#team-activity-timeline button')].find((entry)=>entry.textContent.includes('Open Project Channel')); button?.click(); return Boolean(button)}"); await sleep(400);
    check("timeline exposes canonical source Team Channel navigation", sourceOpened && await invoke(win, "async()=>{const node=document.getElementById('conversation-title'); return Boolean(node && node.textContent==='Project Channel');}"));
    fixture.delayNextAlpha = true; await invoke(win, "async()=>{const button=document.getElementById('nav-activity'); if(button) button.click(); return true}"); await invoke(win, "async()=>{const button=document.querySelectorAll('#team-list button')[1]; if(button) button.click(); return true}");
    await waitFor("Beta after stale Alpha response", async () => await invoke(win, "async()=>{const context=document.getElementById('team-activity-context')?.innerText||''; const timeline=document.getElementById('team-activity-timeline')?.innerText||''; return context.includes('P16 Beta Team') && timeline.includes('Parallel work') && !timeline.includes('Attention') && !timeline.includes('P16 Alpha Team');}")); await sleep(650);
    const staleUi = await invoke(win, "async()=>({context:document.getElementById('team-activity-context')?.innerText||'',timeline:document.getElementById('team-activity-timeline')?.innerText||''})");
    check("stale Alpha response cannot overwrite newly selected Beta context", staleUi.context.includes("P16 Beta Team") && staleUi.timeline.includes("Parallel work") && !staleUi.timeline.includes("Attention") && !staleUi.timeline.includes("P16 Alpha Team"), JSON.stringify(staleUi).slice(0, 600));
    const artifactOpened = await invoke(win, "async()=>{const button=[...document.querySelectorAll('#team-activity-timeline button')].find((entry)=>entry.textContent.includes('Files & Artifacts')); button?.click(); return Boolean(button)}"); await sleep(450);
    check("artifact reference opens the existing Files & Artifacts surface", artifactOpened && await invoke(win, "async()=>document.getElementById('view-artifacts')?.classList.contains('hidden')===false"));
    await invoke(win, "async()=>{const button=document.querySelector('#team-list button'); if(button) button.click(); const activity=document.getElementById('nav-activity'); if(activity) activity.click(); return true}"); await waitFor("Alpha Activity for Attention", async () => await invoke(win, "async()=>{const node=document.getElementById('team-activity-timeline'); return Boolean(node && node.innerText.includes('Attention'));}"));
    const attentionOpened = await invoke(win, "async()=>{const button=[...document.querySelectorAll('#team-activity-timeline button')].find((entry)=>entry.textContent.includes('Open Attention')); button?.click(); return Boolean(button)}"); await sleep(350);
    check("Attention event opens the existing Attention surface", attentionOpened && await invoke(win, "async()=>document.getElementById('view-attention')?.classList.contains('hidden')===false"));
    const beforeForged = fixture.activityRequests.length; await assertReject(win, `window.sovereignbot.teams.activity({teamId:${JSON.stringify(alpha.team.id)},limit:24,workspacePath:"C:\\\\forged"})`, "unknown field"); await assertReject(win, `window.sovereignbot.teams.activity({teamId:${JSON.stringify(alpha.team.id)},limit:101})`, "between 1 and 100");
    check("forged Team Activity fields and over-limit requests are rejected before the handler", fixture.activityRequests.length === beforeForged, JSON.stringify(fixture.activityRequests.at(-1)));
    check("renderer Team Activity requests contain only opaque scope and bounded limit", fixture.activityRequests.length > 0 && fixture.activityRequests.every((payload) => Object.keys(payload).every((key) => ["teamId", "conversationId", "limit"].includes(key)) && !Object.hasOwn(payload, "workspacePath") && !Object.hasOwn(payload, "messageId")), JSON.stringify(fixture.activityRequests));
    unbind(); unbind = undefined; const restarted = makeFixture(dataDir); restarted.alphaConversationId = alphaConversationId; unbind = bindIpcChannels({ win, handlers: handlers(restarted) }); await loadWindow(win);
    const restored = await invoke(win, `async()=>window.sovereignbot.teams.activity({conversationId:${JSON.stringify(alphaConversationId)},limit:100})`);
    check("restart preserves bounded Team timeline and opaque source conversation", restored.events.length >= 8 && restored.events[0].conversationId === alphaConversationId && restored.events.every((event)=>safeVisibleActivity(JSON.stringify(event))), JSON.stringify({ events: restored.events.length, first: restored.events[0] }));
    check("Team Activity IPC and persisted ledger remain capped", restored.events.length <= 100 && (restarted.teamService.activity({ teamId: alpha.team.id, limit: 100 }).events.length <= 1024), JSON.stringify({ ipcMax: 100, eventCount: restored.events.length }));
  } catch (error) { fatal = error; note(`[fatal] ${String(error?.stack ?? error)}`); check("P16 hidden Team Activity gate runner completed", false, String(error?.message ?? error)); }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name); note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
  writeFileSync(join(EVIDENCE_DIR, "verify-p16-team-activity.json"), `${JSON.stringify({ at: new Date().toISOString(), checks, alphaTeamId: alpha?.team.id, betaTeamId: beta?.team.id, alphaConversationId: alpha?.conversation.id, betaConversationId: beta?.conversation.id, requests: fixture?.activityRequests, fatal: fatal ? String(fatal?.message ?? fatal) : undefined }, null, 2)}\n`, "utf8");
  writeFileSync(join(EVIDENCE_DIR, "verify-p16-team-activity.log"), `${log.join("\n")}\n`, "utf8");
  try { unbind?.(); } catch {} try { uninstallProtocol?.(); } catch {} try { win?.destroy(); } catch {} try { rmSync(dataDir, { recursive: true, force: true }); } catch {} try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  if (fatal || failed.length) throw new Error(`P16 Team Activity gate failed: ${failed.join(", ") || String(fatal?.message ?? fatal)}`);
  app.exit(0);
}
