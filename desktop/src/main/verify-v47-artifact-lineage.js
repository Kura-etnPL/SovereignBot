// Hidden real-Electron acceptance for the local Files & Artifacts version path.
// It exercises the renderer, validated preload/IPC, durable ArtifactStore, and
// service reconstruction without starting a provider or opening a visible window.
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
import { pickArtifactRevision } from "./attachment-integration.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = join(WORKTREE_ROOT, "_evidence_v48_2026-09-02");
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
    const projectService = createProjectService({ dataDir, services, teamService, coworkerStore, artifactStore, skillStore, onChanged: () => search?.invalidate() });
    const runtime = { memory: new MemoryStore(join(stateDir, "memory.jsonl")), audit: { readAll: async () => [] } };
    const memoryService = createMemoryService({ runtime, services, coworkerStore, teamService, conversationStore, artifactStore, projectResolver: (projectId) => projectService.resolveProject(projectId), onChanged: () => search?.invalidate() });
    projectService.setMemoryService(memoryService);
    const productSurfaces = createProductSurfaceService({ dataDir, teamService, coworkerStore, artifactStore, runtime });
    search = createSearchService({ teamService, conversationStore, coworkerStore, projectService, artifactStore, skillStore, memoryService });
    return { services, coworkerStore, conversationStore, artifactStore, skillStore, teamService, projectService, memoryService, productSurfaces, search };
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
        "team:list": () => teamService.list(),
        "channel:list": (payload) => teamService.listChannels(payload),
        "artifact:list": (payload) => artifactStore.list(payload),
        "artifact:get": ({ artifactId }) => artifactStore.get(artifactId),
        "artifact:preview": ({ artifactId }) => artifactStore.previewText(artifactId),
        "artifact:open": ({ artifactId }) => ({ ok: true, verified: "managed-artifact", action: "open", artifactId }),
        "artifact:reveal": ({ artifactId }) => ({ ok: true, verified: "managed-artifact", action: "reveal", artifactId }),
        "artifact:history": (payload) => productSurfaces.artifactHistory(payload),
        "artifact:restoreAsNewVersion": ({ artifactId }) => artifactStore.restoreAsNewVersion(artifactId),
        "artifact:reviseViaDialog": ({ artifactId }) => pickArtifactRevision({ win: undefined, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, artifactStore, artifactId }),
        "artifact:hub": (payload) => productSurfaces.artifactHub(payload),
        "playbook:list": (payload) => productSurfaces.listPlaybooks(payload),
        "skill:list": (payload) => skillStore.list(payload),
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
        "computer:history": (payload) => productSurfaces.computerHistory(payload),
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

export async function runVerifyV47ArtifactLineage({ app }) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const checks = {};
    const log = [];
    const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
    const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };
    const publicForbidden = /(?:storageRelativePath|sourceRelativePath|workspacePath|file:\/\/|https?:\/\/|provider|account|session|credential|bearer|token|cwd|authority|coordinate|driver)/i;
    const tempRoot = process.env.SOVEREIGNBOT_V48_TEMP_ROOT;
    if (!tempRoot) throw new Error("V48 temp root is missing; refusing to use the default user profile");
    const dataDir = join(tempRoot, "data");
    const workspace = join(tempRoot, "trusted-workspace");
    let fixture;
    let win;
    let unbind;
    let uninstallProtocol;
    let fatal;
    let source;
    let revised;
    let restored;
    let firstHistory;
    let afterRestore;
    let restartProjection;

    try {
        mkdirSync(workspace, { recursive: true });
        const sourcePath = join(workspace, "reports", "release.md");
        mkdirSync(dirname(sourcePath), { recursive: true });
        writeFileSync(sourcePath, "# P10 revision A\n", "utf8");
        fixture = makeFixture(dataDir);
        const owner = fixture.coworkerStore.list({ includeArchived: true }).coworkers.find((entry) => entry.state !== "archived") ?? fixture.coworkerStore.list({ includeArchived: true }).coworkers[0];
        if (!owner) throw new Error("V47 fixture has no coworker");
        const conversation = fixture.conversationStore.createDirect(owner.id);
        source = fixture.artifactStore.ingestWorkspaceFile({ workspaceId: "workspace_p10", workspacePath: workspace, relativePath: "reports/release.md", title: "P10 release report", createdByCoworkerId: owner.id, conversationId: conversation.id });
        const revisionPath = join(workspace, "reports", "revision.md");
        writeFileSync(revisionPath, "# P10 revision B\n", "utf8");
        revised = fixture.artifactStore.reviseFromPickedFile({ artifactId: source.id, sourcePath: revisionPath });
        uninstallProtocol = installAppProtocolHandler();
        win = createMainWindow({ smoke: true });
        unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
        check("gate window stays hidden", win.isVisible() === false);
        await loadWindow(win);
        const rendererSurface = await invoke(win, "async()=>({history:typeof window.sovereignbot?.artifacts?.history, restore:typeof window.sovereignbot?.artifacts?.restoreAsNewVersion, revise:typeof window.sovereignbot?.artifacts?.reviseViaDialog, artifactsPage:!!document.getElementById('view-artifacts'), artifactRoot:!!document.getElementById('product-artifacts-page')})");
        check("renderer exposes the bounded artifact lifecycle", rendererSurface.history === "function" && rendererSurface.restore === "function" && rendererSurface.revise === "function" && rendererSurface.artifactsPage && rendererSurface.artifactRoot, JSON.stringify(rendererSurface));
        const pickerResult = await invoke(win, `async()=>window.sovereignbot.artifacts.reviseViaDialog({artifactId:${JSON.stringify(source.id)}})`);
        check("revised-version picker is main-process-owned and cancel-safe", pickerResult.canceled === true && pickerResult.artifact === undefined, JSON.stringify(pickerResult));
        const initialHistory = await invoke(win, `async()=>window.sovereignbot.artifacts.history({artifactId:${JSON.stringify(source.id)}})`);
        firstHistory = initialHistory;
        check("history IPC exposes the revised version lineage", initialHistory.artifacts?.length === 2 && initialHistory.artifacts[0].id === revised.id && initialHistory.artifacts[0].version === 2 && initialHistory.artifacts[1].id === source.id && initialHistory.artifacts[1].version === 1, JSON.stringify(initialHistory));
        check("initial public artifact projection is path and authority free", !publicForbidden.test(JSON.stringify(await invoke(win, `async()=>window.sovereignbot.artifacts.get({artifactId:${JSON.stringify(source.id)}})`))), JSON.stringify(source));
        await invoke(win, "async()=>{document.getElementById('nav-artifacts')?.click(); return true}");
        await sleep(700);
        const initialPage = await invoke(win, "async()=>({visible:document.getElementById('view-artifacts')?.classList.contains('hidden')===false, cards:[...document.querySelectorAll('#product-artifacts-page .settings-card')].map((card)=>card.innerText), buttons:[...document.querySelectorAll('#product-artifacts-page button')].map((button)=>button.textContent.trim())})");
        check("Files & Artifacts page renders inspect, selectable history, revise, and restore actions", initialPage.visible && initialPage.cards.some((text) => text.includes("P10 release report") && text.includes("v2")) && initialPage.buttons.some((text) => text.includes("Preview")) && initialPage.buttons.some((text) => text.includes("History")) && initialPage.buttons.some((text) => text.includes("Revise with local file")) && initialPage.buttons.some((text) => text.includes("Restore as new version")), JSON.stringify(initialPage));
        const historyState = await invoke(win, "async()=>{const button=[...document.querySelectorAll('#product-artifacts-page button')].find((entry)=>entry.textContent.includes('History')); button?.click(); await new Promise((resolve)=>setTimeout(resolve,180)); return {rows:[...document.querySelectorAll('#product-artifacts-page .artifact-history-row')].map((row)=>row.innerText), buttons:[...document.querySelectorAll('#product-artifacts-page .artifact-history-panel button')].map((entry)=>entry.textContent.trim())}}");
        check("Hub History action exposes selectable v1 and v2 restore rows", historyState.rows.some((text) => text.includes("v2")) && historyState.rows.some((text) => text.includes("v1")) && historyState.buttons.some((text) => text.includes("Restore v1 as new version")) && historyState.buttons.some((text) => text.includes("Restore v2 as new version")), JSON.stringify(historyState));
        await invoke(win, "async()=>{const button=[...document.querySelectorAll('#product-artifacts-page .artifact-history-panel button')].find((entry)=>entry.textContent.includes('Restore v1 as new version')); button?.click(); return Boolean(button)}");
        await sleep(700);
        afterRestore = await invoke(win, "async()=>({list:await window.sovereignbot.artifacts.list({limit:100}), history:await window.sovereignbot.artifacts.history({artifactId:" + JSON.stringify(source.id) + "}), previews:{source:await window.sovereignbot.artifacts.preview({artifactId:" + JSON.stringify(source.id) + "}), revised:await window.sovereignbot.artifacts.preview({artifactId:" + JSON.stringify(revised.id) + "})}, page:{cards:[...document.querySelectorAll('#product-artifacts-page .settings-card')].map((card)=>card.innerText)}})");
        restored = afterRestore.list.artifacts.find((entry) => entry.version === 3);
        check("Selecting v1 restores A as v3 while retaining v1 and revised v2", restored?.version === 3 && restored.parentArtifactId === source.id && restored.artifactFamilyId === source.artifactFamilyId && afterRestore.list.artifacts.length === 3 && afterRestore.history.artifacts.length === 3 && afterRestore.previews.source.preview === "# P10 revision A\n" && afterRestore.previews.revised.preview === "# P10 revision B\n" && restored.sha256 === source.sha256 && revised.sha256 !== source.sha256 && afterRestore.page.cards.some((text) => text.includes("v3")), JSON.stringify({ restored, history: afterRestore.history, previews: afterRestore.previews, page: afterRestore.page }));
        check("restored public projection preserves Conversation and Coworker lineage", restored?.conversationId === source.conversationId && restored?.createdByCoworkerId === source.createdByCoworkerId, JSON.stringify({ source, restored }));
        check("restored public artifact projection is path and authority free", !publicForbidden.test(JSON.stringify({ list: afterRestore.list, history: afterRestore.history })), JSON.stringify({ list: afterRestore.list, history: afterRestore.history }));
        const persisted = JSON.parse(readFileSync(join(dataDir, "desktop-state", "artifacts.json"), "utf8"));
        const persistedSource = persisted.artifacts.find((entry) => entry.id === source.id);
        const persistedRevised = persisted.artifacts.find((entry) => entry.id === revised.id);
        const persistedRestored = persisted.artifacts.find((entry) => entry.id === restored?.id);
        check("same-store metadata records an append-only A→B→A family", persistedSource?.artifactFamilyId === persistedRevised?.artifactFamilyId && persistedRevised?.artifactFamilyId === persistedRestored?.artifactFamilyId && persistedSource?.version === 1 && persistedRevised?.version === 2 && persistedRestored?.version === 3 && persistedRevised?.parentArtifactId === source.id && persistedRestored?.parentArtifactId === source.id && persistedRestored?.conversationId === source.conversationId && persistedRestored?.createdByCoworkerId === source.createdByCoworkerId, JSON.stringify({ source: persistedSource, revised: persistedRevised, restored: persistedRestored }));
        check("source managed bytes remain unchanged", fixture.artifactStore.previewText(source.id).preview === "# P10 revision A\n" && fixture.artifactStore.previewText(revised.id).preview === "# P10 revision B\n" && fixture.artifactStore.previewText(restored.id).preview === "# P10 revision A\n", JSON.stringify({ sourceId: source.id, revisedId: revised.id, restoredId: restored?.id }));

        unbind?.();
        unbind = undefined;
        fixture = makeFixture(dataDir);
        unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
        await loadWindow(win);
        restartProjection = await invoke(win, `async()=>({list:await window.sovereignbot.artifacts.list({limit:100}), history:await window.sovereignbot.artifacts.history({artifactId:${JSON.stringify(source.id)}}), hub:await window.sovereignbot.artifacts.hub({limit:100}), previews:{source:await window.sovereignbot.artifacts.preview({artifactId:${JSON.stringify(source.id)}}), revised:await window.sovereignbot.artifacts.preview({artifactId:${JSON.stringify(revised.id)}}), restored:await window.sovereignbot.artifacts.preview({artifactId:${JSON.stringify(restored.id)}})}})`);
        const restartedRestored = restartProjection.list.artifacts.find((entry) => entry.id === restored.id);
        check("same hidden renderer after service restart reloads all three versions", restartProjection.list.artifacts.length === 3 && restartedRestored?.version === 3 && restartProjection.history.artifacts.map((entry) => entry.version).join(",") === "3,2,1" && restartProjection.hub.artifacts.length === 1 && restartProjection.hub.artifacts[0].version === 3 && restartProjection.previews.source.preview === "# P10 revision A\n" && restartProjection.previews.revised.preview === "# P10 revision B\n" && restartProjection.previews.restored.preview === "# P10 revision A\n", JSON.stringify(restartProjection));
        check("restart preserves source Conversation, Project workspace, and Coworker lineage", restartedRestored?.conversationId === source.conversationId && restartedRestored?.createdByCoworkerId === source.createdByCoworkerId && fixture.artifactStore.get(restored.id).workspaceId === "workspace_p10", JSON.stringify({ sourceId: source.id, restored: restartedRestored }));
        check("restart public projections remain path and authority free", !publicForbidden.test(JSON.stringify(restartProjection)), JSON.stringify(restartProjection));
    }
    catch (error) {
        fatal = error;
        note(`[fatal] ${String(error?.stack ?? error)}`);
        check("V4.7 Files & Artifacts lineage gate runner completed", false, String(error?.message ?? error));
    }

    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
    const summary = { at: new Date().toISOString(), checks, sourceId: source?.id, revisedId: revised?.id, restoredId: restored?.id, firstHistory, afterRestore, restartProjection, fatal: fatal ? String(fatal?.message ?? fatal) : undefined };
    writeFileSync(join(EVIDENCE_DIR, "verify-v47-artifact-lineage.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    writeFileSync(join(EVIDENCE_DIR, "verify-v47-artifact-lineage.log"), `${log.join("\n")}\n`, "utf8");
    try { unbind?.(); } catch {}
    try { uninstallProtocol?.(); } catch {}
    try { win?.destroy(); } catch {}
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    if (fatal || failed.length) throw new Error(`V4.7 Files & Artifacts lineage gate failed: ${failed.join(", ") || String(fatal?.message ?? fatal)}`);
    app.exit(0);
}
