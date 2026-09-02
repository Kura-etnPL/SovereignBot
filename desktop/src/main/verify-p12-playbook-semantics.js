// Hidden real-Electron acceptance for the bounded semantic Playbook layer.
// It exercises the existing renderer, preload/IPC, Product Surface service,
// TeamService assignment path, durable stores, transfer, and restart.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { createProductSurfaceService } from "./product-surface-service.js";
import { MemoryStore } from "../../../src/memory.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = join(WORKTREE_ROOT, "_evidence_v50_2026-09-02");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function roster() { return { ready: false, mode: "local-gate", roles: {}, agents: [], providers: {}, coworkerBindings: {} }; }

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
    const projectService = createProjectService({ dataDir, services, teamService, coworkerStore, artifactStore, skillStore, onChanged: () => search?.invalidate() });
    const runtime = { memory: new MemoryStore(join(stateDir, "memory.jsonl")), audit: { readAll: async () => [] } };
    const memoryService = createMemoryService({ runtime, services, coworkerStore, teamService, conversationStore, artifactStore, projectResolver: (projectId) => projectService.resolveProject(projectId), onChanged: () => search?.invalidate() });
    projectService.setMemoryService(memoryService);
    const productSurfaces = createProductSurfaceService({ dataDir, teamService, coworkerStore, artifactStore, runtime });
    search = createSearchService({ teamService, conversationStore, coworkerStore, projectService, artifactStore, skillStore, memoryService });
    return { services, coworkerStore, conversationStore, artifactStore, skillStore, teamService, projectService, memoryService, productSurfaces, search };
}

function publicTeamList(fixture) {
    const listed = fixture.teamService.list();
    const recipes = fixture.productSurfaces.recipeList();
    const recipeById = new Map(recipes.map((pack) => [pack.id, pack]));
    const packs = listed.packs.map((pack) => recipeById.has(pack.id) ? { ...pack, ...recipeById.get(pack.id) } : pack);
    const known = new Set(packs.map((pack) => pack.id));
    return { ...listed, packs: [...packs, ...recipes.filter((pack) => !known.has(pack.id))] };
}

function handlers(fixture) {
    const { services, coworkerStore, conversationStore, artifactStore, skillStore, teamService, projectService, memoryService, productSurfaces, search } = fixture;
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
        "team:list": () => publicTeamList(fixture),
        "team:get": ({ teamId }) => teamService.get(teamId),
        "team:installPack": ({ packId }) => teamService.installPack(packId),
        "team:exportPlaybook": ({ teamId, playbookId }) => teamService.exportPlaybook(teamId, playbookId),
        "team:importPlaybook": ({ teamId, playbook }) => teamService.importPlaybook(teamId, playbook),
        "team:exportPackRecipe": ({ packId }) => productSurfaces.exportPack(packId),
        "channel:list": (payload) => teamService.listChannels(payload),
        "playbook:list": (payload) => productSurfaces.listPlaybooks(payload),
        "playbook:create": (payload) => productSurfaces.createPlaybook(payload.playbook),
        "playbook:update": ({ playbookId, patch }) => productSurfaces.updatePlaybook(playbookId, patch),
        "playbook:archive": ({ playbookId }) => productSurfaces.archivePlaybook(playbookId),
        "playbook:restore": ({ playbookId }) => productSurfaces.restorePlaybook(playbookId),
        "playbook:duplicate": ({ playbookId }) => productSurfaces.duplicatePlaybook(playbookId),
        "playbook:export": ({ playbookId }) => productSurfaces.exportPlaybook(playbookId),
        "playbook:import": ({ playbook }) => productSurfaces.importPlaybook(playbook),
        "playbook:assign": ({ playbookId, teamId, channelId }) => productSurfaces.assignPlaybook(playbookId, { teamId, channelId }),
        "artifact:list": (payload) => artifactStore.list(payload),
        "artifact:hub": (payload) => productSurfaces.artifactHub(payload),
        "artifact:history": (payload) => productSurfaces.artifactHistory(payload),
        "computer:history": (payload) => productSurfaces.computerHistory(payload),
        "skill:list": (payload) => skillStore.list(payload),
        "project:list": (payload) => projectService.list(payload),
        "project:get": ({ projectId }) => projectService.get(projectId),
        "memory:list": (payload) => memoryService.list(payload),
        "memory:listSuggestions": () => memoryService.listSuggestions(),
        "search:query": (payload) => search.query(payload),
        "palette:list": () => ({ commands: [{ id: "search", risk: "read-only" }] }),
        "palette:execute": () => ({ ok: true }),
        "connectedApps:list": () => ({ apps: [] }),
        "connectedApps:search": () => ({ apps: [] }),
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

async function invoke(win, expression) { return win.webContents.executeJavaScript(`(${expression})()`); }
async function waitFor(label, fn, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await fn()) return; await sleep(80); }
    throw new Error(`timed out waiting for ${label}`);
}

export async function runVerifyP12PlaybookSemantics({ app }) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const checks = {}; const log = []; const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
    const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };
    const publicForbidden = /(?:workspacePath|providerAccount|credential|session|token|capability|governedTools|password|cookie|driver|file:\/\/|https?:\/\/|[A-Za-z]:[\\/])/i;
    const tempRoot = process.env.SOVEREIGNBOT_V50_TEMP_ROOT;
    if (!tempRoot) throw new Error("V50 temp root is missing; refusing to use the default user profile");
    const dataDir = join(tempRoot, "data");
    let fixture; let win; let unbind; let uninstallProtocol; let fatal; let created; let exported; let duplicated; let imported; let restart;
    const plan = {
        stages: [{ id: "discover", name: "Discover", instructions: "Clarify the decision.", expectedOutput: "Decision brief", recommendedCoworkerRole: "Product Lead", recommendedSkillIds: ["skill_research"] }, { id: "review", name: "Review", instructions: "Check the evidence.", recommendedCoworkerRole: "Reviewer" }],
        reviewPoints: [{ id: "evidence-check", name: "Evidence check", instructions: "Current owner reviews before proceeding.", recommendedCoworkerRole: "Reviewer" }],
        expectedOutput: "A bounded product decision.",
        recommendedCoworkerRoles: ["Product Lead", "Reviewer"],
        recommendedSkillIds: ["skill_research", "skill_synthesis"],
    };
    try {
        fixture = makeFixture(dataDir);
        uninstallProtocol = installAppProtocolHandler();
        win = createMainWindow({ smoke: true });
        unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
        check("gate window stays hidden", win.isVisible() === false);
        await loadWindow(win);
        const surface = await invoke(win, "async()=>({create:typeof window.sovereignbot?.playbooks?.create, update:typeof window.sovereignbot?.playbooks?.update, assign:typeof window.sovereignbot?.playbooks?.assign, root:!!document.getElementById('product-playbooks-page')})");
        check("renderer exposes the existing Playbook editor and assignment path", surface.create === "function" && surface.update === "function" && surface.assign === "function" && surface.root, JSON.stringify(surface));
        created = await invoke(win, `async()=>window.sovereignbot.playbooks.create({playbook:${JSON.stringify({ name: "Semantic Discovery", description: "A reusable decision method.", steps: ["chief", "reviewer"], ...plan })}})`);
        check("renderer creates a semantic Playbook through the existing IPC", created.name === "Semantic Discovery" && created.stages?.length === 2 && created.reviewPoints?.length === 1 && created.expectedOutput === plan.expectedOutput, JSON.stringify(created));
        await invoke(win, `async()=>window.sovereignbot.playbooks.update({playbookId:${JSON.stringify(created.id)},patch:{expectedOutput:"An approved product decision.",reviewPoints:[],stages:${JSON.stringify(plan.stages)}}})`);
        const updated = await invoke(win, `async()=>window.sovereignbot.playbooks.list({includeArchived:true}).then((result)=>result.playbooks.find((entry)=>entry.id===${JSON.stringify(created.id)}))`);
        check("renderer edits semantic fields without changing the simple steps contract", updated.expectedOutput === "An approved product decision." && Array.isArray(updated.reviewPoints) && updated.reviewPoints.length === 0 && JSON.stringify(updated.steps) === JSON.stringify(["chief", "reviewer"]), JSON.stringify(updated));
        await invoke(win, "async()=>window.sovereignbot.teams.installPack({packId:'software-team'})");
        const teams = await invoke(win, "async()=>window.sovereignbot.teams.list({})");
        const team = teams.teams.find((entry) => entry.packId === "software-team"); const channel = team?.channels?.[0];
        check("existing Team and Channel primitives remain available for assignment", Boolean(team?.id && channel?.id), JSON.stringify({ team: team?.id, channel: channel?.id }));
        await invoke(win, `async()=>window.sovereignbot.playbooks.assign({playbookId:${JSON.stringify(created.id)},teamId:${JSON.stringify(team.id)}})`);
        await invoke(win, `async()=>window.sovereignbot.playbooks.assign({playbookId:${JSON.stringify(created.id)},channelId:${JSON.stringify(channel.id)}})`);
        const assigned = await invoke(win, `async()=>({team:await window.sovereignbot.teams.get({teamId:${JSON.stringify(team.id)}}), list:await window.sovereignbot.playbooks.list({includeArchived:true})})`);
        const assignedBook = assigned.team.playbooks.find((entry) => entry.id === created.id); const publicAssigned = assigned.list.playbooks.find((entry) => entry.id === created.id);
        check("Team and Channel assignment preserve the semantic definition", assignedBook?.stages?.[0]?.id === "discover" && assignedBook?.expectedOutput === "An approved product decision." && publicAssigned?.assignedTeams?.some((entry) => entry.id === team.id) && publicAssigned?.assignedChannels?.some((entry) => entry.id === channel.id), JSON.stringify({ assignedBook, publicAssigned }));
        await invoke(win, "async()=>{document.getElementById('nav-playbooks')?.click(); return true}");
        await waitFor("Playbook page", async () => await invoke(win, "async()=>!document.getElementById('view-playbooks')?.classList.contains('hidden')"));
        await waitFor("semantic Playbook card", async () => await invoke(win, `async()=>[...document.querySelectorAll('#product-playbooks-page .settings-card')].some((card)=>card.innerText.includes('Semantic Discovery'))`));
        const page = await invoke(win, `async()=>{const card=[...document.querySelectorAll('#product-playbooks-page .settings-card')].find((entry)=>entry.innerText.includes('Semantic Discovery')); card?.querySelector('details')?.setAttribute('open',''); return card?.innerText||''}`);
        check("Playbook page shows a structured human-readable plan", page.includes("Plan / 计划") && page.includes("Discover") && page.includes("Review") && page.includes("Expected output") && page.includes("Product Lead") && page.includes("Recommended Skills"), page);
        exported = await invoke(win, `async()=>window.sovereignbot.playbooks.export({playbookId:${JSON.stringify(created.id)}})`);
        duplicated = await invoke(win, `async()=>window.sovereignbot.playbooks.duplicate({playbookId:${JSON.stringify(created.id)}})`);
        imported = await invoke(win, `async()=>window.sovereignbot.playbooks.import({playbook:${JSON.stringify({ ...exported, id: "semantic-imported" })}})`);
        check("export, duplicate, and import preserve semantic fields", exported.stages?.[0]?.id === "discover" && duplicated.stages?.[0]?.id === "discover" && imported.imported === true && imported.playbook.expectedOutput === "An approved product decision.", JSON.stringify({ exported, duplicated, imported }));
        const authorityRejected = await invoke(win, `async()=>{try{await window.sovereignbot.playbooks.import({playbook:${JSON.stringify({ ...exported, id: "unsafe-import", workspacePath: "E:/private" })}}); return {rejected:false}}catch(error){return {rejected:true,message:String(error?.message||error)}}}`);
        check("imported semantic content rejects authority and path fields", authorityRejected?.rejected === true, JSON.stringify(authorityRejected));
        const serialized = await invoke(win, "async()=>({list:await window.sovereignbot.playbooks.list({includeArchived:true}), teams:await window.sovereignbot.teams.list({})})");
        check("public Playbook and Team projections remain authority-free", !publicForbidden.test(JSON.stringify({ serialized, exported, duplicated, imported })), JSON.stringify({ serialized, exported, duplicated, imported }));
        const persistedProduct = JSON.parse(readFileSync(join(dataDir, "desktop-state", "product-surfaces.json"), "utf8"));
        const persistedTeams = JSON.parse(readFileSync(join(dataDir, "desktop-state", "teams.json"), "utf8"));
        check("semantic definitions are durable in the existing stores", persistedProduct.playbooks.some((entry) => entry.id === created.id && entry.stages?.[0]?.id === "discover") && persistedTeams.teams.some((entry) => entry.id === team.id && entry.playbooks?.some((book) => book.id === created.id && book.expectedOutput === "An approved product decision.")), JSON.stringify({ persistedProduct, persistedTeams }));
        unbind?.(); unbind = undefined;
        fixture = makeFixture(dataDir); unbind = bindIpcChannels({ win, handlers: handlers(fixture) }); await loadWindow(win);
        restart = await invoke(win, `async()=>({playbooks:await window.sovereignbot.playbooks.list({includeArchived:true}),teams:await window.sovereignbot.teams.list({})})`);
        const restartedBook = restart.playbooks.playbooks.find((entry) => entry.id === created.id); const restartedTeam = restart.teams.teams.find((entry) => entry.id === team.id);
        check("restart preserves semantic Playbooks and their assignment", restartedBook?.stages?.[0]?.id === "discover" && restartedBook?.expectedOutput === "An approved product decision." && restartedTeam?.playbooks?.some((entry) => entry.id === created.id && entry.stages?.[0]?.id === "discover"), JSON.stringify({ restartedBook, restartedTeam }));
        check("restart serialized public state remains authority-free", !publicForbidden.test(JSON.stringify(restart)), JSON.stringify(restart));
    }
    catch (error) { fatal = error; note(`[fatal] ${String(error?.stack ?? error)}`); check("P12 semantic Playbook gate runner completed", false, String(error?.message ?? error)); }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
    const summary = { at: new Date().toISOString(), checks, created, exported, duplicated, imported, restart, fatal: fatal ? String(fatal?.message ?? fatal) : undefined };
    writeFileSync(join(EVIDENCE_DIR, "verify-p12-playbook-semantics.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    writeFileSync(join(EVIDENCE_DIR, "verify-p12-playbook-semantics.log"), `${log.join("\n")}\n`, "utf8");
    try { unbind?.(); } catch {} try { uninstallProtocol?.(); } catch {} try { win?.destroy(); } catch {} try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    if (fatal || failed.length) throw new Error(`P12 semantic Playbook gate failed: ${failed.join(", ") || String(fatal?.message ?? fatal)}`);
    app.exit(0);
}
