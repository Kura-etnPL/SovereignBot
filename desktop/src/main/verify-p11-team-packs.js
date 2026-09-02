// Hidden real-Electron acceptance for the first-party Team Pack gallery.
// It uses the existing declarative Team/Coworker/Channel/Playbook stores and
// exercises the renderer, preload/IPC, gallery, install path, and reload.
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
import { exportTeamPackViaDialog, importTeamPackViaDialog } from "./team-pack-file-io.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(WORKTREE_ROOT, "_evidence_v49_2026-09-02");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function roster() {
    return { ready: false, mode: "local-gate", roles: {}, agents: [], providers: {}, coworkerBindings: {} };
}

function makeFixture(dataDir, { teamPackDialog = {} } = {}) {
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
    return { services, coworkerStore, conversationStore, artifactStore, skillStore, teamService, projectService, memoryService, productSurfaces, search, teamPackDialog };
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
    const { services, coworkerStore, conversationStore, artifactStore, skillStore, teamService, projectService, memoryService, productSurfaces, search, teamPackDialog } = fixture;
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
        "team:installPack": async ({ packId }) => {
            const result = productSurfaces.recipeList().some((pack) => pack.id === packId)
                ? teamService.importPack(productSurfaces.getPackRecipe(packId))
                : teamService.installPack(packId);
            return result;
        },
        "team:importPackViaDialog": () => importTeamPackViaDialog({ parentWindow: undefined, dialog: teamPackDialog, importPack: (pack) => teamService.importPack(pack) }),
        "team:exportPackViaDialog": ({ teamId, packId }) => exportTeamPackViaDialog({
            parentWindow: undefined,
            dialog: teamPackDialog,
            targetName: packId ?? teamId,
            resolvePack: () => teamId ? teamService.exportPack(teamId) : productSurfaces.exportPack(packId),
        }),
        "team:exportPackRecipe": ({ packId }) => productSurfaces.exportPack(packId),
        "team:duplicatePack": ({ packId }) => productSurfaces.duplicatePack(packId),
        "team:editPack": ({ packId, patch }) => productSurfaces.editPack(packId, patch),
        "channel:list": (payload) => teamService.listChannels(payload),
        "playbook:list": (payload) => productSurfaces.listPlaybooks(payload),
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
        "notification:list": () => ({ notifications: [] }),
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

async function waitFor(label, fn, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await fn()) return;
        await sleep(80);
    }
    throw new Error(`timed out waiting for ${label}`);
}

export async function runVerifyP11TeamPacks({ app }) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const checks = {};
    const log = [];
    const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
    const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };
    const publicForbidden = /(?:workspacePath|managed-workspaces|storageRelativePath|sourceRelativePath|file:\/\/|https?:\/\/|providerAccount|credential|session|token|capability|governedTools|password|cookie|driver|\bcoordinates\b)/i;
    const tempRoot = process.env.SOVEREIGNBOT_V49_TEMP_ROOT;
    if (!tempRoot) throw new Error("V49 temp root is missing; refusing to use the default user profile");
    const dataDir = join(tempRoot, "data");
    let fixture;
    let win;
    let unbind;
    let uninstallProtocol;
    let fatal;
    let catalog;
    let installed;
    let restart;

    try {
        const teamPackDialog = {
            openPaths: [],
            savePaths: [],
            async showOpenDialog() { return { canceled: false, filePaths: [this.openPaths.shift()] }; },
            async showSaveDialog() { return { canceled: false, filePath: this.savePaths.shift() }; },
        };
        fixture = makeFixture(dataDir, { teamPackDialog });
        uninstallProtocol = installAppProtocolHandler();
        win = createMainWindow({ smoke: true });
        unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
        check("gate window stays hidden", win.isVisible() === false);
        await loadWindow(win);
        const surface = await invoke(win, "async()=>({list:typeof window.sovereignbot?.teams?.list, install:typeof window.sovereignbot?.teams?.installPack, exportRecipe:typeof window.sovereignbot?.teams?.exportPackRecipe, search:document.getElementById('team-pack-search-page')?.tagName, category:document.getElementById('team-pack-category-page')?.tagName, root:!!document.getElementById('product-packs-page')})");
        check("renderer exposes the existing Team Pack gallery path", surface.list === "function" && surface.install === "function" && surface.exportRecipe === "function" && surface.search === "INPUT" && surface.category === "SELECT" && surface.root, JSON.stringify(surface));

        catalog = await invoke(win, "async()=>window.sovereignbot.teams.list({})");
        const firstParty = catalog.packs.filter((entry) => !entry.custom);
        check("fresh gallery discovers the three differentiated first-party packs", [
            ["product-team", "Product", "Product Discovery Team"],
            ["revenue-team", "Sales", "Revenue Planning Team"],
            ["support-team", "Support", "Customer Support Team"],
        ].every(([id, category, name]) => firstParty.some((entry) => entry.id === id && entry.category === category && entry.name === name)), JSON.stringify(firstParty.map((entry) => ({ id: entry.id, name: entry.name, category: entry.category }))));
        const categories = await invoke(win, "async()=>[...document.getElementById('team-pack-category-page').options].map((option)=>option.value)");
        check("gallery exposes Product, Sales, and Support filters", ["Product", "Sales", "Support"].every((value) => categories.includes(value)), JSON.stringify(categories));

        await invoke(win, "async()=>{document.getElementById('nav-team-packs')?.click(); return true}");
        await waitFor("Team Pack page", async () => await invoke(win, "async()=>!document.getElementById('view-team-packs')?.classList.contains('hidden')"));
        await invoke(win, "async()=>{const input=document.getElementById('team-pack-search-page'); input.value='revenue'; input.dispatchEvent(new Event('input',{bubbles:true})); return true}");
        await waitFor("Revenue search", async () => (await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card h3')].map((node)=>node.textContent)" )).length === 1);
        const revenueSearch = await invoke(win, "async()=>({cards:[...document.querySelectorAll('#product-packs-page .settings-card')].map((card)=>card.innerText)})");
        check("gallery search isolates Revenue Planning", revenueSearch.cards.length === 1 && revenueSearch.cards[0].includes("Revenue Planning Team"), JSON.stringify(revenueSearch));

        await invoke(win, "async()=>{const input=document.getElementById('team-pack-search-page'); input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); return true}");
        await waitFor("gallery search clear", async () => (await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card h3')].map((node)=>node.textContent)" )).length === 7);
        await invoke(win, "async()=>{const select=document.getElementById('team-pack-category-page'); select.value='Support'; select.dispatchEvent(new Event('change',{bubbles:true})); return true}");
        await waitFor("Support filter", async () => { const titles = await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card h3')].map((node)=>node.textContent)"); return titles.length === 1 && titles[0] === "Customer Support Team"; });
        const supportFilter = await invoke(win, "async()=>({cards:[...document.querySelectorAll('#product-packs-page .settings-card')].map((card)=>card.innerText)})");
        check("gallery category filter isolates Customer Support", supportFilter.cards.length === 1 && supportFilter.cards[0].includes("Customer Support Team") && supportFilter.cards[0].includes("Support"), JSON.stringify(supportFilter));

        await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card button')].find((button)=>button.textContent.includes('Preview'))?.click()");
        await waitFor("Support preview", async () => await invoke(win, "async()=>!!document.querySelector('#product-packs-page .team-pack-preview')"));
        const supportPreview = await invoke(win, "async()=>document.querySelector('#product-packs-page .team-pack-preview')?.innerText || ''");
        check("preview inspects the safe Customer Support composition", supportPreview.includes("Support Lead") && supportPreview.includes("Support Triage") && !publicForbidden.test(supportPreview), supportPreview);

        await invoke(win, "async()=>{const select=document.getElementById('team-pack-category-page'); select.value='all'; select.dispatchEvent(new Event('change',{bubbles:true})); return true}");
        await waitFor("gallery category clear", async () => (await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card h3')].map((node)=>node.textContent)" )).length === 7);
        await invoke(win, "async()=>{const input=document.getElementById('team-pack-search-page'); input.value='Product'; input.dispatchEvent(new Event('input',{bubbles:true})); return true}");
        await waitFor("Product search", async () => { const titles = await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card h3')].map((node)=>node.textContent)"); return titles.length === 1 && titles[0] === "Product Discovery Team"; });
        await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card button')].find((button)=>button.textContent.includes('Preview'))?.click()");
        await waitFor("Product preview", async () => await invoke(win, "async()=>!!document.querySelector('#product-packs-page .team-pack-preview')"));
        const productPreview = await invoke(win, "async()=>document.querySelector('#product-packs-page .team-pack-preview')?.innerText || ''");
        check("preview inspects the safe Product Discovery composition", productPreview.includes("Product Lead") && productPreview.includes("Product Discovery") && productPreview.includes("Reviewer") && !publicForbidden.test(productPreview), productPreview);
        await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card button')].find((button)=>button.textContent.includes('Install'))?.click()");
        await waitFor("Product installation", async () => await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card')].some((card)=>card.innerText.includes('Product Discovery Team') && card.innerText.includes('Installed'))"));
        const installedPage = await invoke(win, "async()=>({cards:[...document.querySelectorAll('#product-packs-page .settings-card')].map((card)=>card.innerText)})");
        check("gallery installs Product Discovery through the existing action", installedPage.cards.length === 1 && installedPage.cards[0].includes("Product Discovery Team") && installedPage.cards[0].includes("Installed"), JSON.stringify(installedPage));

        installed = await invoke(win, "async()=>({teams:await window.sovereignbot.teams.list({}), coworkers:await window.sovereignbot.coworkers.list({includeArchived:false}), recipe:await window.sovereignbot.teams.exportPackRecipe({packId:'product-team'})})");
        const productTeam = installed.teams.teams.find((entry) => entry.packId === "product-team");
        const productChannels = productTeam ? await invoke(win, `async()=>window.sovereignbot.channels.list({teamId:${JSON.stringify(productTeam.id)},includeArchived:true})`) : { channels: [] };
        check("installed Product pack has the expected governed composition", productTeam?.name === "Product Discovery Team" && productTeam.coworkers.map((entry) => entry.name).join(",") === "Chief of Staff,Product Lead,Reviewer" && productTeam.channels[0]?.name === "Product Discovery" && productTeam.playbooks[0]?.name === "Product Discovery" && productChannels.channels[0]?.coworkerIds.length === 3, JSON.stringify({ team: productTeam, channels: productChannels, playbooks: productTeam?.playbooks }));
        check("installed pack does not enlist unrelated coworkers", productTeam?.coworkerIds.length === 3 && productTeam.channels.every((channel) => channel.coworkerIds.every((id) => productTeam.coworkerIds.includes(id))), JSON.stringify({ teamCoworkers: productTeam?.coworkerIds, channelCoworkers: productChannels.channels.map((channel) => channel.coworkerIds) }));
        const recipeKeys = Object.keys(installed.recipe).sort();
        check("first-party composition preview stays declarative", JSON.stringify(recipeKeys) === JSON.stringify(["channels", "coworkers", "description", "id", "name", "playbooks", "schema"]), JSON.stringify({ recipeKeys, recipe: installed.recipe }));
        check("installed public projections stay path and authority free", !publicForbidden.test(JSON.stringify({ team: productTeam, channels: productChannels, coworkers: installed.coworkers })), JSON.stringify({ team: productTeam, channels: productChannels }));
        const persisted = JSON.parse(readFileSync(join(dataDir, "desktop-state", "teams.json"), "utf8"));
        check("installed Team Pack state is durable in the existing store", persisted.teams.some((entry) => entry.packId === "product-team" && entry.playbooks?.some((book) => book.id === "product-discovery")), JSON.stringify(persisted.teams.filter((entry) => entry.packId === "product-team")));

        const exportPath = join(dataDir, "p20-product-pack-export.json");
        teamPackDialog.savePaths.push(exportPath);
        await invoke(win, "async()=>{const card=[...document.querySelectorAll('#product-packs-page .settings-card')][0]; [...(card?.querySelectorAll('button')||[])].find((button)=>button.textContent.includes('Export'))?.click(); return true}");
        await waitFor("custom Team Pack export", async () => {
            if (!existsSync(exportPath)) return false;
            try { JSON.parse(readFileSync(exportPath, "utf8")); return true; } catch { return false; }
        });
        const exportedPack = JSON.parse(readFileSync(exportPath, "utf8"));
        check("gallery exports a bounded declarative Team Pack through the native save path", exportedPack.id === "product-team" && Object.keys(exportedPack).sort().join(",") === "channels,coworkers,description,id,name,playbooks,schema" && !publicForbidden.test(JSON.stringify(exportedPack)), JSON.stringify(exportedPack));
        const exportStatus = await invoke(win, "async()=>document.getElementById('team-pack-file-result')?.textContent || ''");
        check("gallery export result exposes only the selected file name", !exportStatus.includes(dataDir), exportStatus);

        teamPackDialog.openPaths.push(exportPath);
        await invoke(win, "async()=>document.getElementById('team-pack-page-import')?.click()");
        await waitFor("Team Pack import", async () => (await invoke(win, "async()=>document.getElementById('team-pack-file-result')?.textContent || ''")).includes("Imported"));
        const importedPage = await invoke(win, "async()=>({status:document.getElementById('team-pack-file-result')?.textContent || '', cards:[...document.querySelectorAll('#product-packs-page .settings-card')].map((card)=>card.innerText)})");
        check("gallery imports the exported file through the native open path", importedPage.status === "Imported p20-product-pack-export.json." && importedPage.cards.some((card) => card.includes("Product Discovery Team")), JSON.stringify(importedPage));

        await invoke(win, "async()=>{const input=document.getElementById('team-pack-search-page'); input.value='Product Discovery Team'; input.dispatchEvent(new Event('input',{bubbles:true})); return true}");
        await waitFor("Product recipe search", async () => (await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card h3')].map((node)=>node.textContent)" )).length >= 2);
        await invoke(win, "async()=>{const select=document.getElementById('team-pack-category-page'); select.value='Custom'; select.dispatchEvent(new Event('change',{bubbles:true})); return true}");
        await waitFor("custom Team Pack filter", async () => { const texts = await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card')].map((card)=>card.innerText)"); return texts.length >= 1 && texts.every((text) => text.includes("Category: Custom")); });
        const customCards = await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card')].map((card)=>({title:card.querySelector('h3')?.textContent || '', text:card.innerText, buttons:[...card.querySelectorAll('button')].map((button)=>button.textContent)}))");
        check("gallery search and Custom filter expose reusable recipes", customCards.length >= 1 && customCards.every((card) => card.text.includes("Category: Custom") && card.text.includes("Product Discovery Team") && card.buttons.some((label) => label.includes("Duplicate")) && card.buttons.some((label) => label.includes("Edit recipe"))), JSON.stringify(customCards));

        const customCardIndex = customCards.findIndex((card) => card.buttons.some((label) => label.includes("Edit recipe")));
        await invoke(win, `async()=>{const card=[...document.querySelectorAll('#product-packs-page .settings-card')][${customCardIndex}]; [...(card?.querySelectorAll('button')||[])].find((button)=>button.textContent.includes('Duplicate'))?.click(); return true}`);
        await waitFor("custom Team Pack duplicate", async () => (await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card h3')].map((node)=>node.textContent)" )).length >= 2);
        await invoke(win, "async()=>{const cards=[...document.querySelectorAll('#product-packs-page .settings-card')]; const card=cards[cards.length-1]; [...(card?.querySelectorAll('button')||[])].find((button)=>button.textContent.includes('Edit recipe'))?.click(); return true}");
        const customRecipeIds = await invoke(win, "async()=>{const listed=await window.sovereignbot.teams.list({}); return (listed.packs??[]).filter((entry)=>entry.custom).map((entry)=>entry.id)}");
        const duplicateRecipeId = customRecipeIds[customRecipeIds.length - 1];
        await invoke(win, `async()=>{await window.sovereignbot.teams.editPack({packId:${JSON.stringify(duplicateRecipeId)},patch:{name:'P20 Edited Recipe',description:'P20 edited declarative recipe'}}); await window.refreshIndependentProductPages?.(); return true}`);
        await invoke(win, "async()=>{const input=document.getElementById('team-pack-search-page'); input.value='P20 Edited Recipe'; input.dispatchEvent(new Event('input',{bubbles:true})); return true}");
        await waitFor("custom Team Pack edit", async () => (await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card h3')].map((node)=>node.textContent)" )).includes("P20 Edited Recipe"));
        const editedCards = await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card')].map((card)=>card.innerText)");
        const editedCatalog = await invoke(win, "async()=>window.sovereignbot.teams.list({})");
        const editedRecipe = editedCatalog.packs.find((entry) => entry.id === duplicateRecipeId);
        check("gallery exposes duplicate/edit controls and edited recipe persists through preload IPC", editedCards.some((card) => card.includes("P20 Edited Recipe")) && editedRecipe?.description === "P20 edited declarative recipe", JSON.stringify({ cards: editedCards, recipe: editedRecipe }));

        const unsafePath = join(dataDir, "p20-unsafe-team-pack.json");
        writeFileSync(unsafePath, JSON.stringify({ ...exportedPack, capabilityGrant: "computer" }), "utf8");
        teamPackDialog.openPaths.push(unsafePath);
        await invoke(win, "async()=>document.getElementById('team-pack-page-import')?.click()");
        await waitFor("unsafe Team Pack rejection", async () => /not accepted|unexpected|capability/i.test(await invoke(win, "async()=>document.querySelector('#product-packs-page')?.innerText || ''")));
        const unsafeResult = await invoke(win, "async()=>document.querySelector('#product-packs-page')?.innerText || ''");
        check("file import rejects authority-bearing Team Pack JSON", /not accepted|unexpected|capability/i.test(unsafeResult) && !unsafeResult.includes(unsafePath), unsafeResult);

        unbind?.();
        unbind = undefined;
        fixture = makeFixture(dataDir, { teamPackDialog });
        unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
        await loadWindow(win);
        restart = await invoke(win, "async()=>({catalog:await window.sovereignbot.teams.list({}), coworkers:await window.sovereignbot.coworkers.list({includeArchived:false})})");
        const restartedTeam = restart.catalog.teams.find((entry) => entry.packId === "product-team");
        check("restart preserves installed first-party Team Pack", restartedTeam?.name === "Product Discovery Team" && restartedTeam.coworkers.map((entry) => entry.name).join(",") === "Chief of Staff,Product Lead,Reviewer" && restartedTeam.channels[0]?.name === "Product Discovery" && restartedTeam.playbooks[0]?.id === "product-discovery", JSON.stringify({ team: restartedTeam }));
        await invoke(win, "async()=>{document.getElementById('nav-team-packs')?.click(); return true}");
        await waitFor("restarted Team Pack page", async () => await invoke(win, "async()=>!document.getElementById('view-team-packs')?.classList.contains('hidden')"));
        await invoke(win, "async()=>{const input=document.getElementById('team-pack-search-page'); input.value='Product'; input.dispatchEvent(new Event('input',{bubbles:true})); return true}");
        await waitFor("restarted Product search", async () => await invoke(win, "async()=>[...document.querySelectorAll('#product-packs-page .settings-card')].some((card)=>card.innerText.includes('Product Discovery Team') && card.innerText.includes('Installed'))"));
        const restartPage = await invoke(win, "async()=>({cards:[...document.querySelectorAll('#product-packs-page .settings-card')].map((card)=>card.innerText)})");
        check("restart keeps gallery install status and safe user-facing state", restartPage.cards.some((card) => card.includes("Product Discovery Team") && card.includes("Installed")) && !publicForbidden.test(JSON.stringify(restartPage)), JSON.stringify(restartPage));
        check("restart public catalog stays path and authority free", !publicForbidden.test(JSON.stringify(restart)), JSON.stringify(restart.catalog));
    }
    catch (error) {
        fatal = error;
        note(`[fatal] ${String(error?.stack ?? error)}`);
        check("P11 Team Pack gate runner completed", false, String(error?.message ?? error));
    }

    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
    const summary = { at: new Date().toISOString(), checks, catalog, installed, restart, fatal: fatal ? String(fatal?.message ?? fatal) : undefined };
    writeFileSync(join(EVIDENCE_DIR, "verify-p11-team-packs.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    writeFileSync(join(EVIDENCE_DIR, "verify-p11-team-packs.log"), `${log.join("\n")}\n`, "utf8");
    try { unbind?.(); } catch {}
    try { uninstallProtocol?.(); } catch {}
    try { win?.destroy(); } catch {}
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    if (fatal || failed.length) throw new Error(`P11 Team Pack gate failed: ${failed.join(", ") || String(fatal?.message ?? fatal)}`);
    app.exit(0);
}
