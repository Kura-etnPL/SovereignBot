// P36 hidden acceptance gate for the first-run Welcome path. It uses the real
// Electron window, sandboxed preload, validated IPC, and canonical local stores.
// Provider status is an explicit disconnected fixture; no login or network is used.
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

function disconnectedRoster() {
  const unavailable = (reason) => ({ found: false, enabled: true, health: "unavailable", usable: false, reason });
  return {
    mode: "provider",
    ready: false,
    roles: {},
    agents: [],
    coworkerBindings: {},
    providers: {
      codex: unavailable("Codex is not connected; use Connect Codex."),
      claude: unavailable("Claude Code is not connected."),
      "chatgpt-web": unavailable("ChatGPT Web is not connected; use Sign in to connect the dedicated profile."),
      antigravity: unavailable("Antigravity is not connected."),
      economy: { ...unavailable("No Economy provider is configured."), configured: false },
    },
  };
}

function makeFixture(dataDir) {
  const stateDir = join(dataDir, "desktop-state");
  mkdirSync(stateDir, { recursive: true });
  const services = createDesktopServices({ dataDir, dialog: {} });
  const coworkerStore = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
  const conversationStore = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore });
  const settings = services.getSettings();
  return { services, coworkerStore, conversationStore, settings };
}

function handlers(fixture) {
  const { services, coworkerStore, conversationStore } = fixture;
  return {
    "app:handshake": () => ({ ok: true, version: "4.0.0", platform: process.platform, locale: "en-US", language: "en" }),
    "firstrun:getStatus": () => ({ browsers: [], providers: { codex: { found: false }, "chatgpt-web": { found: false } } }),
    "settings:get": () => services.getSettings(),
    "settings:update": (patch) => services.updateSettings(patch),
    "workspace:list": () => services.listWorkspaces(),
    "coworker:list": (payload) => coworkerStore.list(payload),
    "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
    "coworker:create": ({ coworker }) => ({ coworker: coworkerStore.create(coworker) }),
    "conversation:list": () => conversationStore.list(),
    "conversation:get": ({ conversationId }) => conversationStore.get(conversationId),
    "conversation:createDirect": ({ coworkerId }) => conversationStore.createDirect(coworkerId),
    "conversation:acknowledge": ({ conversationId }) => ({ resolved: false, count: 0, conversationId }),
    "team:list": () => ({ teams: [], packs: [], channelTemplates: [] }),
    "team:activity": () => ({ events: [] }),
    "project:list": () => ({ projects: [] }),
    "connectedApps:list": () => ({ apps: [] }),
    "data:status": () => ({ backups: [] }),
    "data:listBackups": () => ({ backups: [] }),
    "skill:list": () => ({ skills: [] }),
    "job:list": () => ({ jobs: [] }),
    "job:attention": () => ({ jobs: [] }),
    "routine:list": () => ({ routines: [] }),
    "eventTrigger:list": () => ({ triggers: [] }),
    "memory:list": () => ({ memories: [] }),
    "memory:listSuggestions": () => ({ suggestions: [] }),
    "artifact:list": () => ({ artifacts: [] }),
    "provider:getRoster": () => disconnectedRoster(),
    "provider:refresh": () => ({ applied: false, roster: disconnectedRoster() }),
    "update:status": () => ({ available: false, currentVersion: "4.0.0", channel: "stable" }),
    "notification:list": () => ({ notifications: [], totalCount: 0, unreadCount: 0 }),
    "computerTarget:list": () => ({ targets: [] }),
  };
}

async function loadWindow(win) {
  await win.loadURL(appOrigin());
  await win.webContents.executeJavaScript("(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()");
  await sleep(950);
}

async function invoke(win, expression) {
  return win.webContents.executeJavaScript(`(${expression})()`);
}

export async function runVerifyP36FirstRun({ app } = {}) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const checks = {};
  const notes = [];
  const check = (name, ok, detail = "") => {
    checks[name] = { ok: Boolean(ok), ...(detail ? { detail } : {}) };
    const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`;
    notes.push(line);
    try { process.stderr.write(`${line}\n`); } catch {}
  };
  const result = {
    schema: "sovereignbot.desktop.p36-first-run-canary.v1",
    fixtureBoundary: "LOCAL_FIXTURE",
    publishEligible: false,
    checks,
    notes,
    externalActions: [],
  };
  let dataDir;
  let fixture;
  let win;
  let uninstallProtocol;
  try {
    dataDir = mkdtempSync(join(tmpdir(), "sovereign-p36-data-"));
    fixture = makeFixture(dataDir);
    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    bindIpcChannels({ win, handlers: handlers(fixture) });
    check("hidden Electron window stays hidden", win.isVisible() === false);
    await loadWindow(win);

    const welcome = await invoke(win, `async()=>({
      visible: document.getElementById("view-welcome")?.classList.contains("hidden") === false,
      createCoworker: document.getElementById("welcome-create-coworker")?.textContent || "",
      installSoftwareTeam: document.getElementById("welcome-install-software-team")?.textContent || "",
      providerSummary: document.getElementById("provider-summary")?.textContent || "",
      providerDetail: document.getElementById("provider-readiness-detail")?.textContent || "",
      language: document.documentElement.lang,
    })`);
    check("Welcome is visible on a fresh start", welcome.visible, JSON.stringify(welcome));
    check("Create Coworker is a reachable Welcome action", /Create a coworker/i.test(welcome.createCoworker), JSON.stringify(welcome));
    check("Software Team remains the primary install action", /Install Software Team/i.test(welcome.installSoftwareTeam), JSON.stringify(welcome));
    check("disconnected Codex is projected as Connect Codex", /Connect Codex/i.test(welcome.providerSummary), JSON.stringify(welcome));
    check("disconnected Deep is honest and actionable", /Deep unavailable/i.test(welcome.providerDetail) && /Connect ChatGPT Web/i.test(welcome.providerDetail), JSON.stringify(welcome));

    await invoke(win, `async()=>{ document.getElementById("welcome-create-coworker")?.click(); return true; }`);
    const opened = await invoke(win, `async()=>({
      open: document.getElementById("coworker-dialog")?.open === true,
      name: document.getElementById("coworker-name")?.value || "",
      advancedWorkspace: !!document.getElementById("coworker-workspace"),
      save: !!document.getElementById("coworker-save"),
    })`);
    check("Create Coworker opens the canonical creation dialog", opened.open && opened.name === "" && opened.advancedWorkspace && opened.save, JSON.stringify(opened));

    await invoke(win, `async()=>{
      document.getElementById("coworker-name").value = "P36 Local Coworker";
      document.getElementById("coworker-role").value = "Keep a bounded local brief";
      document.getElementById("coworker-instructions").value = "Return concise local findings.";
      document.getElementById("coworker-form")?.requestSubmit();
      return true;
    }`);
    await sleep(700);
    const created = await invoke(win, `async()=>{
      const listed = await window.sovereignbot.coworkers.list({});
      const coworker = listed.coworkers?.find((entry) => entry.name === "P36 Local Coworker");
      const conversation = (await window.sovereignbot.conversations.list({})).conversations?.find((entry) => entry.kind === "direct" && entry.participants?.includes(coworker?.id));
      return {
        coworker,
        conversation,
        dialogOpen: document.getElementById("coworker-dialog")?.open === true,
        conversationView: document.getElementById("view-conversation")?.classList.contains("hidden") === false,
        title: document.getElementById("conversation-title")?.textContent || "",
      };
    }`);
    check("Create Coworker persists through the canonical IPC path", /^coworker_[a-f0-9]{16}$/i.test(created.coworker?.id ?? "") && !created.dialogOpen, JSON.stringify({ id: created.coworker?.id, dialogOpen: created.dialogOpen }));
    check("created coworker opens a real Direct conversation", created.conversation?.kind === "direct" && created.conversation.participants?.includes(created.coworker.id) && created.conversationView && created.title === "P36 Local Coworker", JSON.stringify({ conversation: created.conversation?.id, title: created.title }));

    await loadWindow(win);
    await invoke(win, `async()=>{ document.querySelector("#coworker-list button")?.click(); return true; }`);
    await sleep(450);
    const restarted = await invoke(win, `async()=>{
      const listed = await window.sovereignbot.coworkers.list({});
      const coworker = listed.coworkers?.find((entry) => entry.name === "P36 Local Coworker");
      const conversations = await window.sovereignbot.conversations.list({});
      const conversation = conversations.conversations?.find((entry) => entry.kind === "direct" && entry.participants?.includes(coworker?.id));
      return { coworker, conversation, view: document.getElementById("view-conversation")?.classList.contains("hidden") === false, title: document.getElementById("conversation-title")?.textContent || "" };
    }`);
    check("coworker and Direct conversation survive a real UI reload", /^coworker_[a-f0-9]{16}$/i.test(restarted.coworker?.id ?? "") && restarted.conversation?.kind === "direct" && restarted.view && restarted.title === "P36 Local Coworker", JSON.stringify({ coworker: restarted.coworker?.id, conversation: restarted.conversation?.id, title: restarted.title }));
  } catch (error) {
    result.error = String(error?.stack ?? error).slice(0, 4000);
    check("P36 hidden first-run gate completed", false, String(error?.message ?? error).slice(0, 500));
  }
  result.ok = Object.values(checks).every((entry) => entry.ok);
  writeFileSync(join(EVIDENCE_DIR, "verify-p36-first-run.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(join(EVIDENCE_DIR, "verify-p36-first-run.log"), `${notes.join("\n")}\n`, "utf8");
  try { uninstallProtocol?.(); } catch {}
  try { win?.destroy(); } catch {}
  try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {}
  if (!result.ok) throw new Error(`P36 first-run gate failed: ${Object.entries(checks).filter(([, entry]) => !entry.ok).map(([name]) => name).join(", ")}`);
  app?.exit(0);
}
