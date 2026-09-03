// P41 hidden acceptance gate for a bounded large Coworker roster.
// The gate uses the real hidden Electron window, sandboxed preload, validated
// IPC and canonical local stores. It never starts a provider or network runtime.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeFixture, handlers, loadWindow, invoke } from "./verify-p15-project-command-center.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createMainWindow } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(process.cwd(), "..", "docs", "acceptance");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export async function runVerifyP41CoworkerRoster({ app } = {}) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const checks = {};
  const notes = [];
  const safe = (value) => String(value ?? "").replace(/(?:[A-Za-z]:[\\/]|file:\/\/|https?:\/\/|workspacePath|provider|account|session|credential|token|secret|password|cookie|cwd|path)/gi, "[redacted]").slice(0, 700);
  const check = (name, ok, detail = "") => {
    checks[name] = { ok: Boolean(ok), ...(detail ? { detail: safe(detail) } : {}) };
    const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${safe(detail)}` : ""}`;
    notes.push(line);
    try { process.stderr.write(`${line}\n`); } catch {}
  };
  const result = {
    schema: "sovereignbot.desktop.p41-coworker-roster-canary.v1",
    fixtureBoundary: "LOCAL_FIXTURE",
    publishEligible: false,
    checks,
    notes,
    externalActions: [],
  };
  let dataDir;
  let fixture;
  let win;
  let unbind;
  let uninstallProtocol;
  try {
    dataDir = mkdtempSync(join(tmpdir(), "sovereign-p41-data-"));
    fixture = makeFixture(dataDir);
    const extras = [];
    for (let index = 0; index < 52; index += 1) {
      extras.push(fixture.coworkerStore.create({
        name: index === 49 ? "P41 Remote Search Target" : `P41 Roster ${String(index).padStart(2, "0")}`,
        role: index === 49 ? "Remote search specialist" : "Roster specialist",
        instructions: "Remain inside the local P41 fixture.",
        state: index === 51 ? "paused" : "active",
      }));
    }
    const target = extras[49];
    const readyId = extras[0].id;
    fixture.conversationStore.createDirect(target.id);
    const team = fixture.teamService.createTeam({ title: "P41 Roster Work Team", coworkerIds: [fixture.chief.id, fixture.specialist.id, extras[1].id], leadCoworkerId: fixture.chief.id });
    fixture.conversationStore.postUserMessage(team.conversation.id, { text: "P41 local roster work" });
    const providerRoster = { ready: true, mode: "local-gate", roles: {}, agents: [], providers: {}, coworkerBindings: { [readyId]: { ready: true } } };
    const fixtureHandlers = {
      ...handlers(fixture),
      "provider:getRoster": () => providerRoster,
      "provider:refresh": () => ({ applied: false, roster: providerRoster }),
      "conversation:createDirect": ({ coworkerId }) => fixture.conversationStore.createDirect(coworkerId),
    };
    const initialCoworkers = fixture.coworkerStore.list().coworkers;
    const expectedTotal = initialCoworkers.length;
    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    unbind = bindIpcChannels({ win, handlers: fixtureHandlers });
    check("hidden Electron window stays hidden", win.isVisible() === false);
    await loadWindow(win);
    await waitFor(async () => await invoke(win, `async()=>Boolean(document.querySelector("#coworker-list .nav-item"))`), "initial Coworker roster");

    const initial = await invoke(win, `async()=>({
      rows:document.querySelectorAll("#coworker-list .nav-item").length,
      more:document.getElementById("coworker-show-more")?.textContent||"",
      summary:document.getElementById("coworker-roster-summary")?.textContent||"",
      controls:["coworker-search","coworker-status-filter","coworker-show-more"].every((id)=>Boolean(document.getElementById(id))),
      body:(document.body.innerText+" "+document.body.innerHTML).slice(0,30000),
    })`);
    check("large roster starts bounded with visible controls and safe count", initial.rows >= 12 && initial.rows <= 16 && initial.controls && /Show .*more|显示其余/i.test(initial.more) && initial.summary.includes(`${expectedTotal} coworkers`) && !/(workspacePath|sessionId|agentId|workerId|providerAccount|accountSlot|accessToken|apiKey|secret)/i.test(initial.body), JSON.stringify({ rows: initial.rows, more: initial.more, summary: initial.summary, controls: initial.controls }));

    await invoke(win, `async()=>{document.getElementById("coworker-show-more")?.click(); return true}`);
    await waitFor(async () => await invoke(win, `async()=>document.querySelectorAll("#coworker-list .nav-item").length===${expectedTotal}`), "expanded full roster");
    const expanded = await invoke(win, `async()=>({ rows:document.querySelectorAll("#coworker-list .nav-item").length, button:document.getElementById("coworker-show-more")?.textContent||"" })`);
    check("Show more reveals every non-archived Coworker", expanded.rows === expectedTotal && /Collapse|收起/i.test(expanded.button), JSON.stringify(expanded));

    await invoke(win, `async()=>{const input=document.getElementById("coworker-search"); input.value=${JSON.stringify(target.name)}; input.dispatchEvent(new Event("input",{bubbles:true})); return true}`);
    await waitFor(async () => await invoke(win, `async()=>document.querySelectorAll("#coworker-list .nav-item").length===1`), "remote Coworker search");
    const searchResult = await invoke(win, `async()=>({ rows:document.querySelectorAll("#coworker-list .nav-item").length, names:[...document.querySelectorAll("#coworker-list .nav-item strong")].map((node)=>node.textContent) })`);
    check("remote search reaches a Coworker beyond the initial crop", searchResult.rows === 1 && searchResult.names[0] === target.name, JSON.stringify(searchResult));

    await invoke(win, `async()=>{document.querySelector('#coworker-list [data-coworker-id="${target.id}"]')?.click(); return true}`);
    await waitFor(async () => await invoke(win, `async()=>document.getElementById("view-conversation")?.classList.contains("hidden")===false`), "selected direct conversation");
    await invoke(win, `async()=>{const input=document.getElementById("coworker-search"); input.value=""; input.dispatchEvent(new Event("input",{bubbles:true})); return true}`);
    await waitFor(async () => await invoke(win, `async()=>Boolean(document.querySelector('#coworker-list [data-coworker-id="${target.id}"]'))`), "selected Coworker retention");
    const selected = await invoke(win, `async()=>({ rows:document.querySelectorAll("#coworker-list .nav-item").length, selected:document.querySelector('#coworker-list [data-coworker-id="${target.id}"]')?.classList.contains("active")===true, title:document.getElementById("conversation-title")?.textContent||"" })`);
    check("selected direct Coworker is retained after the bounded crop", selected.selected && selected.title === target.name && selected.rows <= 16, JSON.stringify(selected));

    await invoke(win, `async()=>{const select=document.getElementById("coworker-status-filter"); select.value="paused"; select.dispatchEvent(new Event("change",{bubbles:true})); return true}`);
    await waitFor(async () => await invoke(win, `async()=>document.querySelectorAll("#coworker-list .nav-item").length===1`), "paused status filter");
    const paused = await invoke(win, `async()=>({ names:[...document.querySelectorAll("#coworker-list .nav-item strong")].map((node)=>node.textContent), summary:document.getElementById("coworker-roster-summary")?.textContent||"" })`);
    check("status filter and counts expose paused state", paused.names.length === 1 && /P41 Roster 51/.test(paused.names[0]) && /paused|已暂停/i.test(paused.summary), JSON.stringify(paused));
    await invoke(win, `async()=>{const select=document.getElementById("coworker-status-filter"); select.value="available"; select.dispatchEvent(new Event("change",{bubbles:true})); return true}`);
    await waitFor(async () => await invoke(win, `async()=>document.querySelectorAll("#coworker-list .nav-item").length===1`), "available status filter");
    const available = await invoke(win, `async()=>[...document.querySelectorAll("#coworker-list .nav-item strong")].map((node)=>node.textContent)`);
    check("provider readiness maps to a safe available status", available.length === 1 && available[0] === extras[0].name, JSON.stringify(available));

    await invoke(win, `async()=>{const input=document.getElementById("coworker-search"); input.value=""; input.dispatchEvent(new Event("input",{bubbles:true})); const select=document.getElementById("coworker-status-filter"); select.value="all"; select.dispatchEvent(new Event("change",{bubbles:true})); document.getElementById("refresh-coworkers")?.click(); return true}`);
    await waitFor(async () => await invoke(win, `async()=>document.getElementById("coworker-roster-summary")?.textContent.includes("${expectedTotal} coworkers")`), "refreshed bounded roster");
    const restartedStore = createCoworkerStore({ persistPath: join(dataDir, "desktop-state", "coworkers.json") });
    unbind?.();
    unbind = bindIpcChannels({ win, handlers: { ...fixtureHandlers, "coworker:list": (payload) => restartedStore.list(payload), "coworker:get": ({ coworkerId }) => restartedStore.get(coworkerId) } });
    await loadWindow(win);
    await waitFor(async () => await invoke(win, `async()=>document.getElementById("coworker-roster-summary")?.textContent.includes("${expectedTotal} coworkers")`), "restarted Coworker roster");
    const afterRestart = await invoke(win, `async()=>({ rows:document.querySelectorAll("#coworker-list .nav-item").length, summary:document.getElementById("coworker-roster-summary")?.textContent||"", names:[...document.querySelectorAll("#coworker-list .nav-item strong")].map((node)=>node.textContent) })`);
    check("refresh and service restart preserve the bounded roster", afterRestart.rows >= 12 && afterRestart.rows <= 16 && afterRestart.summary.includes(`${expectedTotal} coworkers`) && !afterRestart.names.includes(target.name), JSON.stringify({ rows: afterRestart.rows, summary: afterRestart.summary }));
    await invoke(win, `async()=>{const input=document.getElementById("coworker-search"); input.value=${JSON.stringify(target.name)}; input.dispatchEvent(new Event("input",{bubbles:true})); return true}`);
    await waitFor(async () => await invoke(win, `async()=>document.querySelectorAll("#coworker-list .nav-item").length===1`), "persisted remote search");
    const persistedSearch = await invoke(win, `async()=>[...document.querySelectorAll("#coworker-list .nav-item strong")].map((node)=>node.textContent)`);
    check("persisted remote Coworker remains searchable after restart", persistedSearch.length === 1 && persistedSearch[0] === target.name, JSON.stringify(persistedSearch));
  } catch (error) {
    result.error = safe(error?.stack ?? error);
    check("P41 hidden Coworker roster gate completed", false, error?.message ?? error);
  }
  result.ok = Object.values(checks).every((entry) => entry.ok);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, "verify-p41-coworker-roster.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(join(EVIDENCE_DIR, "verify-p41-coworker-roster.log"), `${notes.join("\n")}\n`, "utf8");
  try { unbind?.(); } catch {}
  try { uninstallProtocol?.(); } catch {}
  try { win?.destroy(); } catch {}
  try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {}
  if (!result.ok) { app?.exit(1); return; }
  app?.exit(0);
}
