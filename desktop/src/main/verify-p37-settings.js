// P37 hidden acceptance gate for Settings hierarchy. All provider/workspace
// state is a disconnected local fixture; no login, dialog, backup, update, or network action is used.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createDesktopServices } from "./services.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(WORKTREE_ROOT, "docs", "acceptance");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixtureRoster() {
  const unavailable = (reason) => ({ found: false, enabled: true, health: "unavailable", usable: false, reason });
  return { mode: "provider", ready: false, roles: {}, agents: [], coworkerBindings: {}, providers: {
    codex: unavailable("Codex is not connected."),
    claude: unavailable("Claude Code is not connected."),
    "chatgpt-web": unavailable("ChatGPT Web is not connected."),
    antigravity: unavailable("Antigravity is not connected."),
    economy: { ...unavailable("No Economy provider is configured."), configured: false },
  } };
}

function makeFixture(dataDir) {
  const stateDir = join(dataDir, "desktop-state");
  mkdirSync(stateDir, { recursive: true });
  const services = createDesktopServices({ dataDir, dialog: {} });
  const coworkerStore = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
  const conversationStore = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore });
  return { services, coworkerStore, conversationStore, calls: Object.create(null) };
}

function handlers(fixture) {
  const { services, coworkerStore, conversationStore, calls } = fixture;
  const count = (name, fn) => (...args) => { calls[name] = (calls[name] ?? 0) + 1; return fn(...args); };
  const empty = (key) => () => ({ [key]: [] });
  return {
    "app:handshake": () => ({ ok: true, version: "4.0.0", platform: process.platform, locale: "en-US", language: "en" }),
    "firstrun:getStatus": () => ({ browsers: [], providers: {} }),
    "settings:get": () => services.getSettings(),
    "settings:update": count("settings:update", (patch) => services.updateSettings(patch)),
    "workspace:list": () => services.listWorkspaces(),
    "workspace:addViaDialog": count("workspace:addViaDialog", () => ({ cancelled: true })),
    "workspace:setDefault": count("workspace:setDefault", () => ({ ok: true })),
    "workspace:remove": count("workspace:remove", () => ({ ok: true })),
    "coworker:list": (payload) => coworkerStore.list(payload),
    "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
    "conversation:list": () => conversationStore.list(),
    "conversation:get": ({ conversationId }) => conversationStore.get(conversationId),
    "team:list": empty("teams"),
    "team:activity": empty("events"),
    "project:list": empty("projects"),
    "connectedApps:list": empty("apps"),
    "data:status": () => ({ stateVersion: 1, backups: [] }),
    "data:listBackups": empty("backups"),
    "skill:list": empty("skills"),
    "job:list": empty("jobs"),
    "job:attention": empty("jobs"),
    "routine:list": empty("routines"),
    "eventTrigger:list": empty("triggers"),
    "memory:list": empty("memories"),
    "memory:listSuggestions": empty("suggestions"),
    "artifact:list": empty("artifacts"),
    "provider:getRoster": () => fixtureRoster(),
    "provider:refresh": count("provider:refresh", () => ({ applied: false, roster: fixtureRoster() })),
    "provider:openLogin": count("provider:openLogin", () => ({ cancelled: true })),
    "update:status": () => ({ available: false, currentVersion: "4.0.0", channel: "stable" }),
    "notification:list": () => ({ notifications: [], totalCount: 0, unreadCount: 0 }),
    "computerTarget:list": () => ({ targets: [] }),
  };
}

async function loadWindow(win) {
  await win.loadURL(appOrigin());
  await win.webContents.executeJavaScript("(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()");
  await sleep(1100);
}

async function invoke(win, expression) { return win.webContents.executeJavaScript(`(${expression})()`); }

export async function runVerifyP37Settings({ app } = {}) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const checks = {};
  const notes = [];
  const check = (name, ok, detail = "") => {
    checks[name] = { ok: Boolean(ok), ...(detail ? { detail } : {}) };
    notes.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`);
    try { process.stderr.write(`${notes.at(-1)}\n`); } catch {}
  };
  const result = { schema: "sovereignbot.desktop.p37-settings-canary.v1", fixtureBoundary: "LOCAL_FIXTURE", publishEligible: false, checks, notes, externalActions: [] };
  let dataDir;
  let win;
  let uninstallProtocol;
  try {
    dataDir = mkdtempSync(join(tmpdir(), "sovereign-p37-data-"));
    const fixture = makeFixture(dataDir);
    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    bindIpcChannels({ win, handlers: handlers(fixture) });
    check("hidden Electron window stays hidden", win.isVisible() === false);
    await loadWindow(win);
    await invoke(win, `async()=>{ document.getElementById("nav-settings")?.click(); return true; }`);
    await sleep(1100);
    const initial = await invoke(win, `async()=>({
      view: document.getElementById("view-settings")?.classList.contains("hidden") === false,
      advancedOpen: document.querySelector("#view-settings .advanced-card")?.open === true,
      providersInAdvanced: !!document.querySelector("#view-settings .advanced-card #provider-cards"),
      workspacesInAdvanced: !!document.querySelector("#view-settings .advanced-card #workspace-manager-list"),
      roster: !!document.getElementById("advanced-roster"),
      appearance: !!document.getElementById("setting-language") && !!document.getElementById("setting-theme"),
      model: !!document.getElementById("setting-default-model-profile"),
      computer: !!document.getElementById("provision-driver"),
      connectedApps: !!document.getElementById("connected-apps-list"),
      notifications: !!document.getElementById("setting-notifications"),
      backup: !!document.getElementById("data-lifecycle-card"),
      updates: !!document.getElementById("update-card"),
      advancedLabel: document.querySelector("#view-settings .advanced-card summary")?.textContent || "",
    })`);
    check("ordinary Settings view is visible", initial.view, JSON.stringify(initial));
    check("Advanced is closed by default", initial.advancedOpen === false, JSON.stringify(initial));
    check("ordinary settings cards remain visible", initial.appearance && initial.model && initial.computer && initial.connectedApps && initial.notifications && initial.backup && initial.updates, JSON.stringify(initial));
    check("providers, workspaces, and roster are inside Advanced", initial.providersInAdvanced && initial.workspacesInAdvanced && initial.roster, JSON.stringify(initial));
    check("Advanced label is bilingual", /Advanced|高级/.test(initial.advancedLabel), JSON.stringify(initial));

    await invoke(win, `async()=>{ document.querySelector("#view-settings .advanced-card summary")?.click(); return true; }`);
    await sleep(250);
    const opened = await invoke(win, `async()=>({
      open: document.querySelector("#view-settings .advanced-card")?.open === true,
      providerRefresh: !!document.getElementById("settings-refresh-providers") && !document.getElementById("settings-refresh-providers").disabled,
      addWorkspace: !!document.getElementById("add-workspace") && !document.getElementById("add-workspace").disabled,
      providers: document.getElementById("provider-cards")?.children.length || 0,
      roster: document.getElementById("advanced-roster")?.textContent || "",
    })`);
    check("Advanced opens and exposes provider/workspace controls", opened.open && opened.providerRefresh && opened.addWorkspace, JSON.stringify(opened));
    check("Advanced provider roster is rendered", opened.providers > 0 && typeof opened.roster === "string", JSON.stringify(opened));
    const callsBeforeRefresh = { ...fixture.calls };
    await invoke(win, `async()=>{ document.getElementById("settings-refresh-providers")?.click(); return true; }`);
    await sleep(500);
    const afterRefresh = await invoke(win, `async()=>({ open: document.querySelector("#view-settings .advanced-card")?.open === true, dialogs: document.querySelectorAll("dialog[open]").length })`);
    const writeCalls = Object.fromEntries(Object.entries(fixture.calls).filter(([key]) => key !== "provider:refresh"));
    check("existing Advanced provider refresh binding remains active", (fixture.calls["provider:refresh"] ?? 0) > (callsBeforeRefresh["provider:refresh"] ?? 0), JSON.stringify(fixture.calls));
    check("Advanced interaction performs no dialog or write action", afterRefresh.open && afterRefresh.dialogs === 0 && Object.values(writeCalls).every((value) => value === 0), JSON.stringify({ afterRefresh, writeCalls }));
    await invoke(win, `async()=>{ document.querySelector("#view-settings .advanced-card summary")?.click(); return true; }`);
    await sleep(200);
    const closed = await invoke(win, `async()=>({ open: document.querySelector("#view-settings .advanced-card")?.open === true, providersInDom: !!document.getElementById("provider-cards") })`);
    check("Advanced closes without dropping its content", !closed.open && closed.providersInDom, JSON.stringify(closed));
  } catch (error) {
    result.error = String(error?.stack ?? error).slice(0, 4000);
    check("P37 hidden Settings gate completed", false, String(error?.message ?? error).slice(0, 500));
  }
  result.ok = Object.values(checks).every((entry) => entry.ok);
  writeFileSync(join(EVIDENCE_DIR, "verify-p37-settings.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(join(EVIDENCE_DIR, "verify-p37-settings.log"), `${notes.join("\n")}\n`, "utf8");
  try { uninstallProtocol?.(); } catch {}
  try { win?.destroy(); } catch {}
  try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {}
  if (!result.ok) throw new Error(`P37 Settings gate failed: ${Object.entries(checks).filter(([, entry]) => !entry.ok).map(([name]) => name).join(", ")}`);
  app?.exit(0);
}
