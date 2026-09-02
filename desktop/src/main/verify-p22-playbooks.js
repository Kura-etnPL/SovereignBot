// Hidden local acceptance for the complete Playbook Library product path.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { createProductSurfaceService } from "./product-surface-service.js";
import { MemoryStore } from "../../../src/memory.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";
import { importPlaybookViaDialog, exportPlaybookViaDialog } from "./playbook-file-io.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(WORKTREE_ROOT, "_evidence_v22_2026-09-03");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function roster() { return { ready: false, mode: "local-gate", roles: {}, agents: [], providers: {}, coworkerBindings: {} }; }

function makeFixture(dataDir, { playbookDialog } = {}) {
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
    const projectService = createProjectService({ dataDir, services, teamService, coworkerStore, artifactStore, skillStore, onChanged: () => search?.invalidate() });
    const runtime = { memory: new MemoryStore(join(stateDir, "memory.jsonl")), audit: { readAll: async () => [] } };
    const memoryService = createMemoryService({ runtime, services, coworkerStore, teamService, conversationStore, artifactStore, projectResolver: (projectId) => projectService.resolveProject(projectId), onChanged: () => search?.invalidate() });
    projectService.setMemoryService(memoryService);
    const productSurfaces = createProductSurfaceService({ dataDir, teamService, coworkerStore, artifactStore, runtime });
    if (!teamService.list().teams.length) {
        const coworkers = coworkerStore.list({ includeArchived: false }).coworkers.slice(0, 3);
        teamService.createTeam({ title: "P22 Assignment Team", coworkerIds: coworkers.map((entry) => entry.id), leadCoworkerId: coworkers[0]?.id });
    }
    search = createSearchService({ teamService, conversationStore, coworkerStore, projectService, artifactStore, skillStore, memoryService });
    return { services, coworkerStore, conversationStore, artifactStore, skillStore, teamService, projectService, memoryService, productSurfaces, search, playbookDialog };
}

function publicTeamList(fixture) {
    const listed = fixture.teamService.list();
    const playbooks = fixture.productSurfaces.listPlaybooks({ includeArchived: true }).playbooks;
    const byId = new Map(playbooks.map((entry) => [entry.id, entry]));
    return { ...listed, playbooks: [...playbooks], packs: listed.packs };
}

function handlers(fixture) {
    const { services, coworkerStore, conversationStore, artifactStore, skillStore, teamService, projectService, memoryService, productSurfaces, search, playbookDialog } = fixture;
    return {
        "app:handshake": () => ({ ok: true, version: desktopVersion(), platform: process.platform, locale: "en-US", language: services.getSettings().language }),
        "firstrun:getStatus": () => ({ browsers: [] }),
        "workspace:list": () => services.listWorkspaces(),
        "settings:get": () => services.getSettings(),
        "provider:getRoster": () => roster(),
        "provider:refresh": () => ({ applied: false, roster: roster() }),
        "coworker:list": ({ includeArchived }) => coworkerStore.list({ includeArchived }),
        "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
        "conversation:list": () => conversationStore.list(),
        "conversation:get": ({ conversationId }) => conversationStore.get(conversationId),
        "team:list": () => publicTeamList(fixture),
        "team:get": ({ teamId }) => teamService.get(teamId),
        "channel:list": (payload) => teamService.listChannels(payload),
        "playbook:list": (payload) => productSurfaces.listPlaybooks(payload),
        "playbook:create": ({ playbook }) => productSurfaces.createPlaybook(playbook),
        "playbook:update": ({ playbookId, patch }) => productSurfaces.updatePlaybook(playbookId, patch),
        "playbook:archive": ({ playbookId }) => productSurfaces.archivePlaybook(playbookId),
        "playbook:restore": ({ playbookId }) => productSurfaces.restorePlaybook(playbookId),
        "playbook:duplicate": ({ playbookId }) => productSurfaces.duplicatePlaybook(playbookId),
        "playbook:export": ({ playbookId }) => productSurfaces.exportPlaybook(playbookId),
        "playbook:import": ({ playbook }) => productSurfaces.importPlaybook(playbook),
        "playbook:importViaDialog": () => importPlaybookViaDialog({ parentWindow: undefined, dialog: playbookDialog, importPlaybook: (playbook) => productSurfaces.importPlaybook(playbook) }),
        "playbook:exportViaDialog": ({ playbookId }) => exportPlaybookViaDialog({ parentWindow: undefined, dialog: playbookDialog, targetName: playbookId, resolvePlaybook: () => productSurfaces.exportPlaybook(playbookId) }),
        "playbook:assign": ({ playbookId, teamId, channelId }) => productSurfaces.assignPlaybook(playbookId, { teamId, channelId }),
        "artifact:hub": (payload) => productSurfaces.artifactHub(payload),
        "artifact:history": (payload) => productSurfaces.artifactHistory(payload),
        "computer:history": (payload) => productSurfaces.computerHistory(payload),
        "artifact:list": (payload) => artifactStore.list(payload),
        "skill:list": (payload) => skillStore.list(payload),
        "project:list": (payload) => projectService.list(payload),
        "project:get": ({ projectId }) => projectService.get(projectId),
        "memory:list": (payload) => memoryService.list(payload),
        "memory:listSuggestions": () => memoryService.listSuggestions(),
        "search:query": (payload) => search.query(payload),
        "connectedApps:list": () => ({ apps: [] }),
        "connectedApps:search": () => ({ apps: [] }),
        "eventTrigger:list": () => ({ triggers: [] }),
        "data:status": () => ({ backups: [] }),
        "data:listBackups": () => ({ backups: [] }),
        "update:status": () => ({ channel: "stable", currentVersion: desktopVersion(), available: false }),
        "job:list": () => ({ jobs: [] }),
        "job:attention": () => ({ jobs: [] }),
        "routine:list": () => ({ routines: [] }),
        "notification:list": () => ({ notifications: [] }),
    };
}

async function loadWindow(win) {
    await win.loadURL(appOrigin());
    await win.webContents.executeJavaScript("(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()");
    await sleep(900);
}

async function invoke(win, expression) { return win.webContents.executeJavaScript("(" + expression + ")()"); }
async function waitFor(label, fn, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await fn()) return; await sleep(80); }
    throw new Error("timed out waiting for " + label);
}

export async function runVerifyP22Playbooks({ app }) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const checks = {}; const log = []; const note = (line) => { log.push(line); try { process.stderr.write(line + "\n"); } catch {} };
    const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note((ok ? "PASS " : "FAIL ") + name + (detail ? " " + detail : "")); };
    const forbidden = /(?:workspacePath|managed-workspaces|storageRelativePath|sourceRelativePath|file:\/\/|https?:\/\/|providerAccount|credential|session|token|capability|governedTools|password|cookie|driver|coordinates)/i;
    const tempRoot = process.env.SOVEREIGNBOT_V22_TEMP_ROOT;
    if (!tempRoot) throw new Error("V22 temp root is missing; refusing to use the default user profile");
    const dataDir = join(tempRoot, "data"); let fixture; let win; let unbind; let uninstallProtocol; let fatal;
    try {
        const playbookDialog = {
            openPaths: [], savePaths: [],
            async showOpenDialog() { return { canceled: false, filePaths: [this.openPaths.shift()] }; },
            async showSaveDialog() { return { canceled: false, filePath: this.savePaths.shift() }; },
        };
        fixture = makeFixture(dataDir, { playbookDialog });
        uninstallProtocol = installAppProtocolHandler(); win = createMainWindow({ smoke: true }); unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
        check("gate window stays hidden", win.isVisible() === false);
        await loadWindow(win);
        const surface = await invoke(win, "async()=>({create:typeof window.sovereignbot?.playbooks?.create,update:typeof window.sovereignbot?.playbooks?.update,importFile:typeof window.sovereignbot?.playbooks?.importViaDialog,exportFile:typeof window.sovereignbot?.playbooks?.exportViaDialog,dialog:!!document.getElementById('playbook-dialog'),form:!!document.getElementById('playbook-form')})");
        check("renderer exposes the structured Playbook Library path", surface.create === "function" && surface.update === "function" && surface.importFile === "function" && surface.exportFile === "function" && surface.dialog && surface.form, JSON.stringify(surface));
        await invoke(win, "async()=>{document.getElementById('nav-playbooks')?.click(); return true}");
        await waitFor("Playbook Library page", async () => await invoke(win, "async()=>!document.getElementById('view-playbooks')?.classList.contains('hidden')"));
        await invoke(win, "async()=>document.getElementById('playbook-page-create')?.click()");
        await waitFor("new Playbook dialog", async () => await invoke(win, "async()=>Boolean(document.getElementById('playbook-dialog')?.open)"));
        const editor = await invoke(win, "async()=>({rawJson:!!document.querySelector('#playbook-dialog textarea[id*=json]'),steps:!!document.getElementById('playbook-editor-steps'),stages:!!document.getElementById('playbook-editor-stages'),reviews:!!document.getElementById('playbook-editor-reviews')})");
        check("New Playbook opens structured fields without raw JSON", editor.steps && editor.stages && editor.reviews && !editor.rawJson, JSON.stringify(editor));
        const filled = await invoke(win, "async()=>{const set=(id,value)=>{const field=document.getElementById(id); field.value=value; field.dispatchEvent(new Event('input',{bubbles:true}));}; set('playbook-editor-name','P22 Method'); set('playbook-editor-description','P22 structured method'); set('playbook-editor-output','P22 final output'); set('playbook-editor-roles','chief, reviewer'); set('playbook-editor-skills','safe-skill'); document.getElementById('playbook-editor-add-step')?.click(); document.getElementById('playbook-editor-add-stage')?.click(); document.getElementById('playbook-editor-add-review')?.click(); const stage=document.querySelector('.playbook-editor-stage-name'); if(stage){stage.value='Frame'; stage.dispatchEvent(new Event('input',{bubbles:true}));} const review=document.querySelector('.playbook-editor-review-name'); if(review){review.value='Review'; review.dispatchEvent(new Event('input',{bubbles:true}));} return {steps:document.querySelectorAll('.playbook-editor-step-value').length,stages:document.querySelectorAll('#playbook-editor-stages .playbook-editor-row').length,reviews:document.querySelectorAll('#playbook-editor-reviews .playbook-editor-row').length};}");
        check("New Playbook accepts bounded steps, stages, review points, and recommendations", filled.steps >= 2 && filled.stages === 1 && filled.reviews === 1, JSON.stringify(filled));
        await invoke(win, "async()=>document.getElementById('playbook-form')?.requestSubmit()");
        await waitFor("new Playbook save", async () => await invoke(win, "async()=>!document.getElementById('playbook-dialog')?.open"));
        await waitFor("P22 Method card", async () => await invoke(win, "async()=>[...document.querySelectorAll('#product-playbooks-page .settings-card h3')].some((node)=>node.textContent==='P22 Method')"));
        let listed = await invoke(win, "async()=>window.sovereignbot.playbooks.list({includeArchived:true})");
        let method = listed.playbooks.find((entry) => entry.name === "P22 Method");
        const exported = await invoke(win, "async()=>window.sovereignbot.playbooks.export({playbookId:" + JSON.stringify(method.id) + "})");
        check("saved Playbook persists its declarative composition", exported.description === "P22 structured method" && exported.steps.length >= 2 && exported.stages?.[0]?.name === "Frame" && exported.reviewPoints?.[0]?.name === "Review" && exported.expectedOutput === "P22 final output" && exported.recommendedCoworkerRoles?.join(",") === "chief,reviewer" && exported.recommendedSkillIds?.[0] === "safe-skill", JSON.stringify(exported));
        await invoke(win, "async()=>{const card=document.querySelector('[data-playbook-id=" + JSON.stringify(method.id) + "]'); [...(card?.querySelectorAll('button')||[])].find((button)=>button.textContent.includes('Edit'))?.click(); return true}");
        await waitFor("Edit Playbook dialog", async () => await invoke(win, "async()=>Boolean(document.getElementById('playbook-dialog')?.open)"));
        await invoke(win, "async()=>{const field=document.getElementById('playbook-editor-name'); field.value='P22 Edited Method'; field.dispatchEvent(new Event('input',{bubbles:true})); const step=document.querySelector('.playbook-editor-step-value'); if(step){step.value='reviewer'; step.dispatchEvent(new Event('input',{bubbles:true}));} return true}");
        await invoke(win, "async()=>document.getElementById('playbook-form')?.requestSubmit()");
        await waitFor("edited Playbook refresh", async () => await invoke(win, "async()=>[...document.querySelectorAll('#product-playbooks-page .settings-card h3')].some((node)=>node.textContent==='P22 Edited Method')"));
        method = (await invoke(win, "async()=>window.sovereignbot.playbooks.list({includeArchived:true})")).playbooks.find((entry) => entry.id === method.id);
        check("Edit saves through the product form and refreshes", method?.name === "P22 Edited Method" && method.steps[0] === "reviewer", JSON.stringify(method));
        const teamId = fixture.teamService.list().teams[0].id; const channelId = fixture.teamService.list().teams[0].channels[0].id;
        await invoke(win, "async()=>{const card=document.querySelector('[data-playbook-id=" + JSON.stringify(method.id) + "]'); const team=card?.querySelector('select[aria-label^=\"Team for\"]'); if(team) team.value=" + JSON.stringify(teamId) + "; [...(card?.querySelectorAll('button')||[])].find((button)=>button.textContent.includes('Assign Team'))?.click(); return true}");
        await waitFor("Team assignment", async () => (await invoke(win, "async()=>window.sovereignbot.playbooks.list({includeArchived:true})")).playbooks.find((entry) => entry.id === method.id)?.assignedTeams?.length === 1);
        await invoke(win, "async()=>{const card=document.querySelector('[data-playbook-id=" + JSON.stringify(method.id) + "]'); const channel=card?.querySelector('select[aria-label^=\"Channel for\"]'); if(channel) channel.value=" + JSON.stringify(channelId) + "; [...(card?.querySelectorAll('button')||[])].find((button)=>button.textContent.includes('Assign Channel'))?.click(); return true}");
        await waitFor("Channel assignment", async () => (await invoke(win, "async()=>window.sovereignbot.playbooks.list({includeArchived:true})")).playbooks.find((entry) => entry.id === method.id)?.assignedChannels?.length === 1);
        check("Team and Channel assignments remain explicit and bounded", true);
        await invoke(win, "async()=>{const card=document.querySelector('[data-playbook-id=" + JSON.stringify(method.id) + "]'); [...(card?.querySelectorAll('button')||[])].find((button)=>button.textContent.includes('Duplicate'))?.click(); return true}");
        await waitFor("Playbook duplicate", async () => await invoke(win, "async()=>[...document.querySelectorAll('#product-playbooks-page .settings-card h3')].some((node)=>node.textContent==='P22 Edited Method copy')"));
        listed = await invoke(win, "async()=>window.sovereignbot.playbooks.list({includeArchived:true})"); const duplicate = listed.playbooks.find((entry) => entry.name === "P22 Edited Method copy");
        await invoke(win, "async()=>{const card=document.querySelector('[data-playbook-id=" + JSON.stringify(duplicate.id) + "]'); [...(card?.querySelectorAll('button')||[])].find((button)=>button.textContent.includes('Archive'))?.click(); return true}");
        await waitFor("Playbook archive", async () => (await invoke(win, "async()=>window.sovereignbot.playbooks.list({includeArchived:true})")).playbooks.find((entry) => entry.id === duplicate.id)?.state === "archived");
        await waitFor("archived Playbook card refresh", async () => await invoke(win, "async()=>{const card=document.querySelector('[data-playbook-id=" + JSON.stringify(duplicate.id) + "]'); return [...(card?.querySelectorAll('button')||[])].some((button)=>button.textContent.includes('Restore'));}"));
        await invoke(win, "async()=>{const card=document.querySelector('[data-playbook-id=" + JSON.stringify(duplicate.id) + "]'); [...(card?.querySelectorAll('button')||[])].find((button)=>button.textContent.includes('Restore'))?.click(); return true}");
        await waitFor("Playbook restore", async () => (await invoke(win, "async()=>window.sovereignbot.playbooks.list({includeArchived:true})")).playbooks.find((entry) => entry.id === duplicate.id)?.state === "active");
        check("Duplicate, Archive, and Restore remain wired to the existing service", true);
        const exportPath = join(dataDir, "p22-method.json"); playbookDialog.savePaths.push(exportPath);
        await invoke(win, "async()=>{const card=document.querySelector('[data-playbook-id=" + JSON.stringify(method.id) + "]'); [...(card?.querySelectorAll('button')||[])].find((button)=>button.textContent.includes('Export'))?.click(); return true}");
        await waitFor("native Playbook export", async () => { if (!existsSync(exportPath)) return false; try { JSON.parse(readFileSync(exportPath, "utf8")); return true; } catch { return false; } });
        const exportedFile = JSON.parse(readFileSync(exportPath, "utf8")); check("Playbook export uses native file IO and safe declarative JSON", exportedFile.id === method.id && !forbidden.test(JSON.stringify(exportedFile)) && !(await invoke(win, "async()=>document.getElementById('playbook-file-result')?.textContent || ''")).includes(dataDir), JSON.stringify(exportedFile));
        const importedPath = join(dataDir, "p22-imported-method.json"); writeFileSync(importedPath, JSON.stringify({ ...exportedFile, id: "p22-imported-method" }), "utf8"); playbookDialog.openPaths.push(importedPath);
        await invoke(win, "async()=>document.getElementById('playbook-page-import')?.click()");
        await waitFor("native Playbook import", async () => (await invoke(win, "async()=>document.getElementById('playbook-file-result')?.textContent || ''")).includes("Imported"));
        const imported = (await invoke(win, "async()=>window.sovereignbot.playbooks.list({includeArchived:true})")).playbooks.find((entry) => entry.id === "p22-imported-method");
        check("Playbook import validates and refreshes the library", imported?.name === "P22 Edited Method" && !forbidden.test(JSON.stringify(imported)), JSON.stringify(imported));
        unbind?.(); unbind = undefined; fixture = makeFixture(dataDir, { playbookDialog }); unbind = bindIpcChannels({ win, handlers: handlers(fixture) }); await loadWindow(win);
        const restarted = await invoke(win, "async()=>window.sovereignbot.playbooks.list({includeArchived:true})");
        check("Playbook editor and native file state survive service restart", restarted.playbooks.some((entry) => entry.id === method.id && entry.name === "P22 Edited Method" && entry.assignedTeams?.length === 1 && entry.assignedChannels?.length === 1) && restarted.playbooks.some((entry) => entry.id === "p22-imported-method"), JSON.stringify(restarted));
    } catch (error) { fatal = error; note("[fatal] " + String(error?.stack ?? error)); check("P22 Playbook gate runner completed", false, String(error?.message ?? error)); }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name); note("[summary] " + (Object.keys(checks).length - failed.length) + "/" + Object.keys(checks).length + " PASS");
    const summary = { at: new Date().toISOString(), checks, fatal: fatal ? String(fatal?.message ?? fatal) : undefined };
    writeFileSync(join(EVIDENCE_DIR, "verify-p22-playbooks.json"), JSON.stringify(summary, null, 2) + "\n", "utf8"); writeFileSync(join(EVIDENCE_DIR, "verify-p22-playbooks.log"), log.join("\n") + "\n", "utf8");
    try { unbind?.(); } catch {} try { uninstallProtocol?.(); } catch {} try { win?.destroy(); } catch {} try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    if (fatal || failed.length) throw new Error("P22 Playbook gate failed: " + (failed.join(", ") || String(fatal?.message ?? fatal)));
    app.exit(0);
}
