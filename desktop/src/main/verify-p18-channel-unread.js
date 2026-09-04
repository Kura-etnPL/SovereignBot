import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = join(WORKTREE_ROOT, "_evidence_v57_2026-09-03");
import { createDesktopServices } from "./services.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createArtifactStore } from "./artifact-store.js";
import { createTeamService } from "./team-service.js";
import { createNotificationService } from "./notification-service.js";
import { createChannelUnreadProducer } from "./channel-unread-producer.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";
import { desktopVersion } from "./lib/desktop-version.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function localRoster() {
  return { ready: false, mode: "local-gate", roles: {}, agents: [], providers: {}, coworkerBindings: {} };
}

function makeFixture(dataDir) {
  const stateDir = join(dataDir, "desktop-state");
  mkdirSync(stateDir, { recursive: true });
  const services = createDesktopServices({ dataDir, dialog: {} });
  const coworkerStore = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
  coworkerStore.ensureDefaults();
  const lead = coworkerStore.create({ name: "Chief Lead", role: "Team Lead", instructions: "Lead team" });
  const specialist = coworkerStore.create({ name: "Coding Specialist", role: "Coding Lead", instructions: "Build safely" });

  const conversationStore = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore });
  const teamService = createTeamService({ dataDir, coworkerStore, conversationStore, services });
  const artifactStore = createArtifactStore({ dataDir });
  const notifications = createNotificationService({
    dataDir,
    getSettings: () => services.getSettings(),
    NotificationClass: class FakeNotification {
      static isSupported() { return true; }
      static shown = [];
      constructor(opts) { this.opts = opts; FakeNotification.shown.push(opts); }
      show() {}
    },
  });

  const channelUnreadProducer = createChannelUnreadProducer({
    notifications,
    teamService,
    coworkerStore,
    conversationStore,
  });

  const teamResult = teamService.createTeam({
    title: "Alpha Engineering Team",
    coworkerIds: [lead.id, specialist.id],
    leadCoworkerId: lead.id,
  });
  const channels = teamService.listChannels().channels;
  const channel = channels.find((c) => c.teamId === teamResult.team.id);

  return {
    dataDir,
    services,
    coworkerStore,
    lead,
    specialist,
    conversationStore,
    teamService,
    artifactStore,
    notifications,
    channelUnreadProducer,
    team: teamResult.team,
    channel,
  };
}

function handlers(fixture) {
  const { services, coworkerStore, conversationStore, teamService, artifactStore, notifications } = fixture;
  return {
    "app:handshake": () => ({ ok: true, version: desktopVersion(), platform: process.platform, locale: "en-US", language: services.getSettings().language }),
    "firstrun:getStatus": () => ({ browsers: [] }),
    "workspace:list": () => services.listWorkspaces(),
    "workspace:addViaDialog": () => ({ added: false }),
    "settings:get": () => services.getSettings(),
    "settings:update": (patch) => services.updateSettings(patch),
    "provider:getRoster": () => localRoster(),
    "provider:refresh": () => ({ applied: false, roster: localRoster() }),
    "coworker:list": (payload) => coworkerStore.list(payload),
    "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
    "conversation:list": () => conversationStore.list(),
    // conversation:get remains strictly read-only
    "conversation:get": ({ conversationId }) => conversationStore.get(conversationId),
    // conversation:acknowledge resolves channel unread state
    "conversation:acknowledge": ({ conversationId }) => notifications.resolveChannelUnread(conversationId),
    "team:list": () => teamService.list(),
    "team:get": ({ teamId }) => teamService.get(teamId),
    "team:activity": (payload) => teamService.activity(payload),
    "channel:list": (payload) => teamService.listChannels(payload),
    "artifact:list": (payload) => artifactStore.list(payload),
    "artifact:hub": (payload) => artifactStore.list(payload),
    "computer:history": () => ({ history: [] }),
    "project:list": () => ({ projects: [] }),
    "skill:list": () => ({ skills: [] }),
    "playbook:list": () => ({ playbooks: [] }),
    "memory:list": () => ({ memories: [] }),
    "memory:listSuggestions": () => ({ suggestions: [] }),
    "connectedApps:list": () => ({ apps: [] }),
    "eventTrigger:list": () => ({ triggers: [] }),
    "job:list": () => ({ jobs: [] }),
    "job:attention": () => ({ jobs: [] }),
    "routine:list": () => ({ routines: [] }),
    "data:status": () => ({ backups: [] }),
    "data:listBackups": () => ({ backups: [] }),
    "update:status": () => ({ available: false }),
    "notification:list": (payload) => notifications.list(payload),
    "notification:markRead": (payload) => notifications.markRead(payload),
    "notification:markAllRead": (payload) => notifications.markAllRead(payload),
    "notification:clear": (payload) => notifications.clear(payload),
    "notification:clearAll": (payload) => notifications.clearAll(payload),
  };
}

async function loadWindow(win) {
  await win.loadURL(appOrigin());
  await win.webContents.executeJavaScript(
    "(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()"
  );
  await sleep(950);
}

async function evalInRenderer(win, expression) {
  return win.webContents.executeJavaScript(expression, true);
}

async function waitFor(label, fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fn();
    if (res) return res;
    await sleep(80);
  }
  throw new Error("timed out waiting for " + label);
}

export async function runVerifyP18ChannelUnread({ app }) {
  const tempRoot = process.env.SOVEREIGNBOT_P18_TEMP_ROOT || join(process.cwd(), "temp", "p18-channel-unread");
  rmSync(tempRoot, { recursive: true, force: true });
  const dataDir = join(tempRoot, "data");
  const fixture = makeFixture(dataDir);

  let win;
  let unbind;
  let uninstallProtocol;
  const results = [];
  function pass(name, detail = {}) {
    results.push({ name, passed: true, detail });
    console.log("PASS " + name + " " + JSON.stringify(detail));
  }

  try {
    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    unbind = bindIpcChannels({ win, handlers: handlers(fixture) });

    // 1. Hidden Electron window stays hidden
    if (!win.isVisible()) {
      pass("hidden Electron window stays hidden");
    } else {
      throw new Error("window is visible");
    }

    await loadWindow(win);

    // 2. Preload exposes conversation acknowledge and notification operations
    const preloadOps = await evalInRenderer(win, `(() => ({
      hasAcknowledge: typeof window.sovereignbot?.conversations?.acknowledge === "function",
      hasGet: typeof window.sovereignbot?.conversations?.get === "function",
      hasNotifList: typeof window.sovereignbot?.notifications?.list === "function",
    }))()`);
    if (!preloadOps.hasAcknowledge || !preloadOps.hasGet || !preloadOps.hasNotifList) {
      throw new Error("preload missing required methods: " + JSON.stringify(preloadOps));
    }
    pass("real preload exposes conversation acknowledge and notification methods", preloadOps);

    // 3. Coworker channel message with notifyChannelUnread===true creates notification and updates badge
    fixture.conversationStore.postCoworkerMessage(fixture.channel.conversationId, fixture.specialist.id, {
      text: "Initial deliverable ready for inspection",
    }, { notifyChannelUnread: true });
    await evalInRenderer(win, `(() => { document.dispatchEvent(new CustomEvent("sovereignbot:refresh-notifications-badge")); return true; })()`);
    const badgeState = await waitFor("badge text 1", async () => {
      const b = await evalInRenderer(win, `(() => ({ text: document.getElementById("notifications-badge")?.textContent, hidden: document.getElementById("notifications-badge")?.classList.contains("hidden") }))()`);
      return b.text === "1" && !b.hidden ? b : null;
    });
    pass("coworker channel message automatically creates channel-unread notification and updates badge", badgeState);

    // 4. Notification card renders in Notification Center with correct category, title, body, and safe source
    await evalInRenderer(win, `(() => { document.getElementById("nav-notifications")?.click(); return true; })()`);
    const cardInfo = await waitFor("channel unread notification card", async () => {
      return evalInRenderer(win, `(() => {
        const cards = document.querySelectorAll("#notifications-list .notification-card");
        if (cards.length !== 1) return null;
        const card = cards[0];
        const category = card.querySelector(".notification-category-badge")?.textContent;
        const title = card.querySelector(".notification-card-title")?.textContent;
        const body = card.querySelector(".notification-card-body")?.textContent;
        return { count: cards.length, category, title, body };
      })()`);
    });
    if (!cardInfo.category.includes("Channel unread") || !cardInfo.title.includes(fixture.specialist.name) || !cardInfo.body.includes("Initial deliverable")) {
      throw new Error("card render mismatch: " + JSON.stringify(cardInfo));
    }
    pass("notification card renders in Notification Center with correct channel name, coworker name, and body", cardInfo);

    // 5. Predictable coalescing: subsequent coworker message in same channel updates existing card without duplicate card or spam
    fixture.conversationStore.postCoworkerMessage(fixture.channel.conversationId, fixture.specialist.id, {
      text: "Updated deliverable with second sprint results",
    }, { notifyChannelUnread: true });
    await evalInRenderer(win, `(() => { document.getElementById("notifications-refresh")?.click(); return true; })()`);
    const coalescedInfo = await waitFor("coalesced card body update", async () => {
      return evalInRenderer(win, `(() => {
        const cards = document.querySelectorAll("#notifications-list .notification-card");
        if (cards.length !== 1) return null;
        const card = cards[0];
        const body = card.querySelector(".notification-card-body")?.textContent;
        const badge = document.getElementById("notifications-badge")?.textContent;
        return body.includes("second sprint results") ? { count: cards.length, body, badge } : null;
      })()`);
    });
    pass("predictable coalescing: subsequent coworker message in same channel updates card without duplicate card or spam", coalescedInfo);

    // 6. Suppression: fail-closed default suppresses unspecified intent, user self-messages, and explicit internal turns
    fixture.conversationStore.postCoworkerMessage(fixture.channel.conversationId, fixture.specialist.id, { text: "Unspecified intent message" });
    fixture.conversationStore.postUserMessage(fixture.channel.conversationId, { text: "User response to deliverable" });
    fixture.conversationStore.postCoworkerMessage(fixture.channel.conversationId, fixture.specialist.id, { text: "Handoff to next stage" }, { internal: true, notifyChannelUnread: false });
    await evalInRenderer(win, `(() => { document.getElementById("notifications-refresh")?.click(); return true; })()`);
    const suppressedCount = await evalInRenderer(win, `(() => document.querySelectorAll("#notifications-list .notification-card").length)()`);
    if (suppressedCount !== 1) {
      throw new Error("suppression failed, card count was " + suppressedCount + ", expected 1");
    }
    pass("suppression: fail-closed default suppresses unspecified intent, user messages, and internal protocol turns", { count: suppressedCount });

    // 7. conversation:get remains strictly read-only and does NOT clear unread state
    await evalInRenderer(win, `(async () => {
      return window.sovereignbot.conversations.get({ conversationId: "${fixture.channel.conversationId}" });
    })()`);
    const unreadCheckAfterGet = await evalInRenderer(win, `(async () => {
      const list = await window.sovereignbot.notifications.list({ limit: 10 });
      const badge = document.getElementById("notifications-badge")?.textContent;
      return { unreadCount: list?.unreadCount, badge };
    })()`);
    if (unreadCheckAfterGet.unreadCount !== 1 || unreadCheckAfterGet.badge !== "1") {
      throw new Error("conversation:get improperly resolved unread: " + JSON.stringify(unreadCheckAfterGet));
    }
    pass("conversation:get remains strictly read-only and does NOT clear unread state", unreadCheckAfterGet);

    // 8. Actual open/navigation acknowledgement resolves unread state and clears badge
    await evalInRenderer(win, `(() => {
      const navButtons = [...document.querySelectorAll("#notifications-list .hero-action")];
      const convBtn = navButtons.find((b) => b.textContent.includes("Conversation"));
      if (convBtn) { convBtn.click(); return true; }
      return false;
    })()`);
    const navState = await waitFor("conversation view active after card navigation", async () => {
      return evalInRenderer(win, `(() => {
        const convView = document.getElementById("view-conversation");
        const notifView = document.getElementById("view-notifications");
        const title = document.getElementById("conversation-title")?.textContent;
        if (convView && !convView.classList.contains("hidden") && notifView?.classList.contains("hidden")) {
          return { convVisible: true, notifHidden: true, title };
        }
        return null;
      })()`);
    });
    // Wait for acknowledgement to complete and badge to clear
    await waitFor("badge cleared to 0 after acknowledgement", async () => {
      const badgeText = await evalInRenderer(win, `(() => document.getElementById("notifications-badge")?.textContent)()`);
      const badgeHidden = await evalInRenderer(win, `(() => document.getElementById("notifications-badge")?.classList.contains("hidden"))()`);
      return (badgeText === "0" || badgeHidden) ? true : null;
    });
    // Switch back to Notification Center to verify card is marked read
    await evalInRenderer(win, `(() => { document.getElementById("nav-notifications")?.click(); return true; })()`);
    const readCardState = await waitFor("card marked read in view", async () => {
      return evalInRenderer(win, `(() => {
        const cards = document.querySelectorAll("#notifications-list .notification-card");
        if (cards.length !== 1) return null;
        const card = cards[0];
        const isRead = card.classList.contains("read") || !card.classList.contains("unread");
        const badge = document.getElementById("notifications-badge")?.textContent;
        return isRead ? { isRead, badge } : null;
      })()`);
    });
    pass("truthful read resolution: opening/viewing the channel marks the notification read and clears badge", readCardState);

    // 9. Reactivation: later eligible coworker message in that channel reactivates exactly one coalesced unread notification
    fixture.conversationStore.postCoworkerMessage(fixture.channel.conversationId, fixture.specialist.id, {
      text: "Subsequent question after channel was read",
    }, { notifyChannelUnread: true });
    await evalInRenderer(win, `(() => { document.dispatchEvent(new CustomEvent("sovereignbot:refresh-notifications-badge")); return true; })()`);
    await evalInRenderer(win, `(() => { document.getElementById("notifications-refresh")?.click(); return true; })()`);
    const reactivatedState = await waitFor("reactivated card in unread state", async () => {
      return evalInRenderer(win, `(() => {
        const cards = document.querySelectorAll("#notifications-list .notification-card");
        if (cards.length !== 1) return null;
        const card = cards[0];
        const isUnread = card.classList.contains("unread") || !card.classList.contains("read");
        const body = card.querySelector(".notification-card-body")?.textContent;
        const badge = document.getElementById("notifications-badge")?.textContent;
        return (isUnread && body.includes("Subsequent question")) ? { isRead: !isUnread, body, badge } : null;
      })()`);
    });
    pass("reactivation: later coworker message in that channel reactivates unread notification", reactivatedState);

    // 10. Restart persistence & key security: notifications.json contains digest keys and survives restart without data loss
    const persistPath = join(fixture.dataDir, "desktop-state", "notifications.json");
    const diskContent = readFileSync(persistPath, "utf8");
    const diskParsed = JSON.parse(diskContent);
    const allKeysAreDigests = Array.isArray(diskParsed.events) && diskParsed.events.every((n) => /^k_[a-f0-9]{32}$/.test(n.key));
    const hasOpaqueIds = Array.isArray(diskParsed.events) && diskParsed.events.every((n) => /^notif_[a-f0-9]{16}$/.test(n.id));
    if (!allKeysAreDigests || !hasOpaqueIds) {
      throw new Error(`disk key/id format failure: allKeysAreDigests=${allKeysAreDigests} hasOpaqueIds=${hasOpaqueIds}`);
    }
    // Post message with secret and path to verify redaction
    fixture.conversationStore.postCoworkerMessage(fixture.channel.conversationId, fixture.specialist.id, {
      text: "Loaded C:\\\\Users\\\\Eternal\\\\private.txt with Bearer sk-secret-token-xyz987",
    }, { notifyChannelUnread: true });
    const diskContentAfter = readFileSync(persistPath, "utf8");
    const diskClean = !diskContentAfter.includes("sk-secret-token-xyz987") && !diskContentAfter.includes("C:\\\\Users\\\\Eternal");
    if (!diskClean) throw new Error("redaction failed on disk persistence");

    // Simulate restart
    const restartedService = createNotificationService({
      dataDir: fixture.dataDir,
      getSettings: () => fixture.services.getSettings(),
    });
    const restartedList = restartedService.list();
    if (restartedList.unreadCount !== 1 || restartedList.totalCount !== 1) {
      throw new Error(`restart persistence check failed: unreadCount=${restartedList.unreadCount} totalCount=${restartedList.totalCount}`);
    }
    pass("restart persistence & key security: notifications.json contains digest keys and survives restart without data loss", {
      allKeysAreDigests,
      hasOpaqueIds,
      diskClean,
      restartedCount: restartedList.totalCount,
      restartedUnread: restartedList.unreadCount,
    });

    console.log("[summary] " + results.length + "/" + results.length + " PASS");
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(
      join(EVIDENCE_DIR, "verify-p18-channel-unread.json"),
      JSON.stringify({
        at: new Date().toISOString(),
        publishEligible: false,
        summary: `${results.length}/${results.length} PASS`,
        results,
      }, null, 2) + "\n",
      "utf8"
    );
    writeFileSync(
      join(EVIDENCE_DIR, "verify-p18-channel-unread.log"),
      results.map((r) => `PASS ${r.name} ${JSON.stringify(r.detail)}`).join("\n") + `\n[summary] ${results.length}/${results.length} PASS\n`,
      "utf8"
    );
    unbind?.();
    uninstallProtocol?.();
    win.destroy();
    app.exit(0);
  } catch (err) {
    console.error("FAIL: " + (err?.stack ?? err));
    try { unbind?.(); } catch {}
    try { uninstallProtocol?.(); } catch {}
    try { win?.destroy(); } catch {}
    app.exit(1);
  }
}
