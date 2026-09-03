// P40 hidden acceptance gate for bounded, scope-aware local Memory relevance.
// Only task-owned fixtures, the real app protocol, preload, validated IPC and
// canonical MemoryStore persistence are used; no provider or network is started.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeFixture, handlers, loadWindow, invoke } from "./verify-p15-project-command-center.js";
import { MemoryStore } from "../../../src/memory.js";
import { createMemoryService } from "./memory-service.js";
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

export async function runVerifyP40MemoryRelevance({ app } = {}) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const checks = {}; const notes = [];
  const safeJson = (value) => JSON.stringify(value).replace(/(?:[A-Za-z]:[\\/]|file:\/\/|https?:\/\/|workspacePath|provider|account|session|credential|token|secret|password|cookie|cwd|path)/gi, "[redacted]");
  const check = (name, ok, detail = "") => { checks[name] = { ok: Boolean(ok), ...(detail ? { detail } : {}) }; const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`; notes.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
  const result = { schema: "sovereignbot.desktop.p40-memory-relevance-canary.v1", fixtureBoundary: "LOCAL_FIXTURE", publishEligible: false, checks, notes, externalActions: [] };
  let dataDir; let fixture; let win; let unbind; let uninstallProtocol;
  try {
    dataDir = mkdtempSync(join(tmpdir(), "sovereign-p40-data-"));
    fixture = makeFixture(dataDir);
    const project = await fixture.projectService.create({ name: "P40 Memory Project" });
    const exact = await fixture.memoryService.putFact({ scope: "project", ownerId: project.projectId, draft: { title: "Release Checklist", content: "Deploy safely after review.", tags: ["operations", "release"] }, label: "P40 local fact" });
    await fixture.memoryService.putFact({ scope: "project", ownerId: project.projectId, draft: { title: "Release Playbook", content: "General release workflow.", tags: ["release"] }, label: "P40 local fact" });
    await fixture.memoryService.putFact({ scope: "project", ownerId: project.projectId, draft: { title: "Pinned Release Note", content: "Small operational reminder.", tags: ["release"] }, label: "P40 local fact" });
    const forgotten = await fixture.memoryService.putFact({ scope: "project", ownerId: project.projectId, draft: { title: "Forgotten Release Note", content: "Old release note.", tags: ["release"] }, label: "P40 local fact" });
    await fixture.memoryService.pin({ scope: "project", ownerId: project.projectId, memoryId: (await fixture.memoryService.list({ scope: "project", ownerId: project.projectId, query: "pinned release note" })).memories[0].id, pinned: true });
    await fixture.memoryService.forget({ scope: "project", ownerId: project.projectId, memoryId: forgotten.id });
    const privateFact = await fixture.memoryService.putFact({ scope: "coworker", ownerId: fixture.chief.id, draft: { title: "Release Checklist", content: "Private copy only.", tags: ["operations"] }, label: "P40 local fact" });

    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
    check("hidden Electron window stays hidden", win.isVisible() === false);
    await loadWindow(win);
    const surface = await invoke(win, `async()=>({memoryList:typeof window.sovereignbot?.memory?.list,nav:!!document.getElementById("nav-memory"),list:!!document.getElementById("memory-list"),reason:!!document.querySelector("#memory-result")})`);
    check("real renderer exposes the Memory surface", surface.memoryList === "function" && surface.nav && surface.list && surface.reason, safeJson(surface));

    const exactResult = await invoke(win, `async()=>window.sovereignbot.memory.list({scope:"project",ownerId:${JSON.stringify(project.projectId)},query:"release checklist",limit:10})`);
    check("exact key/title and phrase ranking stay scope-bound", exactResult.resultCount === 1 && exactResult.memories?.[0]?.id === exact.id && ["key-exact", "title-exact"].includes(exactResult.memories?.[0]?.matchReason?.key), safeJson({ count: exactResult.resultCount, id: exactResult.memories?.[0]?.id, reason: exactResult.memories?.[0]?.matchReason }));
    const tagResult = await invoke(win, `async()=>window.sovereignbot.memory.list({scope:"project",ownerId:${JSON.stringify(project.projectId)},query:"operations",limit:10})`);
    const phraseResult = await invoke(win, `async()=>window.sovereignbot.memory.list({scope:"project",ownerId:${JSON.stringify(project.projectId)},query:"deploy safely",limit:10})`);
    check("tag and content phrase reasons are explicit", tagResult.memories?.[0]?.matchReason?.key === "tags" && phraseResult.memories?.[0]?.id === exact.id && phraseResult.memories?.[0]?.matchReason?.key === "phrase", safeJson({ tag: tagResult.memories?.[0]?.matchReason, phrase: phraseResult.memories?.[0]?.matchReason }));
    const emptyResult = await invoke(win, `async()=>window.sovereignbot.memory.list({scope:"project",ownerId:${JSON.stringify(project.projectId)},query:"",limit:2})`);
    check("empty query is bounded and pinned-first", emptyResult.resultCount === 2 && emptyResult.memories?.[0]?.title === "Pinned Release Note", safeJson({ count: emptyResult.resultCount, titles: emptyResult.memories?.map((entry)=>entry.title) }));
    const privateResult = await invoke(win, `async()=>window.sovereignbot.memory.list({scope:"coworker",ownerId:${JSON.stringify(fixture.chief.id)},query:"release checklist",limit:10})`);
    check("coworker and Project memory remain isolated", privateResult.resultCount === 1 && privateResult.memories?.[0]?.id === privateFact.id && exactResult.memories?.every((entry)=>entry.id !== privateFact.id), safeJson({ private: privateResult.memories?.map((entry)=>entry.id), project: exactResult.memories?.map((entry)=>entry.id) }));
    const forgottenHidden = await invoke(win, `async()=>window.sovereignbot.memory.list({scope:"project",ownerId:${JSON.stringify(project.projectId)},query:"forgotten release",limit:10})`);
    const forgottenVisible = await invoke(win, `async()=>window.sovereignbot.memory.list({scope:"project",ownerId:${JSON.stringify(project.projectId)},query:"forgotten release",limit:10,includeForgotten:true})`);
    check("forgotten and deleted records stay hidden by default", forgottenHidden.resultCount === 0 && forgottenVisible.resultCount === 1 && forgottenVisible.memories?.[0]?.id === forgotten.id && forgottenVisible.memories?.[0]?.state === "forgotten", safeJson({ hidden: forgottenHidden.resultCount, visible: forgottenVisible.memories?.map((entry)=>({ id: entry.id, state: entry.state })) }));
    const invalid = await invoke(win, `async()=>{const cases=[{scope:"project",ownerId:${JSON.stringify(project.projectId)},query:"x".repeat(301)},{scope:"project",ownerId:${JSON.stringify(project.projectId)},query:"x",limit:101},{scope:"project",ownerId:${JSON.stringify(project.projectId)},query:42},{scope:"project",ownerId:${JSON.stringify(project.projectId)},query:"x",includeForgotten:"yes"}]; const rejected=[]; for(const payload of cases){try{await window.sovereignbot.memory.list(payload); rejected.push(false)}catch(error){rejected.push(Boolean(error?.message))}} return rejected}`);
    check("query, limit, and includeForgotten boundaries fail closed", invalid.every(Boolean), safeJson(invalid));
    check("public Memory result contains only safe match metadata", !/(provider|account|session|credential|token|secret|password|cookie|cwd|path)/i.test(JSON.stringify(exactResult)) && !Object.hasOwn(exactResult.memories?.[0] ?? {}, "score"), safeJson(Object.keys(exactResult.memories?.[0] ?? {})));

    await invoke(win, `async()=>{document.getElementById("nav-memory")?.click(); return true}`);
    await waitFor(async () => await invoke(win, `async()=>document.querySelectorAll("#memory-owner option").length>0`), "Memory owners");
    await invoke(win, `async()=>{const scope=document.getElementById("memory-scope"); scope.value="project"; scope.dispatchEvent(new Event("change",{bubbles:true})); return true}`);
    await waitFor(async () => await invoke(win, `async()=>[...document.querySelectorAll("#memory-owner option")].some((entry)=>entry.value===${JSON.stringify(project.projectId)})`), "Project Memory owner");
    await invoke(win, `async()=>{const owner=document.getElementById("memory-owner"); owner.value=${JSON.stringify(project.projectId)}; owner.dispatchEvent(new Event("change",{bubbles:true})); const input=document.getElementById("memory-search"); input.value="operations"; input.dispatchEvent(new Event("input",{bubbles:true})); return true}`);
    await waitFor(async () => await invoke(win, `async()=>{const rows=[...document.querySelectorAll("#memory-list .memory-row")]; const result=document.getElementById("memory-result")?.textContent||""; const reasons=rows.map((row)=>row.querySelector(".memory-match-reason")?.textContent||""); const titles=rows.map((row)=>row.querySelector("h3")?.textContent||""); return rows.length===1 && /1 matches|1 条匹配/.test(result) && titles.includes("Release Checklist") && reasons.some((reason)=>/Tag match|标签匹配/.test(reason))}`), "Memory UI tag results");
    const ui = await invoke(win, `async()=>({result:document.getElementById("memory-result")?.textContent||"",reasons:[...document.querySelectorAll("#memory-list .memory-match-reason")].map((entry)=>entry.textContent),titles:[...document.querySelectorAll("#memory-list h3")].map((entry)=>entry.textContent)})`);
    check("Memory UI renders bilingual safe reason and result count", /matches|匹配/.test(ui.result) && ui.reasons.some((entry)=>/Tag match|标签匹配/.test(entry)) && !/operations|Private copy|path|token/i.test(JSON.stringify(ui)), safeJson(ui));

    const restarted = createMemoryService({ runtime: { memory: new MemoryStore(join(dataDir, "desktop-state", "memory.jsonl")) }, services: fixture.services, coworkerStore: fixture.coworkerStore, teamService: fixture.teamService, conversationStore: fixture.conversationStore, artifactStore: fixture.artifactStore, projectResolver: (id) => fixture.projectService.resolveProject(id) });
    unbind?.(); unbind = bindIpcChannels({ win, handlers: { ...handlers(fixture), "memory:list": (payload) => restarted.list(payload) } });
    await loadWindow(win);
    const afterRestart = await invoke(win, `async()=>window.sovereignbot.memory.list({scope:"project",ownerId:${JSON.stringify(project.projectId)},query:"release",limit:10,includeForgotten:true})`);
    const stable = afterRestart.memories?.map((entry) => ({ id: entry.id, reason: entry.matchReason })) ?? [];
    const again = await invoke(win, `async()=>window.sovereignbot.memory.list({scope:"project",ownerId:${JSON.stringify(project.projectId)},query:"release",limit:10,includeForgotten:true})`);
    check("ranking, reasons, and forgotten visibility survive service restart", JSON.stringify(stable) === JSON.stringify(again.memories?.map((entry) => ({ id: entry.id, reason: entry.matchReason })) ?? []) && afterRestart.memories?.some((entry)=>entry.id===forgotten.id), safeJson(stable));
  } catch (error) {
    result.error = String(error?.stack ?? error).slice(0, 4000);
    check("P40 hidden Memory gate completed", false, String(error?.message ?? error).slice(0, 500));
  }
  result.ok = Object.values(checks).every((entry) => entry.ok);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(EVIDENCE_DIR, "verify-p40-memory-relevance.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(join(EVIDENCE_DIR, "verify-p40-memory-relevance.log"), `${notes.join("\n")}\n`, "utf8");
  try { unbind?.(); } catch {}
  try { uninstallProtocol?.(); } catch {}
  try { win?.destroy(); } catch {}
  try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {}
  if (!result.ok) { app?.exit(1); return; }
  app?.exit(0);
}
