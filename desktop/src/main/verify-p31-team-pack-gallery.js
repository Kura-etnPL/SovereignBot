// Hidden real-Electron acceptance for the P31 Team Pack Gallery consistency slice.
// It reaches both ordinary gallery entries and proves they share the P21 editor,
// typed preload IPC, native JSON file IO, and durable state.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixture, handlers, loadWindow, invoke, waitFor } from "./verify-p11-team-packs.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(WORKTREE_ROOT, "_evidence_p31_2026-09-03");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clickVisibleElementWithInput(win, selector, label) {
  const geometry = await invoke(win, `async()=>{const element=document.querySelector(${JSON.stringify(selector)}); if(!element) return {found:false}; const rect=element.getBoundingClientRect(); const style=getComputedStyle(element); const viewport={width:document.documentElement.clientWidth,height:document.documentElement.clientHeight}; return {found:true,x:rect.left+rect.width/2,y:rect.top+rect.height/2,left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height,display:style.display,visibility:style.visibility,opacity:style.opacity,viewport};}`);
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
    check("hidden Electron window stays hidden", win.isVisible() === false);
    await loadWindow(win);

    await invoke(win, "async()=>document.getElementById('nav-product-hubs')?.click()");
    await waitFor("legacy Product hubs Team Pack cards", async () => await invoke(win, "async()=>document.querySelectorAll('#product-packs .settings-card').length >= 3"));
    const oldEntry = await invoke(win, "async()=>({cards:[...document.querySelectorAll('#product-packs .settings-card')].map((card)=>({id:card.dataset.teamPackId,title:card.querySelector('h3')?.textContent,buttons:[...card.querySelectorAll('button')].map((button)=>button.textContent)}))})");
    const oldFirstParty = oldEntry.cards.find((card) => card.id === "product-team");
    check("ordinary Product hubs navigation reaches the older Team Pack gallery", Boolean(oldFirstParty) && oldFirstParty.buttons.some((label) => label.includes("Duplicate")), JSON.stringify(oldEntry));
    check("older first-party gallery entry is read-only and guides Duplicate", Boolean(oldFirstParty) && !oldFirstParty.buttons.some((label) => label.includes("Edit")) && oldFirstParty.buttons.some((label) => label.includes("Duplicate")), JSON.stringify(oldFirstParty));

    const beforeIds = await invoke(win, "async()=>((await window.sovereignbot.teams.list({})).packs.filter((entry)=>entry.custom).map((entry)=>entry.id))");
    const duplicateGeometry = await clickVisibleElementWithInput(win, "#product-packs .settings-card:nth-child(5) button:nth-child(3)", "older gallery Duplicate button");
    note(`Duplicate input coordinates: ${JSON.stringify({ x: duplicateGeometry.x, y: duplicateGeometry.y, viewport: duplicateGeometry.viewport })}`);
    await waitFor("legacy gallery duplicate refresh", async () => await invoke(win, "async()=>((await window.sovereignbot.teams.list({})).packs ?? []).some((entry)=>entry.custom)"));
    const afterDuplicate = await invoke(win, "async()=>{const listed=await window.sovereignbot.teams.list({}); return {ids:listed.packs.filter((entry)=>entry.custom).map((entry)=>entry.id),cards:[...document.querySelectorAll('#product-packs .settings-card')].map((card)=>({id:card.dataset.teamPackId,title:card.querySelector('h3')?.textContent,buttons:[...card.querySelectorAll('button')].map((button)=>button.textContent)}))}})");
    duplicateRecipeId = afterDuplicate.ids.find((id) => !beforeIds.includes(id));
    check("older gallery Duplicate creates an editable custom recipe", Boolean(duplicateRecipeId) && afterDuplicate.cards.some((card) => card.id === duplicateRecipeId && card.buttons.some((label) => label.includes("Edit recipe"))), JSON.stringify(afterDuplicate));

    await invoke(win, `async()=>document.querySelector('[data-team-pack-id="${duplicateRecipeId}"] button:last-child')?.click()`);
    await waitFor("older gallery opens shared structured editor", async () => await invoke(win, "async()=>Boolean(document.getElementById('team-pack-editor-dialog')?.open)"));
    const oldEditor = await invoke(win, "async()=>({name:document.getElementById('team-pack-editor-name')?.value,rawJson:document.querySelector('#team-pack-editor-dialog textarea[id*=json]') !== null,rows:document.querySelectorAll('#team-pack-editor-dialog .team-pack-editor-row').length})");
    check("older gallery Edit opens the P21 structured recipe editor", oldEditor.rows >= 4 && !oldEditor.rawJson, JSON.stringify(oldEditor));
    await invoke(win, `async()=>{const field=document.getElementById('team-pack-editor-name'); field.value=${JSON.stringify(oldRecipeName)}; field.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('team-pack-editor-form')?.requestSubmit(); return true}`);
    await waitFor("older gallery structured save", async () => await invoke(win, "async()=>!document.getElementById('team-pack-editor-dialog')?.open"));
    const oldSaved = await invoke(win, `async()=>window.sovereignbot.teams.exportPackRecipe({packId:${JSON.stringify(duplicateRecipeId)}})`);
    check("older gallery edit writes through the shared typed Team Pack service", oldSaved.name === oldRecipeName, JSON.stringify(oldSaved));

    await invoke(win, `async()=>document.querySelector('[data-team-pack-id="${duplicateRecipeId}"] button:last-child')?.click()`);
    await waitFor("older gallery reopens editor", async () => await invoke(win, "async()=>Boolean(document.getElementById('team-pack-editor-dialog')?.open)"));
    await invoke(win, "async()=>{const field=document.getElementById('team-pack-editor-name'); field.value='P31 Cancelled Change'; field.dispatchEvent(new Event('input',{bubbles:true})); [...document.querySelectorAll('#team-pack-editor-dialog button')].find((button)=>button.textContent.includes('Cancel'))?.click(); return true}");
    await waitFor("older gallery editor cancel", async () => await invoke(win, "async()=>!document.getElementById('team-pack-editor-dialog')?.open"));
    const afterCancel = await invoke(win, `async()=>window.sovereignbot.teams.exportPackRecipe({packId:${JSON.stringify(duplicateRecipeId)}})`);
    check("older gallery editor Cancel performs no write", afterCancel.name === oldRecipeName, JSON.stringify(afterCancel));

    await invoke(win, "async()=>document.getElementById('nav-team-packs')?.click()");
    await waitFor("dedicated Team Pack page", async () => await invoke(win, "async()=>!document.getElementById('view-team-packs')?.classList.contains('hidden')"));
    await invoke(win, `async()=>{const input=document.getElementById('team-pack-search-page'); input.value=${JSON.stringify(oldRecipeName)}; input.dispatchEvent(new Event('input',{bubbles:true})); return true}`);
    await waitFor("dedicated page finds edited custom recipe", async () => await invoke(win, `async()=>Boolean(document.querySelector('[data-team-pack-id="${duplicateRecipeId}"]'))`));
    const pageEntry = await invoke(win, `async()=>{const card=document.querySelector('[data-team-pack-id="${duplicateRecipeId}"]'); return {title:card?.querySelector('h3')?.textContent,buttons:[...(card?.querySelectorAll('button')||[])].map((button)=>button.textContent)}}`);
    check("dedicated Team Pack page exposes the same editable recipe", pageEntry.title === oldRecipeName && pageEntry.buttons.some((label) => label.includes("Edit recipe")), JSON.stringify(pageEntry));
    await invoke(win, `async()=>document.querySelector('[data-team-pack-id="${duplicateRecipeId}"] button:last-child')?.click()`);
    await waitFor("dedicated page opens shared structured editor", async () => await invoke(win, "async()=>Boolean(document.getElementById('team-pack-editor-dialog')?.open)"));
    await invoke(win, `async()=>{const field=document.getElementById('team-pack-editor-name'); field.value=${JSON.stringify(pageRecipeName)}; field.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('team-pack-editor-form')?.requestSubmit(); return true}`);
    await waitFor("dedicated page structured save", async () => await invoke(win, "async()=>!document.getElementById('team-pack-editor-dialog')?.open"));
    const pageSaved = await invoke(win, `async()=>window.sovereignbot.teams.exportPackRecipe({packId:${JSON.stringify(duplicateRecipeId)}})`);
    check("both visible entries converge on one persisted recipe", pageSaved.name === pageRecipeName, JSON.stringify(pageSaved));

    await invoke(win, "async()=>{const clipboard=navigator.clipboard; if(clipboard) clipboard.writeText=()=>{throw new Error('clipboard must not be used')}; document.getElementById('nav-product-hubs')?.click(); return true}");
    await waitFor("legacy gallery after shared save", async () => await invoke(win, `async()=>Boolean(document.querySelector('[data-team-pack-id="${duplicateRecipeId}"]'))`));
    const exportPath = join(dataDir, "p31-old-gallery-export.json");
    teamPackDialog.savePaths.push(exportPath);
    await invoke(win, `async()=>{const card=document.querySelector('[data-team-pack-id="${duplicateRecipeId}"]'); [...(card?.querySelectorAll('button')||[])].find((button)=>button.textContent.includes('Export'))?.click(); return true}`);
    await waitFor("legacy gallery native export", async () => existsSync(exportPath));
    const exported = JSON.parse(readFileSync(exportPath, "utf8"));
    check("older gallery Export uses native bounded JSON IO without clipboard", exported.id === duplicateRecipeId && exported.name === pageRecipeName && !forbidden.test(JSON.stringify(exported)), JSON.stringify(exported));

    const unsafePath = join(dataDir, "p31-unsafe-team-pack.json");
    writeFileSync(unsafePath, JSON.stringify({ ...exported, capabilityGrant: "computer" }), "utf8");
    await invoke(win, "async()=>document.getElementById('nav-team-packs')?.click()");
    await waitFor("dedicated Team Pack page before import", async () => await invoke(win, "async()=>!document.getElementById('view-team-packs')?.classList.contains('hidden')"));
    teamPackDialog.openPaths.push(unsafePath);
    await invoke(win, "async()=>document.getElementById('team-pack-page-import')?.click()");
    await waitFor("authority-bearing import rejection", async () => await invoke(win, "async()=>/not accepted|unexpected|capability/i.test(document.querySelector('#product-packs-page')?.innerText || '')"));
    const unsafeResult = await invoke(win, "async()=>document.querySelector('#product-packs-page')?.innerText || ''");
    check("native import rejects authority-bearing Team Pack JSON in product UI", /not accepted|unexpected|capability/i.test(unsafeResult) && !unsafeResult.includes(unsafePath), unsafeResult);

    unbind?.(); unbind = undefined;
    fixture = makeFixture(dataDir, { teamPackDialog });
    unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
    await loadWindow(win);
    restart = await invoke(win, `async()=>window.sovereignbot.teams.exportPackRecipe({packId:${JSON.stringify(duplicateRecipeId)}})`);
    check("restart preserves the single shared editor result", restart.name === pageRecipeName && !forbidden.test(JSON.stringify(restart)), JSON.stringify(restart));
    await invoke(win, "async()=>document.getElementById('nav-product-hubs')?.click()");
    await waitFor("restarted older gallery", async () => await invoke(win, `async()=>Boolean(document.querySelector('[data-team-pack-id="${duplicateRecipeId}"]'))`));
    const restartedOld = await invoke(win, `async()=>document.querySelector('[data-team-pack-id="${duplicateRecipeId}"]')?.querySelector('h3')?.textContent || ''`);
    check("restart shows the edited recipe in the older gallery entry", restartedOld === pageRecipeName, restartedOld);
  }
  catch (error) {
    fatal = error;
    note(`[fatal] ${String(error?.stack ?? error)}`);
    check("P31 Team Pack gallery gate runner completed", false, String(error?.message ?? error));
  }

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
  writeFileSync(join(EVIDENCE_DIR, "verify-p31-team-pack-gallery.json"), `${JSON.stringify({ at: new Date().toISOString(), checks, duplicateRecipeId, restart, fatal: fatal ? String(fatal?.message ?? fatal) : undefined }, null, 2)}\n`, "utf8");
  writeFileSync(join(EVIDENCE_DIR, "verify-p31-team-pack-gallery.log"), `${log.join("\n")}\n`, "utf8");
  try { unbind?.(); } catch {}
  try { uninstallProtocol?.(); } catch {}
  try { win?.destroy(); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  if (fatal || failed.length) throw new Error(`P31 Team Pack gallery gate failed: ${failed.join(", ") || String(fatal?.message ?? fatal)}`);
  app.exit(0);
}
