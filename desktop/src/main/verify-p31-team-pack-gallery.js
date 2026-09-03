// Hidden real-Electron acceptance for the P31 Team Pack Gallery consistency slice.
// It reaches both ordinary gallery entries and proves they share the P21 editor,
// typed preload IPC, native JSON file IO, and durable state.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixture, handlers, loadWindow, invoke as rawInvoke, waitFor } from "./verify-p11-team-packs.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(WORKTREE_ROOT, "_evidence_p31_2026-09-03");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeDiagnosticText = (value) => String(value ?? "").replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, "<redacted-path>").replace(/(?:file|https?):\/\/[^\s"'<>]+/gi, "<redacted-url>").replace(/\b(?:token|password|secret|credential)\b\s*[=:]\s*[^\s,;]+/gi, "$1=<redacted>").slice(0, 240);
const DUPLICATE_STATE_PROBE_EXPRESSION = "async()=>{try{const listed=await window.sovereignbot.teams.list({}); return {ok:true,ids:(listed?.packs??[]).filter((entry)=>entry.custom).map((entry)=>entry.id),errorSummary:null};}catch(error){return {ok:false,ids:[],errorSummary:(error?.name||'RendererError')+': '+String(error?.message||'operation failed').slice(0,160).replace(/[A-Za-z]:[\\/][^\\s\"'<>]+/g,'<redacted-path>').replace(/(?:file|https?):\\/\\/[^\\s\"'<>]+/gi,'<redacted-url>')};}}";

const INVOKE_EXPRESSIONS = Object.freeze({
  navProductHubs: "async()=>document.getElementById('nav-product-hubs')?.click()",
  legacyCardsReady: "async()=>document.querySelectorAll('#product-packs .settings-card').length >= 3",
  legacyEntrySnapshot: "async()=>({cards:[...document.querySelectorAll('#product-packs .settings-card')].map((card)=>({id:card.dataset.teamPackId,title:card.querySelector('h3')?.textContent,buttons:[...card.querySelectorAll('button')].map((button)=>button.textContent)}))})",
  beforeIds: "async()=>((await window.sovereignbot.teams.list({})).packs.filter((entry)=>entry.custom).map((entry)=>entry.id))",
  editorOpen: "async()=>Boolean(document.getElementById('team-pack-editor-dialog')?.open)",
  editorSnapshot: "async()=>({name:document.getElementById('team-pack-editor-name')?.value,rawJson:document.querySelector('#team-pack-editor-dialog textarea[id*=json]') !== null,rows:document.querySelectorAll('#team-pack-editor-dialog .team-pack-editor-row').length})",
  editorCancel: "async()=>{const field=document.getElementById('team-pack-editor-name'); field.value='P31 Cancelled Change'; field.dispatchEvent(new Event('input',{bubbles:true})); [...document.querySelectorAll('#team-pack-editor-dialog button')].find((button)=>button.textContent.includes('Cancel'))?.click(); return true}",
  editorClosed: "async()=>!document.getElementById('team-pack-editor-dialog')?.open",
  navTeamPacks: "async()=>document.getElementById('nav-team-packs')?.click()",
  dedicatedPageVisible: "async()=>!document.getElementById('view-team-packs')?.classList.contains('hidden')",
  importClick: "async()=>document.getElementById('team-pack-page-import')?.click()",
  importRejected: "async()=>/not accepted|unexpected|capability/i.test(document.querySelector('#product-packs-page')?.innerText || '')",
  importResult: "async()=>document.querySelector('#product-packs-page')?.innerText || ''",
});

function preflightInvokeExpression(expression) {
  const wrapped = `(${expression})()`;
  new Function(`return ${wrapped}`);
  return expression;
}

for (const [label, expression] of Object.entries({ ...INVOKE_EXPRESSIONS, duplicateStateProbe: DUPLICATE_STATE_PROBE_EXPRESSION })) {
  try {
    preflightInvokeExpression(expression);
  }
  catch {
    throw new Error(`P31 verifier expression preflight failed: ${label}`);
  }
}

const PREFLIGHTED_DUPLICATE_STATE_PROBE_EXPRESSION = preflightInvokeExpression(DUPLICATE_STATE_PROBE_EXPRESSION);

async function invokeChecked(win, label, expression) {
  let checkedExpression;
  try {
    checkedExpression = preflightInvokeExpression(expression);
  }
  catch {
    throw new Error(`P31 verifier expression preflight failed: ${safeDiagnosticText(label)}`);
  }
  try {
    return await rawInvoke(win, checkedExpression);
  }
  catch (error) {
    throw new Error(`P31 renderer call failed [${safeDiagnosticText(label)}]: ${safeDiagnosticText(error?.message ?? "renderer invocation failed")}`);
  }
}

async function probeDuplicateState(win) {
  try {
    const result = await invokeChecked(win, "duplicate state probe", PREFLIGHTED_DUPLICATE_STATE_PROBE_EXPRESSION);
    return result && Array.isArray(result.ids) && typeof result.ok === "boolean" ? result : { ok: false, ids: [], errorSummary: "invalid renderer probe result" };
  }
  catch {
    return { ok: false, ids: [], errorSummary: "main executeJavaScript failed transiently" };
  }
}

async function waitForDuplicateState(win, beforeIds, note, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastProbe = { ok: false, ids: [], errorSummary: "probe not run" };
  while (Date.now() < deadline) {
    lastProbe = await probeDuplicateState(win);
    note(`[duplicate-probe] ${JSON.stringify(lastProbe)}`);
    if (lastProbe.ok && lastProbe.ids.some((id) => !beforeIds.includes(id))) return lastProbe;
    await sleep(80);
  }
  throw new Error(`timed out waiting for legacy gallery duplicate state: ${JSON.stringify(lastProbe)}`);
}

async function clickVisibleElementWithInput(win, selector, label) {
  const scrolled = await invokeChecked(win, `scroll ${label}`, `async()=>{const element=document.querySelector(${JSON.stringify(selector)}); if(!element) return false; element.scrollIntoView({block:"center",inline:"center"}); return true;}`);
  if (!scrolled) throw new Error(`${label} is unavailable`);
  await sleep(150);
  const geometry = await invokeChecked(win, `geometry ${label}`, `async()=>{const element=document.querySelector(${JSON.stringify(selector)}); if(!element) return {found:false}; const rect=element.getBoundingClientRect(); const style=getComputedStyle(element); const viewport={width:document.documentElement.clientWidth,height:document.documentElement.clientHeight}; return {found:true,x:rect.left+rect.width/2,y:rect.top+rect.height/2,left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height,display:style.display,visibility:style.visibility,opacity:style.opacity,viewport};}`);
  const values = [geometry?.x, geometry?.y, geometry?.left, geometry?.top, geometry?.right, geometry?.bottom, geometry?.width, geometry?.height, geometry?.viewport?.width, geometry?.viewport?.height];
  if (!geometry?.found) throw new Error(`${label} is unavailable`);
  if (!values.every(Number.isFinite)) throw new Error(`${label} has non-finite bounds`);
  if (!(geometry.width > 0 && geometry.height > 0)) throw new Error(`${label} is not visible: zero bounds`);
  if (geometry.display === "none" || geometry.visibility === "hidden" || Number(geometry.opacity) <= 0) throw new Error(`${label} is not visible`);
  if (!(geometry.left >= 0 && geometry.top >= 0 && geometry.right <= geometry.viewport.width && geometry.bottom <= geometry.viewport.height && geometry.x >= 0 && geometry.y >= 0 && geometry.x <= geometry.viewport.width && geometry.y <= geometry.viewport.height)) throw new Error(`${label} is outside the viewport`);
  win.focus();
  win.webContents.focus();
  await win.webContents.sendInputEvent({ type: "mouseMove", x: geometry.x, y: geometry.y });
  await win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: geometry.x, y: geometry.y });
  await win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: geometry.x, y: geometry.y });
  return geometry;
}

export async function runVerifyP31TeamPackGallery({ app }) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const checks = {};
  const log = [];
  const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
  const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };
  const forbidden = /(?:workspacePath|managed-workspaces|storageRelativePath|sourceRelativePath|file:\/\/|https?:\/\/|providerAccount|credential|session|token|capability|governedTools|password|cookie|driver|\bcoordinates\b)/i;
  const tempRoot = process.env.SOVEREIGNBOT_V49_TEMP_ROOT;
  if (!tempRoot) throw new Error("V49 temp root is missing; refusing to use the default user profile");
  const dataDir = join(tempRoot, "data");
  const oldRecipeName = "P31 Old Gallery Edited";
  const pageRecipeName = "P31 Dedicated Gallery Edited";
  let fixture;
  let win;
  let unbind;
  let uninstallProtocol;
  let fatal;
  let duplicateRecipeId;
  let restart;
  const rendererDiagnostics = [];
  const rendererHealth = [];

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
    win.webContents.on("console-message", (_event, level, message, line) => {
      const detail = { level, message: safeDiagnosticText(message), line: Number.isFinite(line) ? line : null };
      rendererDiagnostics.push(detail);
      note(`[renderer-console] ${JSON.stringify(detail)}`);
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      const detail = { reason: safeDiagnosticText(details?.reason), exitCode: Number.isFinite(details?.exitCode) ? details.exitCode : null };
      rendererHealth.push(detail);
      note(`[renderer-health] ${JSON.stringify(detail)}`);
    });
    unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
    check("hidden Electron window stays hidden", win.isVisible() === false);
    await loadWindow(win);

    await invokeChecked(win, "legacy gallery navigation", INVOKE_EXPRESSIONS.navProductHubs);
    await waitFor("legacy Product hubs Team Pack cards", async () => await invokeChecked(win, "legacy gallery cards ready", INVOKE_EXPRESSIONS.legacyCardsReady));
    const oldEntry = await invokeChecked(win, "legacy gallery card snapshot", INVOKE_EXPRESSIONS.legacyEntrySnapshot);
    const oldFirstParty = oldEntry.cards.find((card) => card.id === "product-team");
    check("ordinary Product hubs navigation reaches the older Team Pack gallery", Boolean(oldFirstParty) && oldFirstParty.buttons.some((label) => label.includes("Duplicate")), JSON.stringify(oldEntry));
    check("older first-party gallery entry is read-only and guides Duplicate", Boolean(oldFirstParty) && !oldFirstParty.buttons.some((label) => label.includes("Edit")) && oldFirstParty.buttons.some((label) => label.includes("Duplicate")), JSON.stringify(oldFirstParty));

    const beforeIds = await invokeChecked(win, "legacy gallery before ids", INVOKE_EXPRESSIONS.beforeIds);
    const duplicateGeometry = await clickVisibleElementWithInput(win, "#product-packs .settings-card:nth-child(5) button:nth-child(3)", "older gallery Duplicate button");
    note(`Duplicate input coordinates: ${JSON.stringify({ x: duplicateGeometry.x, y: duplicateGeometry.y, viewport: duplicateGeometry.viewport })}`);
    note("sendInputEvent completed; state probe pending");
    const duplicateProbe = await waitForDuplicateState(win, beforeIds, note);
    const afterDuplicate = await invokeChecked(win, "legacy gallery after duplicate snapshot", "async()=>{const listed=await window.sovereignbot.teams.list({}); return {ids:listed.packs.filter((entry)=>entry.custom).map((entry)=>entry.id),cards:[...document.querySelectorAll('#product-packs .settings-card')].map((card)=>({id:card.dataset.teamPackId,title:card.querySelector('h3')?.textContent,buttons:[...card.querySelectorAll('button')].map((button)=>button.textContent)}))}}");
    duplicateRecipeId = duplicateProbe.ids.find((id) => !beforeIds.includes(id));
    check("older gallery Duplicate creates an editable custom recipe", Boolean(duplicateRecipeId) && afterDuplicate.cards.some((card) => card.id === duplicateRecipeId && card.buttons.some((label) => label.includes("Edit recipe"))), JSON.stringify(afterDuplicate));

    await invokeChecked(win, "legacy gallery open duplicate editor", `async()=>document.querySelector('[data-team-pack-id="${duplicateRecipeId}"] button:last-child')?.click()`);
    await waitFor("older gallery opens shared structured editor", async () => await invokeChecked(win, "legacy gallery editor open", INVOKE_EXPRESSIONS.editorOpen));
    const oldEditor = await invokeChecked(win, "legacy gallery editor snapshot", INVOKE_EXPRESSIONS.editorSnapshot);
    check("older gallery Edit opens the P21 structured recipe editor", oldEditor.rows >= 4 && !oldEditor.rawJson, JSON.stringify(oldEditor));
    await invokeChecked(win, "legacy gallery editor submit", `async()=>{const field=document.getElementById('team-pack-editor-name'); field.value=${JSON.stringify(oldRecipeName)}; field.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('team-pack-editor-form')?.requestSubmit(); return true}`);
    await waitFor("older gallery structured save", async () => await invokeChecked(win, "legacy gallery editor closed", INVOKE_EXPRESSIONS.editorClosed));
    const oldSaved = await invokeChecked(win, "legacy gallery saved recipe", `async()=>window.sovereignbot.teams.exportPackRecipe({packId:${JSON.stringify(duplicateRecipeId)}})`);
    check("older gallery edit writes through the shared typed Team Pack service", oldSaved.name === oldRecipeName, JSON.stringify(oldSaved));

    await invokeChecked(win, "legacy gallery reopen editor", `async()=>document.querySelector('[data-team-pack-id="${duplicateRecipeId}"] button:last-child')?.click()`);
    await waitFor("older gallery reopens editor", async () => await invokeChecked(win, "legacy gallery editor reopened", INVOKE_EXPRESSIONS.editorOpen));
    await invokeChecked(win, "legacy gallery editor cancel", INVOKE_EXPRESSIONS.editorCancel);
    await waitFor("older gallery editor cancel", async () => await invokeChecked(win, "legacy gallery editor cancelled", INVOKE_EXPRESSIONS.editorClosed));
    const afterCancel = await invokeChecked(win, "legacy gallery recipe after cancel", `async()=>window.sovereignbot.teams.exportPackRecipe({packId:${JSON.stringify(duplicateRecipeId)}})`);
    check("older gallery editor Cancel performs no write", afterCancel.name === oldRecipeName, JSON.stringify(afterCancel));

    await invokeChecked(win, "dedicated page navigation", INVOKE_EXPRESSIONS.navTeamPacks);
    await waitFor("dedicated Team Pack page", async () => await invokeChecked(win, "dedicated page visible", INVOKE_EXPRESSIONS.dedicatedPageVisible));
    await invokeChecked(win, "dedicated page search", `async()=>{const input=document.getElementById('team-pack-search-page'); input.value=${JSON.stringify(oldRecipeName)}; input.dispatchEvent(new Event('input',{bubbles:true})); return true}`);
    await waitFor("dedicated page finds edited custom recipe", async () => await invokeChecked(win, "dedicated page recipe found", `async()=>Boolean(document.querySelector('[data-team-pack-id="${duplicateRecipeId}"]'))`));
    const pageEntry = await invokeChecked(win, "dedicated page card snapshot", `async()=>{const card=document.querySelector('[data-team-pack-id="${duplicateRecipeId}"]'); return {title:card?.querySelector('h3')?.textContent,buttons:[...(card?.querySelectorAll('button')||[])].map((button)=>button.textContent)}}`);
    check("dedicated Team Pack page exposes the same editable recipe", pageEntry.title === oldRecipeName && pageEntry.buttons.some((label) => label.includes("Edit recipe")), JSON.stringify(pageEntry));
    await invokeChecked(win, "dedicated page open editor", `async()=>document.querySelector('[data-team-pack-id="${duplicateRecipeId}"] button:last-child')?.click()`);
    await waitFor("dedicated page opens shared structured editor", async () => await invokeChecked(win, "dedicated page editor open", INVOKE_EXPRESSIONS.editorOpen));
    await invokeChecked(win, "dedicated page editor submit", `async()=>{const field=document.getElementById('team-pack-editor-name'); field.value=${JSON.stringify(pageRecipeName)}; field.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('team-pack-editor-form')?.requestSubmit(); return true}`);
    await waitFor("dedicated page structured save", async () => await invokeChecked(win, "dedicated page editor closed", INVOKE_EXPRESSIONS.editorClosed));
    const pageSaved = await invokeChecked(win, "dedicated page saved recipe", `async()=>window.sovereignbot.teams.exportPackRecipe({packId:${JSON.stringify(duplicateRecipeId)}})`);
    check("both visible entries converge on one persisted recipe", pageSaved.name === pageRecipeName, JSON.stringify(pageSaved));

    await invokeChecked(win, "legacy gallery navigation after shared save", INVOKE_EXPRESSIONS.navProductHubs);
    await waitFor("legacy gallery after shared save", async () => await invokeChecked(win, "legacy gallery saved recipe found", `async()=>Boolean(document.querySelector('[data-team-pack-id="${duplicateRecipeId}"]'))`));
    const exportPath = join(dataDir, "p31-old-gallery-export.json");
    teamPackDialog.savePaths.push(exportPath);
    await invokeChecked(win, "legacy gallery export", `async()=>{const card=document.querySelector('[data-team-pack-id="${duplicateRecipeId}"]'); [...(card?.querySelectorAll('button')||[])].find((button)=>button.textContent.includes('Export'))?.click(); return true}`);
    await waitFor("legacy gallery native export", async () => existsSync(exportPath));
    const exported = JSON.parse(readFileSync(exportPath, "utf8"));
    check("older gallery Export uses native bounded JSON IO without clipboard", exported.id === duplicateRecipeId && exported.name === pageRecipeName && !forbidden.test(JSON.stringify(exported)), JSON.stringify(exported));

    const unsafePath = join(dataDir, "p31-unsafe-team-pack.json");
    writeFileSync(unsafePath, JSON.stringify({ ...exported, capabilityGrant: "computer" }), "utf8");
    await invokeChecked(win, "dedicated page navigation before import", INVOKE_EXPRESSIONS.navTeamPacks);
    await waitFor("dedicated Team Pack page before import", async () => await invokeChecked(win, "dedicated page visible before import", INVOKE_EXPRESSIONS.dedicatedPageVisible));
    teamPackDialog.openPaths.push(unsafePath);
    await invokeChecked(win, "dedicated page import", INVOKE_EXPRESSIONS.importClick);
    await waitFor("authority-bearing import rejection", async () => await invokeChecked(win, "authority-bearing import rejection probe", INVOKE_EXPRESSIONS.importRejected));
    const unsafeResult = await invokeChecked(win, "authority-bearing import result", INVOKE_EXPRESSIONS.importResult);
    check("native import rejects authority-bearing Team Pack JSON in product UI", /not accepted|unexpected|capability/i.test(unsafeResult) && !unsafeResult.includes(unsafePath), unsafeResult);

    unbind?.(); unbind = undefined;
    fixture = makeFixture(dataDir, { teamPackDialog });
    unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
    await loadWindow(win);
    restart = await invokeChecked(win, "restart persisted recipe", `async()=>window.sovereignbot.teams.exportPackRecipe({packId:${JSON.stringify(duplicateRecipeId)}})`);
    check("restart preserves the single shared editor result", restart.name === pageRecipeName && !forbidden.test(JSON.stringify(restart)), JSON.stringify(restart));
    await invokeChecked(win, "restarted legacy gallery navigation", INVOKE_EXPRESSIONS.navProductHubs);
    await waitFor("restarted older gallery", async () => await invokeChecked(win, "restarted recipe found", `async()=>Boolean(document.querySelector('[data-team-pack-id="${duplicateRecipeId}"]'))`));
    const restartedOld = await invokeChecked(win, "restarted recipe title", `async()=>document.querySelector('[data-team-pack-id="${duplicateRecipeId}"]')?.querySelector('h3')?.textContent || ''`);
    check("restart shows the edited recipe in the older gallery entry", restartedOld === pageRecipeName, restartedOld);
  }
  catch (error) {
    fatal = error;
    note(`[fatal] ${String(error?.stack ?? error)}`);
    check("P31 Team Pack gallery gate runner completed", false, String(error?.message ?? error));
  }

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
  writeFileSync(join(EVIDENCE_DIR, "verify-p31-team-pack-gallery.json"), `${JSON.stringify({ at: new Date().toISOString(), checks, duplicateRecipeId, restart, rendererDiagnostics, rendererHealth, fatal: fatal ? String(fatal?.message ?? fatal) : undefined }, null, 2)}\n`, "utf8");
  writeFileSync(join(EVIDENCE_DIR, "verify-p31-team-pack-gallery.log"), `${log.join("\n")}\n`, "utf8");
  try { unbind?.(); } catch {}
  try { uninstallProtocol?.(); } catch {}
  try { win?.destroy(); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  if (fatal || failed.length) throw new Error(`P31 Team Pack gallery gate failed: ${failed.join(", ") || String(fatal?.message ?? fatal)}`);
  app.exit(0);
}
