// P38 hidden acceptance gate for deterministic local Search relevance and UI reasons.
// Fixture data is task-owned; no provider, login, network, or user data is used.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { makeFixture, handlers, loadWindow, invoke } from "./verify-p15-project-command-center.js";
import { createSearchService } from "./search-service.js";
import { createMainWindow } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(WORKTREE_ROOT, "docs", "acceptance");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15_000) { const started = Date.now(); while (Date.now() - started < timeout) { if (await check()) return; await sleep(100); } throw new Error(`timed out waiting for ${label}`); }

export async function runVerifyP38SearchRelevance({ app } = {}) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const checks = {};
  const notes = [];
  const check = (name, ok, detail = "") => { checks[name] = { ok: Boolean(ok), ...(detail ? { detail } : {}) }; const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`; notes.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
  const safeJson = (value) => JSON.stringify(value).replace(/(?:[A-Za-z]:[\\/]|file:\/\/|https?:\/\/|workspacePath|searchText|projectIds|credential|session|provider|account|token|secret|password|cookie)/gi, "[redacted]");
  const result = { schema: "sovereignbot.desktop.p38-search-relevance-canary.v1", fixtureBoundary: "LOCAL_FIXTURE", publishEligible: false, checks, notes, externalActions: [] };
  let dataDir;
  let fixture;
  let win;
  let unbind;
  let uninstallProtocol;
  try {
    dataDir = mkdtempSync(join(tmpdir(), "sovereign-p38-data-"));
    fixture = makeFixture(dataDir);
    const project = await fixture.projectService.create({ name: "P38 Local Search Project" });
    const fact = await fixture.memoryService.putFact({ scope: "project", ownerId: project.projectId, draft: { title: "P38 Tag Memory", content: "Unrelated body text", tags: ["p38-launch"] }, label: "P38 approved local fact" });
    const team = fixture.teamService.createTeam({ title: "P38 Search Team", coworkerIds: [fixture.chief.id, fixture.specialist.id] }).team;
    const conversationId = team.channels?.[0]?.conversationId;
    const workspacePath = fixture.services.workspacePath(fixture.sharedWorkspaceId);
    mkdirSync(join(workspacePath, "p38"), { recursive: true });
    writeFileSync(join(workspacePath, "p38", "archived.txt"), "P38 archived artifact\n", "utf8");
    const artifact = fixture.artifactStore.ingestWorkspaceFile({ workspaceId: fixture.sharedWorkspaceId, workspacePath, relativePath: "p38/archived.txt", title: "P38 Archived Artifact", createdByCoworkerId: fixture.chief.id, conversationId });
    fixture.artifactStore.archive(artifact.id);
    fixture.search.invalidate();
    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
    check("hidden Electron window stays hidden", win.isVisible() === false);
    await loadWindow(win);

    const phrase = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P38 Local Search Project",types:["projects"],status:"active",limit:10})`);
    check("title phrase ranks the exact local Project", phrase.results?.[0]?.id === project.projectId && phrase.results?.[0]?.matchReason?.key === "title-exact", safeJson({ id: phrase.results?.[0]?.id, matchReason: phrase.results?.[0]?.matchReason }));
    const tag = await invoke(win, `async()=>window.sovereignbot.search.query({query:"p38-launch",types:["memory"],status:"active",limit:10})`);
    const tagResult = tag.results?.find((entry) => entry.id === fact.id);
    check("Memory tags rank as structured tag matches", tagResult?.matchReason?.key === "tags" && tagResult.matchReason.fields.join(",") === "tags", safeJson({ id: tagResult?.id, matchReason: tagResult?.matchReason }));
    check("public result strips internal search fields", tagResult && !Object.hasOwn(tagResult, "searchText") && !Object.hasOwn(tagResult, "projectIds") && !Object.hasOwn(tagResult, "tags") && !/p38-launch|Unrelated body text/i.test(JSON.stringify(tagResult)), safeJson(tagResult));
    const archivedActive = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P38 Archived Artifact",types:["artifacts"],status:"active",limit:10})`);
    const archivedVisible = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P38 Archived Artifact",types:["artifacts"],status:"archived",limit:10})`);
    check("status filtering keeps archived artifacts out of active results", archivedActive.results?.length === 0 && archivedVisible.results?.[0]?.id === artifact.id, safeJson({ active: archivedActive.results?.length, archived: archivedVisible.results?.[0]?.id, store: fixture.artifactStore.list({ visibility: "all" }).artifacts.map((entry) => ({ id: entry.id, title: entry.title, archived: entry.archived })) }));
    const weak = await invoke(win, `async()=>window.sovereignbot.search.query({query:"workspace missing",types:["history"],status:"active",limit:10})`);
    check("weak partial content matches are filtered", weak.results?.length === 0, safeJson({ total: weak.total }));
    const firstOrder = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P38",types:["projects","memory"],status:"all",limit:100})`);
    const secondOrder = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P38",types:["projects","memory"],status:"all",limit:100})`);
    check("ranking and match reasons are deterministic", JSON.stringify(firstOrder.results) === JSON.stringify(secondOrder.results), safeJson(firstOrder.results?.map((entry) => ({ id: entry.id, score: entry.score, matchReason: entry.matchReason }))));
    check("bounded pagination contract remains intact", firstOrder.total >= firstOrder.results.length && firstOrder.hasMore === false, safeJson({ total: firstOrder.total, count: firstOrder.results.length, hasMore: firstOrder.hasMore }));

    await invoke(win, `async()=>{document.getElementById("open-command-palette")?.click(); return true}`);
    await waitFor(async () => (await invoke(win, `async()=>document.querySelectorAll("#palette-results .command-palette-result").length`)) === 7, "palette commands");
    await invoke(win, `async()=>{const input=document.querySelector("#command-palette input[type=search]"); const type=document.getElementById("palette-type-filter"); type.value="memory"; type.dispatchEvent(new Event("change",{bubbles:true})); input.value="p38-launch"; input.dispatchEvent(new Event("input",{bubbles:true})); return true}`);
    await waitFor(async () => (await invoke(win, `async()=>document.querySelectorAll("#palette-results .command-palette-result").length`)) === 1, "tag result");
    const uiTag = await invoke(win, `async()=>({ title:document.querySelector("#palette-results .command-palette-result-title")?.textContent||"", subtitle:document.querySelector("#palette-results .command-palette-result-subtitle")?.textContent||"" })`);
    check("UI renders the safe bilingual tag match reason", /Tag match|标签匹配/.test(uiTag.subtitle) && !/p38-launch|Unrelated body/i.test(uiTag.subtitle), safeJson(uiTag));
    await invoke(win, `async()=>{const input=document.querySelector("#command-palette input[type=search]"); const type=document.getElementById("palette-type-filter"); type.value="projects"; type.dispatchEvent(new Event("change",{bubbles:true})); input.value="P38 Local Search Project"; input.dispatchEvent(new Event("input",{bubbles:true})); return true}`);
    await waitFor(async () => (await invoke(win, `async()=>document.querySelectorAll("#palette-results .command-palette-result").length`)) === 1, "project result");
    await invoke(win, `async()=>{document.querySelector("#command-palette input[type=search]")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})); return true}`);
    await waitFor(async () => await invoke(win, `async()=>document.getElementById("view-projects")?.classList.contains("hidden")===false`), "project navigation");
    check("keyboard Enter preserves exact search navigation", await invoke(win, `async()=>document.getElementById("view-projects")?.classList.contains("hidden")===false`));

    const restartedSearch = createSearchService({ teamService: fixture.teamService, conversationStore: fixture.conversationStore, coworkerStore: fixture.coworkerStore, projectService: fixture.projectService, artifactStore: fixture.artifactStore, skillStore: fixture.skillStore, productSurfaces: fixture.productSurfaces, getRoutines: () => fixture.routines.list(), memoryService: fixture.memoryService, getJobs: () => fixture.jobs, getHistory: (payload) => fixture.productSurfaces.computerHistory(payload) });
    unbind?.();
    unbind = bindIpcChannels({ win, handlers: { ...handlers(fixture), "search:query": (payload) => restartedSearch.query(payload) } });
    await loadWindow(win);
    const afterRestart = await invoke(win, `async()=>window.sovereignbot.search.query({query:"p38-launch",types:["memory"],status:"active",limit:10})`);
    check("local search index rebuilds after a real renderer/service restart", afterRestart.results?.[0]?.id === fact.id && afterRestart.results?.[0]?.matchReason?.key === "tags", safeJson({ id: afterRestart.results?.[0]?.id, matchReason: afterRestart.results?.[0]?.matchReason }));
  } catch (error) {
    result.error = String(error?.stack ?? error).slice(0, 4000);
    check("P38 hidden Search gate completed", false, String(error?.message ?? error).slice(0, 500));
  }
  result.ok = Object.values(checks).every((entry) => entry.ok);
  writeFileSync(join(EVIDENCE_DIR, "verify-p38-search-relevance.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(join(EVIDENCE_DIR, "verify-p38-search-relevance.log"), `${notes.join("\n")}\n`, "utf8");
  try { unbind?.(); } catch {}
  try { uninstallProtocol?.(); } catch {}
  try { win?.destroy(); } catch {}
  try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {}
  if (!result.ok) { app?.exit(1); return; }
  app?.exit(0);
}
