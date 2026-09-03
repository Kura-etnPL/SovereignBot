// P42 hidden acceptance gate for indexed Artifact Hub and Search coverage.
// All records are local canonical artifacts.json metadata; no provider or
// network runtime is started and no managed files are copied for the scale set.
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

function metadata(id, { familyId = id, version = 1, title = `P42 artifact ${id}`, conversationId, coworkerId, createdAt = "2026-09-03T00:00:00.000Z" } = {}) {
  return {
    id, title, fileName: `${id}.md`, mimeType: "text/markdown", size: 1, sha256: "0".repeat(64),
    storageRelativePath: `${id}/${id}.md`, createdAt, artifactFamilyId: familyId, version,
    sourceKind: "coworker", published: true, archived: false,
    ...(conversationId ? { conversationId } : {}), ...(coworkerId ? { createdByCoworkerId: coworkerId } : {}),
  };
}

export async function runVerifyP42ArtifactIndex({ app } = {}) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const checks = {}; const notes = [];
  const safeJson = (value) => JSON.stringify(value).replace(/(?:[A-Za-z]:[\\/]|file:\/\/|https?:\/\/|workspacePath|storageRelativePath|sourceRelativePath|provider|account|session|credential|token|secret|password|cookie|cwd|path)/gi, "[redacted]").slice(0, 1_200);
  const check = (name, ok, detail = "") => { checks[name] = { ok: Boolean(ok), ...(detail ? { detail: safeJson(detail) } : {}) }; const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${safeJson(detail)}` : ""}`; notes.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
  const result = { schema: "sovereignbot.desktop.p42-artifact-index-canary.v1", fixtureBoundary: "LOCAL_FIXTURE", publishEligible: false, checks, notes, externalActions: [] };
  let dataDir; let fixture; let win; let unbind; let uninstallProtocol;
  try {
    dataDir = mkdtempSync(join(tmpdir(), "sovereign-p42-data-"));
    fixture = makeFixture(dataDir);
    const createdTeam = fixture.teamService.createTeam({ title: "P42 Indexed Artifact Team", coworkerIds: [fixture.chief.id, fixture.specialist.id], leadCoworkerId: fixture.chief.id });
    const targetConversationId = createdTeam.conversation.id;
    const targetChannelId = createdTeam.team.channels[0].id;
    const targetFamilyId = "artifact_0000000000000001";
    const targetId = "artifact_0000000000000001";
    const latestId = "artifact_0000000000000002";
    const artifacts = [
      metadata(targetId, { familyId: targetFamilyId, version: 1, title: "P42 Indexed Target Artifact", conversationId: targetConversationId, coworkerId: fixture.chief.id, createdAt: "2026-08-01T00:00:00.000Z" }),
      metadata(latestId, { familyId: targetFamilyId, version: 2, title: "P42 Indexed Target Artifact", conversationId: targetConversationId, coworkerId: fixture.chief.id, createdAt: "2026-08-01T00:00:01.000Z" }),
    ];
    for (let index = 3; index <= 620; index += 1) {
      const id = `artifact_${index.toString(16).padStart(16, "0")}`;
      artifacts.push(metadata(id, { title: `P42 Recent Unrelated ${index}`, createdAt: `2026-09-03T00:01:${String(index % 60).padStart(2, "0")}.000Z` }));
    }
    writeFileSync(join(dataDir, "desktop-state", "artifacts.json"), JSON.stringify({ schema: "sovereignbot.desktop.artifacts.v1", artifacts }), "utf8");
    fixture.artifactStore = createArtifactStore({ dataDir });
    fixture.productSurfaces = createProductSurfaceService({ dataDir, teamService: fixture.teamService, coworkerStore: fixture.coworkerStore, artifactStore: fixture.artifactStore, runtime: {}, getRuntime: () => ({}) });
    fixture.search = createSearchService({ teamService: fixture.teamService, conversationStore: fixture.conversationStore, coworkerStore: fixture.coworkerStore, projectService: fixture.projectService, artifactStore: fixture.artifactStore, skillStore: fixture.skillStore, productSurfaces: fixture.productSurfaces, getRoutines: () => fixture.routines?.list?.(), memoryService: fixture.memoryService, getJobs: () => fixture.jobs, getHistory: (payload) => fixture.productSurfaces.computerHistory(payload) });
    const baseHandlers = handlers(fixture);
    const fixtureHandlers = {
      ...baseHandlers,
      "artifact:archive": ({ artifactId }) => { const value = fixture.artifactStore.archive(artifactId); fixture.search.invalidate(); return value; },
      "artifact:restore": ({ artifactId }) => { const value = fixture.artifactStore.restore(artifactId); fixture.search.invalidate(); return value; },
      "artifact:restoreAsNewVersion": ({ artifactId }) => { const value = fixture.artifactStore.restoreAsNewVersion(artifactId); fixture.search.invalidate(); return value; },
    };
    uninstallProtocol = installAppProtocolHandler(); win = createMainWindow({ smoke: true }); unbind = bindIpcChannels({ win, handlers: fixtureHandlers });
    check("hidden Electron window stays hidden", win.isVisible() === false); await loadWindow(win);

    const indexed = fixture.artifactStore.indexRecords({ visibility: "all", limit: 5_000 }).artifacts;
    check("canonical ArtifactStore index covers 620 metadata records", indexed.length === 620 && indexed[0].id === latestId && indexed.at(-1).id === targetId, JSON.stringify({ count: indexed.length, first: indexed[0]?.id, last: indexed.at(-1)?.id }));
    check("indexed query rejects unbounded limits and arbitrary fields", (() => { try { fixture.artifactStore.indexRecords({ limit: 5_001 }); return false; } catch {} try { fixture.artifactStore.indexRecords({ predicate: "all" }); return false; } catch {} return true; })());

    const searchResult = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P42 Indexed Target Artifact",types:["artifacts"],status:"active",limit:10})`);
    check("renderer Search finds the old scoped Artifact outside the recent 500", searchResult.results?.some((entry) => entry.id === latestId) && searchResult.results?.length === 2 && !/(storageRelativePath|sourceRelativePath|workspacePath|provider|session|token|secret)/i.test(JSON.stringify(searchResult)), safeJson({ total: searchResult.total, ids: searchResult.results?.map((entry) => entry.id) }));

    await invoke(win, `async()=>{document.getElementById("nav-artifacts")?.click(); return true}`);
    await waitFor(async () => await invoke(win, `async()=>document.getElementById("view-artifacts")?.classList.contains("hidden")===false`), "Artifact page");
    await waitFor(async () => await invoke(win, `async()=>[...document.querySelectorAll("#artifact-hub-filter-page option")].some((option)=>option.value==="channel:${targetChannelId}")`), "target Channel scope");
    await invoke(win, `async()=>{const select=document.getElementById("artifact-hub-filter-page"); select.value=${JSON.stringify(`channel:${targetChannelId}`)}; select.dispatchEvent(new Event("change",{bubbles:true})); return true}`);
    await waitFor(async () => await invoke(win, `async()=>Boolean(document.querySelector('[data-artifact-id="${latestId}"]'))`), "scoped Artifact Hub card");
    const hub = await invoke(win, `async()=>({ cards:[...document.querySelectorAll("#product-artifacts-page [data-artifact-id]")].map((node)=>node.dataset.artifactId), body:document.getElementById("product-artifacts-page")?.textContent||"" })`);
    check("renderer Artifact Hub uses indexed Team/Channel candidates and latest family version", hub.cards.length === 1 && hub.cards[0] === latestId && /P42 Indexed Target Artifact/.test(hub.body), safeJson(hub));

    await invoke(win, `async()=>window.sovereignbot.artifacts.archive({artifactId:${JSON.stringify(latestId)}})`);
    await waitFor(async () => fixture.artifactStore.list({ visibility: "active" }).artifacts.every((entry) => entry.id !== targetId && entry.id !== latestId), "archived family");
    const archivedSearch = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P42 Indexed Target Artifact",types:["artifacts"],status:"active",limit:10})`);
    check("archive removes the indexed family from active Search", archivedSearch.results?.length === 0, JSON.stringify({ total: archivedSearch.total }));
    await invoke(win, `async()=>window.sovereignbot.artifacts.restore({artifactId:${JSON.stringify(latestId)}})`);
    await waitFor(async () => fixture.artifactStore.list({ visibility: "active" }).artifacts.some((entry) => entry.id === latestId), "restored family");
    const restoredSearch = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P42 Indexed Target Artifact",types:["artifacts"],status:"active",limit:10})`);
    check("restore reindexes the family without changing latest version", restoredSearch.results?.some((entry) => entry.id === latestId) && fixture.artifactStore.history(latestId).history.map((entry) => entry.version).join(",") === "2,1", JSON.stringify({ ids: restoredSearch.results?.map((entry) => entry.id), history: fixture.artifactStore.history(latestId).history.map((entry) => entry.version) }));

    const invalid = await invoke(win, `async()=>{const result={}; for(const [key,call] of Object.entries({hub:()=>window.sovereignbot.artifacts.hub({limit:501}),search:()=>window.sovereignbot.search.query({query:"x",limit:101})})){try{await call(); result[key]=false}catch(error){result[key]=Boolean(error?.message)}} return result}`);
    check("public Hub and Search limits remain fail-closed", invalid.hub && invalid.search, JSON.stringify(invalid));

    const restartedStore = createArtifactStore({ dataDir });
    fixture.artifactStore = restartedStore;
    fixture.productSurfaces = createProductSurfaceService({ dataDir, teamService: fixture.teamService, coworkerStore: fixture.coworkerStore, artifactStore: restartedStore, runtime: {}, getRuntime: () => ({}) });
    fixture.search = createSearchService({ teamService: fixture.teamService, conversationStore: fixture.conversationStore, coworkerStore: fixture.coworkerStore, projectService: fixture.projectService, artifactStore: restartedStore, skillStore: fixture.skillStore, productSurfaces: fixture.productSurfaces, getRoutines: () => fixture.routines?.list?.(), memoryService: fixture.memoryService, getJobs: () => fixture.jobs, getHistory: (payload) => fixture.productSurfaces.computerHistory(payload) });
    unbind?.(); unbind = bindIpcChannels({ win, handlers: { ...handlers(fixture), "artifact:archive": ({ artifactId }) => { const value = restartedStore.archive(artifactId); fixture.search.invalidate(); return value; }, "artifact:restore": ({ artifactId }) => { const value = restartedStore.restore(artifactId); fixture.search.invalidate(); return value; } } });
    await loadWindow(win);
    const afterRestart = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P42 Indexed Target Artifact",types:["artifacts"],status:"active",limit:10})`);
    const restartedHub = await invoke(win, `async()=>window.sovereignbot.artifacts.hub({teamId:${JSON.stringify(createdTeam.team.id)},channelId:${JSON.stringify(targetChannelId)},limit:10})`);
    check("restart rebuilds the index and preserves scoped Hub/Search coverage", afterRestart.results?.some((entry) => entry.id === latestId) && restartedHub.artifacts?.length === 1 && restartedHub.artifacts[0].id === latestId && restartedStore.indexRecords({ visibility: "all", limit: 5_000 }).artifacts.length === 620, JSON.stringify({ searchIds: afterRestart.results?.map((entry) => entry.id), hubIds: restartedHub.artifacts?.map((entry) => entry.id), count: restartedStore.indexRecords({ visibility: "all", limit: 5_000 }).artifacts.length }));
  } catch (error) { result.error = safeJson(error?.stack ?? error); check("P42 hidden Artifact index gate completed", false, error?.message ?? error); }
  result.ok = Object.values(checks).every((entry) => entry.ok);
  mkdirSync(EVIDENCE_DIR, { recursive: true }); writeFileSync(join(EVIDENCE_DIR, "verify-p42-artifact-index.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8"); writeFileSync(join(EVIDENCE_DIR, "verify-p42-artifact-index.log"), `${notes.join("\n")}\n`, "utf8");
  try { unbind?.(); } catch {} try { uninstallProtocol?.(); } catch {} try { win?.destroy(); } catch {} try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {}
  if (!result.ok) { app?.exit(1); return; } app?.exit(0);
}
