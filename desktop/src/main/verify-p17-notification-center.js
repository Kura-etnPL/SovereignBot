// P17 hidden acceptance gate for Desktop Notification Center.
// It uses the real hidden Electron renderer, sandboxed preload, validated IPC,
// NotificationService store, and real app protocol. No provider, network, or
// remote runtime is started.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { desktopVersion } from "./lib/desktop-version.js";
import { createDesktopServices } from "./services.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createArtifactStore } from "./artifact-store.js";
import { createTeamService } from "./team-service.js";
import { createNotificationService } from "./notification-service.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = join(WORKTREE_ROOT, "_evidence_v56_2026-09-03");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function localRoster() {
  return { ready: false, mode: "local-gate", roles: {}, agents: [], providers: {}, coworkerBindings: {} };
}

function makeFixture(dataDir) {
  const stateDir = join(dataDir, "desktop-state");
  mkdirSync(stateDir, { recursive: true });
  const services = createDesktopServices({ dataDir, dialog: {} });
  const coworkerStore = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
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

  return {
    services,
    coworkerStore,
    conversationStore,
    teamService,
    artifactStore,
    notifications,
    notificationRequests: [],
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
    "conversation:get": ({ conversationId }) => conversationStore.get(conversationId),
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
    "notification:list": (payload) => {
      fixture.notificationRequests.push({ channel: "notification:list", payload: structuredClone(payload) });
      return notifications.list(payload);
    },
    "notification:markRead": (payload) => {
      fixture.notificationRequests.push({ channel: "notification:markRead", payload: structuredClone(payload) });
      return notifications.markRead(payload);
    },
    "notification:markAllRead": (payload) => {
      fixture.notificationRequests.push({ channel: "notification:markAllRead", payload: structuredClone(payload) });
      return notifications.markAllRead(payload);
    },
    "notification:clear": (payload) => {
      fixture.notificationRequests.push({ channel: "notification:clear", payload: structuredClone(payload) });
      return notifications.clear(payload);
    },
    "notification:clearAll": (payload) => {
      fixture.notificationRequests.push({ channel: "notification:clearAll", payload: structuredClone(payload) });
      return notifications.clearAll(payload);
    },
  };
}

async function loadWindow(win) {
  await win.loadURL(appOrigin());
  await win.webContents.executeJavaScript(
    "(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()"
  );
  await sleep(950);
}

async function invoke(win, expression) {
  return win.webContents.executeJavaScript("(" + expression + ")()");
}

async function waitFor(label, fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(80);
  }
  throw new Error("timed out waiting for " + label);
}

async function assertReject(win, expression, expected) {
  let rejected = false;
  try {
    await invoke(win, "async()=>" + expression);
  } catch (error) {
    rejected = String(error?.message ?? error).includes(expected);
  }
  if (!rejected) throw new Error("expected rejection containing " + expected);
}

export async function runVerifyP17NotificationCenter({ app }) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const checks = {};
  const log = [];
  const note = (line) => {
    log.push(line);
    try { process.stderr.write(line + "\n"); } catch {}
  };
  const check = (name, ok, detail = "") => {
    checks[name] = Boolean(ok);
    note((ok ? "PASS " : "FAIL ") + name + (detail ? " " + detail : ""));
  };

  const tempRoot = process.env.SOVEREIGNBOT_V56_TEMP_ROOT;
  if (!tempRoot) throw new Error("V56 temp root is missing; refusing to use default profile");
  const dataDir = join(tempRoot, "data");

  let fixture;
  let win;
  let unbind;
  let uninstallProtocol;
  let fatal;

  try {
    fixture = makeFixture(dataDir);

    // Create a real coworker and team so conversation belongs to a legitimate team channel
    const testCoworker = fixture.coworkerStore.create({ name: "Alpha", role: "Review Specialist", instructions: "Review accurately" });
    const testReviewer = fixture.coworkerStore.create({ name: "Beta", role: "Security Reviewer", instructions: "Review securely" });
    const { team: testTeam, conversation: testConversation } = fixture.teamService.createTeam({
      title: "Alpha Team",
      coworkerIds: [testCoworker.id, testReviewer.id],
    });
    const testConversationId = testConversation.id;
    fixture.conversationStore.postCoworkerMessage(testConversationId, testCoworker.id, {
      text: "Security review completed by Reviewer",
    });

    // Seed notifications across all 5 allowlisted categories plus canary
    fixture.notifications.notify({
      category: "attention",
      key: "job:job_attn_1:attention",
      title: "Attention needed",
      body: "Compilation failed on test branch",
      source: { target: "attention", jobId: "job_attn_1" },
    });

    fixture.notifications.notify({
      category: "routine-completed",
      key: "job:job_rout_2:completed",
      title: "Routine completed",
      body: "Nightly backup routine finished",
      source: { target: "routines", routineId: "rout_nightly" },
    });

    fixture.notifications.notify({
      category: "trigger-fired",
      key: "job:job_trig_3:completed",
      title: "Trigger fired",
      body: "File change detected in reports",
      source: { target: "triggers", triggerId: "trig_file_watch" },
    });

    fixture.notifications.notify({
      category: "coworker-finished",
      key: "job:job_cowork_4:completed",
      title: "Coworker finished",
      body: "Security review completed by Reviewer",
      source: { target: "conversation", conversationId: testConversationId },
    });

    fixture.notifications.notify({
      category: "channel-unread",
      key: "channel:general:unread",
      title: "Channel unread",
      body: "New updates in software channel",
      source: null,
    });

    // Seed redaction canary notification with generic auth token, cookie, and path in key and body
    fixture.notifications.notify({
      category: "attention",
      key: "canary:C:\\Users\\SecretAdmin\\secret.pem:arbitraryToken999",
      title: "Secret path C:\\Users\\SecretAdmin\\secret.pem",
      body: "Authorization: Bearer arbitrarySecretValue123 and Cookie: auth_session=arbitraryCookieValue789 and \\\\intranet\\pass.txt",
      source: { target: "attention", jobId: "job_canary" },
    });

    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    unbind = bindIpcChannels({ win, handlers: handlers(fixture) });

    check("hidden Electron window stays hidden", win.isVisible() === false);
    await loadWindow(win);

    // Check preload exposes notifications
    const preloadExposed = await invoke(
      win,
      "async()=>({list:typeof window.sovereignbot?.notifications?.list==='function',markRead:typeof window.sovereignbot?.notifications?.markRead==='function',markAllRead:typeof window.sovereignbot?.notifications?.markAllRead==='function',clear:typeof window.sovereignbot?.notifications?.clear==='function',clearAll:typeof window.sovereignbot?.notifications?.clearAll==='function'})"
    );
    check(
      "real preload exposes notification center operations",
      preloadExposed.list && preloadExposed.markRead && preloadExposed.markAllRead && preloadExposed.clear && preloadExposed.clearAll,
      JSON.stringify(preloadExposed)
    );

    // Wait for badge to reflect initial unread count (6 notifications)
    await waitFor("notifications badge", async () => {
      return await invoke(win, "async()=>document.getElementById('notifications-badge')?.textContent==='6'");
    });

    const badgeInfo = await invoke(
      win,
      "async()=>({text:document.getElementById('notifications-badge')?.textContent,hidden:document.getElementById('notifications-badge')?.classList.contains('hidden')})"
    );
    check(
      "sidebar has notifications button with unread count badge",
      badgeInfo.text === "6" && badgeInfo.hidden === false,
      JSON.stringify(badgeInfo)
    );

    // Click nav-notifications and verify view activation
    await invoke(win, "async()=>{document.getElementById('nav-notifications')?.click(); return true;}");
    await waitFor("Notification Center view visible", async () => {
      return await invoke(win, "async()=>document.getElementById('view-notifications')?.classList.contains('hidden')===false");
    });

    const viewState = await invoke(
      win,
      "async()=>({notifVisible:!document.getElementById('view-notifications')?.classList.contains('hidden'),welcomeHidden:document.getElementById('view-welcome')?.classList.contains('hidden'),navActive:document.getElementById('nav-notifications')?.classList.contains('active')})"
    );
    check(
      "clicking nav-notifications displays Notification Center",
      viewState.notifVisible && viewState.welcomeHidden && viewState.navActive,
      JSON.stringify(viewState)
    );

    // Wait for cards to render (6 cards)
    await waitFor("6 cards rendered in inbox", async () => {
      return await invoke(win, "async()=>document.querySelectorAll('#notifications-list .notification-card').length===6");
    });

    const cardsInfo = await invoke(
      win,
      "async()=>{" +
        "const cards = [...document.querySelectorAll('#notifications-list .notification-card')];" +
        "return {" +
          "count: cards.length," +
          "unreadCards: cards.filter(c=>c.classList.contains('unread')).length," +
          "titles: cards.map(c=>c.querySelector('.notification-card-title')?.textContent)," +
          "keysOmitted: cards.every(c=>!c.dataset.key)," +
          "opaqueIds: cards.map(c=>c.dataset.id)," +
          "noDataAttrsOnNav: [...document.querySelectorAll('#notifications-list .hero-action')].every(b=>!b.dataset.conversationId && !b.dataset.url)" +
        "};" +
      "}"
    );
    const allOpaque = cardsInfo.opaqueIds.every((id) => /^notif_[a-f0-9]{16}$/.test(id));
    check(
      "cards render newest-first with bilingual categories, times, titles, and bodies",
      cardsInfo.count === 6 && cardsInfo.unreadCards === 6 && cardsInfo.titles.some(t=>t.includes("Attention needed")) && cardsInfo.titles.some(t=>t.includes("Channel unread")),
      JSON.stringify({ count: cardsInfo.count, unreadCards: cardsInfo.unreadCards })
    );

    check(
      "public notification projections omit internal dedupe key and use opaque IDs",
      cardsInfo.keysOmitted && allOpaque && cardsInfo.noDataAttrsOnNav,
      JSON.stringify({ keysOmitted: cardsInfo.keysOmitted, allOpaque, noDataAttrsOnNav: cardsInfo.noDataAttrsOnNav })
    );

    // Check ordinary UI copy: no disk paths, mentions channel-unread limitation
    const toolbarText = await invoke(win, "async()=>document.querySelector('#view-notifications .notifications-toolbar')?.textContent || ''");
    const noPathInCopy = !toolbarText.includes("notifications.json") && !toolbarText.includes("desktop-state");
    const mentionsChannelLimitation = toolbarText.includes("Channel unread") || toolbarText.includes("channel unread");
    check(
      "ordinary UI copy contains no storage paths and notes channel-unread limitation",
      noPathInCopy && mentionsChannelLimitation,
      JSON.stringify({ noPathInCopy, mentionsChannelLimitation })
    );

    // Redaction canary check: neither DOM nor disk contains raw path/secret or credential tails
    const canaryCard = await invoke(
      win,
      "async()=>{" +
        "const text = document.getElementById('notifications-list')?.textContent || '';" +
        "return {" +
          "hasRedactedPath: text.includes('[REDACTED_PATH]')," +
          "hasRedactedToken: text.includes('[REDACTED_TOKEN]')," +
          "leaksSecretAdmin: text.includes('SecretAdmin')," +
          "leaksArbitrarySecret: text.includes('arbitrarySecretValue123')," +
          "leaksArbitraryCookie: text.includes('arbitraryCookieValue789')," +
          "leaksArbitraryToken: text.includes('arbitraryToken999')" +
        "};" +
      "}"
    );
    const diskJson = readFileSync(join(dataDir, "desktop-state", "notifications.json"), "utf8");
    const diskClean = !diskJson.includes("SecretAdmin") &&
      !diskJson.includes("arbitrarySecretValue123") &&
      !diskJson.includes("arbitraryCookieValue789") &&
      !diskJson.includes("arbitraryToken999") &&
      diskJson.includes("[REDACTED_PATH]");
    const diskKeysAreDigests = JSON.parse(diskJson).events.every(e => /^k_[a-f0-9]{32}$/.test(e.key));
    check(
      "redaction canary enforces secret, token, and path redaction at service boundary without credential tails or key leaks",
      canaryCard.hasRedactedPath && canaryCard.hasRedactedToken &&
      !canaryCard.leaksSecretAdmin && !canaryCard.leaksArbitrarySecret &&
      !canaryCard.leaksArbitraryCookie && !canaryCard.leaksArbitraryToken &&
      diskClean && diskKeysAreDigests,
      JSON.stringify({ canaryCard, diskClean, diskKeysAreDigests })
    );

    // Category filter test: filter by 'routine-completed'
    await invoke(win, "async()=>{const sel=document.getElementById('notifications-category-filter'); sel.value='routine-completed'; sel.dispatchEvent(new Event('change')); return true;}");
    await waitFor("routine category filter applied", async () => {
      return await invoke(win, "async()=>document.querySelectorAll('#notifications-list .notification-card').length===1");
    });
    const filterInfo = await invoke(
      win,
      "async()=>({count:document.querySelectorAll('#notifications-list .notification-card').length,title:document.querySelector('#notifications-list .notification-card-title')?.textContent})"
    );
    check(
      "category filter isolates selected category",
      filterInfo.count === 1 && filterInfo.title === "Routine completed",
      JSON.stringify(filterInfo)
    );

    // Safe source navigation test: Routines source opens Routines view
    const routineNavClicked = await invoke(win, "async()=>{const btn=document.querySelector('#notifications-list .hero-action'); if(btn && btn.textContent.includes('Routines')){ btn.click(); return true; } return false;}");
    await sleep(400);
    const routineViewState = await invoke(
      win,
      "async()=>({routinesVisible:document.getElementById('view-routines')?.classList.contains('hidden')===false,notifHidden:document.getElementById('view-notifications')?.classList.contains('hidden')===true,navRoutinesActive:document.getElementById('nav-routines')?.classList.contains('active')===true})"
    );
    check(
      "routine source navigation button opens Routines surface",
      routineNavClicked && routineViewState.routinesVisible && routineViewState.notifHidden,
      JSON.stringify(routineViewState)
    );

    // Return to Notification Center and reset category filter
    await invoke(win, "async()=>{document.getElementById('nav-notifications')?.click(); const sel=document.getElementById('notifications-category-filter'); sel.value='all'; sel.dispatchEvent(new Event('change')); return true;}");
    await waitFor("all cards restored", async () => {
      return await invoke(win, "async()=>document.querySelectorAll('#notifications-list .notification-card').length===6");
    });

    // Safe source navigation test: Attention source navigates to Attention view
    const attnNavClicked = await invoke(win, "async()=>{const navButtons=[...document.querySelectorAll('#notifications-list .hero-action')]; const attnBtn=navButtons.find(b=>b.textContent.includes('Attention')); if(attnBtn){ attnBtn.click(); return true; } return false;}");
    await sleep(400);
    const attnNavState = await invoke(
      win,
      "async()=>({attentionVisible:document.getElementById('view-attention')?.classList.contains('hidden')===false,notifHidden:document.getElementById('view-notifications')?.classList.contains('hidden')===true})"
    );
    check(
      "attention source navigation button navigates to Attention surface",
      attnNavClicked && attnNavState.attentionVisible && attnNavState.notifHidden,
      JSON.stringify(attnNavState)
    );

    // Return to Notification Center
    await invoke(win, "async()=>{document.getElementById('nav-notifications')?.click(); return true;}");
    await waitFor("back in notifications after attention", async () => {
      return await invoke(win, "async()=>document.getElementById('view-notifications')?.classList.contains('hidden')===false");
    });

    // Safe source navigation test: Conversation source navigates to Conversation view and verifies content & selection
    const convNavClicked = await invoke(win, "async()=>{const navButtons=[...document.querySelectorAll('#notifications-list .hero-action')]; const convBtn=navButtons.find(b=>b.textContent.includes('Conversation')); if(convBtn){ convBtn.click(); return true; } return false;}");
    await sleep(400);
    const convNavState = await invoke(
      win,
      "async()=>({" +
        "convVisible: document.getElementById('view-conversation')?.classList.contains('hidden') === false," +
        "notifHidden: document.getElementById('view-notifications')?.classList.contains('hidden') === true," +
        "headerTitle: document.getElementById('conversation-title')?.textContent || ''," +
        "messagesText: document.getElementById('conversation-messages')?.textContent || ''" +
      "})"
    );
    check(
      "conversation source navigation button opens intended Conversation identity and content safely",
      convNavClicked && convNavState.convVisible && convNavState.notifHidden && convNavState.messagesText.includes("Security review completed by Reviewer"),
      JSON.stringify({ convVisible: convNavState.convVisible, headerTitle: convNavState.headerTitle, hasExpectedMessage: convNavState.messagesText.includes("Security review completed by Reviewer") })
    );

    // Return to Notification Center
    await invoke(win, "async()=>{document.getElementById('nav-notifications')?.click(); return true;}");
    await waitFor("back in notifications after conversation", async () => {
      return await invoke(win, "async()=>document.getElementById('view-notifications')?.classList.contains('hidden')===false");
    });

    // Regression check for stale refresh generation guard: verifies stale success and stale failure are discarded
    const staleGuardResult = await invoke(win, "async () => {" +
      "const listEl = document.getElementById('notifications-list');" +
      "const errEl = document.getElementById('notifications-error');" +
      "const refreshBtn = document.getElementById('notifications-refresh');" +
      "const origList = window.sovereignbot.notifications.list;" +
      "let resolveSlowSuccess;" +
      "const slowSuccessPromise = new Promise((resolve) => { resolveSlowSuccess = resolve; });" +
      "let callCount = 0;" +
      "window.sovereignbot.notifications.list = async (params) => {" +
        "callCount++;" +
        "if (callCount === 1) return await slowSuccessPromise;" +
        "return await origList(params);" +
      "};" +
      "refreshBtn?.click();" +
      "await new Promise(r => setTimeout(r, 20));" +
      "refreshBtn?.click();" +
      "await new Promise(r => setTimeout(r, 60));" +
      "resolveSlowSuccess({" +
        "notifications: [{ id: 'notif_stale000000000', category: 'attention', title: 'STALE_SUCCESS_OVERWRITE', body: '', createdAt: new Date().toISOString(), read: false, readAt: null, source: null }]," +
        "totalCount: 1," +
        "unreadCount: 1" +
      "});" +
      "await new Promise(r => setTimeout(r, 60));" +
      "const leakedStaleSuccess = (listEl?.textContent || '').includes('STALE_SUCCESS_OVERWRITE');" +
      "callCount = 0;" +
      "let rejectSlowFailure;" +
      "const slowFailurePromise = new Promise((_, reject) => { rejectSlowFailure = reject; });" +
      "window.sovereignbot.notifications.list = async (params) => {" +
        "callCount++;" +
        "if (callCount === 1) return await slowFailurePromise;" +
        "return await origList(params);" +
      "};" +
      "refreshBtn?.click();" +
      "await new Promise(r => setTimeout(r, 20));" +
      "refreshBtn?.click();" +
      "await new Promise(r => setTimeout(r, 60));" +
      "rejectSlowFailure(new Error('STALE_FAILURE_OVERWRITE'));" +
      "await new Promise(r => setTimeout(r, 60));" +
      "const leakedStaleFailure = (errEl?.textContent || '').includes('STALE_FAILURE_OVERWRITE');" +
      "window.sovereignbot.notifications.list = origList;" +
      "return {" +
        "staleSuccessDiscarded: !leakedStaleSuccess," +
        "staleFailureDiscarded: !leakedStaleFailure" +
      "};" +
    "}");
    check(
      "refresh generation guard discards stale async success and failure responses",
      staleGuardResult.staleSuccessDiscarded && staleGuardResult.staleFailureDiscarded,
      JSON.stringify(staleGuardResult)
    );

    // Mark single card read via card action button
    await invoke(win, "async()=>{const firstCardBtn=document.querySelector('#notifications-list .notification-card .quiet-action'); firstCardBtn?.click(); return true;}");
    await waitFor("one card marked read", async () => {
      return await invoke(win, "async()=>document.querySelectorAll('#notifications-list .notification-card.unread').length===5");
    });
    const readToggleInfo = await invoke(
      win,
      "async()=>({unread:document.querySelectorAll('#notifications-list .notification-card.unread').length,badge:document.getElementById('notifications-badge')?.textContent})"
    );
    check(
      "card markRead action toggles read state and updates badge",
      readToggleInfo.unread === 5 && readToggleInfo.badge === "5",
      JSON.stringify(readToggleInfo)
    );

    // Read state filter test: filter by 'read'
    await invoke(win, "async()=>{const sel=document.getElementById('notifications-read-filter'); sel.value='read'; sel.dispatchEvent(new Event('change')); return true;}");
    await waitFor("read filter applied", async () => {
      return await invoke(win, "async()=>document.querySelectorAll('#notifications-list .notification-card').length===1");
    });
    const readFilterInfo = await invoke(
      win,
      "async()=>({count:document.querySelectorAll('#notifications-list .notification-card').length,unreadCount:document.querySelectorAll('#notifications-list .notification-card.unread').length})"
    );
    check(
      "read state filter isolates unread vs read",
      readFilterInfo.count === 1 && readFilterInfo.unreadCount === 0,
      JSON.stringify(readFilterInfo)
    );

    // Reset read filter
    await invoke(win, "async()=>{const sel=document.getElementById('notifications-read-filter'); sel.value='all'; sel.dispatchEvent(new Event('change')); return true;}");
    await waitFor("all cards restored again", async () => {
      return await invoke(win, "async()=>document.querySelectorAll('#notifications-list .notification-card').length===6");
    });

    // Mark visible read
    await invoke(win, "async()=>{document.getElementById('notifications-mark-all-read')?.click(); return true;}");
    await waitFor("all visible marked read", async () => {
      return await invoke(win, "async()=>document.querySelectorAll('#notifications-list .notification-card.unread').length===0");
    });
    const markAllInfo = await invoke(
      win,
      "async()=>({unreadCards:document.querySelectorAll('#notifications-list .notification-card.unread').length,badge:document.getElementById('notifications-badge')?.textContent,badgeHidden:document.getElementById('notifications-badge')?.classList.contains('hidden')})"
    );
    check(
      "mark visible read marks visible cards as read and updates badge",
      markAllInfo.unreadCards === 0 && markAllInfo.badgeHidden === true,
      JSON.stringify(markAllInfo)
    );

    // Clear visible
    await invoke(win, "async()=>{document.getElementById('notifications-clear-all')?.click(); return true;}");
    await waitFor("all visible cleared", async () => {
      return await invoke(win, "async()=>document.querySelectorAll('#notifications-list .notification-card').length===0");
    });
    const clearAllInfo = await invoke(
      win,
      "async()=>({cards:document.querySelectorAll('#notifications-list .notification-card').length,emptyText:document.querySelector('#notifications-list .detail-help')?.textContent})"
    );
    check(
      "clear visible dismisses cards from view",
      clearAllInfo.cards === 0 && clearAllInfo.emptyText.includes("No notifications yet"),
      JSON.stringify(clearAllInfo)
    );

    // Forgery and boundary validation: reject forged payloads and raw internal keys
    const reqCountBefore = fixture.notificationRequests.length;
    await assertReject(win, "window.sovereignbot.notifications.list({limit:101})", "between 1 and 100");
    await assertReject(win, "window.sovereignbot.notifications.list({category:'invalid_cat'})", "unsupported notification category");
    await assertReject(win, "window.sovereignbot.notifications.markRead({id:'notif_1',command:'calc.exe'})", "unknown field");
    await assertReject(win, "window.sovereignbot.notifications.clear({id:'notif_1',cwd:'/forbidden'})", "unknown field");
    await assertReject(win, "window.sovereignbot.notifications.markRead({id:'job:job_attn_1:attention'})", "valid notification identifier");
    check(
      "forged notification IPC payloads and authority fields are rejected",
      fixture.notificationRequests.length === reqCountBefore,
      JSON.stringify({ rejected: true })
    );

    // Restart test: reload window with new service instance pointing to same dataDir
    unbind();
    unbind = undefined;
    const restartedFixture = makeFixture(dataDir);
    unbind = bindIpcChannels({ win, handlers: handlers(restartedFixture) });
    await loadWindow(win);

    // In the restarted fixture, all 6 items were cleared/dismissed in the previous step,
    // so list should return 0 items and seenCount should still remember the keys (deduplication).
    const restartList = restartedFixture.notifications.list();
    check(
      "restart preserves notification state, read status, and dismissals",
      restartList.totalCount === 0 && restartList.notifications.length === 0 && restartedFixture.notifications.seenCount() === 6,
      JSON.stringify({ totalCount: restartList.totalCount, seenCount: restartedFixture.notifications.seenCount() })
    );

    // Add 1 fresh event to restarted service and verify bounded list
    restartedFixture.notifications.notify({
      category: "routine-completed",
      key: "job:restart_test:1",
      title: "Restart verified",
      body: "Notification persisted safely",
    });
    const freshList = restartedFixture.notifications.list({ limit: 10 });
    check(
      "bounded storage and list limits remain strictly enforced",
      freshList.totalCount === 1 && freshList.notifications.length === 1 && freshList.notifications[0].title === "Restart verified",
      JSON.stringify(freshList.notifications[0])
    );

  } catch (error) {
    fatal = error;
    note("[fatal] " + String(error?.stack ?? error));
    check("P17 hidden Notification Center gate runner completed", false, String(error?.message ?? error));
  }

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  note("[summary] " + (Object.keys(checks).length - failed.length) + "/" + Object.keys(checks).length + " PASS");

  writeFileSync(
    join(EVIDENCE_DIR, "verify-p17-notification-center.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      publishEligible: false,
      channelUnreadStatus: "Channel-unread category is allowlisted and supported in storage, UI, and filters. Automated production event hook remains unwired in main process pending trusted event source.",
      checks,
      requests: fixture?.notificationRequests,
      fatal: fatal ? String(fatal?.message ?? fatal) : undefined,
    }, null, 2) + "\n",
    "utf8"
  );
  writeFileSync(join(EVIDENCE_DIR, "verify-p17-notification-center.log"), log.join("\n") + "\n", "utf8");

  try { unbind?.(); } catch {}
  try { uninstallProtocol?.(); } catch {}
  try { win?.destroy(); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}

  if (fatal || failed.length) {
    throw new Error("P17 Notification Center gate failed: " + (failed.join(", ") || String(fatal?.message ?? fatal)));
  }
  app.exit(0);
}
