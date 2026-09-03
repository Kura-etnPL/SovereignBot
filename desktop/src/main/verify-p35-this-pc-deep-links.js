// P35 hidden acceptance gate for the ordinary This PC surface and its safe
// artifact/history deep links. The fixture is local and isolated; no provider,
// browser, login, user data, or real Computer driver is started.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeFixture, handlers, loadWindow, invoke } from "./verify-p15-project-command-center.js";
import { createMainWindow } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(process.cwd(), "..", "_evidence_p35_2026-09-03");
const PROJECT_ID = "project_aaaaaaaaaaaaaaaa";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15_000) { const started = Date.now(); while (Date.now() - started < timeout) { if (await check()) return; await sleep(100); } throw new Error(`timed out waiting for ${label}`); }

export async function runVerifyP35ThisPcDeepLinks({ app }) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const checks = {}; const log = []; const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} }; const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };
  let dataDir; let fixture; let win; let unbind; let uninstallProtocol; let fatal; let mode = "ready"; const artifactCalls = []; const historyCalls = [];
  try {
    dataDir = mkdtempSync(join(tmpdir(), "sovereign-p35-data-")); fixture = makeFixture(dataDir);
    const coworkerId = fixture.chief.id;
    const targetArtifact = { id: "artifact_aaaaaaaaaaaaaaaa", title: "P35 Coworker result", fileName: "p35-result.md", mimeType: "text/markdown", size: 12, version: 1, creator: { name: "P35 Chief" }, status: "available" };
    const unrelatedArtifact = { id: "artifact_bbbbbbbbbbbbbbbb", title: "Unrelated result", fileName: "other.md", mimeType: "text/markdown", size: 10, version: 1, creator: { name: "Other Coworker" }, status: "available" };
    const appHandlers = {
      ...handlers(fixture),
      "project:list": () => ({ projects: [{ projectId: PROJECT_ID, name: "P35 This PC Project", state: "active" }] }),
      "thisPc:list": ({ projectId }) => {
        if (mode === "error") throw new Error("This PC fixture unavailable");
        if (mode === "empty") return { schema: "sovereignbot.desktop.this-pc.v1", projectId, computers: [] };
        return { schema: "sovereignbot.desktop.this-pc.v1", projectId, computers: [{ coworkerId, coworkerName: "P35 Chief", status: "working", statusMessage: "Working on this Project.", health: { status: "ready", message: "Computer is ready." }, context: { kind: "shared", label: "Shared context / 共享上下文", detail: "Shared Coworkers take turns in this Project." }, currentWork: "P35 local deep-link fixture", currentApp: "Web browser", currentSite: "example.test", canTakeOver: false, canHandBack: false, artifacts: [targetArtifact], history: [{ activity: "snapshot", status: "completed" }] }] };
      },
      "artifact:hub": (payload = {}) => { artifactCalls.push(payload); return { artifacts: payload.coworkerId === coworkerId ? [targetArtifact] : [targetArtifact, unrelatedArtifact] }; },
      "computer:history": (payload = {}) => { historyCalls.push(payload); return { history: payload.coworkerId === coworkerId ? [{ id: "history_aaaaaaaaaaaaaaaa", coworkerId, activity: "P35 snapshot", eventType: "computer.snapshot", source: "computer", summary: "P35 safe snapshot", app: "Web browser", site: "example.test", timestamp: "2026-09-03T00:00:00.000Z", status: "completed" }] : [{ id: "history_aaaaaaaaaaaaaaaa", coworkerId, activity: "P35 snapshot", eventType: "computer.snapshot", source: "computer", summary: "P35 safe snapshot", app: "Web browser", site: "example.test", timestamp: "2026-09-03T00:00:00.000Z", status: "completed" }, { id: "history_bbbbbbbbbbbbbbbb", coworkerId: "coworker_other_0001", activity: "Other snapshot", eventType: "computer.snapshot", source: "computer", summary: "Other safe snapshot", status: "completed" }] }; },
    };
    uninstallProtocol = installAppProtocolHandler(); win = createMainWindow({ smoke: true }); unbind = bindIpcChannels({ win, handlers: appHandlers });
    check("hidden Electron window stays hidden", win.isVisible() === false); await loadWindow(win);
    const surface = await invoke(win, "async()=>({nav:!!document.getElementById('nav-this-pc'),view:!!document.getElementById('view-this-pc'),project:!!document.getElementById('this-pc-project'),list:!!document.getElementById('this-pc-list'),api:typeof window.sovereignbot?.thisPc?.list})");
    check("ordinary This PC entry exposes the bounded public surface", surface.nav && surface.view && surface.project && surface.list && surface.api === "function", JSON.stringify(surface));
    await invoke(win, "async()=>{document.getElementById('nav-this-pc')?.click(); return true}");
    await waitFor(async () => await invoke(win, "async()=>document.querySelectorAll('#this-pc-list .this-pc-card').length === 1"), "This PC card");
    const initial = await invoke(win, "async()=>({body:document.getElementById('view-this-pc')?.innerText||'',status:document.querySelector('.this-pc-status')?.innerText||''})");
    check("This PC renders safe status, app/site, context, and artifact/activity actions", /Working|工作中/.test(initial.status) && /Web browser|example\.test|Shared context|Open artifacts|Open activity/.test(initial.body), JSON.stringify(initial));
    check("This PC renderer projection contains no raw Computer internals", !/(agent-|driver|coordinate|profile path|session|token|C:\\|workspacePath|lease)/i.test(initial.body), initial.body.slice(0, 1200));

    await invoke(win, "async()=>{[...document.querySelectorAll('#this-pc-list button')].find((node)=>/Open activity/.test(node.textContent))?.click(); return true}");
    await waitFor(async () => await invoke(win, "async()=>document.getElementById('view-computer-history')?.classList.contains('hidden')===false && document.getElementById('computer-history-filter-page')?.value && document.getElementById('product-computer-history-page')?.innerText.includes('P35 safe snapshot')"), "Computer History deep link");
    const historyUi = await invoke(win, "async()=>({filter:document.getElementById('computer-history-filter-page')?.value||'',notice:document.getElementById('product-computer-history-deeplink-status')?.textContent||'',body:document.getElementById('product-computer-history-page')?.innerText||''})");
    check("This PC activity deep link preserves the Coworker filter and visible scope", historyUi.filter === coworkerId && /Showing activity for this Coworker/.test(historyUi.notice) && /P35 safe snapshot/.test(historyUi.body) && !/Other safe snapshot/.test(historyUi.body), JSON.stringify(historyUi));
    check("Computer History receives only the selected opaque Coworker id", historyCalls.some((payload) => payload.coworkerId === coworkerId) && historyCalls.every((payload) => !Object.hasOwn(payload, "agentId")), JSON.stringify(historyCalls));

    await invoke(win, "async()=>{document.getElementById('nav-this-pc')?.click(); return true}"); await waitFor(async () => await invoke(win, "async()=>document.querySelectorAll('#this-pc-list .this-pc-card').length === 1"), "This PC return");
    await invoke(win, "async()=>{[...document.querySelectorAll('#this-pc-list button')].find((node)=>/Open artifacts/.test(node.textContent))?.click(); return true}");
    await waitFor(async () => await invoke(win, "async()=>document.getElementById('view-artifacts')?.classList.contains('hidden')===false && document.getElementById('product-artifacts-page')?.innerText.includes('P35 Coworker result') && !document.getElementById('product-artifacts-page')?.innerText.includes('Unrelated result')"), "Artifacts deep link");
    const artifactUi = await invoke(win, "async()=>({filter:document.getElementById('artifact-hub-filter-page')?.value||'',notice:document.getElementById('product-artifacts-deeplink-status')?.textContent||'',body:document.getElementById('product-artifacts-page')?.innerText||''})");
    check("This PC artifact deep link preserves the Coworker filter and visible scope", artifactUi.filter === `coworker:${coworkerId}` && /Showing artifacts created by this Coworker/.test(artifactUi.notice) && /P35 Coworker result/.test(artifactUi.body) && !/Unrelated result/.test(artifactUi.body), JSON.stringify(artifactUi));
    check("Artifact Hub receives the selected opaque Coworker id", artifactCalls.some((payload) => payload.coworkerId === coworkerId) && artifactCalls.every((payload) => !Object.hasOwn(payload, "agentId")), JSON.stringify(artifactCalls));

    mode = "empty"; await invoke(win, "async()=>{document.getElementById('nav-this-pc')?.click(); return true}"); await waitFor(async () => await invoke(win, "async()=>document.getElementById('this-pc-list')?.innerText.includes('No active Coworkers')"), "empty This PC state");
    check("This PC empty state is understandable and non-destructive", /No active Coworkers/.test(await invoke(win, "async()=>document.getElementById('this-pc-list')?.innerText||''")));
    mode = "error"; await invoke(win, "async()=>{document.getElementById('this-pc-refresh')?.click(); return true}"); await waitFor(async () => await invoke(win, "async()=>/fixture unavailable/.test(document.getElementById('this-pc-result')?.innerText||'')"), "This PC failure state");
    check("This PC failure state stays in-product", /fixture unavailable/.test(await invoke(win, "async()=>document.getElementById('this-pc-result')?.innerText||''")));
    mode = "ready"; unbind(); unbind = bindIpcChannels({ win, handlers: appHandlers }); await loadWindow(win); await invoke(win, "async()=>{document.getElementById('nav-this-pc')?.click(); return true}"); await waitFor(async () => await invoke(win, "async()=>document.querySelectorAll('#this-pc-list .this-pc-card').length === 1"), "restarted This PC");
    check("ordinary This PC entry survives a renderer/service restart", await invoke(win, "async()=>document.getElementById('view-this-pc')?.classList.contains('hidden')===false"));
  } catch (error) { fatal = error; note(`[fatal] ${String(error?.stack ?? error)}`); check("P35 hidden gate runner completed", false, String(error?.message ?? error)); }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name); note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`); writeFileSync(join(EVIDENCE_DIR, "verify-p35-this-pc-deep-links.json"), `${JSON.stringify({ at: new Date().toISOString(), publishEligible: false, checks, fatal: fatal ? String(fatal?.message ?? fatal) : undefined }, null, 2)}\n`, "utf8"); writeFileSync(join(EVIDENCE_DIR, "verify-p35-this-pc-deep-links.log"), `${log.join("\n")}\n`, "utf8"); try { unbind?.(); } catch {} try { uninstallProtocol?.(); } catch {} try { win?.destroy(); } catch {} try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {} if (fatal || failed.length) { app.exit(1); return; } app.exit(0);
}
