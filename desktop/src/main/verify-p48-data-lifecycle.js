// P48 hidden real-Electron gate. It drives the production Settings/Data Lifecycle
// renderer and IPC against an isolated temporary state tree; no user state is opened.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDesktopDataLifecycle } from "./data-lifecycle.js";
import { createDesktopServices } from "./services.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(WORKTREE_ROOT, "docs", "acceptance");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function seedState(dataDir) {
  const stateDir = join(dataDir, "desktop-state");
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(dataDir, "artifacts"), { recursive: true });
  await writeFile(join(dataDir, "tasks.json"), "[]\n", "utf8");
  await writeFile(join(stateDir, "settings.json"), JSON.stringify({ schema: "sovereignbot.desktop.settings.v1", theme: "dark", fixtureMarker: "P48_RESTORE_SOURCE" }), "utf8");
  await writeFile(join(stateDir, "workspaces.json"), JSON.stringify({ schema: "sovereignbot.desktop.workspaces.v1", workspaces: [] }), "utf8");
}

export async function runVerifyP48DataLifecycle({ app } = {}) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const checks = {};
  const notes = [];
  const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); notes.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); try { process.stderr.write(`${notes.at(-1)}\n`); } catch {} };
  let dataDir;
  let win;
  let uninstallProtocol;
  let unbind;
  let lifecycle;
  let restoreCalls = 0;
  let restoreFailOnce = false;
  let prepareResetCalls = 0;
  let resetCalls = 0;
  let prepareFailOnce = false;
  let lastPrepared;
  try {
    dataDir = await mkdtemp(join(tmpdir(), "sovereign-p48-"));
    await seedState(dataDir);
    const services = createDesktopServices({ dataDir, dialog: {} });
    const coworkerStore = createCoworkerStore({ persistPath: join(dataDir, "desktop-state", "coworkers.json") });
    coworkerStore.ensureDefaults();
    const conversationStore = createConversationStore({ persistPath: join(dataDir, "desktop-state", "conversations.json"), coworkerStore });
    lifecycle = createDesktopDataLifecycle({ dataDir });
    const sourceBackup = await lifecycle.backup({ id: "p48-restore-source" });
    await writeFile(join(dataDir, "desktop-state", "settings.json"), JSON.stringify({ schema: "sovereignbot.desktop.settings.v1", theme: "light", fixtureMarker: "P48_MUTATED_STATE" }), "utf8");
    const restoreRetryBackup = await lifecycle.backup({ id: "p48-restore-retry-source" });
    await writeFile(join(dataDir, "desktop-state", "settings.json"), JSON.stringify({ schema: "sovereignbot.desktop.settings.v1", theme: "contrast", fixtureMarker: "P48_RETRY_MUTATED_STATE" }), "utf8");
    const roster = { ready: false, mode: "provider", roles: {}, agents: [], providers: {}, coworkerBindings: {} };
    const empty = (key) => () => ({ [key]: [] });
    lifecycle = createDesktopDataLifecycle({ dataDir });
    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    unbind = bindIpcChannels({
      win,
      handlers: {
        "app:handshake": () => ({ ok: true, version: "4.0.0", platform: process.platform, locale: "en-US", language: "en" }),
        "firstrun:getStatus": () => ({ browsers: [], providers: {} }),
        "settings:get": () => services.getSettings(),
        "settings:update": (patch) => services.updateSettings(patch),
        "workspace:list": () => services.listWorkspaces(),
        "workspace:addViaDialog": () => ({ canceled: true }),
        "workspace:setDefault": () => ({ ok: true }),
        "workspace:remove": () => ({ removed: false }),
        "coworker:list": (payload) => coworkerStore.list(payload),
        "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
        "conversation:list": () => conversationStore.list(),
        "conversation:get": ({ conversationId }) => conversationStore.get(conversationId),
        "team:list": empty("teams"),
        "team:activity": empty("events"),
        "project:list": empty("projects"),
        "connectedApps:list": empty("apps"),
        "skill:list": empty("skills"),
        "job:list": empty("jobs"),
        "job:attention": empty("jobs"),
        "routine:list": empty("routines"),
        "eventTrigger:list": empty("triggers"),
        "memory:list": () => ({ memory: [], suggestions: [] }),
        "memory:listSuggestions": empty("suggestions"),
        "artifact:list": empty("artifacts"),
        "provider:getRoster": () => roster,
        "provider:refresh": () => ({ applied: false, roster }),
        "provider:openLogin": () => ({ canceled: true }),
        "update:status": () => ({ available: false, currentVersion: "4.0.0", channel: "stable" }),
        "notification:list": () => ({ notifications: [], totalCount: 0, unreadCount: 0 }),
        "computerTarget:list": () => ({ targets: [] }),
        "data:status": () => lifecycle.status(),
        "data:listBackups": () => lifecycle.listBackups(),
        "data:backup": () => lifecycle.backup({ id: "p48-ui-backup" }),
        "data:export": () => lifecycle.exportData({ id: "p48-ui-export" }),
        "data:restore": async ({ id }) => { restoreCalls += 1; await sleep(120); if (restoreFailOnce) { restoreFailOnce = false; throw new Error(`P48 restore IPC failed at ${dataDir} confirmation=fixture`); } return lifecycle.restoreBackup({ id }); },
        "data:prepareReset": async () => { prepareResetCalls += 1; await sleep(120); if (prepareFailOnce) { prepareFailOnce = false; throw new Error(`P48 reset IPC failed at ${dataDir} nonce=fixture`); } lastPrepared = await lifecycle.prepareReset(); return lastPrepared; },
        "data:reset": async ({ confirmation, backupId }) => { resetCalls += 1; await sleep(120); return lifecycle.cleanReset({ confirmation, backupId }); },
      },
    });
    check("hidden Electron window stays hidden", win.isVisible() === false);
    await win.loadURL(appOrigin());
    await win.webContents.executeJavaScript("(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()");
    await sleep(800);
    await win.webContents.executeJavaScript("document.getElementById('nav-settings')?.click()");
    await sleep(800);
    const surface = await win.webContents.executeJavaScript(`(()=>({
      card:!!document.getElementById('data-lifecycle-card'),
      restoreDialog:!!document.getElementById('data-lifecycle-restore-dialog'),
      resetDialog:!!document.getElementById('data-lifecycle-reset-dialog'),
      backupRows:document.querySelectorAll('#data-lifecycle-backups .workspace-card').length,
      text:document.getElementById('data-lifecycle-card')?.textContent||''
    }))()`);
    check("Settings exposes Data Lifecycle card and validated backup row", surface.card && surface.restoreDialog && surface.resetDialog && surface.backupRows >= 2, JSON.stringify(surface));
    check("public Data Lifecycle UI contains no fixture path or opaque canary", !surface.text.includes(dataDir) && !surface.text.includes("confirmation=fixture") && !surface.text.includes("nonce=fixture"), JSON.stringify({ text: surface.text }));

    const openRestore = (id) => win.webContents.executeJavaScript(`(()=>{const row=[...document.querySelectorAll('#data-lifecycle-backups .workspace-card')].find((entry)=>entry.textContent.includes(${JSON.stringify(id)})); const button=row?.querySelector('button'); if(!button) return {found:false}; button.click(); const dialog=document.getElementById('data-lifecycle-restore-dialog'); return {found:true,open:dialog?.open===true,text:dialog?.textContent||''};})()`);
    const restoreConfirm = (doubleClick = false) => win.webContents.executeJavaScript(`(async()=>{const button=document.getElementById('data-lifecycle-restore-confirm'); if(!button || !document.getElementById('data-lifecycle-restore-dialog')?.open) return {found:false}; button.click(); if(${doubleClick ? "true" : "false"}) button.click(); await new Promise((resolve)=>setTimeout(resolve,0)); return {found:true,disabled:button.disabled};})()`);
    const restoreCancel = await openRestore(sourceBackup.id);
    const restoreCancelResult = await win.webContents.executeJavaScript(`(()=>{document.querySelector('#data-lifecycle-restore-dialog [data-close-dialog]')?.click(); return {open:document.getElementById('data-lifecycle-restore-dialog')?.open===true};})()`);
    check("Restore cancel closes product dialog without IPC or write", restoreCancel.found && restoreCancel.open && restoreCancelResult.open === false && restoreCalls === 0 && (await readFile(join(dataDir, "desktop-state", "settings.json"), "utf8")).includes("P48_RETRY_MUTATED_STATE"), JSON.stringify({ restoreCancel, restoreCancelResult, restoreCalls }));

    const restoreConfirmDialog = await openRestore(sourceBackup.id);
    const restoreConfirmResult = await restoreConfirm();
    await sleep(450);
    const restoredSettings = await readFile(join(dataDir, "desktop-state", "settings.json"), "utf8");
    const restoreSuccess = await win.webContents.executeJavaScript("document.getElementById('data-lifecycle-result')?.textContent||''");
    check("Restore confirm calls existing backend and preserves safe success refresh", restoreConfirmDialog.found && restoreConfirmResult.found && restoreCalls === 1 && restoredSettings.includes("P48_RESTORE_SOURCE") && restoreSuccess.includes("Backup restored") && !restoreSuccess.includes(dataDir), JSON.stringify({ restoreConfirmDialog, restoreConfirmResult, restoreCalls, restoreSuccess }));

    await writeFile(join(dataDir, "desktop-state", "settings.json"), JSON.stringify({ schema: "sovereignbot.desktop.settings.v1", theme: "retry", fixtureMarker: "P48_RESTORE_RETRY_MUTATED" }), "utf8");
    restoreFailOnce = true;
    const restoreFailureDialog = await openRestore(restoreRetryBackup.id);
    const restoreFailureConfirm = await restoreConfirm(true);
    await sleep(300);
    const restoreFailureState = await win.webContents.executeJavaScript(`(()=>({open:document.getElementById('data-lifecycle-restore-dialog')?.open===true,text:document.getElementById('data-lifecycle-restore-dialog')?.textContent||''}))()`);
    const restoreRetryConfirm = await restoreConfirm();
    await sleep(450);
    const restoreRetrySettings = await readFile(join(dataDir, "desktop-state", "settings.json"), "utf8");
    check("Restore IPC failure stays visible, keeps dialog retryable, and retry succeeds", restoreFailureDialog.found && restoreFailureConfirm.found && restoreFailureState.open && restoreFailureState.text.includes("Backup could not be restored") && !restoreFailureState.text.includes(dataDir) && restoreRetryConfirm.found && restoreCalls === 3 && restoreRetrySettings.includes("P48_MUTATED_STATE"), JSON.stringify({ restoreFailureDialog, restoreFailureConfirm, restoreFailureState, restoreRetryConfirm, restoreCalls }));

    const resetDialog = await win.webContents.executeJavaScript(`(()=>{document.getElementById('data-lifecycle-reset')?.click(); const dialog=document.getElementById('data-lifecycle-reset-dialog'); return {open:dialog?.open===true,text:dialog?.textContent||'',disabled:document.getElementById('data-lifecycle-reset-confirm')?.disabled};})()`);
    const resetCancel = await win.webContents.executeJavaScript(`(()=>{document.querySelector('#data-lifecycle-reset-dialog [data-close-dialog]')?.click(); return {open:document.getElementById('data-lifecycle-reset-dialog')?.open===true};})()`);
    check("Clean Reset cancel closes dialog without prepare/reset IPC", resetDialog.open && resetDialog.text.includes("Protected credentials") && resetDialog.disabled && resetCancel.open === false && prepareResetCalls === 0 && resetCalls === 0, JSON.stringify({ resetDialog, resetCancel, prepareResetCalls, resetCalls }));

    const resetWrong = await win.webContents.executeJavaScript(`(()=>{document.getElementById('data-lifecycle-reset')?.click(); const phrase=document.getElementById('data-lifecycle-reset-phrase'); phrase.value='reset'; phrase.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('data-lifecycle-reset-form')?.requestSubmit(); return {open:document.getElementById('data-lifecycle-reset-dialog')?.open===true,disabled:document.getElementById('data-lifecycle-reset-confirm')?.disabled,error:document.getElementById('data-lifecycle-reset-error')?.textContent||''};})()`);
    await sleep(120);
    check("Clean Reset wrong phrase is blocked without write", resetWrong.open && resetWrong.disabled && resetWrong.error.includes("Type RESET exactly") && prepareResetCalls === 0 && resetCalls === 0, JSON.stringify({ resetWrong, prepareResetCalls, resetCalls }));
    await win.webContents.executeJavaScript("document.querySelector('#data-lifecycle-reset-dialog [data-close-dialog]')?.click()");

    prepareFailOnce = true;
    const resetFailure = await win.webContents.executeJavaScript(`(()=>{document.getElementById('data-lifecycle-reset')?.click(); const phrase=document.getElementById('data-lifecycle-reset-phrase'); phrase.value='RESET'; phrase.dispatchEvent(new Event('input',{bubbles:true})); const button=document.getElementById('data-lifecycle-reset-confirm'); button.click(); button.click(); return {open:document.getElementById('data-lifecycle-reset-dialog')?.open===true,disabled:button.disabled};})()`);
    await sleep(320);
    const resetFailureState = await win.webContents.executeJavaScript(`(()=>({open:document.getElementById('data-lifecycle-reset-dialog')?.open===true,text:document.getElementById('data-lifecycle-reset-dialog')?.textContent||''}))()`);
    check("Clean Reset prepare IPC failure is visible, non-destructive, and duplicate-safe", resetFailure.open && resetFailure.disabled && resetFailureState.open && resetFailureState.text.includes("Clean reset could not be completed") && !resetFailureState.text.includes(dataDir) && prepareResetCalls === 1 && resetCalls === 0, JSON.stringify({ resetFailure, resetFailureState, prepareResetCalls, resetCalls }));

    const resetRetry = await win.webContents.executeJavaScript(`(()=>{const button=document.getElementById('data-lifecycle-reset-confirm'); button.click(); button.click(); return {disabled:button.disabled};})()`);
    await sleep(650);
    const resetResult = await win.webContents.executeJavaScript(`(()=>({open:document.getElementById('data-lifecycle-reset-dialog')?.open===true,status:document.getElementById('data-lifecycle-result')?.textContent||'',body:document.getElementById('data-lifecycle-card')?.textContent||''}))()`);
    check("Clean Reset exact RESET uses opaque backend confirmation and refreshes safely", resetRetry.disabled && !resetResult.open && resetResult.status.includes("Product state reset completed") && prepareResetCalls === 2 && resetCalls === 1 && lastPrepared?.confirmation && !resetResult.body.includes(lastPrepared.confirmation) && !resetResult.body.includes(dataDir), JSON.stringify({ resetRetry, resetResult: { open: resetResult.open, status: resetResult.status }, prepareResetCalls, resetCalls }));
    check("Data Lifecycle gate leaves no public nonce or raw path after reset", !resetResult.body.includes(dataDir) && !resetResult.body.includes(lastPrepared?.confirmation ?? "unavailable-confirmation"), JSON.stringify({ body: resetResult.body }));
  } catch (error) {
    check("P48 Data Lifecycle hidden gate completed", false, String(error?.message ?? error));
  } finally {
    try { unbind?.(); } catch {}
    try { uninstallProtocol?.(); } catch {}
    try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch {}
    try { if (dataDir) await rm(`${dataDir}.backups`, { recursive: true, force: true }); } catch {}
    try { if (dataDir) await rm(`${dataDir}.exports`, { recursive: true, force: true }); } catch {}
  }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  const result = { schema: "sovereignbot.desktop.p48-data-lifecycle-canary.v1", fixtureBoundary: "LOCAL_FIXTURE", publishEligible: false, checks: Object.fromEntries(Object.entries(checks).map(([name, ok]) => [name, { ok }])), notes, externalActions: [], ok: failed.length === 0 };
  await writeFile(join(EVIDENCE_DIR, "verify-p48-data-lifecycle.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(join(EVIDENCE_DIR, "verify-p48-data-lifecycle.log"), `${notes.join("\n")}\n`, "utf8");
  const exitCode = failed.length ? 1 : 0;
  if (app?.exit) { app.exit(exitCode); return result; }
  if (exitCode) throw new Error(`P48 Data Lifecycle gate failed: ${failed.join(", ")}`);
  return result;
}
