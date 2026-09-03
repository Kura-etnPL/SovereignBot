// Hidden real-Electron gate for the Settings Update Apply product dialog.
// It uses only an isolated local fixture and the existing typed update IPC.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationStore } from "./conversation-store.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createDesktopServices } from "./services.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidenceDir = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR;

function updateStatus() {
  return {
    currentVersion: "4.0.0",
    channel: "stable",
    available: { version: "4.0.1", signature: { status: "signed", verified: true } },
    staged: { version: "4.0.1", backupId: "fixture-backup", verified: true },
  };
}

function makeHandlers({ services, coworkerStore, conversationStore, calls }) {
  const empty = (key) => () => ({ [key]: [] });
  return {
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
    "memory:list": () => ({ memories: [], suggestions: [] }),
    "memory:listSuggestions": empty("suggestions"),
    "artifact:list": empty("artifacts"),
    "provider:getRoster": () => ({ ready: false, mode: "provider", roles: {}, agents: [], providers: {}, coworkerBindings: {} }),
    "provider:refresh": () => ({ applied: false, roster: { ready: false, mode: "provider", roles: {}, agents: [], providers: {}, coworkerBindings: {} } }),
    "provider:openLogin": () => ({ canceled: true }),
    "notification:list": () => ({ notifications: [], totalCount: 0, unreadCount: 0 }),
    "computerTarget:list": () => ({ targets: [] }),
    "update:status": () => updateStatus(),
    "update:check": () => updateStatus(),
    "update:stage": () => updateStatus(),
    "update:apply": async () => {
      calls.apply += 1;
      await sleep(140);
      if (calls.apply === 1) throw new Error("Injected update apply failure; safe to retry.");
      return { requested: true, restartRequired: true, version: "4.0.1" };
    },
  };
}

async function invoke(win, expression) { return win.webContents.executeJavaScript(`(${expression})()`); }

async function waitFor(win, expression, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await invoke(win, expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function runVerifyUpdateApplyDialog({ app } = {}) {
  const checks = {};
  const notes = [];
  const check = (name, ok, detail = "") => { checks[name] = { ok: Boolean(ok), ...(detail ? { detail } : {}) }; notes.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); try { process.stdout.write(`${notes.at(-1)}\n`); } catch {} };
  let dataDir;
  let win;
  let uninstallProtocol;
  let unbind;
  const calls = { apply: 0 };
  try {
    dataDir = await mkdtemp(join(tmpdir(), "sovereign-update-dialog-"));
    const stateDir = join(dataDir, "desktop-state");
    await mkdir(stateDir, { recursive: true });
    const services = createDesktopServices({ dataDir, dialog: {} });
    const coworkerStore = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
    coworkerStore.ensureDefaults();
    const conversationStore = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore });
    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    unbind = bindIpcChannels({ win, handlers: makeHandlers({ services, coworkerStore, conversationStore, calls }) });
    check("hidden Electron window stays hidden", win.isVisible() === false);
    await win.loadURL(appOrigin());
    await sleep(900);
    await invoke(win, "async()=>{ document.getElementById('nav-settings')?.click(); return true; }");
    await waitFor(win, "async()=>!!document.getElementById('update-card') && !!document.getElementById('update-apply-dialog')", "Update Apply dialog");

    const opened = await invoke(win, "async()=>{ document.getElementById('update-apply')?.click(); const dialog=document.getElementById('update-apply-dialog'); return { open: dialog?.open===true, summary: dialog?.querySelector('#update-apply-summary')?.textContent||'', native: document.querySelectorAll('dialog[open]').length }; }");
    check("Settings opens the in-product Update Apply confirmation", opened.open && opened.summary.includes("4.0.1") && opened.native === 1, JSON.stringify(opened));
    const cancel = await invoke(win, "async()=>{ document.getElementById('update-apply-cancel')?.click(); return { open: document.getElementById('update-apply-dialog')?.open===true }; }");
    check("Cancel closes Update Apply without IPC or write", !cancel.open && calls.apply === 0, JSON.stringify({ cancel, applyCalls: calls.apply }));

    await invoke(win, "async()=>{ document.getElementById('update-apply')?.click(); return true; }");
    const pending = await invoke(win, "async()=>{ const button=document.getElementById('update-apply-confirm'); button?.click(); button?.click(); return { open: document.getElementById('update-apply-dialog')?.open===true, disabled: button?.disabled===true }; }");
    await waitFor(win, "async()=>document.getElementById('update-apply-error')?.textContent.includes('Injected update apply failure')", "visible apply failure");
    const failure = await invoke(win, "async()=>({ open: document.getElementById('update-apply-dialog')?.open===true, error: document.getElementById('update-apply-error')?.textContent||'', feedback: document.getElementById('update-apply-feedback')?.textContent||'', retryDisabled: document.getElementById('update-apply-confirm')?.disabled===true, text: document.getElementById('update-apply-dialog')?.textContent||'' })");
    check("Apply failure is visible, single-call, and retryable", pending.open && pending.disabled && failure.open && failure.error.includes("Injected update apply failure") && failure.feedback.includes("remains available") && !failure.retryDisabled && calls.apply === 1 && !failure.text.includes(dataDir), JSON.stringify({ pending, failure: { ...failure, text: undefined }, applyCalls: calls.apply }));

    await invoke(win, "async()=>{ const button=document.getElementById('update-apply-confirm'); button?.click(); button?.click(); return true; }");
    await waitFor(win, "async()=>!document.getElementById('update-apply-dialog')?.open && document.getElementById('update-status')?.textContent.includes('restart required')", "successful apply feedback");
    const success = await invoke(win, "async()=>({ open: document.getElementById('update-apply-dialog')?.open===true, status: document.getElementById('update-status')?.textContent||'', statusKind: document.getElementById('update-status')?.dataset.kind||'' })");
    check("Successful Apply closes dialog and clearly reports restart required", !success.open && success.status.includes("Update 4.0.1 requested") && success.status.includes("restart required") && success.statusKind === "success" && calls.apply === 2, JSON.stringify({ ...success, applyCalls: calls.apply }));
  } catch (error) {
    check("Update Apply hidden gate completed", false, String(error?.message ?? error).slice(0, 600));
  } finally {
    try { unbind?.(); } catch {}
    try { uninstallProtocol?.(); } catch {}
    try { win?.destroy(); } catch {}
    try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch {}
  }
  const result = { schema: "sovereignbot.desktop.update-apply-dialog-canary.v1", fixtureBoundary: "LOCAL_FIXTURE", publishEligible: false, checks, notes, externalActions: [], ok: Object.values(checks).every((entry) => entry.ok) };
  if (evidenceDir) { await mkdir(evidenceDir, { recursive: true }); await writeFile(join(evidenceDir, "verify-update-apply-dialog.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8"); await writeFile(join(evidenceDir, "verify-update-apply-dialog.log"), `${notes.join("\n")}\n`, "utf8"); }
  if (!result.ok) throw new Error(`Update Apply gate failed: ${Object.entries(checks).filter(([, entry]) => !entry.ok).map(([name]) => name).join(", ")}`);
  return result;
}
