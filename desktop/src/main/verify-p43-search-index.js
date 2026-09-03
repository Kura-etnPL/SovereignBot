// P43 hidden acceptance gate for the canonical global Search query index.
// The scale corpus is local metadata only; no provider, network, or user data is used.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeFixture, handlers, loadWindow, invoke } from "./verify-p15-project-command-center.js";
import { createArtifactStore } from "./artifact-store.js";
import { createProductSurfaceService } from "./product-surface-service.js";
import { createSearchService } from "./search-service.js";
import { createMainWindow } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(process.cwd(), "..", "docs", "acceptance");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15_000) {
    const started = Date.now();
    while (Date.now() - started < timeout) { if (await check()) return; await sleep(100); }
    throw new Error(`timed out waiting for ${label}`);
}

function metadata(id, { title, conversationId, coworkerId, archived = false, createdAt = "2026-09-03T00:00:00.000Z" } = {}) {
    return {
        id, title, fileName: `${id}.md`, mimeType: "text/markdown", size: 1, sha256: "0".repeat(64),
        storageRelativePath: `${id}/${id}.md`, createdAt, artifactFamilyId: id, version: 1,
        sourceKind: "coworker", published: true, archived,
        ...(conversationId ? { conversationId } : {}), ...(coworkerId ? { createdByCoworkerId: coworkerId } : {}),
    };
}

export async function runVerifyP43SearchIndex({ app } = {}) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const checks = {}; const notes = [];
    const safeJson = (value) => JSON.stringify(value).replace(/(?:[A-Za-z]:[\\/]|file:\/\/|https?:\/\/|workspacePath|storageRelativePath|sourceRelativePath|searchText|projectIds|provider|account|session|credential|token|secret|password|cookie|cwd|path)/gi, "[redacted]").slice(0, 1_200);
    const check = (name, ok, detail = "") => { checks[name] = { ok: Boolean(ok), ...(detail ? { detail: safeJson(detail) } : {}) }; const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${safeJson(detail)}` : ""}`; notes.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
    const result = { schema: "sovereignbot.desktop.p43-search-index-canary.v1", fixtureBoundary: "LOCAL_FIXTURE", publishEligible: false, checks, notes, externalActions: [] };
    let dataDir; let fixture; let win; let unbind; let uninstallProtocol;
    try {
        dataDir = mkdtempSync(join(tmpdir(), "sovereign-p43-data-"));
        fixture = makeFixture(dataDir);
        const team = fixture.teamService.createTeam({ title: "P43 Indexed Search Team", coworkerIds: [fixture.chief.id, fixture.specialist.id], leadCoworkerId: fixture.chief.id });
        const targetConversationId = team.conversation.id;
        const targetId = "artifact_0000000000001388";
        const artifacts = [];
        for (let index = 1; index < 5_000; index += 1) {
            const id = `artifact_${index.toString(16).padStart(16, "0")}`;
            artifacts.push(metadata(id, { title: `Unrelated scale artifact ${index}`, createdAt: `2026-09-03T00:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z` }));
        }
        artifacts.push(metadata(targetId, { title: "P43 Quartz Needle Result", conversationId: targetConversationId, coworkerId: fixture.chief.id, createdAt: "2026-08-01T00:00:00.000Z" }));
        writeFileSync(join(dataDir, "desktop-state", "artifacts.json"), JSON.stringify({ schema: "sovereignbot.desktop.artifacts.v1", artifacts }), "utf8");
        fixture.artifactStore = createArtifactStore({ dataDir });
        fixture.productSurfaces = createProductSurfaceService({ dataDir, teamService: fixture.teamService, coworkerStore: fixture.coworkerStore, artifactStore: fixture.artifactStore, runtime: {}, getRuntime: () => ({}) });
        fixture.search = createSearchService({ teamService: fixture.teamService, conversationStore: fixture.conversationStore, coworkerStore: fixture.coworkerStore, projectService: fixture.projectService, artifactStore: fixture.artifactStore, skillStore: fixture.skillStore, productSurfaces: fixture.productSurfaces, getRoutines: () => fixture.routines?.list?.(), memoryService: fixture.memoryService, getJobs: () => fixture.jobs, getHistory: () => ({ history: [] }) });
        const fixtureHandlers = {
            ...handlers(fixture),
            "computer:history": () => ({ history: [] }), "job:list": () => ({ jobs: [] }), "job:attention": () => ({ jobs: [] }),
            "artifact:archive": ({ artifactId }) => { const value = fixture.artifactStore.archive(artifactId); fixture.search.invalidate(); return value; },
            "artifact:restore": ({ artifactId }) => { const value = fixture.artifactStore.restore(artifactId); fixture.search.invalidate(); return value; },
        };
        uninstallProtocol = installAppProtocolHandler(); win = createMainWindow({ smoke: true }); unbind = bindIpcChannels({ win, handlers: fixtureHandlers });
        check("hidden Electron window stays hidden", win.isVisible() === false); await loadWindow(win);

        const initial = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P43 Quartz Needle Result",types:["artifacts"],status:"active",limit:10})`);
        const stats = fixture.search.diagnostics();
        const reduction = { ...stats, candidateReductionRatio: Number((1 - stats.candidateCount / Math.max(1, stats.corpusCount)).toFixed(4)), matchReductionRatio: Number((1 - stats.matchEvaluations / Math.max(1, stats.corpusCount)).toFixed(4)) };
        check("renderer Search finds the deep canonical Artifact", initial.results?.length === 1 && initial.results[0].id === targetId && initial.results[0].matchReason?.key === "title-exact" && !/(searchText|projectIds|storageRelativePath|sourceRelativePath|provider|session|token|secret)/i.test(JSON.stringify(initial)), { total: initial.total, ids: initial.results?.map((entry) => entry.id), matchReason: initial.results?.[0]?.matchReason });
        check("non-empty query narrows before matchFor without a full-corpus refinement pass", stats.indexed && stats.corpusCount >= 5_000 && stats.candidateCount <= 100 && stats.matchEvaluations <= 100 && stats.matchEvaluations <= stats.candidateCount, reduction);

        await invoke(win, `async()=>{document.getElementById("open-command-palette")?.click(); return true}`);
        await waitFor(async () => (await invoke(win, `async()=>document.querySelectorAll("#palette-results .command-palette-result").length`)) === 7, "Search palette");
        await invoke(win, `async()=>{const input=document.querySelector("#command-palette input[type=search]"); const type=document.getElementById("palette-type-filter"); type.value="artifacts"; type.dispatchEvent(new Event("change",{bubbles:true})); input.value="P43 Quartz Needle Result"; input.dispatchEvent(new Event("input",{bubbles:true})); return true}`);
        await waitFor(async () => (await invoke(win, `async()=>document.querySelectorAll("#palette-results .command-palette-result").length`)) === 1, "deep Artifact UI result");
        const ui = await invoke(win, `async()=>({title:document.querySelector("#palette-results .command-palette-result-title")?.textContent||"", subtitle:document.querySelector("#palette-results .command-palette-result-subtitle")?.textContent||""})`);
        check("Search UI uses the indexed query path and safe public projection", ui.title === "P43 Quartz Needle Result" && !/(searchText|projectIds|storageRelativePath|sourceRelativePath|provider|session|token|secret)/i.test(JSON.stringify(ui)), ui);

        await invoke(win, `async()=>window.sovereignbot.artifacts.archive({artifactId:${JSON.stringify(targetId)}})`);
        await waitFor(async () => fixture.artifactStore.indexRecords({ visibility: "active", limit: 5_000 }).artifacts.every((entry) => entry.id !== targetId), "archived deep Artifact");
        const archived = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P43 Quartz Needle Result",types:["artifacts"],status:"active",limit:10})`);
        const archivedVisible = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P43 Quartz Needle Result",types:["artifacts"],status:"archived",limit:10})`);
        check("archive invalidates indexed Search and preserves archived filtering", archived.results?.length === 0 && archivedVisible.results?.[0]?.id === targetId, { active: archived.results?.length, archived: archivedVisible.results?.[0]?.id });
        await invoke(win, `async()=>window.sovereignbot.artifacts.restore({artifactId:${JSON.stringify(targetId)}})`);
        await waitFor(async () => fixture.artifactStore.indexRecords({ visibility: "active", limit: 5_000 }).artifacts.some((entry) => entry.id === targetId), "restored deep Artifact");
        const restored = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P43 Quartz Needle Result",types:["artifacts"],status:"active",limit:10})`);
        check("restore rebuilds the indexed Search view", restored.results?.[0]?.id === targetId, { ids: restored.results?.map((entry) => entry.id) });

        const restartedStore = createArtifactStore({ dataDir });
        fixture.artifactStore = restartedStore;
        fixture.productSurfaces = createProductSurfaceService({ dataDir, teamService: fixture.teamService, coworkerStore: fixture.coworkerStore, artifactStore: restartedStore, runtime: {}, getRuntime: () => ({}) });
        fixture.search = createSearchService({ teamService: fixture.teamService, conversationStore: fixture.conversationStore, coworkerStore: fixture.coworkerStore, projectService: fixture.projectService, artifactStore: restartedStore, skillStore: fixture.skillStore, productSurfaces: fixture.productSurfaces, getRoutines: () => fixture.routines?.list?.(), memoryService: fixture.memoryService, getJobs: () => fixture.jobs, getHistory: () => ({ history: [] }) });
        unbind?.(); unbind = bindIpcChannels({ win, handlers: { ...handlers(fixture), "computer:history": () => ({ history: [] }), "job:list": () => ({ jobs: [] }), "job:attention": () => ({ jobs: [] }) } });
        await loadWindow(win);
        const afterRestart = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P43 Quartz Needle Result",types:["artifacts"],status:"active",limit:10})`);
        const restartStats = fixture.search.diagnostics();
        check("restart rebuilds the bounded Search index and keeps deep coverage", afterRestart.results?.[0]?.id === targetId && restartStats.corpusCount >= 5_000 && restartStats.matchEvaluations <= 100, { ids: afterRestart.results?.map((entry) => entry.id), stats: { ...restartStats, matchReductionRatio: Number((1 - restartStats.matchEvaluations / Math.max(1, restartStats.corpusCount)).toFixed(4)) } });
    } catch (error) {
        result.error = safeJson(error?.stack ?? error); check("P43 hidden Search index gate completed", false, error?.message ?? error);
    }
    result.ok = Object.values(checks).every((entry) => entry.ok);
    writeFileSync(join(EVIDENCE_DIR, "verify-p43-search-index.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    writeFileSync(join(EVIDENCE_DIR, "verify-p43-search-index.log"), `${notes.join("\n")}\n`, "utf8");
    try { unbind?.(); } catch {} try { uninstallProtocol?.(); } catch {} try { win?.destroy(); } catch {} try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {}
    if (!result.ok) { app?.exit(1); return; } app?.exit(0);
}
