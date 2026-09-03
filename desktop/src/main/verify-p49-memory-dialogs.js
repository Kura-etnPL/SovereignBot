// P49 hidden real-Electron gate. It exercises the shared Memory dialogs through
// the production renderer, sandboxed preload, typed IPC, and isolated stores.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore } from "./artifact-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createCoworkerStore } from "./coworker-store.js";
import { desktopVersion } from "./lib/desktop-version.js";
import { createMemoryService } from "./memory-service.js";
import { createProjectService } from "./project-service.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";
import { createDesktopServices } from "./services.js";
import { createTeamService } from "./team-service.js";
import { MemoryStore } from "../../../src/memory.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidenceDir = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR;

function makeFixture(dataDir) {
  const stateDir = join(dataDir, "desktop-state");
  mkdirSync(stateDir, { recursive: true });
  const services = createDesktopServices({ dataDir, dialog: {} });
  const coworkers = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
  coworkers.ensureDefaults();
  const conversations = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore: coworkers });
  const artifacts = createArtifactStore({ dataDir });
  const teams = createTeamService({ dataDir, coworkerStore: coworkers, conversationStore: conversations, services });
  const projects = createProjectService({ dataDir, services, teamService: teams, coworkerStore: coworkers, artifactStore: artifacts, skillStore: { list: () => ({ skills: [] }) } });
  const runtime = { memory: new MemoryStore(join(stateDir, "memory.jsonl")) };
  const memory = createMemoryService({ runtime, services, coworkerStore: coworkers, teamService: teams, conversationStore: conversations, artifactStore: artifacts, projectResolver: (id) => projects.resolveProject(id) });
  return { services, coworkers, conversations, artifacts, teams, projects, runtime, memory };
}

function makeHandlers(fixture, failures) {
  const { services, coworkers, conversations, artifacts, teams, projects, memory } = fixture;
  return {
    "app:handshake": () => ({ ok: true, version: desktopVersion(), platform: process.platform, locale: "en-US", language: services.getSettings().language }),
    "firstrun:getStatus": () => ({ browsers: [] }),
    "settings:get": () => services.getSettings(),
    "settings:update": (patch) => services.updateSettings(patch),
    "workspace:list": () => services.listWorkspaces(),
    "provider:getRoster": () => ({ ready: false, mode: "local-gate", roles: {}, agents: [], providers: {}, coworkerBindings: {} }),
    "provider:refresh": () => ({ applied: false, roster: { ready: false, mode: "local-gate", roles: {}, agents: [], providers: {}, coworkerBindings: {} } }),
    "coworker:list": (payload) => coworkers.list(payload),
    "coworker:get": ({ coworkerId }) => coworkers.get(coworkerId),
    "conversation:list": () => conversations.list(),
    "conversation:get": ({ conversationId }) => conversations.get(conversationId),
    "conversation:createDirect": ({ coworkerId }) => conversations.createDirect(coworkerId),
    "team:list": () => teams.list(),
    "channel:list": (payload) => teams.listChannels(payload),
    "project:list": (payload) => projects.list(payload),
    "project:get": ({ projectId }) => projects.get(projectId),
    "artifact:list": (payload) => artifacts.list(payload),
    "connectedApps:list": () => ({ apps: [] }),
    "connectedApps:search": () => ({ apps: [] }),
    "memory:list": (payload) => memory.list(payload),
    "memory:listSuggestions": () => memory.listSuggestions(),
    "memory:sourceTrace": (payload) => memory.sourceTrace(payload),
    "memory:pin": (payload) => memory.pin(payload),
    "memory:forget": (payload) => memory.forget(payload),
    "memory:update": async (payload) => { if (failures.edit) { failures.edit = false; throw new Error("Injected edit failure; retry is safe."); } return memory.update(payload); },
    "memory:delete": async (payload) => { failures.deleteCalls += 1; if (failures.delete) { failures.delete = false; throw new Error("Injected delete failure; retry is safe."); } return memory.delete(payload); },
    "job:list": () => ({ jobs: [] }),
    "job:attention": () => ({ jobs: [] }),
    "routine:list": () => ({ routines: [] }),
    "update:status": () => ({ channel: "stable", currentVersion: desktopVersion(), available: false }),
  };
}

async function loadWindow(win) {
  await win.loadURL(appOrigin());
  await win.webContents.executeJavaScript("(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()");
  await sleep(900);
}

async function invoke(win, expression) { return win.webContents.executeJavaScript(`(${expression})()`); }

export async function runVerifyP49MemoryDialogs({ app }) {
  const checks = {};
  const notes = [];
  const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); notes.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };
  let dataDir;
  let win;
  let unbind;
  let uninstallProtocol;
  try {
    dataDir = await mkdtemp(join(tmpdir(), "sovereign-p49-memory-"));
    const fixture = makeFixture(dataDir);
    const chief = fixture.coworkers.list({}).coworkers.find((entry) => entry.name === "Chief of Staff") ?? fixture.coworkers.list({}).coworkers[0];
    const conversation = fixture.conversations.createDirect(chief.id);
    const record = await fixture.runtime.memory.put({ scope: `coworker:${chief.id}`, key: "p49-memory", value: { title: "P49 Memory", content: "Before edit" }, tags: ["local"], provenance: { type: "fact", label: "P49 local gate" } });
    const failures = { edit: false, delete: false, deleteCalls: 0 };
    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    unbind = bindIpcChannels({ win, handlers: makeHandlers(fixture, failures) });
    await loadWindow(win);
    const surface = await invoke(win, `async()=>({edit:!!document.getElementById("memory-edit-dialog"),del:!!document.getElementById("memory-delete-dialog"),prompt:String(document.body.innerHTML).includes("window.prompt"),confirm:String(document.body.innerHTML).includes("window.confirm")})`);
    check("hidden renderer exposes both Memory product dialogs", surface.edit && surface.del && !surface.prompt && !surface.confirm, JSON.stringify(surface));

    await invoke(win, `async()=>{const button=[...document.querySelectorAll("#coworker-list button")].find((entry)=>entry.textContent.includes("Chief")) ?? document.querySelector("#coworker-list button"); button?.click(); return Boolean(button)}`);
    await sleep(550);
    await invoke(win, `async()=>{document.getElementById("nav-memory")?.click(); return true}`);
    await sleep(450);
    const mainEdit = await invoke(win, `async()=>{const card=document.querySelector("#memory-list .memory-row"); const button=[...(card?.querySelectorAll("button")||[])].find((entry)=>entry.textContent.includes("Edit")); button?.click(); await new Promise(r=>setTimeout(r,80)); return {open:!!document.getElementById("memory-edit-dialog")?.open,title:document.getElementById("memory-edit-title")?.value,content:document.getElementById("memory-edit-content")?.value}}`);
    check("main Memory edit keeps the existing product dialog regression", mainEdit.open && mainEdit.title === "P49 Memory" && mainEdit.content === "Before edit", JSON.stringify(mainEdit));
    await invoke(win, `async()=>{document.getElementById("memory-edit-dialog")?.close(); return true}`);

    await invoke(win, `async()=>{document.querySelector("#coworker-list button")?.click(); return true}`);
    await sleep(550);
    await invoke(win, `async()=>{document.getElementById("open-details")?.click(); return true}`);
    await sleep(450);
    const detailEdit = await invoke(win, `async()=>{const card=document.querySelector("#details-coworker-memory-list .memory-row"); const button=[...(card?.querySelectorAll("button")||[])].find((entry)=>entry.textContent.includes("Edit")); button?.click(); await new Promise(r=>setTimeout(r,80)); return {open:!!document.getElementById("memory-edit-dialog")?.open,content:document.getElementById("memory-edit-content")?.value}}`);
    check("Conversation Details Edit reuses the shared Memory dialog", detailEdit.open && detailEdit.content === "Before edit", JSON.stringify(detailEdit));
    failures.edit = true;
    const editFailure = await invoke(win, `async()=>{document.getElementById("memory-edit-content").value="After edit"; const button=document.querySelector("#memory-edit-form button[type=submit]"); button?.click(); button?.click(); await new Promise(r=>setTimeout(r,180)); return {open:!!document.getElementById("memory-edit-dialog")?.open,error:document.getElementById("memory-edit-form-error")?.textContent||"",disabled:button?.disabled}}`);
    check("injected edit failure stays visible and suppresses duplicate submit", editFailure.open && editFailure.error.includes("Injected edit failure") && editFailure.disabled, JSON.stringify(editFailure));
    const editRetry = await invoke(win, `async()=>{const button=document.querySelector("#memory-edit-form button[type=submit]"); button?.click(); await new Promise(r=>setTimeout(r,250)); return {open:!!document.getElementById("memory-edit-dialog")?.open,content:(await window.sovereignbot.memory.list({scope:"coworker",ownerId:${JSON.stringify(chief.id)},limit:20})).memories?.[0]?.content}}`);
    check("edit retry closes the dialog and persists through existing Memory authority", !editRetry.open && editRetry.content === "After edit", JSON.stringify(editRetry));

    const cancel = await invoke(win, `async()=>{const card=document.querySelector("#details-coworker-memory-list .memory-row"); const button=[...(card?.querySelectorAll("button")||[])].find((entry)=>entry.textContent.includes("Delete")); button?.click(); await new Promise(r=>setTimeout(r,60)); const dialog=document.getElementById("memory-delete-dialog"); const open=dialog?.open===true; document.querySelector("#memory-delete-form [data-close-dialog]")?.click(); return {open,after:dialog?.open===true}}`);
    check("Delete cancel closes the product dialog without IPC", cancel.open && !cancel.after && failures.deleteCalls === 0, JSON.stringify(cancel));

    failures.delete = true;
    const deleteFailure = await invoke(win, `async()=>{const card=document.querySelector("#details-coworker-memory-list .memory-row"); const button=[...(card?.querySelectorAll("button")||[])].find((entry)=>entry.textContent.includes("Delete")); button?.click(); await new Promise(r=>setTimeout(r,60)); const confirm=document.getElementById("memory-delete-confirm"); confirm?.click(); confirm?.click(); await new Promise(r=>setTimeout(r,180)); return {open:document.getElementById("memory-delete-dialog")?.open===true,error:document.getElementById("memory-delete-form-error")?.textContent||"",disabled:confirm?.disabled}}`);
    check("injected delete failure stays retryable and duplicate-safe", deleteFailure.open && deleteFailure.error.includes("Injected delete failure") && deleteFailure.disabled && failures.deleteCalls === 1, JSON.stringify(deleteFailure));
    const deleteRetry = await invoke(win, `async()=>{document.getElementById("memory-delete-confirm")?.click(); await new Promise(r=>setTimeout(r,300)); return {open:document.getElementById("memory-delete-dialog")?.open===true,memories:(await window.sovereignbot.memory.list({scope:"coworker",ownerId:${JSON.stringify(chief.id)},limit:20})).memories}}`);
    check("delete retry removes only the selected Memory and refreshes the scope", !deleteRetry.open && deleteRetry.memories.length === 0 && failures.deleteCalls === 2, JSON.stringify({ open: deleteRetry.open, memoryCount: deleteRetry.memories.length, deleteCalls: failures.deleteCalls }));
    check("Memory dialog text exposes no fixture path or internal authority", !String(deleteFailure.error).match(/(?:workspace|provider|credential|session|token|C:\\|\/tmp\/)/i), deleteFailure.error);
  } catch (error) {
    check("P49 hidden Memory dialog gate completes", false, String(error?.message ?? error));
    try { process.stderr.write(`${error?.stack ?? error}\n`); } catch {}
  } finally {
    try { unbind?.(); } catch {}
    try { uninstallProtocol?.(); } catch {}
    try { win?.destroy(); } catch {}
    if (dataDir) try { await rm(dataDir, { recursive: true, force: true }); } catch {}
  }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, "verify-p49-memory-dialogs.json"), `${JSON.stringify({ schema: "sovereignbot.desktop.p49-memory-dialogs.v1", checks, failed, notes, fixtureBoundary: "LOCAL_FIXTURE", externalActions: [], ok: failed.length === 0 }, null, 2)}\n`, "utf8");
    await writeFile(join(evidenceDir, "verify-p49-memory-dialogs.log"), `${notes.join("\n")}\n`, "utf8");
  }
  if (failed.length) throw new Error(`P49 Memory dialog gate failed: ${failed.join(", ")}`);
  if (app?.exit) { app.exit(0); return { ok: true, checks }; }
  return { ok: true, checks };
}
