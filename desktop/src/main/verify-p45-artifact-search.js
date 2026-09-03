// P45 hidden acceptance gate for bounded text Artifact content Search.
// Uses only local fixture files and the real hidden Electron/preload/IPC/UI chain.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeFixture, handlers, loadWindow, invoke } from "./verify-p15-project-command-center.js";
import { createArtifactStore } from "./artifact-store.js";
import { createSearchService } from "./search-service.js";
import { createProductSurfaceService } from "./product-surface-service.js";
import { createMainWindow } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(process.cwd(), ".p45-evidence");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 20_000, diagnose) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeout) {
        if (diagnose) { try { last = await diagnose(); } catch (error) { last = { diagnoseError: String(error?.message ?? error) }; } }
        if (await check()) return;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify({ last })}`);
}

export async function runVerifyP45ArtifactSearch({ app } = {}) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const checks = {}; const notes = [];
    const safeJson = (value) => JSON.stringify(value).replace(/(?:[A-Za-z]:[\\/]|file:\/\/|https?:\/\/|workspacePath|storageRelativePath|sourceRelativePath|searchText|projectIds|provider|account|session|credential|token|secret|password|cookie|cwd|path)/gi, "[redacted]").slice(0, 1_500);
    const check = (name, ok, detail = "") => { checks[name] = { ok: Boolean(ok), ...(detail ? { detail: safeJson(detail) } : {}) }; const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${safeJson(detail)}` : ""}`; notes.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
    const result = { schema: "sovereignbot.desktop.p45-artifact-content-search-canary.v1", fixtureBoundary: "LOCAL_FIXTURE", publishEligible: false, checks, notes, externalActions: [] };
    let dataDir; let fixture; let win; let unbind; let uninstallProtocol;
    try {
        dataDir = mkdtempSync(join(tmpdir(), "sovereign-p45-data-"));
        fixture = makeFixture(dataDir);
        const workspacePath = fixture.services.workspacePath(fixture.sharedWorkspaceId);
        const artifactDir = join(workspacePath, "p45-artifacts");
        mkdirSync(artifactDir, { recursive: true });
        let targetArtifact;
        for (let index = 0; index < 620; index += 1) {
            const fileName = `artifact-${String(index).padStart(4, "0")}.md`;
            const body = index === 0 ? "P45 ancient cobalt lantern" : `P45 unrelated artifact body ${index}`;
            writeFileSync(join(artifactDir, fileName), body, "utf8");
            const artifact = fixture.artifactStore.ingestWorkspaceFile({ workspaceId: fixture.sharedWorkspaceId, workspacePath, relativePath: `p45-artifacts/${fileName}`, title: `P45 Artifact ${index}` });
            if (index === 0) targetArtifact = artifact;
        }
        writeFileSync(join(artifactDir, "opaque-bin.png"), Buffer.from("obsidian raster sigil", "utf8"));
        const binaryArtifact = fixture.artifactStore.ingestWorkspaceFile({ workspaceId: fixture.sharedWorkspaceId, workspacePath, relativePath: "p45-artifacts/opaque-bin.png", title: "Binary Fixture" });
        writeFileSync(join(artifactDir, "overflow.txt"), Buffer.alloc(64 * 1024 + 1, "x").toString("utf8") + " vermilion overflow glyph");
        const oversizedArtifact = fixture.artifactStore.ingestWorkspaceFile({ workspaceId: fixture.sharedWorkspaceId, workspacePath, relativePath: "p45-artifacts/overflow.txt", title: "Oversized Fixture" });
        writeFileSync(join(artifactDir, "secret.txt"), "token=P45HiddenArtifactSecret C:\\Users\\Eternal\\private\\secret.txt", "utf8");
        const secretArtifact = fixture.artifactStore.ingestWorkspaceFile({ workspaceId: fixture.sharedWorkspaceId, workspacePath, relativePath: "p45-artifacts/secret.txt", title: "Secret Fixture" });
        check("canonical ArtifactStore retains the full bounded text corpus", fixture.artifactStore.indexRecords({ visibility: "all", limit: 5_000 }).artifacts.length >= 623, { count: fixture.artifactStore.indexRecords({ visibility: "all", limit: 5_000 }).artifacts.length, targetId: targetArtifact?.id });

        const fixtureHandlers = {
            ...handlers(fixture),
            "computer:history": () => ({ history: [] }),
            "job:list": () => ({ jobs: [] }),
            "job:attention": () => ({ jobs: [] }),
            "memory:list": () => ({ memories: [], total: 0 }),
            "thisPc:list": () => ({ items: [] }),
            "notification:list": () => ({ notifications: [], totalCount: 0, unreadCount: 0 }),
            "artifact:archive": ({ artifactId }) => fixture.artifactStore.archive(artifactId),
            "artifact:restore": ({ artifactId }) => fixture.artifactStore.restore(artifactId),
            "artifact:discard": ({ artifactIds }) => fixture.artifactStore.discardArtifacts(artifactIds),
        };
        uninstallProtocol = installAppProtocolHandler();
        win = createMainWindow({ smoke: true });
        unbind = bindIpcChannels({ win, handlers: fixtureHandlers });
        check("hidden Electron window stays hidden", win.isVisible() === false);
        await loadWindow(win);

        const initial = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P45 ancient cobalt lantern",types:["artifacts"],status:"active",limit:10})`);
        const hit = initial.results?.[0];
        const stats = fixture.search.diagnostics();
        const publicJson = JSON.stringify(hit ?? {});
        check("Search finds old Artifact body content beyond the recent 500", initial.results?.length === 1 && hit?.id === targetArtifact.id && /cobalt lantern/i.test(hit?.matchSnippet ?? ""), { total: initial.total, id: hit?.id, targetId: targetArtifact.id, snippetLength: hit?.matchSnippet?.length });
        check("Artifact content Search uses bounded candidates and safe projection", stats.indexed && stats.corpusCount >= 623 && stats.candidateCount < stats.corpusCount / 4 && stats.matchEvaluations <= stats.candidateCount && hit?.matchSnippet?.length <= 180 && !/(searchText|projectIds|storageRelativePath|sourceRelativePath|provider|session|credential|token|secret|password|cwd|path)/i.test(publicJson), { ...stats, keys: Object.keys(hit ?? {}) });

        const secret = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P45HiddenArtifactSecret",types:["artifacts"],status:"active",limit:10})`);
        const binary = await invoke(win, `async()=>window.sovereignbot.search.query({query:"obsidian raster sigil",types:["artifacts"],status:"active",limit:10})`);
        const oversized = await invoke(win, `async()=>window.sovereignbot.search.query({query:"vermilion overflow glyph",types:["artifacts"],status:"active",limit:10})`);
        check("binary, oversized, and sensitive content stay out of Search", secret.results?.length === 0 && binary.results?.length === 0 && oversized.results?.length === 0, { secret: secret.results?.length, binary: binary.results?.length, oversized: oversized.results?.length, binaryId: binaryArtifact.id, oversizedId: oversizedArtifact.id, secretId: secretArtifact.id });

        await invoke(win, `async()=>{document.getElementById("open-command-palette")?.click(); return true}`);
        await waitFor(async () => (await invoke(win, `async()=>!!document.querySelector("#command-palette:not(.hidden)")`)), "Artifact Search palette");
        await invoke(win, `async()=>{const type=document.getElementById("palette-type-filter"); type.value="artifacts"; type.dispatchEvent(new Event("change",{bubbles:true})); const input=document.querySelector("#command-palette input[type=search]"); input.value="P45 ancient cobalt lantern"; input.dispatchEvent(new Event("input",{bubbles:true})); return true}`);
        await waitFor(async () => (await invoke(win, `async()=>document.querySelectorAll("#palette-results .command-palette-result").length`)) === 1, "Artifact content Search UI result", 20_000, async () => invoke(win, `async()=>({count:document.querySelectorAll("#palette-results .command-palette-result").length,results:document.querySelector("#palette-results")?.textContent||""})`));
        const uiBeforeOpen = await invoke(win, `async()=>({title:document.querySelector("#palette-results .command-palette-result-title")?.textContent||"",subtitle:document.querySelector("#palette-results .command-palette-result-subtitle")?.textContent||""})`);
        await invoke(win, `async()=>{document.querySelector("#palette-results .command-palette-result")?.click(); return true}`);
        await waitFor(async () => (await invoke(win, `async()=>document.querySelector("#view-artifacts")?.classList.contains("hidden")===false`)), "Artifact deep link view", 20_000, async () => invoke(win, `async()=>({artifactsHidden:document.querySelector("#view-artifacts")?.classList.contains("hidden"),body:document.querySelector("#view-artifacts")?.textContent?.slice(0,500)||""})`));
        await waitFor(async () => (await invoke(win, `async()=>!!document.querySelector('[data-artifact-id="${targetArtifact.id}"]')`)), "Artifact deep link card", 20_000, async () => invoke(win, `async()=>({targetId:${JSON.stringify(targetArtifact.id)},cards:document.querySelectorAll("#artifact-hub-list [data-artifact-id], #artifacts-list [data-artifact-id]").length,body:document.querySelector("#view-artifacts")?.textContent?.slice(0,500)||""})`));
        const ui = await invoke(win, `async()=>{const card=document.querySelector('[data-artifact-id="${targetArtifact.id}"]'); return {title:document.querySelector("#view-artifacts h1")?.textContent||"",focused:card?.getAttribute("aria-current")==="true",uiBeforeOpen:${JSON.stringify(uiBeforeOpen)}}}`);
        check("Search UI shows a safe content snippet and opens the exact Artifact", /cobalt lantern/i.test(uiBeforeOpen.subtitle) && ui.focused && /Artifacts/i.test(ui.title), ui);

        await invoke(win, `async()=>window.sovereignbot.artifacts.archive({artifactId:${JSON.stringify(targetArtifact.id)}})`);
        const archived = await invoke(win, `async()=>({active:await window.sovereignbot.search.query({query:"P45 ancient cobalt lantern",types:["artifacts"],status:"active",limit:10}),archived:await window.sovereignbot.search.query({query:"P45 ancient cobalt lantern",types:["artifacts"],status:"archived",limit:10})})`);
        check("archive invalidates content Search and preserves archived filtering", archived.active.results?.length === 0 && archived.archived.results?.[0]?.id === targetArtifact.id, { active: archived.active.results?.length, archived: archived.archived.results?.[0]?.id });
        await invoke(win, `async()=>window.sovereignbot.artifacts.restore({artifactId:${JSON.stringify(targetArtifact.id)}})`);
        const restored = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P45 ancient cobalt lantern",types:["artifacts"],status:"active",limit:10})`);
        check("restore rebuilds Artifact content Search", restored.results?.[0]?.id === targetArtifact.id && restored.results?.[0]?.matchSnippet, { id: restored.results?.[0]?.id, snippetLength: restored.results?.[0]?.matchSnippet?.length });

        const revisionPath = join(artifactDir, "artifact-revision.md");
        writeFileSync(revisionPath, "P45 revised emerald artifact body", "utf8");
        const revisedArtifact = fixture.artifactStore.reviseFromPickedFile({ artifactId: targetArtifact.id, sourcePath: revisionPath });
        const revised = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P45 revised emerald artifact body",types:["artifacts"],status:"active",limit:10})`);
        check("revision invalidates and indexes the new Artifact version", revised.results?.[0]?.id === revisedArtifact.id && revised.results?.[0]?.matchSnippet, { id: revised.results?.[0]?.id, revisedId: revisedArtifact.id });

        const discardedPath = join(artifactDir, "discarded.md");
        writeFileSync(discardedPath, "P45 discarded artifact body", "utf8");
        const discardedArtifact = fixture.artifactStore.ingestWorkspaceFile({ workspaceId: fixture.sharedWorkspaceId, workspacePath, relativePath: "p45-artifacts/discarded.md", title: "P45 Discarded", published: false });
        const beforeDiscard = fixture.search.diagnostics();
        const discarded = fixtureHandlers["artifact:discard"]({ artifactIds: [discardedArtifact.id] });
        const afterDiscard = fixture.search.diagnostics();
        check("discard invalidates the authoritative Artifact Search service", afterDiscard.generation > beforeDiscard.generation && discarded?.[0]?.id === discardedArtifact.id && !fixture.artifactStore.indexRecords({ visibility: "all", limit: 5_000 }).artifacts.some((entry) => entry.id === discardedArtifact.id), { before: beforeDiscard, after: afterDiscard, discardedId: discarded?.[0]?.id });

        const restartedStore = createArtifactStore({ dataDir });
        fixture.artifactStore = restartedStore;
        fixture.productSurfaces = createProductSurfaceService({ dataDir, teamService: fixture.teamService, coworkerStore: fixture.coworkerStore, artifactStore: restartedStore, runtime: {}, getRuntime: () => ({}) });
        fixture.search = createSearchService({ teamService: fixture.teamService, conversationStore: fixture.conversationStore, coworkerStore: fixture.coworkerStore, projectService: fixture.projectService, artifactStore: restartedStore, skillStore: fixture.skillStore, productSurfaces: fixture.productSurfaces, getRoutines: () => fixture.routines?.list?.(), memoryService: fixture.memoryService, getJobs: () => fixture.jobs, getHistory: () => ({ history: [] }) });
        restartedStore.onChanged(() => fixture.search?.invalidate());
        unbind?.();
        unbind = bindIpcChannels({ win, handlers: {
            ...handlers(fixture),
            "computer:history": () => ({ history: [] }),
            "job:list": () => ({ jobs: [] }),
            "job:attention": () => ({ jobs: [] }),
            "memory:list": () => ({ memories: [], total: 0 }),
            "thisPc:list": () => ({ items: [] }),
            "notification:list": () => ({ notifications: [], totalCount: 0, unreadCount: 0 }),
        } });
        await loadWindow(win);
        const afterRestart = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P45 revised emerald artifact body",types:["artifacts"],status:"active",limit:10})`);
        const restartStats = fixture.search.diagnostics();
        check("restart rebuilds bounded Artifact content Search", afterRestart.results?.[0]?.id === revisedArtifact.id && restartStats.corpusCount >= 623 && afterRestart.results?.[0]?.matchSnippet, { id: afterRestart.results?.[0]?.id, revisedId: revisedArtifact.id, stats: restartStats });
    }
    catch (error) {
        result.error = safeJson(error?.stack ?? error); check("P45 hidden Artifact content Search gate completed", false, error?.message ?? error);
    }
    result.ok = Object.values(checks).every((entry) => entry.ok);
    writeFileSync(join(EVIDENCE_DIR, "verify-p45-artifact-search.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    writeFileSync(join(EVIDENCE_DIR, "verify-p45-artifact-search.log"), `${notes.join("\n")}\n`, "utf8");
    try { unbind?.(); } catch {} try { uninstallProtocol?.(); } catch {} try { win?.destroy(); } catch {} try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {}
    if (!result.ok) { app?.exit(1); return; } app?.exit(0);
}
