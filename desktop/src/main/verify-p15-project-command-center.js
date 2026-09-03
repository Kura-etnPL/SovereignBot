// P15 hidden acceptance gate for the Project Command Center. It exercises the
// real hidden Electron window, sandboxed preload, validated IPC and local
// canonical stores/services without starting a provider or network runtime.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { desktopVersion } from "./lib/desktop-version.js";
import { createDesktopServices } from "./services.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createArtifactStore } from "./artifact-store.js";
import { createSkillStore } from "./skill-store.js";
import { createTeamService } from "./team-service.js";
import { createProjectService } from "./project-service.js";
import { createMemoryService } from "./memory-service.js";
import { createSearchService } from "./search-service.js";
import { createConnectedAppsService } from "./connected-apps.js";
import { createProductSurfaceService } from "./product-surface-service.js";
import { createCommandPaletteService } from "./command-palette-service.js";
import { createJobController } from "./job-controller.js";
import { createRoutineController } from "./routine-controller.js";
import { createEventTriggerController } from "./event-trigger-controller.js";
import { MemoryStore } from "../../../src/memory.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(WORKTREE_ROOT, "_evidence_v54_2026-09-03");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function roster() { return { ready: true, mode: "local-gate", roles: { planner: "p15-local-supervisor" }, agents: [], providers: {}, coworkerBindings: {} }; }

export function makeFixture(dataDir) {
  const stateDir = join(dataDir, "desktop-state"); mkdirSync(stateDir, { recursive: true });
  const baseServices = createDesktopServices({ dataDir, dialog: {} });
  const shared = baseServices.createManagedWorkspace({ label: "P15 Command Center workspace", kind: "shared-project", idHint: "p15-shared" });
  const services = { ...baseServices, createManagedWorkspace: () => ({ workspace: structuredClone(shared.workspace), path: shared.path }) };
  const coworkerStore = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
  const chief = coworkerStore.create({ name: "P15 Chief", role: "Own the local acceptance", instructions: "Keep work bounded and local." });
  const specialist = coworkerStore.create({ name: "P15 Specialist", role: "Inspect the Project contents", instructions: "Return a concise local result." });
  const conversationStore = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore });
  const artifactStore = createArtifactStore({ dataDir });
  const skillStore = createSkillStore({ persistPath: join(stateDir, "skills.json") });
  const teamService = createTeamService({ dataDir, coworkerStore, conversationStore, services });
  let routines;
  let eventTriggers;
  let productSurfaces;
  let search;
  let projectService;
  const connectedApps = createConnectedAppsService({ dataDir, teamService, coworkerStore, getProjectScope: (id) => projectService?.resolveScope(id) });
  projectService = createProjectService({ dataDir, services, teamService, coworkerStore, artifactStore, skillStore, connectedApps, getRoutines: () => routines?.list(), getEventTriggers: () => eventTriggers?.list(), getPlaybooks: () => productSurfaces?.listPlaybooks(), onChanged: () => search?.invalidate() });
  connectedApps.setProjectScopeResolver((id) => projectService.resolveScope(id));
  skillStore.setTargetResolver({
    hasCoworker: (id) => coworkerStore.list({ includeArchived: true }).coworkers.some((entry) => entry.id === id),
    hasTeam: (id) => teamService.list().teams.some((entry) => entry.id === id),
    teamIdsForCoworker: (id) => teamService.list().teams.filter((team) => team.coworkerIds.includes(id)).map((team) => team.id),
  });
  const tasks = [];
  const runtime = { orchestrator: {
    async createPlan(input) { return { id: `plan_${tasks.length + 1}`, ...input }; },
    async delegateTrusted(planId, spec, executionContext, supervisorId) { const task = { id: `task_${tasks.length + 1}`, planId, status: "queued", input: spec.input, executionContext, supervisorId }; tasks.push(task); return structuredClone(task); },
    async runUntilIdle() {}, async listTasks() { return structuredClone(tasks); }, async aggregatePlan(planId) { return { planId, status: "completed" }; },
  } };
  const jobs = createJobController({ dataDir, runtime, roster, coworkerStore, services, skillStore, supervisorAgentId: "p15-local-supervisor", readiness: () => ({ allowed: true }), projectService, teamService });
  routines = createRoutineController({ dataDir, jobController: jobs, coworkerStore, skillStore, services, projectService, teamService });
  eventTriggers = createEventTriggerController({ dataDir, routineController: routines, services });
  productSurfaces = createProductSurfaceService({ dataDir, teamService, coworkerStore, artifactStore, runtime, getRuntime: () => runtime });
  const memoryService = createMemoryService({ runtime: { memory: new MemoryStore(join(stateDir, "memory.jsonl")) }, services, coworkerStore, teamService, conversationStore, artifactStore, projectResolver: (id) => projectService.resolveProject(id), onChanged: () => search?.invalidate() });
  projectService.setMemoryService(memoryService);
  search = createSearchService({ teamService, conversationStore, coworkerStore, projectService, artifactStore, skillStore, productSurfaces, getRoutines: () => routines?.list(), memoryService, getJobs: () => jobs, getHistory: (payload) => productSurfaces.computerHistory(payload) });
  conversationStore.onMessage(() => search?.invalidate());
  const palette = createCommandPaletteService({ runRoutine: (routineId) => routines.runNow(routineId) });
  return { services, rawServices: baseServices, coworkerStore, conversationStore, artifactStore, skillStore, teamService, projectService, memoryService, connectedApps, productSurfaces, routines, eventTriggers, search, jobs, palette, chief, specialist, sharedWorkspaceId: shared.workspace.id };
}

export function handlers(fixture) {
  const { services, coworkerStore, conversationStore, artifactStore, skillStore, teamService, projectService, memoryService, connectedApps, productSurfaces, routines, eventTriggers, search, jobs, palette } = fixture;
  return {
    "app:handshake": () => ({ ok: true, version: desktopVersion(), platform: process.platform, locale: "en-US", language: services.getSettings().language }),
    "firstrun:getStatus": () => ({ browsers: [] }), "workspace:list": () => services.listWorkspaces(), "workspace:addViaDialog": () => ({ added: false }), "settings:get": () => services.getSettings(), "settings:update": (patch) => services.updateSettings(patch),
    "provider:getRoster": () => roster(), "provider:refresh": () => ({ applied: false, roster: roster() }), "coworker:list": (payload) => coworkerStore.list(payload), "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
    "conversation:list": () => conversationStore.list(), "conversation:get": ({ conversationId, limit, beforeMessageId, aroundMessageId }) => conversationStore.getPage(conversationId, { limit, beforeMessageId, aroundMessageId }), "conversation:acknowledge": ({ conversationId }) => ({ resolved: false, count: 0, conversationId }),
    "project:list": (payload) => projectService.list(payload), "project:get": ({ projectId }) => projectService.get(projectId), "project:create": ({ name }) => projectService.create({ name }), "project:open": ({ projectId }) => projectService.open(projectId), "project:archive": ({ projectId }) => projectService.archive(projectId), "project:restore": ({ projectId }) => projectService.restore(projectId), "project:export": ({ projectId }) => projectService.export(projectId), "project:backup": ({ projectId }) => projectService.backup(projectId),
    "team:list": () => teamService.list(), "team:get": ({ teamId }) => teamService.get(teamId), "team:activity": (payload) => teamService.activity(payload), "channel:list": (payload) => teamService.listChannels(payload), "channel:get": ({ channelId }) => teamService.getChannel(channelId),
    "memory:list": (payload) => memoryService.list(payload), "memory:putFact": (payload) => memoryService.putFact(payload), "memory:get": (payload) => memoryService.get(payload), "memory:update": (payload) => memoryService.update(payload), "memory:forget": (payload) => memoryService.forget(payload), "memory:delete": (payload) => memoryService.delete(payload), "memory:pin": (payload) => memoryService.pin(payload), "memory:sourceTrace": (payload) => memoryService.sourceTrace(payload), "memory:listSuggestions": () => memoryService.listSuggestions(), "memory:approveSuggestion": ({ suggestionId }) => memoryService.approveSuggestion(suggestionId), "memory:rejectSuggestion": ({ suggestionId }) => memoryService.rejectSuggestion(suggestionId),
    "artifact:list": (payload) => artifactStore.list(payload), "artifact:get": ({ artifactId }) => artifactStore.get(artifactId), "artifact:preview": ({ artifactId }) => artifactStore.previewText(artifactId), "artifact:hub": (payload) => productSurfaces.artifactHub(payload), "artifact:history": (payload) => productSurfaces.artifactHistory(payload), "computer:history": (payload) => productSurfaces.computerHistory(payload),
    "skill:list": (payload) => skillStore.list(payload), "skill:get": ({ skillId }) => skillStore.get(skillId), "skill:create": ({ skill }) => skillStore.create(skill), "skill:assign": (payload) => skillStore.assign(payload.skillId, payload),
    "playbook:list": (payload) => productSurfaces.listPlaybooks(payload), "playbook:create": (payload) => productSurfaces.createPlaybook(payload.playbook), "playbook:assign": ({ playbookId, teamId, channelId }) => productSurfaces.assignPlaybook(playbookId, { teamId, channelId }),
    "routine:list": (payload) => routines.list(payload), "routine:get": ({ routineId }) => routines.get(routineId), "routine:create": (payload) => routines.create(payload), "routine:setEnabled": ({ routineId, enabled }) => routines.setEnabled(routineId, enabled), "routine:archive": ({ routineId }) => routines.archive(routineId), "routine:restore": ({ routineId }) => routines.restore(routineId), "routine:history": ({ routineId }) => routines.history(routineId), "routine:runNow": ({ routineId }) => routines.runNow(routineId), "routine:remove": ({ routineId }) => routines.remove(routineId),
    "eventTrigger:list": () => eventTriggers.list(), "eventTrigger:get": ({ triggerId }) => eventTriggers.get(triggerId), "eventTrigger:create": (payload) => eventTriggers.create(payload), "eventTrigger:setEnabled": ({ triggerId, enabled }) => eventTriggers.setEnabled(triggerId, enabled), "eventTrigger:remove": ({ triggerId }) => eventTriggers.remove(triggerId),
    "connectedApps:list": (payload) => connectedApps.list(payload), "connectedApps:search": (payload) => connectedApps.search(payload), "connectedApps:assign": (payload) => connectedApps.setAssignment(payload), "connectedApps:health": (payload) => connectedApps.health(payload),
    "search:query": (payload) => search.query(payload), "palette:list": () => palette.list(), "palette:execute": (payload) => palette.execute({ commandId: payload.paletteId, args: payload.args }), "job:list": () => jobs.listJobs(), "job:attention": (payload) => jobs.attentionJobs(payload), "thisPc:list": () => ({ items: [] }), "data:status": () => ({ backups: [] }), "data:listBackups": () => ({ backups: [] }), "update:status": () => ({ available: false }), "notification:list": () => ({ notifications: [], totalCount: 0, unreadCount: 0 }),
  };
}

export async function loadWindow(win) { await win.loadURL(appOrigin()); await win.webContents.executeJavaScript("(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()"); await sleep(950); }
export async function invoke(win, expression) { return win.webContents.executeJavaScript(`(${expression})()`); }

export async function runVerifyP15ProjectCommandCenter({ app, projectCreateGate = false, routinePaletteGate = false }) {
  mkdirSync(EVIDENCE_DIR, { recursive: true }); const evidenceBase = routinePaletteGate ? "verify-p29-routine-selector" : projectCreateGate ? "verify-p28-project-create" : "verify-p15-project-command-center"; const checks = {}; const log = []; const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} }; const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };
  let dataDir; let fixture; let win; let unbind; let uninstallProtocol; let fatal; let projectId; let uiProjectId; let teamId; let conversationId; let artifactId; let memoryId; let routineId; let triggerId;
  try {
    dataDir = mkdtempSync(join(tmpdir(), "sovereign-p15-")); fixture = makeFixture(dataDir); uninstallProtocol = installAppProtocolHandler(); win = createMainWindow({ smoke: true }); unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
    check("hidden Electron window stays hidden", win.isVisible() === false); await loadWindow(win);
    const surface = await invoke(win, `async()=>({projects:typeof window.sovereignbot?.projects?.get,projectNav:!!document.getElementById("nav-projects"),workbench:!!document.getElementById("view-projects"),ready:document.readyState})`);
    check("real preload exposes Project command-center surface", surface.projects === "function" && surface.projectNav && surface.workbench, JSON.stringify(surface));
    if (projectCreateGate) {
      await invoke(win, `async()=>{document.getElementById("nav-projects")?.click(); return true}`); await sleep(350);
      const before = await invoke(win, `async()=>window.sovereignbot.projects.list({includeArchived:true,limit:50})`);
      await invoke(win, `async()=>{document.getElementById("project-create")?.click(); return true}`); await sleep(100);
      const opened = await invoke(win, `async()=>({open:document.getElementById("project-create-dialog")?.open===true, name:document.getElementById("project-create-name")?.value||"", save:!!document.getElementById("project-create-save")})`);
      check("Project create uses a bounded in-product dialog", opened.open && opened.name === "" && opened.save, JSON.stringify(opened));
      await invoke(win, `async()=>{const input=document.getElementById("project-create-name"); input.value="   "; document.getElementById("project-create-save")?.click(); return true}`); await sleep(100);
      const invalid = await invoke(win, `async()=>({open:document.getElementById("project-create-dialog")?.open===true,error:document.getElementById("project-create-form-error")?.textContent||"",count:(await window.sovereignbot.projects.list({includeArchived:true,limit:50})).projects.length})`);
      check("blank Project names stay in-dialog and perform no write", invalid.open && /Project name|项目名称/i.test(invalid.error) && invalid.count === (before.projects?.length ?? -1), JSON.stringify(invalid));
      await invoke(win, `async()=>{document.querySelector('[data-close-dialog="project-create-dialog"]')?.click(); return true}`); await sleep(100);
      const canceled = await invoke(win, `async()=>({open:document.getElementById("project-create-dialog")?.open===true,count:(await window.sovereignbot.projects.list({includeArchived:true,limit:50})).projects.length})`);
      check("Project create cancellation closes without writing", !canceled.open && canceled.count === (before.projects?.length ?? -1), JSON.stringify(canceled));
      await invoke(win, `async()=>{document.getElementById("project-create")?.click(); return true}`); await sleep(100);
      await invoke(win, `async()=>{document.getElementById("project-create-name").value="P28 Projects UX"; document.getElementById("project-create-save")?.click(); return true}`); await sleep(700);
      const createdFromUi = await invoke(win, `async()=>window.sovereignbot.projects.list({includeArchived:true,limit:50})`);
      const uiProject = createdFromUi.projects?.find((entry)=>entry.name === "P28 Projects UX"); uiProjectId = uiProject?.projectId;
      const closed = await invoke(win, `async()=>document.getElementById("project-create-dialog")?.open===false`);
      check("Project create follows the real UI → IPC → service path", /^project_[a-f0-9]{16}$/i.test(uiProjectId ?? "") && closed, JSON.stringify({ projectId: uiProjectId, count: createdFromUi.projects?.length, closed }));
    }
    if (routinePaletteGate) {
      const runnable = fixture.routines.create({ name: "P29 Runnable", coworkerId: fixture.chief.id, workspaceId: fixture.sharedWorkspaceId, instruction: "Run the P29 local selector check.", schedule: { type: "custom", intervalMinutes: 60 } });
      const disabled = fixture.routines.create({ name: "P29 Disabled", coworkerId: fixture.chief.id, workspaceId: fixture.sharedWorkspaceId, instruction: "Remain disabled during the P29 check.", schedule: { type: "custom", intervalMinutes: 60 } }); fixture.routines.setEnabled(disabled.id, false);
      const archived = fixture.routines.create({ name: "P29 Archived", coworkerId: fixture.chief.id, workspaceId: fixture.sharedWorkspaceId, instruction: "Remain archived during the P29 check.", schedule: { type: "custom", intervalMinutes: 60 } }); fixture.routines.archive(archived.id);
      const unavailableWorkspace = fixture.rawServices.createManagedWorkspace({ label: "P29 unavailable", kind: "shared-project", idHint: "p29-unavailable" });
      const unavailable = fixture.routines.create({ name: "P29 Unavailable", coworkerId: fixture.chief.id, workspaceId: unavailableWorkspace.workspace.id, instruction: "Become unavailable before selection.", schedule: { type: "custom", intervalMinutes: 60 } }); fixture.services.removeWorkspace(unavailableWorkspace.workspace.id);
      const stale = fixture.routines.create({ name: "P29 Stale", coworkerId: fixture.chief.id, workspaceId: fixture.sharedWorkspaceId, instruction: "Be removed after selection.", schedule: { type: "custom", intervalMinutes: 60 } });
      const openSelector = async (keyboard = false) => { if (keyboard) await invoke(win, `async()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true})); return true}`); else await invoke(win, `async()=>{document.getElementById("open-command-palette")?.click(); return true}`); await sleep(250); await invoke(win, `async()=>{const item=[...document.querySelectorAll("#palette-results button")].find((node)=>node.textContent.includes("Run Routine")); item?.click(); return Boolean(item)}`); await sleep(180); };
      await openSelector(true);
      const selector = await invoke(win, `async()=>({open:document.getElementById("routine-run-dialog")?.open===true,search:!!document.getElementById("routine-run-search"),list:!!document.getElementById("routine-run-list"),confirm:!!document.getElementById("routine-run-confirm")})`);
      check("Command Palette opens a bounded Routine selector by keyboard", selector.open && selector.search && selector.list && selector.confirm, JSON.stringify(selector));
      const options = await invoke(win, `async()=>[...document.querySelectorAll("#routine-run-list [data-routine-id]")].map((node)=>({id:node.dataset.routineId,name:node.querySelector("strong")?.textContent||"",disabled:node.disabled,text:node.textContent||""}))`);
      const optionByName = new Map(options.map((entry)=>[entry.name, entry]));
      check("selector exposes safe Routine names and fail-closed lifecycle states", optionByName.get("P29 Runnable")?.disabled === false && optionByName.get("P29 Disabled")?.disabled === true && optionByName.get("P29 Archived")?.disabled === true && optionByName.get("P29 Unavailable")?.disabled === true && /Ready/.test(optionByName.get("P29 Runnable")?.text ?? "") && /Disabled/.test(optionByName.get("P29 Disabled")?.text ?? "") && /Archived/.test(optionByName.get("P29 Archived")?.text ?? "") && /Unavailable/.test(optionByName.get("P29 Unavailable")?.text ?? ""), JSON.stringify(options));
      const jobsBefore = fixture.jobs.listJobs().jobs.length;
      await invoke(win, `async()=>{document.querySelector('[data-close-dialog="routine-run-dialog"]')?.click(); return true}`); await sleep(100);
      check("selector cancellation performs no governed run", fixture.jobs.listJobs().jobs.length === jobsBefore, JSON.stringify({ jobsBefore, jobsAfter: fixture.jobs.listJobs().jobs.length }));
      await openSelector(); await invoke(win, `async()=>{document.getElementById("routine-run-confirm")?.click(); return true}`); await sleep(100);
      const noSelection = await invoke(win, `async()=>({open:document.getElementById("routine-run-dialog")?.open===true,error:document.getElementById("routine-run-form-error")?.textContent||""})`);
      check("no Routine selection stays in-dialog and performs no run", noSelection.open && /Choose.*Routine|选择.*例行/i.test(noSelection.error) && fixture.jobs.listJobs().jobs.length === jobsBefore, JSON.stringify(noSelection));
      await invoke(win, `async()=>{document.querySelector('[data-close-dialog="routine-run-dialog"]')?.click(); return true}`); await sleep(100);
      await openSelector(); await invoke(win, `async()=>{document.querySelector('[data-routine-id="${runnable.id}"]')?.click(); document.getElementById("routine-run-confirm")?.click(); return true}`); await sleep(450);
      const success = await invoke(win, `async()=>({dialogOpen:document.getElementById("routine-run-dialog")?.open===true,paletteStatus:document.getElementById("palette-status")?.textContent||""})`);
      check("selected Routine reuses palette IPC and creates one governed Job", fixture.jobs.listJobs().jobs.length === jobsBefore + 1 && !success.dialogOpen && /Routine started|已启动/.test(success.paletteStatus), JSON.stringify({ success, jobs: fixture.jobs.listJobs().jobs.length }));
      await openSelector(); await invoke(win, `async()=>{document.querySelector('[data-routine-id="${stale.id}"]')?.click(); return true}`); fixture.routines.remove(stale.id); await invoke(win, `async()=>{document.getElementById("routine-run-confirm")?.click(); return true}`); await sleep(150);
      const staleResult = await invoke(win, `async()=>({open:document.getElementById("routine-run-dialog")?.open===true,error:document.getElementById("routine-run-form-error")?.textContent||""})`);
      check("stale Routine ids fail closed with an in-product error and no Job", staleResult.open && /unknown routine|not runnable|未启动/i.test(staleResult.error) && fixture.jobs.listJobs().jobs.length === jobsBefore + 1, JSON.stringify(staleResult));
      await invoke(win, `async()=>{document.querySelector('[data-close-dialog="routine-run-dialog"]')?.click(); return true}`); await sleep(100);
      await assertReject(win, `window.sovereignbot.palette.execute({paletteId:"run-routine",args:{routineId:"routine_ffffffffffffffff"}})`, "unknown routine id");
      check("forged Routine id is rejected by the governed palette service", fixture.jobs.listJobs().jobs.length === jobsBefore + 1, JSON.stringify({ jobs: fixture.jobs.listJobs().jobs.length }));
      fixture.routines.setEnabled(runnable.id, false); fixture.routines.setEnabled(unavailable.id, false);
    }
    const team = fixture.teamService.createTeam({ title: "P15 Command Team", coworkerIds: [fixture.chief.id, fixture.specialist.id], leadCoworkerId: fixture.chief.id }); teamId = team.team.id; conversationId = team.team.channels[0].conversationId;
    const created = await invoke(win, `async()=>window.sovereignbot.projects.create({name:"P15 Command Center"})`); projectId = created.projectId;
    check("renderer creates canonical Project", /^project_[a-f0-9]{16}$/i.test(projectId) && created.name === "P15 Command Center", JSON.stringify({ projectId, name: created.name }));
    const skill = await invoke(win, `async()=>window.sovereignbot.skills.create({skill:{name:"P15 Skill",description:"Project-scoped skill",instructions:"Verify the bounded Project result."}})`); await invoke(win, `async()=>window.sovereignbot.skills.assign({skillId:${JSON.stringify(skill.id)},targetKind:"team",targetId:${JSON.stringify(teamId)},enabled:true})`);
    await invoke(win, `async()=>window.sovereignbot.connectedApps.assign({appId:"sovereignbot-workspace",projectId:${JSON.stringify(projectId)},teamId:${JSON.stringify(teamId)},enabled:true})`);
    const routine = await invoke(win, `async()=>window.sovereignbot.routines.create({name:"P15 Routine",instruction:"Prepare the local Project summary.",coworkerId:${JSON.stringify(fixture.chief.id)},teamId:${JSON.stringify(teamId)},projectId:${JSON.stringify(projectId)},workspaceId:${JSON.stringify(fixture.sharedWorkspaceId)},skillId:${JSON.stringify(skill.id)},schedule:{type:"custom",intervalMinutes:60}})`); routineId = routine.id;
    const trigger = await invoke(win, `async()=>window.sovereignbot.eventTriggers.create({name:"P15 Trigger",routineId:${JSON.stringify(routineId)},workspaceId:${JSON.stringify(fixture.sharedWorkspaceId)},pathPrefix:"inbox"})`); triggerId = trigger.id; await invoke(win, `async()=>window.sovereignbot.routines.setEnabled({routineId:${JSON.stringify(routineId)},enabled:false})`); await invoke(win, `async()=>window.sovereignbot.eventTriggers.setEnabled({triggerId:${JSON.stringify(triggerId)},enabled:false})`);
    const workspacePath = fixture.services.workspacePath(fixture.sharedWorkspaceId); mkdirSync(join(workspacePath, "inbox"), { recursive: true }); writeFileSync(join(workspacePath, "inbox", "p15-report.md"), "P15 local report\n", "utf8"); const artifact = fixture.artifactStore.ingestWorkspaceFile({ workspaceId: fixture.sharedWorkspaceId, workspacePath, relativePath: "inbox/p15-report.md", title: "P15 Report", createdByCoworkerId: fixture.chief.id, conversationId }); artifactId = artifact.id;
    const fact = await invoke(win, `async()=>window.sovereignbot.memory.putFact({scope:"project",ownerId:${JSON.stringify(projectId)},draft:{title:"P15 Memory",content:"Project contents remain bounded and local.",tags:["p15"]},label:"P15 acceptance fact"})`); memoryId = fact.id;
    await invoke(win, `async()=>{document.getElementById("nav-projects")?.click(); return true}`); await sleep(500); await invoke(win, `async()=>{document.getElementById("project-refresh")?.click(); return true}`); await sleep(700); await invoke(win, `async()=>{const switcher=document.getElementById("project-switcher"); if(switcher){switcher.value=${JSON.stringify(projectId)}; switcher.dispatchEvent(new Event("change",{bubbles:true}));} return true}`); await sleep(150);
    const projected = await invoke(win, `async()=>window.sovereignbot.projects.get({projectId:${JSON.stringify(projectId)}})`);
    const contentKeys = Object.keys(projected.contents ?? {}); const groupTotals = Object.fromEntries(contentKeys.map((key)=>[key,projected.contents[key].total]));
    check("Project public projection contains all bounded command-center groups", JSON.stringify(contentKeys) === JSON.stringify(["teams","channels","coworkers","files","artifacts","skills","playbooks","routines","triggers","memory","connectedApps"]), JSON.stringify(contentKeys));
    check("all associated canonical entities are scoped into the Project", ["teams","channels","coworkers","files","artifacts","skills","playbooks","routines","triggers","memory","connectedApps"].every((key)=>groupTotals[key] >= 1), JSON.stringify(groupTotals));
    check("Project projection is bounded and authority-free", Object.values(projected.contents).every((section)=>section.items.length <= 50 && Number.isInteger(section.total) && typeof section.truncated === "boolean") && !JSON.stringify(projected).match(/workspacePath|workspaceId|pathPrefix|sourceRelativePath|storageRelativePath|provider|token|session|capability/i), JSON.stringify({ groupTotals, sample: projected.contents.artifacts.items[0] }));
    const ui = await invoke(win, `async()=>({active:document.getElementById("view-projects")?.classList.contains("hidden")===false,selected:document.getElementById("project-switcher")?.value,body:document.getElementById("project-detail")?.innerText||"",conversation:window.__p15SelectedConversation||null})`);
    check("Project switcher selects the workbench without jumping to a conversation", ui.active && ui.selected === projectId && ui.body.includes("P15 Command Center") && !ui.conversation, JSON.stringify({ active: ui.active, selected: ui.selected, conversation: ui.conversation }));
    check("workbench renders every grouped section and associated labels", ["Teams /","Channels /","Coworkers /","Files /","Artifacts /","Skills /","Playbooks /","Routines /","Triggers /","Memory /","Connected Apps /","P15 Report","P15 Skill","P15 Routine","P15 Trigger","P15 Memory"].every((text)=>ui.body.includes(text)), ui.body.slice(0, 5000));
    const connectedAppsClicked = await invoke(win, `async()=>{const button=[...document.querySelectorAll("#project-detail button")].find((item)=>item.textContent.includes("Open Connected Apps / 打开已连接应用")); button?.click(); return Boolean(button)}`); await sleep(550); const appsNavigation = await invoke(win, `async()=>({ clicked:${connectedAppsClicked}, visible:document.getElementById("view-apps")?.classList.contains("hidden")===false, title:document.querySelector("#view-apps h1")?.textContent||"" })`); check("Connected Apps navigation opens the existing Apps surface", appsNavigation.clicked && appsNavigation.visible && appsNavigation.title.includes("Apps Catalog"), JSON.stringify(appsNavigation));
    await invoke(win, `async()=>{document.getElementById("nav-projects")?.click(); return true}`); await sleep(350);
    const channelOpened = await invoke(win, `async()=>{const row=[...document.querySelectorAll("#project-detail .project-content-section")].find((node)=>node.textContent.includes("Channels /")); row?.querySelector("button")?.click(); return true}`); await sleep(500); const navigation = await invoke(win, `async()=>({title:document.getElementById("conversation-title")?.textContent||"",dom:document.getElementById("view-conversation")?.classList.contains("hidden")===false})`); check("canonical Channel navigation opens only the selected Project conversation", channelOpened && navigation.dom && navigation.title.includes("P15"), JSON.stringify(navigation));
    await invoke(win, `async()=>{document.getElementById("nav-projects")?.click(); return true}`); await sleep(350);
    await invoke(win, `async()=>window.sovereignbot.projects.archive({projectId:${JSON.stringify(projectId)}})`); const archived = await invoke(win, `async()=>window.sovereignbot.projects.get({projectId:${JSON.stringify(projectId)}})`); check("archived Project remains inspectable and labeled", archived.state === "archived" && archived.contents.teams.total >= 1, JSON.stringify({ state: archived.state, teams: archived.contents.teams.total })); await assertReject(win, `window.sovereignbot.projects.open({projectId:${JSON.stringify(projectId)}})`, "archived Project must be restored"); await assertReject(win, `window.sovereignbot.memory.putFact({scope:"project",ownerId:${JSON.stringify(projectId)},draft:{title:"blocked",content:"blocked"}})`, "archived Project memory is read-only");
    await invoke(win, `async()=>window.sovereignbot.projects.restore({projectId:${JSON.stringify(projectId)}})`); unbind?.(); unbind = bindIpcChannels({ win, handlers: handlers(fixture) }); await loadWindow(win); const restarted = await invoke(win, `async()=>window.sovereignbot.projects.get({projectId:${JSON.stringify(projectId)}})`); check("Project and grouped contents survive a real service restart", restarted.state === "active" && restarted.contents.artifacts.items.some((entry)=>entry.id===artifactId) && restarted.contents.memory.items.some((entry)=>entry.id===memoryId) && restarted.contents.routines.items.some((entry)=>entry.id===routineId), JSON.stringify({ state: restarted.state, counts: restarted.counts }));
    if (projectCreateGate) { const restartedProjects = await invoke(win, `async()=>window.sovereignbot.projects.list({includeArchived:true,limit:50})`); const persistedUiProject = restartedProjects.projects?.find((entry)=>entry.projectId===uiProjectId); check("UI-created Project survives a real restart", persistedUiProject?.name === "P28 Projects UX" && persistedUiProject?.state === "active", JSON.stringify(persistedUiProject)); }
    fixture.services.removeWorkspace(fixture.sharedWorkspaceId); const unavailable = await invoke(win, `async()=>window.sovereignbot.projects.list({includeArchived:true,limit:50})`); const unavailableProject = unavailable.projects.find((entry)=>entry.projectId===projectId); check("unavailable workspace remains visible with fail-closed read-only projection", unavailableProject?.available === false && unavailableProject?.contents?.teams?.total === 0, JSON.stringify(unavailableProject)); await assertReject(win, `window.sovereignbot.projects.open({projectId:${JSON.stringify(projectId)}})`, "Project workspace is unavailable"); await assertReject(win, `window.sovereignbot.projects.archive({projectId:${JSON.stringify(projectId)}})`, "Project workspace is unavailable"); await assertReject(win, `window.sovereignbot.projects.export({projectId:${JSON.stringify(projectId)}})`, "Project workspace is unavailable"); await assertReject(win, `window.sovereignbot.projects.backup({projectId:${JSON.stringify(projectId)}})`, "Project workspace is unavailable");
    await assertReject(win, `window.sovereignbot.projects.get({projectId:"project_ffffffffffffffff",workspacePath:"C:\\\\secret"})`, "unexpected request field"); await assertReject(win, `window.sovereignbot.projects.get({projectId:"not-a-project"})`, "Project identifier");
  } catch (error) { fatal = error; note(`[fatal] ${String(error?.stack ?? error)}`); check("P15 hidden gate runner completed", false, String(error?.message ?? error)); }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name); note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`); const summary = { at: new Date().toISOString(), checks, projectId, uiProjectId, teamId, conversationId, artifactId, memoryId, routineId, triggerId, fatal: fatal ? String(fatal?.message ?? fatal) : undefined }; writeFileSync(join(EVIDENCE_DIR, `${evidenceBase}.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8"); writeFileSync(join(EVIDENCE_DIR, `${evidenceBase}.log`), `${log.join("\n")}\n`, "utf8"); try { unbind?.(); } catch {} try { uninstallProtocol?.(); } catch {} try { win?.destroy(); } catch {} try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {} if (fatal || failed.length) throw new Error(`P15 Project Command Center gate failed: ${failed.join(", ") || String(fatal?.message ?? fatal)}`); app.exit(0);
}

async function assertReject(win, expression, expected) { let rejected = false; try { await invoke(win, `async()=>${expression}`); } catch (error) { rejected = String(error?.message ?? error).includes(expected); } if (!rejected) throw new Error(`expected rejection containing ${expected}`); }
