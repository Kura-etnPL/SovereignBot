// V4.6 Project -> Memory -> Search vertical gate. This uses the real hidden
// BrowserWindow, sandboxed preload, validated IPC, local stores, and renderer
// product surfaces. It deliberately does not start a provider or any external
// runtime because this phase is a local product-surface expansion.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
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
import { MemoryStore } from "../../../src/memory.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = join(WORKTREE_ROOT, "_evidence_v46_2026-09-02");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function roster() {
  return { ready: false, mode: "local-gate", roles: {}, agents: [], providers: {}, coworkerBindings: {} };
}

function makeFixture(dataDir) {
  const stateDir = join(dataDir, "desktop-state");
  mkdirSync(stateDir, { recursive: true });
  const services = createDesktopServices({ dataDir, dialog: {} });
  const coworkerStore = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
  coworkerStore.ensureDefaults();
  const conversationStore = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore });
  const artifactStore = createArtifactStore({ dataDir });
  const skillStore = createSkillStore({ persistPath: join(stateDir, "skills.json") });
  const teamService = createTeamService({ dataDir, coworkerStore, conversationStore, services });
  let search;
  const projectService = createProjectService({
    dataDir,
    services,
    teamService,
    coworkerStore,
    artifactStore,
    skillStore,
    onChanged: () => search?.invalidate(),
  });
  const runtime = { memory: new MemoryStore(join(stateDir, "memory.jsonl")) };
  const memoryService = createMemoryService({
    runtime,
    services,
    coworkerStore,
    teamService,
    conversationStore,
    artifactStore,
    projectResolver: (projectId) => projectService.resolveProject(projectId),
    onChanged: () => search?.invalidate(),
  });
  projectService.setMemoryService(memoryService);
  search = createSearchService({
    teamService,
    conversationStore,
    coworkerStore,
    projectService,
    artifactStore,
    skillStore,
    memoryService,
  });
  return { services, coworkerStore, conversationStore, artifactStore, skillStore, teamService, projectService, memoryService, search };
}

function handlers(fixture) {
  const { services, coworkerStore, conversationStore, artifactStore, skillStore, teamService, projectService, memoryService, search } = fixture;
  return {
    "app:handshake": () => ({ ok: true, version: desktopVersion(), platform: process.platform, locale: "en-US", language: services.getSettings().language }),
    "firstrun:getStatus": () => ({ browsers: [] }),
    "workspace:list": () => services.listWorkspaces(),
    "workspace:addViaDialog": () => ({ added: false }),
    "settings:get": () => services.getSettings(),
    "settings:update": (patch) => services.updateSettings(patch),
    "provider:getRoster": () => roster(),
    "provider:refresh": () => ({ applied: false, roster: roster() }),
    "coworker:list": ({ includeArchived }) => coworkerStore.list({ includeArchived }),
    "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
    "conversation:list": () => conversationStore.list(),
    "conversation:get": ({ conversationId }) => conversationStore.get(conversationId),
    "team:list": () => teamService.list(),
    "channel:list": (payload) => teamService.listChannels(payload),
    "artifact:list": (payload) => artifactStore.list(payload),
    "skill:list": ({ includeArchived }) => skillStore.list({ includeArchived }),
    "project:list": (payload) => projectService.list(payload),
    "project:get": ({ projectId }) => projectService.get(projectId),
    "project:create": ({ name }) => projectService.create({ name }),
    "project:open": ({ projectId }) => projectService.open(projectId),
    "project:archive": ({ projectId }) => projectService.archive(projectId),
    "project:restore": ({ projectId }) => projectService.restore(projectId),
    "project:export": ({ projectId }) => projectService.export(projectId),
    "project:backup": ({ projectId }) => projectService.backup(projectId),
    "memory:list": (payload) => memoryService.list(payload),
    "memory:putFact": (payload) => memoryService.putFact(payload),
    "memory:get": (payload) => memoryService.get(payload),
    "memory:update": (payload) => memoryService.update(payload),
    "memory:forget": (payload) => memoryService.forget(payload),
    "memory:delete": (payload) => memoryService.delete(payload),
    "memory:pin": (payload) => memoryService.pin(payload),
    "memory:sourceTrace": (payload) => memoryService.sourceTrace(payload),
    "memory:listSuggestions": () => memoryService.listSuggestions(),
    "memory:approveSuggestion": ({ suggestionId }) => memoryService.approveSuggestion(suggestionId),
    "memory:rejectSuggestion": ({ suggestionId }) => memoryService.rejectSuggestion(suggestionId),
    "search:query": (payload) => search.query(payload),
    "palette:list": () => ({ commands: [{ id: "search", risk: "read-only" }] }),
    "palette:execute": () => ({ ok: true }),
    "connectedApps:list": () => ({ apps: [] }),
    "connectedApps:search": () => ({ apps: [] }),
    "computer:history": () => ({ history: [] }),
    "artifact:hub": () => ({ artifacts: [] }),
    "eventTrigger:list": () => ({ triggers: [] }),
    "data:status": () => ({ backups: [] }),
    "data:listBackups": () => ({ backups: [] }),
    "update:status": () => ({ channel: "stable", currentVersion: desktopVersion(), available: false }),
    "job:list": () => ({ jobs: [] }),
    "job:attention": () => ({ jobs: [] }),
    "routine:list": () => ({ routines: [] }),
  };
}

async function loadWindow(win) {
  await win.loadURL(appOrigin());
  await win.webContents.executeJavaScript("(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()");
  await sleep(900);
}

async function invoke(win, expression) {
  return win.webContents.executeJavaScript(`(${expression})()`);
}

export async function runVerifyV46ProjectMemorySearch({ app }) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const checks = {};
  const log = [];
  const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
  const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };
  let dataDir;
  let fixture;
  let win;
  let unbind;
  let uninstallProtocol;
  let fatal;
  let projectId;
  let memoryId;
  let firstProjection;
  let firstSearch;
  let restartProjection;

  try {
    dataDir = mkdtempSync(join(tmpdir(), "sovereign-v46-"));
    fixture = makeFixture(dataDir);
    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
    check("gate window stays hidden", win.isVisible() === false);
    await loadWindow(win);
    const rendererSurface = await invoke(win, `async()=>({putFact:typeof window.sovereignbot?.memory?.putFact, memoryDialog:!!document.getElementById("memory-fact-dialog"), memoryScope:!!document.getElementById("memory-scope"), projectNav:!!document.getElementById("nav-projects")})`);
    check("renderer exposes the P9 Memory surface", rendererSurface.putFact === "function" && rendererSurface.memoryDialog && rendererSurface.memoryScope && rendererSurface.projectNav, JSON.stringify(rendererSurface));

    const created = await invoke(win, `async()=>window.sovereignbot.projects.create({name:"P9 Local Project"})`);
    projectId = created.projectId;
    check("renderer preload creates canonical Project", /^project_[a-f0-9]{16}$/i.test(projectId) && !JSON.stringify(created).toLowerCase().includes("workspacepath"), JSON.stringify({ projectId, name: created.name }));
    await invoke(win, `async()=>{document.getElementById("nav-projects")?.click(); return true}`);
    await sleep(350);
    const projectSurface = await invoke(win, `async()=>({nav:!!document.getElementById("nav-projects"), cards:[...document.querySelectorAll("#project-list .project-card")].map((card)=>card.innerText), add:[...document.querySelectorAll("#project-list button")].map((button)=>button.textContent.trim())})`);
    check("Project page renders the created Project and Add fact action", projectSurface.cards.some((text) => text.includes("P9 Local Project")) && projectSurface.add.some((text) => text.includes("Add fact")), JSON.stringify(projectSurface));

    await invoke(win, `async()=>{const button=[...document.querySelectorAll("#project-list button")].find((entry)=>entry.textContent.includes("Add fact")); button?.click(); return Boolean(button)}`);
    await sleep(300);
    const formState = await invoke(win, `async()=>({open:!!document.getElementById("memory-fact-dialog")?.open, scope:document.getElementById("memory-scope")?.value, owner:document.getElementById("memory-owner")?.value})`);
    check("Project Add fact opens scoped Memory form", formState.open && formState.scope === "project" && formState.owner === projectId, JSON.stringify(formState));
    await invoke(win, `async()=>{document.getElementById("memory-fact-title").value="P9 launch checklist"; document.getElementById("memory-fact-content").value="Keep the local release checklist in Project Memory."; document.getElementById("memory-fact-tags").value="release, p9"; document.getElementById("memory-fact-form").requestSubmit(); return true}`);
    await sleep(500);
    firstProjection = await invoke(win, `async()=>({view:document.getElementById("view-memory")?.classList.contains("hidden")===false, result:document.getElementById("memory-result")?.textContent, cards:[...document.querySelectorAll("#memory-list .memory-row")].map((card)=>card.innerText)})`);
    const listed = await invoke(win, `async()=>window.sovereignbot.memory.list({scope:"project",ownerId:${JSON.stringify(projectId)},limit:100})`);
    memoryId = listed.memories?.[0]?.id;
    check("approved Project fact appears in Memory UI and IPC projection", firstProjection.view && firstProjection.cards.some((text) => text.includes("P9 launch checklist")) && listed.memories?.length === 1 && listed.memories[0].source?.type === "fact", JSON.stringify({ result: firstProjection.result, memories: listed.memories }));
    check("public Project Memory stays authority-free", !JSON.stringify(listed).toLowerCase().match(/(?:workspacepath|session|provider|account|credential|bearer|token|cwd|authority)/), JSON.stringify(listed));

    const searchState = await invoke(win, `async()=>{document.getElementById("open-command-palette")?.click(); await new Promise((resolve)=>setTimeout(resolve,120)); const scope=document.getElementById("palette-project-scope"); scope.value=${JSON.stringify(projectId)}; scope.dispatchEvent(new Event("change",{bubbles:true})); const type=document.getElementById("palette-type-filter"); type.value="memory"; type.dispatchEvent(new Event("change",{bubbles:true})); const input=document.querySelector("#command-palette input[type=search]"); input.value="P9 launch checklist"; input.dispatchEvent(new Event("input",{bubbles:true})); await new Promise((resolve)=>setTimeout(resolve,350)); return {open:!document.getElementById("command-palette")?.classList.contains("hidden"), body:document.getElementById("palette-results")?.innerText||"", status:document.getElementById("palette-status")?.textContent||""}}`);
    firstSearch = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P9 launch checklist",types:["memory"],projectId:${JSON.stringify(projectId)},status:"active",limit:50})`);
    check("Project-scoped Search finds the approved fact", searchState.open && searchState.body.includes("P9 launch checklist") && firstSearch.results?.some((entry) => entry.id === memoryId && entry.projectId === projectId), JSON.stringify({ ui: searchState, api: firstSearch }));
    check("Search exposes bounded result metadata", firstSearch.total === 1 && firstSearch.hasMore === false && firstSearch.results?.length === 1, JSON.stringify({ total: firstSearch.total, hasMore: firstSearch.hasMore }));
    check("Search result deep-links back to the selected Project Memory", firstSearch.results?.[0]?.navigation?.view === "memory" && firstSearch.results?.[0]?.navigation?.ownerId === projectId && firstSearch.results?.[0]?.navigation?.memoryId === memoryId);
    check("public Search result has no raw authority or Team scope", !JSON.stringify(firstSearch).toLowerCase().match(/(?:workspacepath|team_[a-f0-9]{16}|session|provider|account|credential|bearer|token|cwd|authority)/), JSON.stringify(firstSearch));
    await invoke(win, `async()=>{document.querySelector("#palette-results button")?.click(); return true}`);
    await sleep(300);
    const deepLink = await invoke(win, `async()=>({memoryView:document.getElementById("view-memory")?.classList.contains("hidden")===false, selected:document.querySelector("#memory-list .memory-row.selected")?.innerText||""})`);
    check("renderer Search navigation selects the Memory row", deepLink.memoryView && deepLink.selected.includes("P9 launch checklist"), JSON.stringify(deepLink));

    unbind?.(); unbind = undefined;
    fixture = makeFixture(dataDir);
    unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
    await loadWindow(win);
    const restarted = await invoke(win, `async()=>({project:(await window.sovereignbot.projects.list({includeArchived:true,limit:100})).projects, memory:(await window.sovereignbot.memory.list({scope:"project",ownerId:${JSON.stringify(projectId)},limit:100})).memories, search:await window.sovereignbot.search.query({query:"P9 launch checklist",types:["memory"],projectId:${JSON.stringify(projectId)},status:"active",limit:50})})`);
    restartProjection = restarted;
    check("Project and approved fact survive service restart", restarted.project?.some((entry) => entry.projectId === projectId) && restarted.memory?.length === 1 && restarted.memory[0].id === memoryId && restarted.memory[0].source?.type === "fact", JSON.stringify({ projectCount: restarted.project?.length, memoryCount: restarted.memory?.length }));
    check("Search index rebuilds from durable Project Memory after restart", restarted.search.results?.some((entry) => entry.id === memoryId && entry.projectId === projectId) && restarted.search.total === 1 && restarted.search.hasMore === false, JSON.stringify(restarted.search));
    check("restart projection contains no raw paths or provider/session data", !JSON.stringify(restarted).toLowerCase().match(/(?:workspacepath|session|provider|account|credential|bearer|token|cwd|authority)/), JSON.stringify({ project: restarted.project, memory: restarted.memory, search: restarted.search }));
  } catch (error) {
    fatal = error;
    note(`[fatal] ${String(error?.stack ?? error)}`);
    check("V4.6 Project Memory Search gate runner completed", false, String(error?.message ?? error));
  }

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
  const summary = {
    at: new Date().toISOString(),
    checks,
    projectId,
    memoryId,
    firstProjection,
    firstSearch,
    restartProjection,
    fatal: fatal ? String(fatal?.message ?? fatal) : undefined,
  };
  writeFileSync(join(EVIDENCE_DIR, "verify-v46-project-memory-search.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(join(EVIDENCE_DIR, "verify-v46-project-memory-search.log"), `${log.join("\n")}\n`, "utf8");
  try { unbind?.(); } catch {}
  try { uninstallProtocol?.(); } catch {}
  try { win?.destroy(); } catch {}
  try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {}
  if (fatal || failed.length) throw new Error(`V4.6 Project Memory Search gate failed: ${failed.join(", ") || String(fatal?.message ?? fatal)}`);
  app.exit(0);
}
