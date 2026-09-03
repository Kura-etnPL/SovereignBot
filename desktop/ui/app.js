"use strict";

const state = {
  handshake: undefined,
  coworkers: [],
  conversations: [],
  teams: [],
  projects: [],
  teamActivity: { events: [] },
  teamPacks: [],
  channelTemplates: [],
  channels: [],
  roster: { ready: false, mode: "provider", roles: {}, agents: [], coworkerBindings: {}, providers: {} },
  settings: undefined,
  workspaces: { workspaces: [], defaultWorkspaceId: undefined },
  firstRun: undefined,
  connectedApps: { apps: [] },
  updateStatus: undefined,
  selectedConversationId: undefined,
  selectedConversation: undefined,
  activeView: "welcome",
  mentionIds: new Set(),
  replyTo: undefined,
  redirectMode: false,
  voice: { listening: false },
  editingCoworkerId: undefined,
  editingCoworkerSnapshot: undefined,
  editingChannelId: undefined,
  editingChannelTeamId: undefined,
  channelEditorReturnView: undefined,
  pollTimer: undefined,
  conversationSignature: undefined,
  conversationPage: undefined,
  conversationRefreshRequest: 0,
  inlineAttentionFor: undefined,
  inlineAttentionAt: 0,
  inlineAttentionRequest: 0,
  activityScopeTeamId: undefined,
  activityRequestId: 0,
  coworkerRoster: { query: "", filter: "all", expanded: false },
};

let voiceController;

const READ_MARKERS_KEY = "sovereignbot.conversation-read-v1";
let readMarkers = {};
try {
  const stored = JSON.parse(window.localStorage.getItem(READ_MARKERS_KEY) || "{}");
  if (stored && typeof stored === "object" && !Array.isArray(stored)) readMarkers = stored;
} catch {}

const $ = (id) => document.getElementById(id);
const show = (el) => el?.classList.remove("hidden");
const hide = (el) => el?.classList.add("hidden");

const VOICE_STATUS_TEXT = Object.freeze({
  ready: "Voice ready / 语音已就绪",
  listening: "Listening — release to finish / 正在聆听——松开完成",
  transcribed: "Transcript added to this conversation / 转写已加入当前会话",
  unsupported: "Voice is unavailable in this environment / 当前环境不支持语音",
  "permission-denied": "Microphone permission was denied / 麦克风权限被拒绝",
  "no-conversation": "Open a conversation before using voice / 请先打开会话",
  muted: "Voice is muted / 语音已静音",
  stopped: "Voice stopped / 语音已停止",
  "conversation-switch": "Voice stopped after conversation change / 会话切换后已停止语音",
  "view-switch": "Voice stopped / 语音已停止",
  "app-quit": "Voice stopped / 语音已停止",
  error: "Voice is unavailable / 语音暂不可用",
});

function renderVoiceStatus({ code = "ready", detail = "" } = {}) {
  const value = VOICE_STATUS_TEXT[code] || (detail ? `Voice unavailable: ${detail}` : VOICE_STATUS_TEXT.error);
  for (const id of ["voice-input-status", "voice-settings-status", "voice-status"]) {
    const target = $(id);
    if (target) target.textContent = value;
  }
}

function text(value) {
  return String(value ?? "");
}

function initials(name) {
  const parts = text(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "✦";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
}

function avatarFor(coworker) {
  return coworker?.avatar || initials(coworker?.name);
}

function coworkerById(id) {
  return state.coworkers.find((entry) => entry.id === id);
}

function conversationById(id) {
  return state.conversations.find((entry) => entry.id === id);
}

const CONVERSATION_PAGE_SIZE = 100;
const MAX_RENDERED_MESSAGES = 300;

function resetConversationPage(conversationId) {
  state.conversationPage = {
    conversationId,
    messages: [],
    total: 0,
    hasOlder: false,
    nextBeforeMessageId: undefined,
    loadedOlder: false,
    loadingOlder: false,
    historyMode: false,
    windowIncludesLatest: true,
    newMessagesAvailable: 0,
    latestMessageId: undefined,
    seenMessageIds: new Set(),
  };
}

function updateConversationPageControls() {
  const page = state.conversationPage;
  const button = $("conversation-load-older");
  const latestButton = $("conversation-latest-messages");
  const status = $("conversation-page-status");
  if (!button || !status) return;
  const current = page?.conversationId === state.selectedConversationId ? page : undefined;
  button.classList.toggle("hidden", !current?.hasOlder);
  button.disabled = Boolean(current?.loadingOlder);
  button.textContent = current?.loadingOlder ? "Loading older messages… / 正在加载更早消息…" : "Load older messages / 加载更早消息";
  if (latestButton) {
    const showLatest = Boolean(current?.historyMode || current?.newMessagesAvailable);
    latestButton.classList.toggle("hidden", !showLatest);
    latestButton.disabled = Boolean(current?.loadingLatest);
    latestButton.textContent = current?.newMessagesAvailable
      ? `${current.newMessagesAvailable} new message${current.newMessagesAvailable === 1 ? "" : "s"} · Back to latest / ${current.newMessagesAvailable} 条新消息 · 回到最新`
      : "Back to latest / 回到最新";
  }
  status.textContent = current && current.total > current.messages.length
    ? `${current.messages.length} of ${current.total} messages loaded / 已加载 ${current.messages.length} / ${current.total} 条消息`
    : current?.historyMode ? "Browsing older messages / 正在浏览更早消息" : "";
}

function mergeConversationPage(pageResponse, mode = "latest") {
  const page = state.conversationPage;
  const incoming = Array.isArray(pageResponse?.messages) ? pageResponse.messages : [];
  const current = page?.messages ?? [];
  let freshMessages = mode === "latest" ? incoming.filter((message) => message?.id && !page.seenMessageIds.has(message.id)) : [];
  const observedLatestId = pageResponse?.lastMessage?.id ?? incoming.at(-1)?.id;
  const previousLatestId = page.latestMessageId;
  const previousTotal = page.total;
  page.total = Number.isInteger(pageResponse?.messageCount) ? pageResponse.messageCount : (pageResponse?.pageInfo?.total ?? page.total);
  let merged;
  if (mode === "older") {
    const seen = new Set();
    merged = [...incoming, ...current].filter((message) => {
      if (!message?.id || seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
  } else {
    const positions = new Map(current.map((message, index) => [message.id, index]));
    merged = current.map((message) => incoming.find((entry) => entry?.id === message.id) ?? message);
    for (const message of incoming) if (message?.id && !positions.has(message.id)) merged.push(message);
  }
  if (mode === "older") {
    const includesLatest = Boolean(page.latestMessageId && merged.some((message) => message?.id === page.latestMessageId));
    if (merged.length > MAX_RENDERED_MESSAGES) {
      // Keep the newly requested older edge. The omitted latest tail is
      // deliberately not replaced by the next polling response.
      merged = merged.slice(0, MAX_RENDERED_MESSAGES);
      page.windowIncludesLatest = false;
      page.historyMode = true;
    } else {
      page.windowIncludesLatest = includesLatest;
      page.historyMode = !includesLatest;
    }
  } else if (page.historyMode || page.windowIncludesLatest === false) {
    // A polling page is still useful for totals and latest identity while the
    // user is reading history, but must not eject the visible historical window.
    merged = current;
    const latestChanged = Boolean(observedLatestId && previousLatestId && observedLatestId !== previousLatestId);
    if (latestChanged || (page.total > previousTotal && previousLatestId)) {
      page.newMessagesAvailable += Math.max(1, page.total - previousTotal);
    }
    freshMessages = [];
  } else if (merged.length > MAX_RENDERED_MESSAGES) {
    // At the live edge, retain the latest bounded window as new messages land.
    merged = merged.slice(-MAX_RENDERED_MESSAGES);
    page.windowIncludesLatest = true;
  }
  page.messages = merged;
  page.hasOlder = mode === "older" ? Boolean(pageResponse?.pageInfo?.hasOlder) : Boolean(page.hasOlder || pageResponse?.pageInfo?.hasOlder);
  page.nextBeforeMessageId = page.hasOlder ? (page.messages[0]?.id ?? pageResponse?.pageInfo?.nextBeforeMessageId) : undefined;
  page.loadedOlder = page.loadedOlder || mode === "older";
  if (observedLatestId) page.latestMessageId = observedLatestId;
  for (const message of incoming) if (message?.id) page.seenMessageIds.add(message.id);
  while (page.seenMessageIds.size > MAX_RENDERED_MESSAGES * 2) page.seenMessageIds.delete(page.seenMessageIds.values().next().value);
  return { messages: page.messages, freshMessages };
}

function conversationUnread(conversation) {
  const last = conversation?.lastMessage;
  return Boolean(conversation?.id && last?.senderId !== "user" && last?.createdAt && conversation.id !== state.selectedConversationId
    && (!readMarkers[conversation.id] || readMarkers[conversation.id] < last.createdAt));
}

function markConversationRead(conversation) {
  if (!conversation?.id) return Promise.resolve();
  const stamp = conversation?.lastMessage?.createdAt ?? conversation?.messages?.at(-1)?.createdAt;
  if (stamp) {
    readMarkers[conversation.id] = stamp;
    try { window.localStorage.setItem(READ_MARKERS_KEY, JSON.stringify(readMarkers)); } catch {}
  }
  let ackPromise;
  try {
    ackPromise = window.sovereignbot?.conversations?.acknowledge?.({ conversationId: conversation.id });
  } catch (err) {
    ackPromise = Promise.reject(err);
  }
  return Promise.resolve(ackPromise)
    .then(() => {
      document.dispatchEvent(new CustomEvent("sovereignbot:refresh-notifications-badge"));
    })
    .catch((err) => {
      console.warn("[app] conversation acknowledgement failed:", err);
    });
}

function channelForConversation(conversationId) {
  return state.channels.find((entry) => entry.conversationId === conversationId);
}

function teamForConversation(conversationId) {
  const channel = channelForConversation(conversationId);
  return channel ? state.teams.find((entry) => entry.id === channel.teamId) : undefined;
}

function activityContext() {
  const contextualTeam = teamForConversation(state.selectedConversationId);
  if (contextualTeam) return { team: contextualTeam, teamId: contextualTeam.id, conversationId: state.selectedConversationId, contextual: true };
  const team = state.teams.find((entry) => entry.id === state.activityScopeTeamId) ?? state.teams[0];
  return team ? { team, teamId: team.id, contextual: false } : { contextual: false };
}

function activityContextKey(context = activityContext()) {
  return `${context.teamId ?? "none"}:${context.conversationId ?? "team"}`;
}

function bindingFor(coworkerId) {
  return state.roster?.coworkerBindings?.[coworkerId];
}

function humanProvider(provider) {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude Code";
  if (provider === "chatgpt-web") return "ChatGPT Web / Sol";
  if (provider === "antigravity") return "Antigravity";
  if (provider === "economy") return "Economy";
  return "Automatic";
}

function translate(key, fallback, params) {
  const value = globalThis.SovereignI18n?.t?.(key, params);
  return value && value !== key ? value : fallback;
}

function economyAvailable() {
  const provider = state.roster?.providers?.economy;
  return provider?.configured === true && provider.usable === true && provider.health === "ready";
}

function syncEconomyControls() {
  const available = economyAvailable();
  const profileOption = $("coworker-economy-option");
  const providerOption = $("coworker-economy-provider-option");
  if (profileOption) { profileOption.hidden = !available; profileOption.disabled = !available; }
  if (providerOption) { providerOption.hidden = !available; providerOption.disabled = !available; }
}

function humanModelProfile(profile) {
  if (profile === "efficient") return "Efficient / 高效";
  if (profile === "deep") return "Deep / 深度";
  if (profile === "economy") return "Economy / 经济";
  if (profile === "custom") return "Custom / 自定义";
  return "Automatic / 自动";
}

function formatTime(iso) {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value);
}

function formatRelative(iso) {
  const value = new Date(iso).getTime();
  if (!Number.isFinite(value)) return "";
  const delta = Date.now() - value;
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

function switchView(name) {
  if (name !== "conversation") voiceController?.stop("view-switch");
  state.activeView = name;
  for (const view of document.querySelectorAll(".main-view")) hide(view);
  show($(`view-${name}`));
  $("nav-settings")?.classList.toggle("active", name === "settings");
  if (name !== "conversation") {
    clearTimeout(state.pollTimer);
    state.pollTimer = undefined;
  }
}

function clearNode(node) {
  if (node) node.textContent = "";
}

function makeNavItem({ avatar, title, subtitle, meta, status, statusLabel, unread, active, compact, onClick }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `nav-item${active ? " active" : ""}${compact ? " compact" : ""}`;
  const icon = document.createElement("span");
  icon.className = "nav-avatar";
  icon.textContent = avatar;
  const copy = document.createElement("span");
  copy.className = "nav-copy";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const small = document.createElement("span");
  small.textContent = subtitle ?? "";
  copy.append(strong, small);
  let right;
  if (status) {
    right = document.createElement("span");
    right.className = `nav-status ${status}`;
    right.setAttribute("aria-label", statusLabel ?? status);
    right.title = statusLabel ?? status;
  } else {
    right = document.createElement("span");
    right.className = "nav-meta";
    right.textContent = meta ?? "";
  }
  button.append(icon, copy, right);
  if (unread) {
    const badge = document.createElement("span");
    badge.className = "nav-unread";
    badge.textContent = "1";
    badge.title = "Unread activity / 未读动态";
    button.append(badge);
  }
  button.addEventListener("click", onClick);
  return button;
}

function renderCoworkers() {
  const list = $("coworker-list");
  clearNode(list);
  const roster = state.coworkerRoster;
  const query = text(roster.query).trim().toLocaleLowerCase();
  const directByCoworker = new Map();
  for (const conversation of state.conversations) {
    if (conversation.kind !== "direct") continue;
    for (const id of conversation.participants ?? []) if (id !== "user" && !directByCoworker.has(id)) directByCoworker.set(id, conversation);
  }
  const attentionIds = new Set();
  const workingIds = new Set();
  for (const team of state.teams) {
    const flow = team.flow ?? {};
    for (const id of flow.attentionCoworkerIds ?? []) attentionIds.add(id);
    if (flow.status === "active" && flow.currentOwnerId) workingIds.add(flow.currentOwnerId);
  }
  if (state.selectedConversation?.kind === "direct") for (const id of pendingUserRecipients(state.selectedConversation)) workingIds.add(id);
  const statusFor = (coworker) => {
    if (coworker.state === "paused") return "paused";
    if (attentionIds.has(coworker.id)) return "attention";
    if (workingIds.has(coworker.id)) return "working";
    if (bindingFor(coworker.id)?.ready === true) return "available";
    return "active";
  };
  const statusLabel = { active: "Active / 活跃", working: "Working / 工作中", available: "Available / 可用", attention: "Attention / 需关注", paused: "Paused / 已暂停" };
  const priority = { attention: 0, working: 1, available: 2, active: 3, paused: 4 };
  const all = state.coworkers.filter((entry) => entry.state !== "archived").map((coworker, index) => ({ coworker, index, status: statusFor(coworker) }));
  const filtered = all.filter(({ coworker, status }) => {
    const matchesQuery = !query || `${coworker.name} ${coworker.role}`.toLocaleLowerCase().includes(query);
    const matchesFilter = roster.filter === "all"
      ? true
      : roster.filter === "active"
        ? coworker.state === "active"
        : status === roster.filter;
    return matchesQuery && matchesFilter;
  }).sort((a, b) => priority[a.status] - priority[b.status] || a.coworker.name.localeCompare(b.coworker.name, undefined, { sensitivity: "base" }) || a.index - b.index);
  const counts = { active: all.filter(({ coworker }) => coworker.state === "active").length, paused: all.filter(({ coworker }) => coworker.state === "paused").length, working: all.filter(({ status }) => status === "working").length, attention: all.filter(({ status }) => status === "attention").length, available: all.filter(({ status }) => status === "available").length };
  const total = all.length;
  const count = $("coworker-count");
  if (count) count.textContent = `${total} persistent coworker${total === 1 ? "" : "s"} · ${counts.active} active · ${counts.available} available`;
  const summary = $("coworker-roster-summary");
  if (summary) summary.textContent = `${total} coworkers / ${total} 位同事 · ${counts.working} working / 工作中 · ${counts.attention} attention / 需关注 · ${counts.paused} paused / 已暂停`;
  const selectedCoworkerId = [...directByCoworker.entries()].find(([, conversation]) => conversation.id === state.selectedConversationId)?.[0];
  const renderLimit = roster.expanded ? filtered.length : 14;
  const shown = filtered.slice(0, renderLimit);
  if (!roster.expanded && selectedCoworkerId) {
    const selected = filtered.find((entry) => entry.coworker.id === selectedCoworkerId);
    if (selected && !shown.some((entry) => entry.coworker.id === selectedCoworkerId)) shown.push(selected);
  }
  for (const { coworker, status } of shown) {
    const direct = directByCoworker.get(coworker.id);
    const item = makeNavItem({
      avatar: avatarFor(coworker),
      title: coworker.name,
      subtitle: `${coworker.role} · ${statusLabel[status]}`,
      status: status === "available" ? "ready" : status === "paused" ? "offline" : status,
      statusLabel: statusLabel[status],
      unread: conversationUnread(direct),
      active: direct?.id === state.selectedConversationId,
      onClick: () => openDirect(coworker.id),
    });
    item.dataset.coworkerId = coworker.id;
    list.append(item);
  }
  const more = $("coworker-show-more");
  if (more) {
    const hiddenCount = Math.max(0, filtered.length - shown.length);
    more.classList.toggle("hidden", filtered.length <= 14);
    more.textContent = roster.expanded ? "Collapse / 收起" : `Show ${hiddenCount} more / 显示其余 ${hiddenCount} 位`;
  }
  const empty = $("coworker-empty");
  if (empty) {
    empty.classList.toggle("hidden", filtered.length > 0);
    empty.textContent = total === 0 ? "Create your first coworker / 请先创建同事" : "No coworkers match this search / 没有匹配的同事";
  }
}

function renderTeams() {
  const list = $("team-list");
  clearNode(list);
  if (state.teams.length) {
    for (const team of state.teams) {
      const channel = team.channels?.[0] ?? state.channels.find((entry) => entry.teamId === team.id);
      const flow = team.flow;
      const conversation = conversationById(channel?.conversationId);
      const rosterSize = team.coworkerIds?.length ?? 0;
      const activeCount = flow?.status === "active" && flow.currentOwner ? 1 : 0;
      const attentionCount = flow?.attentionCoworkerIds?.length ?? 0;
      const availableCount = Math.max(0, rosterSize - activeCount - attentionCount);
      const counts = `${activeCount} active · ${availableCount} available${attentionCount ? ` · ${attentionCount} attention` : ""}`;
      list.append(makeNavItem({
        avatar: "#",
        title: team.name,
        subtitle: channel?.name ?? "Project Channel",
        meta: counts,
        unread: conversationUnread(conversation),
        active: channel?.conversationId === state.selectedConversationId,
        onClick: () => channel?.conversationId && openConversation(channel.conversationId),
      }));
    }
    return;
  }
  const teams = state.conversations
    .filter((entry) => entry.kind === "team")
    .sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)));
  for (const conversation of teams) {
    list.append(makeNavItem({
      avatar: "#",
      title: conversation.title,
      subtitle: `${Math.max(0, (conversation.participants?.length ?? 1) - 1)} coworkers`,
      meta: formatRelative(conversation.updatedAt),
      unread: conversationUnread(conversation),
      active: conversation.id === state.selectedConversationId,
      onClick: () => openConversation(conversation.id),
    }));
  }
}

function renderTeamPackActions() {
  const container = $("team-pack-actions");
  if (!container) return;
  clearNode(container);
  for (const pack of state.teamPacks) {
    const card = document.createElement("div");
    card.className = "team-pack-card";
    const title = document.createElement("strong");
    title.textContent = pack.name;
    const description = document.createElement("span");
    description.textContent = pack.description ?? "";
    const contents = document.createElement("small");
    contents.textContent = `${pack.coworkerNames?.length ?? 0} coworkers · ${pack.channelNames?.length ?? 0} channels · ${pack.playbookNames?.length ?? 0} playbooks`;
    card.append(title, description, contents);
    if (pack.installed) {
      const installed = document.createElement("span");
      installed.className = "soft-pill";
      installed.textContent = "Installed / 已安装";
      card.append(installed);
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "quiet-action";
      button.textContent = `Install ${pack.name}`;
      button.title = pack.description ?? "Install this team";
      button.addEventListener("click", () => installTeamPack(pack.id, button));
      card.append(button);
    }
    container.append(card);
  }
  const importButton = document.createElement("button");
  importButton.type = "button";
  importButton.className = "quiet-action";
  importButton.textContent = "Import Team Pack / 导入团队包";
  importButton.addEventListener("click", () => openTeamPackDialog());
  container.append(importButton);
}

function renderRecent() {
  const list = $("conversation-list");
  clearNode(list);
  const recent = [...state.conversations]
    .filter((entry) => entry.messageCount > 0)
    .sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)))
    .slice(0, 8);
  for (const conversation of recent) {
    const coworkerId = conversation.kind === "direct" ? conversation.participants?.find((id) => id !== "user") : undefined;
    const coworker = coworkerById(coworkerId);
    list.append(makeNavItem({
      avatar: conversation.kind === "team" ? "#" : avatarFor(coworker),
      title: conversation.title,
      subtitle: conversation.lastMessage?.textPreview || (conversation.kind === "team" ? "Team conversation" : coworker?.role),
      meta: formatRelative(conversation.updatedAt),
      compact: true,
      active: conversation.id === state.selectedConversationId,
      onClick: () => openConversation(conversation.id),
    }));
  }
}

function renderSidebar() {
  renderCoworkers();
  renderTeams();
  renderRecent();
}

function renderReadiness() {
  const readyCoworkers = Object.values(state.roster?.coworkerBindings ?? {}).filter((entry) => entry?.ready).length;
  const providerState = (key) => state.roster?.providers?.[key] ?? {};
  const isReady = (entry) => entry?.health === "ready" && entry?.usable === true;
  const codex = providerState("codex");
  const claude = providerState("claude");
  const deep = providerState("chatgpt-web");
  const providers = Object.entries(state.roster?.providers ?? {}).filter(([, value]) => isReady(value)).map(([key]) => humanProvider(key));
  const summary = $("provider-summary");
  const dot = $("provider-dot");
  const detail = $("provider-readiness-detail");
  if (state.roster?.mode === "demo") {
    summary.textContent = translate("status.demoMode", "Demo mode");
    if (detail) detail.textContent = "";
    dot.classList.add("offline");
  } else if (!isReady(codex)) {
    summary.textContent = codex?.health === "capacity-limited"
      ? translate("status.codexCapacityLimited", "Codex capacity is limited")
      : translate("status.connectCodex", "Connect Codex");
    if (detail) {
      const core = isReady(claude) ? translate("status.claudeReady", "Claude Code ready") : "";
      const deepStatus = deep?.health === "capacity-limited"
        ? translate("status.deepCapacityLimited", "Deep unavailable · ChatGPT Web capacity is limited")
        : isReady(deep)
          ? translate("status.deepReady", "Deep ready")
          : translate("status.deepUnavailable", "Deep unavailable · Connect ChatGPT Web");
      detail.textContent = [core, deepStatus].filter(Boolean).join(" · ");
    }
    dot.classList.add("offline");
  } else if (state.roster?.ready) {
    summary.textContent = providers.length ? `${providers.join(" + ")} ready · ${readyCoworkers} coworker lanes` : `${readyCoworkers} coworker lanes ready`;
    if (detail) {
      const deepStatus = deep?.health === "capacity-limited"
        ? translate("status.deepCapacityLimited", "Deep unavailable · ChatGPT Web capacity is limited")
        : isReady(deep)
          ? translate("status.deepReady", "Deep ready")
          : translate("status.deepUnavailable", "Deep unavailable · Connect ChatGPT Web");
      detail.textContent = deepStatus;
    }
    dot.classList.remove("offline");
  } else {
    summary.textContent = translate("status.connectProvider", "Connect Codex or Claude Code");
    if (detail) detail.textContent = translate("status.deepUnavailable", "Deep unavailable · Connect ChatGPT Web");
    dot.classList.add("offline");
  }
}

async function refreshCoworkers() {
  try {
    const result = await window.sovereignbot.coworkers.list({});
    state.coworkers = result?.coworkers ?? [];
  } catch (error) {
    state.coworkers = state.coworkers ?? [];
    const target = $("provider-action-result");
    if (target && error) target.textContent = String(error?.message ?? error).slice(0, 200);
  }
  renderConnectedApps();
  renderSidebar();
}

async function refreshConversations() {
  try {
    const result = await window.sovereignbot.conversations.list({});
    state.conversations = result?.conversations ?? [];
  } catch (error) {
    state.conversations = state.conversations ?? [];
    const target = $("provider-action-result");
    if (target && error) target.textContent = String(error?.message ?? error).slice(0, 200);
  }
  renderSidebar();
}

async function refreshTeams() {
  try {
    const result = await window.sovereignbot.teams.list({});
    state.teams = result?.teams ?? [];
    state.teamPacks = result?.packs ?? state.teamPacks;
    state.channelTemplates = result?.channelTemplates ?? state.channelTemplates;
    state.channels = state.teams.flatMap((team) => team.channels ?? []);
  } catch (error) {
    state.teams = state.teams ?? [];
    state.channels = state.channels ?? [];
    const target = $("provider-action-result");
    if (target && error) target.textContent = String(error?.message ?? error).slice(0, 200);
  }
  renderConnectedApps();
  renderTeamPackActions();
  renderSidebar();
  if (!$("activity-drawer")?.classList.contains("hidden")) renderActivityTeamSelector(activityContext());
}

async function refreshProjects() {
  try {
    const result = await window.sovereignbot.projects.list({ includeArchived: true, limit: 100 });
    state.projects = result?.projects ?? [];
  } catch (error) {
    state.projects = state.projects ?? [];
    const target = $("provider-action-result");
    if (target && error) target.textContent = String(error?.message ?? error).slice(0, 200);
  }
}

async function refreshRoster() {
  try {
    state.roster = await window.sovereignbot.providers.getRoster({});
  } catch (error) {
    const target = $("provider-action-result");
    if (target && error) target.textContent = String(error?.message ?? error).slice(0, 200);
  }
  renderReadiness();
  renderSidebar();
}

async function openDirect(coworkerId) {
  try {
    const conversation = await window.sovereignbot.conversations.createDirect({ coworkerId });
    await refreshConversations();
    await openConversation(conversation.id);
  } catch (error) {
    showToastError(error);
  }
}

async function openConversation(conversationId) {
  if (state.selectedConversationId && state.selectedConversationId !== conversationId) voiceController?.stop("conversation-switch");
  state.selectedConversationId = conversationId;
  state.mentionIds.clear();
  state.replyTo = undefined;
  state.redirectMode = false;
  state.conversationSignature = undefined;
  state.conversationRefreshRequest += 1;
  resetConversationPage(conversationId);
  updateConversationPageControls();
  switchView("conversation");
  hide($("details-panel"));
  renderSidebar();
  await refreshConversation(true);
  try { $("composer-input")?.focus({ preventScroll: true }); } catch { $("composer-input")?.focus(); }
  // If Chromium still nudged the root scroller on focus, pin it back. Keep the
  // inner message-scroller behavior intact; only the root viewport must stay at 0.
  try {
    if ((window.scrollY ?? 0) !== 0) window.scrollTo(0, 0);
    const root = document.scrollingElement;
    if (root && root.scrollTop !== 0) root.scrollTop = 0;
  } catch {}
  if (!$("activity-drawer")?.classList.contains("hidden")) void refreshActivity();
}

function participantCoworkers(conversation) {
  return (conversation?.participants ?? []).filter((id) => id !== "user").map(coworkerById).filter(Boolean);
}

function pendingUserRecipients(conversation) {
  const pending = new Set();
  for (const message of conversation?.messages ?? []) {
    if (message.senderId !== "user") continue;
    for (const [id, delivery] of Object.entries(message.delivery ?? {})) {
      if (delivery?.status === "pending") pending.add(id);
    }
  }
  return pending;
}

function renderReplyComposer(conversation) {
  const row = $("reply-row");
  if (!row) return;
  clearNode(row);
  const message = state.replyTo ? conversation?.messages?.find((entry) => entry.id === state.replyTo) : undefined;
  if (!message) {
    state.replyTo = undefined;
    hide(row);
    return;
  }
  show(row);
  const copy = document.createElement("span");
  const author = message.senderId === "user" ? "You" : coworkerById(message.senderId)?.name || "Coworker";
  copy.textContent = `Replying to ${author}: ${text(message.text).slice(0, 180)}`;
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "quiet-action reply-clear";
  clear.textContent = "Cancel / 取消";
  clear.addEventListener("click", () => {
    state.replyTo = undefined;
    renderReplyComposer(conversation);
  });
  row.append(copy, clear);
}

function renderMentionRow(conversation) {
  const row = $("mention-row");
  clearNode(row);
  if (conversation.kind !== "team") {
    hide(row);
    return;
  }
  show(row);
  const everyone = document.createElement("button");
  everyone.type = "button";
  everyone.className = `mention-chip${state.mentionIds.has("everyone") ? " active" : ""}`;
  everyone.textContent = "@everyone";
  everyone.addEventListener("click", () => {
    if (state.mentionIds.has("everyone")) state.mentionIds.clear();
    else state.mentionIds = new Set(["everyone"]);
    renderMentionRow(conversation);
  });
  row.append(everyone);
  for (const coworker of participantCoworkers(conversation)) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `mention-chip${state.mentionIds.has(coworker.id) ? " active" : ""}`;
    chip.textContent = `@${coworker.name}`;
    chip.addEventListener("click", () => {
      state.mentionIds.delete("everyone");
      if (state.mentionIds.has(coworker.id)) state.mentionIds.delete(coworker.id);
      else state.mentionIds.add(coworker.id);
      renderMentionRow(conversation);
    });
    row.append(chip);
  }
}

function renderConversationHeader(conversation) {
  const members = participantCoworkers(conversation);
  const direct = conversation.kind === "direct" ? members[0] : undefined;
  const channel = channelForConversation(conversation.id);
  const team = teamForConversation(conversation.id);
  $("conversation-avatar").textContent = conversation.kind === "team" ? "#" : avatarFor(direct);
  $("conversation-title").textContent = channel?.name ?? conversation.title;
  $("conversation-kind").textContent = channel ? "Project Channel" : conversation.kind === "team" ? "Team" : "Coworker";
  $("conversation-subtitle").textContent = conversation.kind === "team"
    ? channel && team ? `${team.name} · ${members.map((entry) => entry.name).join(" · ")}` : members.map((entry) => entry.name).join(" · ")
    : direct?.role || "Persistent coworker conversation";
  $("demo-banner").classList.toggle("hidden", state.roster?.mode !== "demo");

  const pending = pendingUserRecipients(conversation);
  const presence = $("conversation-presence");
  if (pending.size) {
    presence.className = "presence busy";
    presence.lastChild.textContent = ` ${pending.size > 1 ? `${pending.size} coworkers working` : "Working"}`;
  } else {
    const directBinding = direct ? bindingFor(direct.id) : undefined;
    const offline = conversation.kind === "direct" && !directBinding?.ready;
    presence.className = `presence${offline ? " offline" : ""}`;
    presence.lastChild.textContent = offline ? " Provider unavailable" : " Ready";
  }

  const stopButton = $("conversation-stop");
  const redirectButton = $("conversation-redirect");
  if (stopButton) stopButton.classList.toggle("hidden", pending.size === 0);
  if (redirectButton) {
    if (!pending.size) state.redirectMode = false;
    redirectButton.classList.toggle("hidden", pending.size === 0);
    redirectButton.textContent = state.redirectMode ? "Cancel redirect / 取消" : "Redirect / 重定向";
  }
  const hint = $("composer-hint");
  if (hint) hint.textContent = state.redirectMode
    ? "Enter to redirect the active work · Shift+Enter for a new line"
    : pending.size ? "Active work is running · Redirect changes its direction" : "Enter to send · Shift+Enter for a new line";

  renderMentionRow(conversation);
  renderReplyComposer(conversation);
  renderDetails(conversation);
}

async function refreshInlineAttention(conversationId, force = false) {
  const root = $("conversation-attention-strip") ?? (() => {
    const element = document.createElement("div");
    element.id = "conversation-attention-strip";
    element.className = "demo-banner conversation-attention hidden";
    $("demo-banner")?.after(element);
    return element;
  })();
  if (!root) return;
  if (!force && state.inlineAttentionFor === conversationId && Date.now() - state.inlineAttentionAt < 5000) return;
  const request = ++state.inlineAttentionRequest;
  state.inlineAttentionFor = conversationId;
  state.inlineAttentionAt = Date.now();
  try {
    const result = await window.sovereignbot.jobs.attention({});
    if (request !== state.inlineAttentionRequest || state.selectedConversationId !== conversationId) return;
    const jobs = (result?.jobs ?? []).filter((job) => job.conversationId === conversationId);
    root.textContent = "";
    root.classList.toggle("hidden", jobs.length === 0);
    for (const job of jobs.slice(0, 3)) {
      const card = document.createElement("div");
      card.className = "attention-inline-card";
      const copy = document.createElement("span");
      copy.textContent = `${job.title}: ${job.attentionState?.reason || job.error || "Needs your decision"}`.slice(0, 360);
      const allowed = job.attentionState?.actions;
      const actions = [];
      if (Array.isArray(allowed) && allowed.includes("retry")) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "hero-action";
        retry.textContent = "Retry / 重试";
        retry.addEventListener("click", async () => { retry.disabled = true; try { await window.sovereignbot.jobs.approve({ jobId: job.id }); await refreshInlineAttention(conversationId, true); } finally { retry.disabled = false; } });
        actions.push(retry);
      }
      if (Array.isArray(allowed) && allowed.includes("dismiss")) {
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "quiet-action";
        dismiss.textContent = "Dismiss / 忽略";
        dismiss.addEventListener("click", async () => { dismiss.disabled = true; try { await window.sovereignbot.jobs.dismiss({ jobId: job.id }); await refreshInlineAttention(conversationId, true); } finally { dismiss.disabled = false; } });
        actions.push(dismiss);
      }
      card.append(copy, ...actions);
      root.append(card);
    }
  } catch {
    if (request === state.inlineAttentionRequest) root.classList.add("hidden");
  }
}

function replyPreview(conversation, replyTo) {
  if (!replyTo) return undefined;
  return conversation.messages.find((entry) => entry.id === replyTo)?.text;
}

function speakMessage(conversation, message, button) {
  return voiceController?.speakReply(conversation?.id, message, button) ?? false;
}

function renderMessage(conversation, message) {
  const row = document.createElement("li");
  row.dataset.messageId = message.id;
  const user = message.senderId === "user";
  row.className = `chat-row${user ? " user" : ""}`;
  const coworker = user ? undefined : coworkerById(message.senderId);

  if (!user) {
    const avatar = document.createElement("div");
    avatar.className = "chat-avatar";
    avatar.textContent = avatarFor(coworker);
    row.append(avatar);
  }

  const content = document.createElement("div");
  content.className = "chat-content";
  const preview = replyPreview(conversation, message.replyTo);
  if (preview) {
    const reply = document.createElement("div");
    reply.className = "reply-context";
    reply.textContent = preview.slice(0, 180);
    content.append(reply);
  }
  const meta = document.createElement("div");
  meta.className = "chat-meta";
  const author = document.createElement("strong");
  author.textContent = user ? "You" : coworker?.name || "Coworker";
  const time = document.createElement("time");
  time.textContent = formatTime(message.createdAt);
  meta.append(author, time);
  if (!user && conversation.kind === "team" && Array.isArray(message.mentions) && message.mentions.length === 1) {
    const target = coworkerById(message.mentions[0]);
    if (target) {
      const handoff = document.createElement("div");
      handoff.className = "handoff-card";
      handoff.textContent = `Handoff → ${target.name} / 交接 → ${target.name}`;
      content.append(handoff);
    }
  }
  const body = document.createElement("div");
  body.className = "chat-text";
  body.textContent = message.text;
  content.append(meta, body);

  const actions = document.createElement("div");
  actions.className = "message-actions";
  const reply = document.createElement("button");
  reply.type = "button";
  reply.className = "message-action";
  reply.textContent = "Reply / 回复";
  reply.addEventListener("click", () => {
    state.replyTo = message.id;
    renderReplyComposer(conversation);
    try { $("composer-input")?.focus({ preventScroll: true }); } catch { $("composer-input")?.focus(); }
  });
  actions.append(reply);
  if (!user && message.voiceEligible === true && window.speechSynthesis && typeof window.SpeechSynthesisUtterance === "function") {
    const speak = document.createElement("button");
    speak.type = "button";
    speak.className = "message-action";
    speak.textContent = "Speak / 播放";
    speak.setAttribute("aria-label", "Speak final reply / 播放最终回复");
    speak.addEventListener("click", () => voiceController?.speakReply(conversation.id, message, speak));
    actions.append(speak);
  }
  content.append(actions);

  if (user && Object.keys(message.delivery ?? {}).length) {
    const delivery = document.createElement("div");
    delivery.className = "delivery-line";
    const values = Object.values(message.delivery);
    const pending = values.filter((entry) => entry?.status === "pending").length;
    const failed = values.filter((entry) => entry?.status === "failed").length;
    delivery.textContent = pending ? "Working…": failed ? `${failed} delivery failed` : "Delivered";
    content.append(delivery);
  }
  row.append(content);
  return row;
}

function renderMessages(conversation, forceScroll = false, { voiceMessages = conversation.messages ?? [], preserveScroll = false, preserveAnchor } = {}) {
  const list = $("conversation-messages");
  const scroller = $("message-scroller");
  const beforeHeight = scroller?.scrollHeight ?? 0;
  const beforeTop = scroller?.scrollTop ?? 0;
  const nearBottom = Boolean(forceScroll || !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160);
  voiceController?.observeConversation(conversation.id, voiceMessages);
  const messages = conversation.messages ?? [];
  const signature = JSON.stringify(messages);
  const changed = signature !== state.conversationSignature;
  state.conversationSignature = signature;
  if (changed) {
    clearNode(list);
    for (const message of messages) list.append(renderMessage(conversation, message));
  }

  const members = participantCoworkers(conversation);
  const start = $("conversation-start");
  const hasMessages = (conversation.messageCount ?? messages.length) > 0;
  start.classList.toggle("hidden", hasMessages);
  if (!hasMessages) {
    const direct = conversation.kind === "direct" ? members[0] : undefined;
    $("conversation-start-avatar").textContent = conversation.kind === "team" ? "#" : avatarFor(direct);
    $("conversation-start-title").textContent = conversation.kind === "team" ? conversation.title : direct?.name || "Start a conversation";
    $("conversation-start-role").textContent = conversation.kind === "team"
      ? `A shared room with ${members.map((entry) => entry.name).join(", ")}.`
      : direct?.role || "This coworker keeps context across turns.";
  }

  const pending = pendingUserRecipients(conversation);
  $("typing-row").classList.toggle("hidden", pending.size === 0);
  if (pending.size) {
    const names = [...pending].map((id) => coworkerById(id)?.name).filter(Boolean);
    $("typing-label").textContent = names.length > 1 ? `${names.join(" & ")} are working…` : `${names[0] || "Coworker"} is working…`;
  }
  updateConversationPageControls();
  if (!changed && !forceScroll && !preserveScroll) return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(() => {
    if (!scroller) { resolve(); return; }
    if (preserveScroll) {
      const anchor = preserveAnchor?.messageId
        ? [...list.querySelectorAll("[data-message-id]")].find((row) => row.dataset.messageId === preserveAnchor.messageId)
        : undefined;
      if (anchor) {
        const delta = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - preserveAnchor.offset;
        scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
      } else {
        scroller.scrollTop = Math.max(0, beforeTop + scroller.scrollHeight - beforeHeight);
      }
    } else if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
    resolve();
  }));
}

async function refreshConversation(forceScroll = false) {
  const id = state.selectedConversationId;
  if (!id || state.activeView !== "conversation") return;
  if (state.conversationPage?.conversationId !== id) resetConversationPage(id);
  const requestId = ++state.conversationRefreshRequest;
  try {
    const conversationSummary = conversationById(id) ?? (state.selectedConversation?.id === id ? state.selectedConversation : undefined);
    const activityPromise = conversationSummary?.kind === "team"
      ? window.sovereignbot.teams.activity({ conversationId: id, limit: 24 }).catch(() => ({ events: [] }))
      : Promise.resolve({ events: [] });
    const [pageResponse, activity] = await Promise.all([
      window.sovereignbot.conversations.get({ conversationId: id, limit: CONVERSATION_PAGE_SIZE }),
      activityPromise,
    ]);
    if (requestId !== state.conversationRefreshRequest || state.selectedConversationId !== id) return;
    const { messages, freshMessages } = mergeConversationPage(pageResponse, "latest");
    const conversation = { ...pageResponse, messages, pageInfo: pageResponse.pageInfo };
    state.selectedConversation = conversation;
    state.teamActivity = activity ?? { events: [] };
    markConversationRead(conversation);
    renderConversationHeader(conversation);
    renderMessages(conversation, forceScroll, { voiceMessages: freshMessages });
    void refreshInlineAttention(id);
    await refreshConversations();
    if (state.teams.length) await refreshTeams();
    // Team flow state is refreshed after the conversation header. Re-render the
    // details panel so active fanout status is visible without waiting for the
    // next polling cycle.
    if (state.selectedConversationId === id && state.selectedConversation) renderDetails(state.selectedConversation);
  } catch (error) {
    if (requestId === state.conversationRefreshRequest && state.selectedConversationId === id) {
      $("composer-error").textContent = text(error?.message || error);
      show($("composer-error"));
    }
  }
  if (requestId !== state.conversationRefreshRequest) return;
  clearTimeout(state.pollTimer);
  if (state.activeView === "conversation" && state.selectedConversationId === id) state.pollTimer = setTimeout(() => refreshConversation(false), 850);
}

async function loadOlderMessages() {
  const page = state.conversationPage;
  const id = state.selectedConversationId;
  if (!page || page.conversationId !== id || !page.hasOlder || page.loadingOlder || !page.nextBeforeMessageId) return;
  const scroller = $("message-scroller");
  const viewportTop = scroller?.getBoundingClientRect().top ?? 0;
  const viewportBottom = viewportTop + (scroller?.clientHeight ?? 0);
  const anchor = [...$("conversation-messages")?.querySelectorAll("[data-message-id]") ?? []]
    .map((row) => ({ row, rect: row.getBoundingClientRect() }))
    .find(({ rect }) => rect.bottom > viewportTop + 72 && rect.top < viewportBottom - 72);
  const preserveAnchor = anchor ? { messageId: anchor.row.dataset.messageId, offset: anchor.rect.top - viewportTop } : undefined;
  page.loadingOlder = true;
  updateConversationPageControls();
  try {
    const response = await window.sovereignbot.conversations.get({ conversationId: id, limit: CONVERSATION_PAGE_SIZE, beforeMessageId: page.nextBeforeMessageId });
    if (state.selectedConversationId !== id || state.conversationPage !== page) return;
    const { messages } = mergeConversationPage(response, "older");
    const conversation = { ...response, messages, pageInfo: response.pageInfo };
    state.selectedConversation = conversation;
    renderConversationHeader(conversation);
    await renderMessages(conversation, false, { voiceMessages: [], preserveScroll: true, preserveAnchor });
    if (state.selectedConversation) renderDetails(state.selectedConversation);
  } catch (error) {
    if (state.selectedConversationId === id) {
      $("composer-error").textContent = text(error?.message || error);
      show($("composer-error"));
    }
  } finally {
    if (state.conversationPage === page) {
      page.loadingOlder = false;
      updateConversationPageControls();
    }
  }
}

async function jumpToLatestMessages() {
  const page = state.conversationPage;
  const id = state.selectedConversationId;
  if (!page || page.conversationId !== id || page.loadingLatest) return;
  page.loadingLatest = true;
  updateConversationPageControls();
  try {
    const response = await window.sovereignbot.conversations.get({ conversationId: id, limit: CONVERSATION_PAGE_SIZE });
    if (state.selectedConversationId !== id || state.conversationPage !== page) return;
    const messages = Array.isArray(response?.messages) ? response.messages.slice(-MAX_RENDERED_MESSAGES) : [];
    page.messages = messages;
    page.total = Number.isInteger(response?.messageCount) ? response.messageCount : (response?.pageInfo?.total ?? messages.length);
    page.hasOlder = Boolean(response?.pageInfo?.hasOlder);
    page.nextBeforeMessageId = page.hasOlder ? messages[0]?.id : undefined;
    page.loadedOlder = false;
    page.historyMode = false;
    page.windowIncludesLatest = true;
    page.newMessagesAvailable = 0;
    page.latestMessageId = response?.lastMessage?.id ?? messages.at(-1)?.id;
    page.seenMessageIds = new Set(messages.map((message) => message?.id).filter(Boolean));
    state.conversationSignature = undefined;
    const conversation = { ...response, messages, pageInfo: response.pageInfo };
    state.selectedConversation = conversation;
    renderConversationHeader(conversation);
    renderMessages(conversation, true, { voiceMessages: [] });
    if (state.selectedConversation) renderDetails(state.selectedConversation);
  } catch (error) {
    if (state.selectedConversationId === id) {
      $("composer-error").textContent = text(error?.message || error);
      show($("composer-error"));
    }
  } finally {
    if (state.conversationPage === page) {
      page.loadingLatest = false;
      updateConversationPageControls();
    }
  }
}

function autoSizeComposer() {
  const area = $("composer-input");
  area.style.height = "auto";
  area.style.height = `${Math.min(area.scrollHeight, 180)}px`;
}

async function sendMessage(event) {
  event?.preventDefault();
  const conversation = state.selectedConversation;
  if (!conversation) return;
  const area = $("composer-input");
  const value = area.value.trim();
  if (!value) return;
  hide($("composer-error"));
  $("composer-send").disabled = true;
  try {
    const pending = pendingUserRecipients(conversation);
    const payload = {
      conversationId: conversation.id,
      text: value,
      ...(state.mentionIds.size ? { mentions: [...state.mentionIds] } : {}),
      ...(state.replyTo ? { replyTo: state.replyTo } : {}),
      clientMessageId: `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    };
    const send = state.redirectMode && pending.size
      ? window.sovereignbot.conversations.redirect
      : window.sovereignbot.conversations.send;
    await send(payload);
    area.value = "";
    autoSizeComposer();
    state.mentionIds.clear();
    state.replyTo = undefined;
    state.redirectMode = false;
    await refreshConversation(true);
  } catch (error) {
    $("composer-error").textContent = text(error?.message || error).replace(/^.*Error: /, "");
    show($("composer-error"));
  } finally {
    $("composer-send").disabled = false;
  }
}

function renderCollaborationControls(conversation, team) {
  const section = $("details-collaboration");
  const targetSelect = $("collaboration-target");
  const submit = $("collaboration-submit");
  if (!section || !targetSelect || !submit) return;
  const flow = team?.flow ?? {};
  const owner = flow.currentOwnerId ? coworkerById(flow.currentOwnerId) : undefined;
  const members = participantCoworkers(conversation);
  const targets = members.filter((entry) => entry.id !== flow.currentOwnerId && entry.state === "active");
  section.classList.toggle("hidden", conversation.kind !== "team" || !team || !owner);
  const previous = targetSelect.value;
  targetSelect.textContent = "";
  for (const coworker of targets) {
    const option = document.createElement("option");
    option.value = coworker.id;
    option.textContent = coworker.name;
    targetSelect.append(option);
  }
  if (targets.some((entry) => entry.id === previous)) targetSelect.value = previous;
  const protocol = flow.activeProtocol;
  const waitingForProtocol = ["requested", "review_requested", "accepted", "review_accepted", "working", "reviewing"].includes(protocol?.state)
    || (protocol?.kind === "review" && protocol.state === "submitted");
  const parallelActive = Boolean(flow.activeFanout);
  submit.disabled = !owner || !targets.length || waitingForProtocol || parallelActive;
  submit.textContent = $("collaboration-type")?.value === "review" ? "Ask for review / 请求审阅" : "Send to teammate / 发给同事";
  submit.title = parallelActive ? "Finish parallel work first" : waitingForProtocol ? "Finish the current collaboration first" : "Send a bounded task to the selected teammate";
}

async function submitCollaborationRequest() {
  const conversation = state.selectedConversation;
  const targetCoworkerId = $("collaboration-target")?.value;
  const handoffType = $("collaboration-type")?.value;
  const boundedTask = $("collaboration-task")?.value.trim();
  const reason = $("collaboration-reason")?.value.trim();
  const errorTarget = $("collaboration-form-error");
  const submit = $("collaboration-submit");
  if (!conversation || conversation.kind !== "team") return;
  hide(errorTarget);
  if (!targetCoworkerId || !boundedTask || !reason) {
    errorTarget.textContent = "Choose a teammate and provide both a bounded task and a reason.";
    show(errorTarget);
    return;
  }
  submit.disabled = true;
  try {
    await window.sovereignbot.teams.requestCollaboration({ conversationId: conversation.id, targetCoworkerId, handoffType, reason, boundedTask });
    $("collaboration-task").value = "";
    $("collaboration-reason").value = "";
    await refreshConversation(true);
  } catch (error) {
    errorTarget.textContent = text(error?.message || error).replace(/^.*Error: /, "");
    show(errorTarget);
  } finally {
    if (state.selectedConversation) renderCollaborationControls(state.selectedConversation, teamForConversation(state.selectedConversation.id));
  }
}

function makeParallelLabel(label, control) {
  const wrapper = document.createElement("label");
  wrapper.textContent = label;
  wrapper.append(control);
  return wrapper;
}

function ensureParallelControls() {
  const existing = $("details-parallel-collaboration");
  if (existing) return existing;
  const collaboration = $("details-collaboration");
  if (!collaboration) return undefined;
  const section = document.createElement("section");
  section.id = "details-parallel-collaboration";
  section.className = "detail-section hidden";
  const label = document.createElement("span");
  label.className = "detail-label";
  label.textContent = "Parallel Specialists / 并行专家";
  const help = document.createElement("p");
  help.id = "parallel-collaboration-help";
  help.className = "detail-help";
  help.textContent = "Split this bounded task across 2–4 active Specialists, then require one independent review before the current owner joins the results.";
  const progress = document.createElement("div");
  progress.id = "parallel-collaboration-progress";
  progress.className = "detail-value parallel-progress";
  const progressList = document.createElement("div");
  progressList.id = "parallel-progress-list";
  progressList.className = "member-list parallel-progress-list";
  const form = document.createElement("div");
  form.id = "parallel-collaboration-form";
  const rows = document.createElement("div");
  rows.id = "parallel-specialist-list";
  rows.className = "parallel-specialist-list";
  const add = document.createElement("button");
  add.id = "parallel-add-specialist";
  add.type = "button";
  add.className = "quiet-action";
  add.textContent = "Add Specialist / 添加专家";
  add.addEventListener("click", () => {
    const list = $("parallel-specialist-list");
    if (!list || list.children.length >= 4) return;
    list.append(makeParallelRow());
    renderParallelControls(state.selectedConversation, teamForConversation(state.selectedConversation?.id));
  });
  const rowActions = document.createElement("div");
  rowActions.className = "detail-actions";
  rowActions.append(add);
  const reviewer = document.createElement("select");
  reviewer.id = "parallel-reviewer";
  reviewer.className = "detail-select";
  const reason = document.createElement("input");
  reason.id = "parallel-reason";
  reason.maxLength = 400;
  reason.placeholder = "Why split this work? / 为什么并行？";
  const submit = document.createElement("button");
  submit.id = "parallel-submit";
  submit.type = "button";
  submit.className = "hero-action";
  submit.textContent = "Start parallel work / 开始并行";
  const error = document.createElement("p");
  error.id = "parallel-form-error";
  error.className = "inline-error hidden";
  form.append(rows, rowActions, makeParallelLabel("Independent reviewer / 独立审阅者", reviewer), makeParallelLabel("Reason / 原因", reason), submit, error);
  section.append(label, help, progress, progressList, form);
  collaboration.after(section);
  submit.addEventListener("click", submitParallelCollaboration);
  if (!rows.children.length) { rows.append(makeParallelRow(), makeParallelRow()); }
  return section;
}

function makeParallelRow() {
  const row = document.createElement("div");
  row.className = "parallel-specialist-row";
  const title = document.createElement("span");
  title.className = "detail-label";
  title.textContent = "Specialist / 专家";
  const target = document.createElement("select");
  target.className = "detail-select parallel-target";
  target.addEventListener("change", () => renderParallelControls(state.selectedConversation, teamForConversation(state.selectedConversation?.id)));
  const task = document.createElement("textarea");
  task.className = "parallel-task";
  task.maxLength = 800;
  task.rows = 2;
  task.placeholder = "Bounded subtask / 有界子任务";
  const computerLabel = document.createElement("label");
  computerLabel.className = "parallel-computer-label";
  const computer = document.createElement("input");
  computer.type = "checkbox";
  computer.className = "parallel-computer";
  computerLabel.append(computer, document.createTextNode(" Needs Computer / 需要电脑"));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "quiet-action parallel-remove";
  remove.textContent = "Remove / 移除";
  remove.addEventListener("click", () => {
    const list = $("parallel-specialist-list");
    if (list?.children.length <= 2) return;
    row.remove();
    renderParallelControls(state.selectedConversation, teamForConversation(state.selectedConversation?.id));
  });
  row.append(title, target, task, computerLabel, remove);
  return row;
}

function parallelRows() {
  return [...document.querySelectorAll("#parallel-specialist-list .parallel-specialist-row")];
}

function refreshParallelReviewerOptions(members, ownerId) {
  const reviewer = $("parallel-reviewer");
  if (!reviewer) return;
  const previous = reviewer.value;
  const selected = new Set(parallelRows().map((row) => row.querySelector(".parallel-target")?.value).filter(Boolean));
  reviewer.textContent = "";
  for (const coworker of members.filter((entry) => entry.state === "active" && entry.id !== ownerId && !selected.has(entry.id))) {
    const option = document.createElement("option");
    option.value = coworker.id;
    option.textContent = coworker.name;
    reviewer.append(option);
  }
  if ([...reviewer.options].some((option) => option.value === previous)) reviewer.value = previous;
}

function renderParallelControls(conversation, team) {
  const section = ensureParallelControls();
  if (!section) return;
  const flow = team?.flow ?? {};
  const owner = flow.currentOwnerId ? coworkerById(flow.currentOwnerId) : undefined;
  const members = participantCoworkers(conversation);
  const visible = conversation?.kind === "team" && Boolean(team) && Boolean(owner);
  section.classList.toggle("hidden", !visible);
  if (!visible) return;
  const fanout = flow.activeFanout;
  const progress = $("parallel-collaboration-progress");
  const progressList = $("parallel-progress-list");
  const form = $("parallel-collaboration-form");
  if (fanout?.children?.length) {
    const completed = fanout.children.filter((entry) => entry.status === "completed").length;
    const status = fanout.state === "blocked" || fanout.state === "stopped" ? "Attention" : fanout.state === "review_requested" || fanout.state === "reviewing" ? "Reviewing" : fanout.state === "join_requested" || fanout.state === "joining" ? "Joining" : "Parallel work";
    progress.textContent = `${completed}/${fanout.children.length} specialists complete · ${status}`;
    progressList.textContent = "";
    for (const child of fanout.children) {
      const row = document.createElement("div");
      row.className = "member-row parallel-progress-row";
      const copy = document.createElement("span");
      const childStatus = { requested: "Queued", running: "Working", completed: "Complete", failed: "Attention", stopped: "Stopped" }[child.status] ?? child.status;
      copy.textContent = `${child.coworker} · ${childStatus} · ${child.task}`;
      row.append(copy);
      if (child.resultSummary) {
        const result = document.createElement("small");
        result.textContent = child.resultSummary;
        row.append(result);
      }
      progressList.append(row);
    }
    if (fanout.reviewSummary) {
      const review = document.createElement("div");
      review.className = "detail-help";
      review.textContent = `Review: ${fanout.reviewSummary}`;
      progressList.append(review);
    }
    show(progress); show(progressList); hide(form);
    return;
  }
  hide(progress); hide(progressList); show(form);
  const list = $("parallel-specialist-list");
  while (list.children.length < 2) list.append(makeParallelRow());
  const targets = members.filter((entry) => entry.state === "active" && entry.id !== owner.id);
  const selected = new Set();
  for (const row of parallelRows()) {
    const select = row.querySelector(".parallel-target");
    const previous = select.value;
    select.textContent = "";
    for (const coworker of targets) {
      const option = document.createElement("option");
      option.value = coworker.id;
      option.textContent = coworker.name;
      option.disabled = selected.has(coworker.id) && coworker.id !== previous;
      select.append(option);
    }
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    if (select.value) selected.add(select.value);
    row.querySelector(".parallel-remove").disabled = list.children.length <= 2;
  }
  $("parallel-add-specialist").disabled = list.children.length >= 4;
  refreshParallelReviewerOptions(members, owner.id);
}

async function submitParallelCollaboration() {
  const conversation = state.selectedConversation;
  const rows = parallelRows();
  const reviewerCoworkerId = $("parallel-reviewer")?.value;
  const reason = $("parallel-reason")?.value.trim();
  const errorTarget = $("parallel-form-error");
  const submit = $("parallel-submit");
  if (!conversation || conversation.kind !== "team") return;
  hide(errorTarget);
  const children = rows.map((row) => ({
    targetCoworkerId: row.querySelector(".parallel-target")?.value,
    boundedTask: row.querySelector(".parallel-task")?.value.trim(),
    ...(row.querySelector(".parallel-computer")?.checked ? { requiresComputer: true } : {}),
  }));
  if (children.length < 2 || children.some((entry) => !entry.targetCoworkerId || !entry.boundedTask) || !reviewerCoworkerId || !reason) {
    errorTarget.textContent = "Choose 2–4 Specialists, give each a bounded subtask, choose an independent reviewer, and provide a reason.";
    show(errorTarget);
    return;
  }
  submit.disabled = true;
  try {
    await window.sovereignbot.teams.requestParallel({ conversationId: conversation.id, children, reviewerCoworkerId, reason });
    await refreshConversation(true);
  } catch (error) {
    errorTarget.textContent = text(error?.message || error).replace(/^.*Error: /, "");
    show(errorTarget);
  } finally {
    if (state.selectedConversation) renderParallelControls(state.selectedConversation, teamForConversation(state.selectedConversation.id));
  }
}

function renderDetails(conversation) {
  const membersEl = $("details-members");
  clearNode(membersEl);
  const members = participantCoworkers(conversation);
  for (const coworker of members) {
    const row = document.createElement("div");
    row.className = "member-row";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = avatarFor(coworker);
    const name = document.createElement("span");
    name.textContent = coworker.name;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "message-action member-edit";
    edit.textContent = "Edit / 编辑";
    edit.addEventListener("click", () => openCoworkerDialog(coworker));
    row.append(avatar, name, edit);
    membersEl.append(row);
  }

  const profiles = [...new Set(members.map((entry) => bindingFor(entry.id)?.profile).filter(Boolean))];
  $("details-provider").textContent = profiles.length ? profiles.map(humanModelProfile).join(" + ") : "Automatic / 自动";
  const team = teamForConversation(conversation.id);
  $("details-workspace").textContent = team ? "Shared project workspace" : "Private workspace";
  renderCoworkerConnectedApps(conversation.kind === "direct" ? members[0] : undefined);
  const teamTools = $("details-team-tools");
  teamTools?.classList.toggle("hidden", !team);
  if (!team) $("team-pack-transfer-result") && ($("team-pack-transfer-result").textContent = "");
  const playbookSelect = $("team-playbook-select");
  if (playbookSelect) {
    playbookSelect.textContent = "";
    for (const playbook of team?.playbooks ?? []) {
      const option = document.createElement("option");
      option.value = playbook.id;
      option.textContent = playbook.name;
      playbookSelect.append(option);
    }
  }
  const channelSelect = $("team-channel-select");
  if (channelSelect) {
    channelSelect.textContent = "";
    for (const channel of team?.channels ?? []) {
      const option = document.createElement("option");
      option.value = channel.conversationId;
      option.textContent = `${channel.name} / ${channel.kind}${channel.archived ? " · archived / 已归档" : ""}`;
      option.selected = channel.conversationId === conversation.id;
      channelSelect.append(option);
    }
  }
  const selectedChannel = team?.channels?.find((entry) => entry.conversationId === conversation.id);
  $("team-edit-channel")?.classList.toggle("hidden", !selectedChannel);
  $("team-archive-channel")?.classList.toggle("hidden", !selectedChannel || selectedChannel.archived);
  $("team-restore-channel")?.classList.toggle("hidden", !selectedChannel?.archived);
  const templateSelect = $("team-channel-template-select");
  if (templateSelect) {
    templateSelect.textContent = "";
    for (const template of state.channelTemplates) {
      const option = document.createElement("option");
      option.value = template.id;
      option.textContent = `${template.name} / ${template.kind}`;
      templateSelect.append(option);
    }
  }
  const roster = $("details-roster");
  clearNode(roster);
  if (team) {
    const flow = team.flow ?? {};
    const attention = new Set(flow.attentionCoworkerIds ?? []);
    for (const member of team.coworkers ?? members.map((entry) => ({ id: entry.id, name: entry.name }))) {
      const row = document.createElement("div");
      row.className = "member-row";
      const name = document.createElement("span");
      name.textContent = member.name;
      const status = document.createElement("small");
      status.className = "member-status";
      status.textContent = attention.has(member.id) ? "Attention" : member.id === flow.currentOwnerId && flow.status === "active" ? "Active" : member.id === flow.currentOwnerId ? "Waiting" : "Available";
      row.append(name, status);
      roster.append(row);
    }
  }
  const pending = pendingUserRecipients(conversation);
  const latestActivity = state.teamActivity?.events?.[0];
  const activitySuffix = latestActivity?.targetCoworker && latestActivity.label?.toLowerCase().includes("handoff")
    ? ` · ${latestActivity.label} → ${latestActivity.targetCoworker}`
    : latestActivity?.label ? ` · ${latestActivity.label}` : "";
  const parallel = team?.flow?.activeFanout;
  if (parallel?.children?.length) {
    const done = parallel.children.filter((entry) => entry.status === "completed").length;
    const parallelStatus = parallel.state === "stopped" || parallel.state === "blocked"
      ? "Attention"
      : parallel.state === "reviewing" ? "Reviewing" : parallel.state === "join_requested" || parallel.state === "joining" ? "Joining results" : "Parallel work";
    $("details-current-work").textContent = `${done}/${parallel.children.length} specialists complete · ${parallelStatus}`;
  } else $("details-current-work").textContent = team?.flow?.currentOwner
    ? `${team.flow.status === "needs-attention" ? "Attention" : team.flow.status === "active" ? "Active" : team.flow.status === "stopped" ? "Attention" : "Waiting"} · ${team.flow.currentOwner}${activitySuffix}`
    : pending.size ? `${pending.size} coworker${pending.size === 1 ? "" : "s"} working` : "Ready";
  renderCollaborationControls(conversation, team);
  renderParallelControls(conversation, team);
  void renderMemorySections(conversation, team);
}

function memoryTarget(scope, ownerId) { return { scope, ownerId, limit: 20 }; }
function memoryScopeTarget(scope, ownerId) { return { scope, ownerId }; }

async function renderMemorySection(sectionId, listId, scope, ownerId) {
  const section = $(sectionId);
  const root = $(listId);
  if (!section || !root || !ownerId || !window.sovereignbot?.memory?.list) return;
  show(section);
  clearNode(root);
  try {
    const result = await window.sovereignbot.memory.list(memoryTarget(scope, ownerId));
    const memories = result?.memories ?? [];
    if (!memories.length) {
      const empty = document.createElement("small");
      empty.textContent = "No memories yet.";
      root.append(empty);
      return;
    }
    for (const memory of memories) {
      const row = document.createElement("div");
      row.className = "memory-row";
      const title = document.createElement("strong");
      title.textContent = `${memory.title}${memory.pinned ? " · pinned" : ""}`;
      const content = document.createElement("span");
      content.textContent = memory.content;
      const source = document.createElement("small");
      source.textContent = `Source: ${memory.source?.label ?? "Unavailable"}`;
      const actions = document.createElement("div");
      actions.className = "detail-actions";
      const action = (label, handler) => { const button = document.createElement("button"); button.type = "button"; button.className = "quiet-action"; button.textContent = label; button.addEventListener("click", handler); actions.append(button); };
      action(memory.pinned ? "Unpin" : "Pin", async () => { await window.sovereignbot.memory.pin({ ...memoryScopeTarget(scope, ownerId), memoryId: memory.id, pinned: !memory.pinned }); await renderMemorySection(sectionId, listId, scope, ownerId); });
      action("Edit", async () => {
        const next = window.prompt("Edit memory content", memory.content);
        if (next === null) return;
        await window.sovereignbot.memory.update({ ...memoryScopeTarget(scope, ownerId), memoryId: memory.id, patch: { title: memory.title, content: next, tags: memory.tags } });
        await renderMemorySection(sectionId, listId, scope, ownerId);
      });
      action("Forget", async () => { await window.sovereignbot.memory.forget({ ...memoryScopeTarget(scope, ownerId), memoryId: memory.id }); await renderMemorySection(sectionId, listId, scope, ownerId); });
      action("Delete", async () => { if (!window.confirm("Delete this memory?")) return; await window.sovereignbot.memory.delete({ ...memoryScopeTarget(scope, ownerId), memoryId: memory.id }); await renderMemorySection(sectionId, listId, scope, ownerId); });
      action("Source", async () => { const trace = await window.sovereignbot.memory.sourceTrace({ ...memoryScopeTarget(scope, ownerId), memoryId: memory.id }); source.textContent = `Source: ${trace?.label ?? "Unavailable"}`; if (trace?.navigation?.conversationId && typeof openConversation === "function") openConversation(trace.navigation.conversationId); });
      row.append(title, content, source, actions);
      root.append(row);
    }
  } catch (error) {
    const message = document.createElement("small");
    message.textContent = text(error?.message || error).replace(/^.*Error: /, "");
    root.append(message);
  }
}

async function renderMemorySections(conversation, team) {
  const members = participantCoworkers(conversation);
  const coworkerId = conversation?.kind === "direct" ? members[0]?.id : undefined;
  const channel = team?.channels?.find((entry) => entry.conversationId === conversation?.id);
  if (team && !state.projects.length) await refreshProjects();
  const project = team && state.projects.find((entry) => entry.teams?.some((candidate) => candidate.id === team.id) || entry.teams?.some((candidate) => candidate.channels?.some((candidateChannel) => candidateChannel.id === channel?.id)));
  const projectId = project?.projectId;
  for (const [sectionId, listId, scope, ownerId] of [
    ["details-coworker-memory", "details-coworker-memory-list", "coworker", coworkerId],
    ["details-team-memory", "details-team-memory-list", "team", team?.id],
    ["details-project-memory", "details-project-memory-list", "project", projectId],
  ]) {
    if (!ownerId) { hide($(sectionId)); continue; }
    await renderMemorySection(sectionId, listId, scope, ownerId);
  }
}

function renderCoworkerConnectedApps(coworker) {
  const section = $("details-connected-apps");
  const root = $("details-connected-app-list");
  if (!section || !root) return;
  section.classList.toggle("hidden", !coworker);
  clearNode(root);
  if (!coworker) return;
  const apps = state.connectedApps?.apps ?? [];
  if (!apps.length) {
    const empty = document.createElement("small");
    empty.textContent = "No governed connections are available yet.";
    root.append(empty);
    return;
  }
  for (const app of apps) {
    const label = document.createElement("label");
    label.className = "member-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = (app.assignedCoworkerIds ?? []).includes(coworker.id);
    checkbox.disabled = app.state !== "available";
    checkbox.addEventListener("change", async () => {
      checkbox.disabled = true;
      try {
        const updated = await window.sovereignbot.connectedApps.assign({ appId: app.id, coworkerId: coworker.id, enabled: checkbox.checked });
        state.connectedApps = { apps: (state.connectedApps?.apps ?? []).map((entry) => entry.id === updated.id ? updated : entry) };
        renderCoworkerConnectedApps(coworker);
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        showToastError(error);
        checkbox.disabled = app.state !== "available";
      }
    });
    const textEl = document.createElement("span");
    textEl.textContent = `${app.name} · ${app.state === "available" ? "Available / 可用" : "Unavailable / 不可用"}`;
    label.append(checkbox, textEl);
    root.append(label);
  }
}

function openTeamPackDialog(pack) {
  const area = $("team-pack-json");
  const error = $("team-pack-form-error");
  if (!area) return;
  area.value = pack ? JSON.stringify(pack, null, 2) : "";
  hide(error);
  $("team-pack-dialog")?.showModal?.();
  if (!pack) area.focus();
}

async function exportCurrentTeamPack() {
  const team = teamForConversation(state.selectedConversationId);
  if (!team || !window.sovereignbot?.teams?.exportPack) return;
  const result = $("team-pack-transfer-result");
  try {
    const pack = await window.sovereignbot.teams.exportPack({ teamId: team.id });
    openTeamPackDialog(pack);
    if (result) result.textContent = "Export ready. Copy the JSON to share it.";
  } catch (error) {
    if (result) result.textContent = text(error?.message || error).replace(/^.*Error: /, "");
  }
}

async function importTeamPack(event) {
  event.preventDefault();
  const area = $("team-pack-json");
  const error = $("team-pack-form-error");
  hide(error);
  let pack;
  try {
    pack = JSON.parse(area.value);
  } catch {
    error.textContent = "Paste a valid team pack JSON.";
    show(error);
    return;
  }
  try {
    const imported = await window.sovereignbot.teams.importPack({ pack });
    $("team-pack-dialog")?.close();
    await Promise.all([refreshCoworkers(), refreshConversations(), refreshTeams(), refreshRoster()]);
    const channel = imported?.team?.channels?.[0] ?? state.channels.find((entry) => entry.teamId === imported?.team?.id);
    if (channel?.conversationId) await openConversation(channel.conversationId);
  } catch (caught) {
    error.textContent = text(caught?.message || caught).replace(/^.*Error: /, "");
    show(error);
  }
}

async function copyTeamPack() {
  const area = $("team-pack-json");
  const result = $("team-pack-form-error");
  hide(result);
  if (!area?.value.trim()) return;
  try {
    await navigator.clipboard.writeText(area.value);
    result.textContent = "Copied to clipboard.";
    result.classList.remove("hidden");
  } catch {
    result.textContent = "Clipboard is unavailable; select the JSON and copy it manually.";
    result.classList.remove("hidden");
  }
}

function openPlaybookDialog(playbook) {
  const area = $("playbook-json");
  const error = $("playbook-form-error");
  if (!area) return;
  area.value = playbook ? JSON.stringify(playbook, null, 2) : "";
  hide(error);
  $("playbook-dialog")?.showModal?.();
  if (!playbook) area.focus();
}

async function exportCurrentPlaybook() {
  const team = teamForConversation(state.selectedConversationId);
  const playbookId = $("team-playbook-select")?.value;
  if (!team || !playbookId || !window.sovereignbot?.teams?.exportPlaybook) return;
  const result = $("team-pack-transfer-result");
  try {
    const playbook = await window.sovereignbot.teams.exportPlaybook({ teamId: team.id, playbookId });
    openPlaybookDialog(playbook);
    if (result) result.textContent = "Method export ready. Copy the JSON to share it.";
  } catch (error) {
    if (result) result.textContent = text(error?.message || error).replace(/^.*Error: /, "");
  }
}

async function importPlaybook(event) {
  event.preventDefault();
  const team = teamForConversation(state.selectedConversationId);
  const area = $("playbook-json");
  const error = $("playbook-form-error");
  hide(error);
  if (!team) {
    error.textContent = "Open a team channel first.";
    show(error);
    return;
  }
  let playbook;
  try {
    playbook = JSON.parse(area.value);
  } catch {
    error.textContent = "Paste a valid Playbook JSON.";
    show(error);
    return;
  }
  try {
    const imported = await window.sovereignbot.teams.importPlaybook({ teamId: team.id, playbook });
    $("playbook-dialog")?.close();
    await refreshTeams();
    if (state.selectedConversation) renderDetails(state.selectedConversation);
    $("team-pack-transfer-result").textContent = imported.imported ? "Playbook imported." : "Playbook already exists.";
  } catch (caught) {
    error.textContent = text(caught?.message || caught).replace(/^.*Error: /, "");
    show(error);
  }
}

async function copyPlaybook() {
  const area = $("playbook-json");
  const result = $("playbook-form-error");
  hide(result);
  if (!area?.value.trim()) return;
  try {
    await navigator.clipboard.writeText(area.value);
    result.textContent = "Copied to clipboard.";
    show(result);
  } catch {
    result.textContent = "Clipboard is unavailable; select the JSON and copy it manually.";
    show(result);
  }
}

async function openSelectedTeamChannel() {
  const conversationId = $("team-channel-select")?.value;
  if (conversationId) await openConversation(conversationId);
}

async function addChannelFromTemplate() {
  const team = teamForConversation(state.selectedConversationId);
  const templateId = $("team-channel-template-select")?.value;
  if (!team || !templateId || !window.sovereignbot?.teams?.createChannelFromTemplate) return;
  const result = $("team-pack-transfer-result");
  try {
    const created = await window.sovereignbot.teams.createChannelFromTemplate({ teamId: team.id, templateId });
    await Promise.all([refreshConversations(), refreshTeams()]);
    if (created?.channel?.conversationId) await openConversation(created.channel.conversationId);
    if (result) result.textContent = created.created ? "Channel added." : "That channel is already in this team.";
  } catch (error) {
    if (result) result.textContent = text(error?.message || error).replace(/^.*Error: /, "");
  }
}

function populateChannelDialog(channel, team) {
  state.editingChannelId = channel?.id;
  state.editingChannelTeamId = team?.id;
  $("channel-dialog-eyebrow").textContent = channel ? "EDIT CHANNEL / 编辑频道" : "NEW CHANNEL / 新建频道";
  $("channel-dialog-title").textContent = channel ? "Shape this channel" : "Create a channel";
  $("channel-save").textContent = channel ? "Save changes / 保存修改" : "Create channel / 创建频道";
  $("channel-name").value = channel?.name ?? "";
  $("channel-kind").value = channel?.kind ?? "project";
  $("channel-instructions").value = channel?.instructions ?? "";
  const workspace = $("channel-workspace");
  workspace.textContent = "";
  for (const entry of state.workspaces?.workspaces ?? []) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.kind === "shared-project" ? "Shared project workspace / 共享项目工作区" : entry.label || "Private workspace / 私有工作区";
    option.selected = (channel?.workspaceId ?? team?.sharedWorkspaceId) === entry.id;
    workspace.append(option);
  }
  const playbook = $("channel-playbook");
  playbook.textContent = "";
  for (const entry of team?.playbooks ?? []) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.name;
    option.selected = (channel?.playbookId ?? team?.playbooks?.[0]?.id) === entry.id;
    playbook.append(option);
  }
  hide($("channel-form-error"));
  openDialog("channel-dialog");
}

function openNewChannelDialog() {
  const team = teamForConversation(state.selectedConversationId);
  if (team) {
    state.channelEditorReturnView = undefined;
    populateChannelDialog(undefined, team);
  }
}

function openEditChannelDialog() {
  const team = teamForConversation(state.selectedConversationId);
  const channel = team?.channels?.find((entry) => entry.conversationId === state.selectedConversationId);
  if (team && channel) {
    state.channelEditorReturnView = undefined;
    populateChannelDialog(channel, team);
  }
}

window.openProductChannelEditor = async ({ teamId, channelId } = {}) => {
  if (!state.teams.some((entry) => entry.id === teamId)) await refreshTeams();
  const team = state.teams.find((entry) => entry.id === teamId);
  const channel = team?.channels?.find((entry) => entry.id === channelId);
  if (!team) throw new Error("Choose a team first.");
  if (channelId && !channel) throw new Error("Channel is no longer available.");
  if (!state.workspaces?.workspaces?.length) await refreshSettingsData();
  state.channelEditorReturnView = "channels";
  populateChannelDialog(channel, team);
};

async function saveChannel(event) {
  event.preventDefault();
  const team = state.editingChannelTeamId
    ? state.teams.find((entry) => entry.id === state.editingChannelTeamId)
    : teamForConversation(state.selectedConversationId);
  const error = $("channel-form-error");
  hide(error);
  if (!team) return;
  const payload = {
    name: $("channel-name").value,
    kind: $("channel-kind").value,
    instructions: $("channel-instructions").value,
    workspaceId: $("channel-workspace").value,
    playbookId: $("channel-playbook").value,
  };
  try {
    const result = state.editingChannelId
      ? await window.sovereignbot.channels.update({ channelId: state.editingChannelId, patch: payload })
      : await window.sovereignbot.channels.create({ teamId: team.id, ...payload });
    $("channel-dialog")?.close();
    await Promise.all([refreshConversations(), refreshTeams()]);
    const returnView = state.channelEditorReturnView;
    state.channelEditorReturnView = undefined;
    state.editingChannelTeamId = undefined;
    if (returnView) {
      await window.refreshIndependentProductPages?.();
      switchView(returnView);
    } else if (result?.channel?.conversationId) await openConversation(result.channel.conversationId);
  } catch (caught) {
    error.textContent = text(caught?.message || caught).replace(/^.*Error: /, "");
    show(error);
  }
}

async function setSelectedChannelArchived(archived) {
  const team = teamForConversation(state.selectedConversationId);
  const channel = team?.channels?.find((entry) => entry.conversationId === state.selectedConversationId);
  if (!channel) return;
  const result = $("team-pack-transfer-result");
  try {
    const operation = archived ? window.sovereignbot.channels.archive : window.sovereignbot.channels.restore;
    await operation({ channelId: channel.id });
    await refreshTeams();
    if (state.selectedConversation) renderDetails(state.selectedConversation);
    if (result) result.textContent = archived ? "Channel archived; it is now read-only." : "Channel restored.";
  } catch (error) {
    if (result) result.textContent = text(error?.message || error).replace(/^.*Error: /, "");
  }
}

function setupVoiceInput() {
  if (!globalThis.SovereignVoice) return;
  voiceController = globalThis.SovereignVoice.createVoiceController({
    window,
    document,
    getConversationId: () => state.selectedConversationId,
    getComposer: () => $("composer-input"),
    getSystemLocale: () => state.handshake?.locale || navigator.language,
    getContext: () => ({ conversationId: state.selectedConversationId, activeView: state.activeView }),
    setStatus: renderVoiceStatus,
  });
  voiceController.setupInput($("voice-input"));
  window.sovereignbotStopVoice = () => voiceController?.stop("stopped");
  window.addEventListener("beforeunload", () => voiceController?.stop("app-quit"), { once: true });
  window.addEventListener("pagehide", () => voiceController?.stop("app-quit"), { once: true });
}

function renderConnectedApps() {
  let root = $("connected-apps-list");
  if (!root) {
    const grid = document.querySelector("#view-settings .settings-grid");
    if (!grid) return;
    const section = document.createElement("section");
    section.className = "settings-card span-2";
    const head = document.createElement("div");
    head.className = "card-heading";
    const copy = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = "Connected Apps / 已连接应用";
    const description = document.createElement("p");
    description.textContent = "Assign governed product connections to a team or coworker. Runtime authority remains with the Governor.";
    copy.append(title, description);
    head.append(copy);
    root = document.createElement("div");
    root.id = "connected-apps-list";
    root.className = "connected-apps-list";
    section.append(head, root);
    grid.insertBefore(section, grid.firstChild);
  }
  if (!root) return;
  clearNode(root);
  const apps = state.connectedApps?.apps ?? [];
  if (!apps.length) {
    const empty = document.createElement("p");
    empty.className = "setting-feedback";
    empty.textContent = "No governed connections are available yet.";
    root.append(empty);
    return;
  }
  for (const app of apps) {
    const card = document.createElement("article");
    card.className = "connected-app-card";
    const head = document.createElement("div");
    head.className = "connected-app-head";
    const title = document.createElement("strong");
    title.textContent = app.name;
    const status = document.createElement("span");
    status.className = "connected-app-state" + (app.state === "available" ? " ready" : "");
    status.textContent = app.state === "available" ? "Available" : "Unavailable";
    head.append(title, status);
    const service = document.createElement("p");
    service.textContent = String(app.service || "") + " · " + String(app.authority || "");
    const description = document.createElement("p");
    description.className = "connected-app-description";
    description.textContent = app.description;
    const capabilities = document.createElement("small");
    capabilities.textContent = "Capabilities: " + (app.capabilities ?? []).join(" · ");
    const approval = document.createElement("small");
    approval.className = "connected-app-approval";
    approval.textContent = app.approval?.mode === "governed"
      ? "Approval: Governor review when required / 审批：需要时由 Governor 审核"
      : "Approval: not specified / 审批：未说明";
    card.append(head, service, description, capabilities, approval);

    const assignment = document.createElement("div");
    assignment.className = "connected-app-assignment";
    const assignmentTitle = document.createElement("span");
    assignmentTitle.className = "detail-label";
    assignmentTitle.textContent = "Available to / 可分配给";
    assignment.append(assignmentTitle);
    const targets = [
      ...(state.teams ?? []).map((team) => ({ kind: "team", id: team.id, label: team.name + " / Team" })),
      ...(state.coworkers ?? []).filter((coworker) => coworker.state !== "archived").map((coworker) => ({ kind: "coworker", id: coworker.id, label: coworker.name + " / Coworker" })),
    ];
    if (!targets.length) {
      const none = document.createElement("small");
      none.textContent = "Install a team or create a coworker first.";
      assignment.append(none);
    }
    for (const target of targets) {
      const label = document.createElement("label");
      label.className = "connected-app-target";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = target.kind === "team"
        ? (app.assignedTeamIds ?? []).includes(target.id)
        : (app.assignedCoworkerIds ?? []).includes(target.id);
      checkbox.addEventListener("change", async () => {
        checkbox.disabled = true;
        try {
          const updated = await window.sovereignbot.connectedApps.assign({
            appId: app.id,
            ...(target.kind === "team" ? { teamId: target.id } : { coworkerId: target.id }),
            enabled: checkbox.checked,
          });
          state.connectedApps = {
            apps: (state.connectedApps?.apps ?? []).map((entry) => entry.id === updated.id ? updated : entry),
          };
          renderConnectedApps();
        } catch (error) {
          checkbox.checked = !checkbox.checked;
          showToastError(error);
        } finally {
          checkbox.disabled = false;
        }
      });
      const textEl = document.createElement("span");
      textEl.textContent = target.label;
      label.append(checkbox, textEl);
      assignment.append(label);
    }
    card.append(assignment);
    root.append(card);
  }
}

async function stopCurrentConversation() {
  voiceController?.stop("stopped");
  const conversation = state.selectedConversation;
  if (!conversation || !window.sovereignbot.conversations.stop) return;
  const button = $("conversation-stop");
  if (button) button.disabled = true;
  hide($("composer-error"));
  try {
    await window.sovereignbot.conversations.stop({ conversationId: conversation.id });
    state.redirectMode = false;
    await refreshConversation(true);
  } catch (error) {
    $("composer-error").textContent = text(error?.message || error).replace(/^.*Error: /, "");
    show($("composer-error"));
  } finally {
    if (button) button.disabled = false;
  }
}

function toggleRedirectMode() {
  const conversation = state.selectedConversation;
  if (!conversation || !pendingUserRecipients(conversation).size) return;
  state.redirectMode = !state.redirectMode;
  renderConversationHeader(conversation);
  try { $("composer-input")?.focus({ preventScroll: true }); } catch { $("composer-input")?.focus(); }
}

function populateTeamPicker() {
  const picker = $("team-member-picker");
  clearNode(picker);
  for (const coworker of state.coworkers.filter((entry) => entry.state === "active")) {
    const label = document.createElement("label");
    label.className = "member-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = coworker.id;
    const avatar = document.createElement("span");
    avatar.className = "nav-avatar";
    avatar.textContent = avatarFor(coworker);
    const copy = document.createElement("span");
    copy.textContent = `${coworker.name} — ${coworker.role}`;
    label.append(checkbox, avatar, copy);
    picker.append(label);
  }
}

function openDialog(id) {
  const dialog = $(id);
  if (dialog?.showModal) dialog.showModal();
}

function resetCoworkerDialog() {
  state.editingCoworkerId = undefined;
  state.editingCoworkerSnapshot = undefined;
  $("coworker-dialog-eyebrow").textContent = "NEW COWORKER / 新建同事";
  $("coworker-dialog-title").textContent = "Who are you adding?";
  $("coworker-save").textContent = "Create coworker";
  $("coworker-advanced-help").textContent = "Optional safe binding hints. These select a provider/model; they never grant tools or permissions.";
  $("coworker-state-field").classList.add("hidden");
  document.querySelector("#coworker-dialog .quick-role-row")?.classList.remove("hidden");
  for (const id of ["coworker-advanced-provider", "coworker-advanced-account", "coworker-advanced-model"]) $(id).disabled = false;
  $("coworker-form")?.reset();
}

function openCoworkerDialog(coworker) {
  populateCoworkerAdvanced();
  state.editingCoworkerId = coworker?.id;
  state.editingCoworkerSnapshot = coworker ? structuredClone(coworker) : undefined;
  $("coworker-dialog-eyebrow").textContent = "EDIT COWORKER / 编辑同事";
  $("coworker-dialog-title").textContent = "Shape how this coworker works";
  $("coworker-save").textContent = "Save changes / 保存修改";
  $("coworker-advanced-help").textContent = "Existing provider/account/model binding is preserved while editing. Change the profile above to replace it safely.";
  $("coworker-state-field").classList.remove("hidden");
  document.querySelector("#coworker-dialog .quick-role-row")?.classList.add("hidden");
  $("coworker-name").value = coworker?.name ?? "";
  $("coworker-role").value = coworker?.role ?? "";
  $("coworker-instructions").value = coworker?.instructions ?? "";
  $("coworker-provider").value = coworker?.modelBinding?.profile ?? state.settings?.defaultModelProfile ?? "automatic";
  syncEconomyControls();
  $("coworker-state").value = coworker?.state === "paused" ? "paused" : "active";
  $("coworker-workspace").value = coworker?.workspaceIds?.[0] ?? "";
  $("coworker-computer-profile").value = coworker?.computerProfileId ?? "";
  const rosterBinding = state.roster?.coworkerBindings?.[coworker?.id];
  $("coworker-advanced-provider").value = rosterBinding?.provider ?? "";
  $("coworker-advanced-account").value = rosterBinding?.accountSlot ?? "";
  $("coworker-advanced-model").value = "";
  $("coworker-advanced-provider").disabled = true;
  $("coworker-advanced-account").disabled = rosterBinding?.provider !== "antigravity";
  $("coworker-advanced-model").disabled = true;
  hide($("coworker-form-error"));
  openDialog("coworker-dialog");
}

function populateCoworkerAdvanced() {
  const select = $("coworker-workspace");
  if (!select) return;
  select.textContent = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Coworker default / 同事默认";
  select.append(defaultOption);
  for (const workspace of state.workspaces?.workspaces ?? []) {
    const option = document.createElement("option");
    option.value = workspace.id;
    option.textContent = workspace.kind === "shared-project" ? "Shared project workspace / 共享项目工作区" : workspace.label || "Private workspace / 私有工作区";
    select.append(option);
  }
}

function applyCoworkerRolePreset(roleKey) {
  const presets = {
    chief: {
      name: "Chief",
      role: "Own outcomes and coordinate the team.",
      instructions: "Scope the outcome, choose the next best coworker, keep one owner active, and synthesize the final result.",
      profile: "automatic",
    },
    "coding-lead": {
      name: "Coding Lead",
      role: "Implement and improve software in trusted workspaces.",
      instructions: "Inspect the workspace, make focused changes, run relevant checks, and hand important changes to a reviewer.",
      profile: "efficient",
    },
    reviewer: {
      name: "Reviewer",
      role: "Review work for correctness, security, and product quality.",
      instructions: "Review the proposed result, identify concrete risks, and return bounded actionable feedback.",
      profile: "deep",
    },
    researcher: {
      name: "Researcher",
      role: "Investigate questions and produce decision-ready findings.",
      instructions: "Separate evidence from inference, preserve provenance, and deliver concise findings another coworker can act on.",
      profile: "automatic",
    },
  };
  const preset = presets[roleKey];
  if (!preset) return;
  $("coworker-name").value = preset.name;
  $("coworker-role").value = preset.role;
  $("coworker-instructions").value = preset.instructions;
  $("coworker-provider").value = preset.profile;
}

async function saveCoworker(event) {
  event.preventDefault();
  hide($("coworker-form-error"));
  try {
    const profile = $("coworker-provider").value;
    const provider = $("coworker-advanced-provider").value;
    const accountSlot = $("coworker-advanced-account").value;
    const model = $("coworker-advanced-model").value.trim();
    if (!provider && (accountSlot || model)) throw new Error("Choose a provider before pinning an account or model.");
    const fields = {
          name: $("coworker-name").value.trim(),
          role: $("coworker-role").value.trim(),
          instructions: $("coworker-instructions").value.trim(),
          ...(!state.editingCoworkerId ? {
            modelBinding: {
              profile,
              ...(provider ? { provider } : {}),
              ...(model ? { model } : {}),
            },
            ...($("coworker-workspace").value ? { workspaceIds: [$("coworker-workspace").value] } : {}),
            ...($("coworker-computer-profile").value.trim() ? { computerProfileId: $("coworker-computer-profile").value.trim() } : {}),
          } : {
            ...(profile !== state.editingCoworkerSnapshot?.modelBinding?.profile ? { modelBinding: { profile, ...(state.roster?.coworkerBindings?.[state.editingCoworkerId]?.provider ? { provider: state.roster.coworkerBindings[state.editingCoworkerId].provider } : {}) } } : {}),
            ...(JSON.stringify($("coworker-workspace").value ? [$("coworker-workspace").value] : []) !== JSON.stringify(state.editingCoworkerSnapshot?.workspaceIds ?? [])
              ? { workspaceIds: $("coworker-workspace").value ? [$("coworker-workspace").value] : [] } : {}),
            ...($("coworker-computer-profile").value.trim() !== (state.editingCoworkerSnapshot?.computerProfileId ?? "")
              ? { computerProfileId: $("coworker-computer-profile").value.trim() || undefined } : {}),
            ...($("coworker-state").value !== (state.editingCoworkerSnapshot?.state ?? "active")
              ? { state: $("coworker-state").value } : {}),
          }),
    };
    const wasEditing = Boolean(state.editingCoworkerId);
    let result = wasEditing
      ? await window.sovereignbot.coworkers.update({ coworkerId: state.editingCoworkerId, patch: fields })
      : await window.sovereignbot.coworkers.create({ coworker: fields });
    const accountCoworkerId = result?.coworker?.id ?? state.editingCoworkerId;
    if (provider === "antigravity" && accountSlot && accountCoworkerId)
      result = await window.sovereignbot.providers.setCoworkerAccount({ coworkerId: accountCoworkerId, provider: "antigravity", accountSlot });
    $("coworker-dialog").close();
    const createdId = result?.coworker?.id;
    resetCoworkerDialog();
    await Promise.all([refreshCoworkers(), refreshConversations(), refreshTeams(), refreshRoster()]);
    if (!wasEditing && createdId) await openDirect(createdId);
    else if (state.selectedConversation) renderDetails(state.selectedConversation);
  } catch (error) {
    $("coworker-form-error").textContent = text(error?.message || error).replace(/^.*Error: /, "");
    show($("coworker-form-error"));
  }
}

async function installTeamPack(packId, button = $("welcome-install-software-team")) {
  const result = $("team-install-result");
  if (!button || !window.sovereignbot?.teams) return;
  button.disabled = true;
  hide(result);
  try {
    const installed = await window.sovereignbot.teams.installPack({ packId });
    await Promise.all([refreshCoworkers(), refreshConversations(), refreshTeams(), refreshRoster()]);
    const channel = installed?.team?.channels?.[0] ?? state.channels.find((entry) => entry.teamId === installed?.team?.id);
    if (channel?.conversationId) await openConversation(channel.conversationId);
  } catch (error) {
    if (result) {
      result.textContent = text(error?.message || error).replace(/^.*Error: /, "");
      show(result);
    }
  } finally {
    button.disabled = false;
  }
}

async function installSoftwareTeam() {
  return installTeamPack("software-team");
}

async function createTeam(event) {
  event.preventDefault();
  hide($("team-form-error"));
  const ids = [...$("team-member-picker").querySelectorAll("input:checked")].map((entry) => entry.value);
  if (ids.length < 2) {
    $("team-form-error").textContent = "Choose at least two coworkers.";
    show($("team-form-error"));
    return;
  }
  try {
    const conversation = await window.sovereignbot.conversations.createTeam({ title: $("team-name").value.trim(), coworkerIds: ids });
    $("team-dialog").close();
    $("team-form").reset();
    await refreshConversations();
    await openConversation(conversation.id);
  } catch (error) {
    $("team-form-error").textContent = text(error?.message || error).replace(/^.*Error: /, "");
    show($("team-form-error"));
  }
}

function applyLocale(setting, systemLocale) {
  const I18n = globalThis.SovereignI18n;
  if (!I18n) return "en";
  const locale = I18n.resolveLocale(setting, systemLocale);
  I18n.setLocale(locale);
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = I18n.t(key);
  }
  const t = I18n.t.bind(I18n);
  const langEl = $("setting-language");
  if (langEl) langEl.value = setting ?? "system";
  const placeholder = $("composer-input");
  if (placeholder) placeholder.placeholder = t("chat.placeholder");
  const hint = $("composer-hint");
  if (hint) hint.textContent = t("chat.hint");
  return locale;
}
function renderSettings() {
  const settings = state.settings;
  if (!settings) return;
  ensureSettingsPreferences();
  ensureVoiceSettingsCard();
  voiceController?.setSettings(settings);
  $("setting-theme").value = settings.theme ?? "system";
  document.body.dataset.theme = settings.theme ?? "system";
  $("setting-close").value = settings.closeBehavior ?? "ask";
  $("setting-notifications").checked = settings.notifications !== false;
  $("setting-demo-mode").checked = settings.demoMode === true;
  $("setting-default-model-profile").value = settings.defaultModelProfile ?? "automatic";
  for (const input of document.querySelectorAll("[data-notification-category]")) {
    input.checked = settings.notificationPreferences?.[input.dataset.notificationCategory] !== false;
    input.disabled = settings.notifications === false;
  }
  $("setting-language").value = settings.language ?? "system";
  $("setting-voice-language").value = settings.voiceLanguage ?? "system";
  $("setting-speak-replies").checked = settings.speakReplies === true;
  $("setting-voice-muted").checked = settings.voiceMuted === true;
  applyLocale(settings.language ?? "system", state.handshake?.locale);
}

function renderProviderCards() {
  const root = $("provider-cards");
  clearNode(root);
  const firstRunProviders = state.firstRun?.providers ?? {};
  syncEconomyControls();
  const providerIds = ["codex", "claude", "chatgpt-web", "antigravity", ...(economyAvailable() ? ["economy"] : [])];
  for (const provider of providerIds) {
    const info = firstRunProviders[provider] ?? {};
    const rosterProvider = state.roster?.providers?.[provider] ?? {};
    const health = rosterProvider.health ?? (rosterProvider.usable ? "ready" : info.found ? "unavailable" : "unavailable");
    const usable = health === "ready" && rosterProvider.usable === true;
    const card = document.createElement("article");
    card.className = "provider-card";
    const head = document.createElement("div");
    head.className = "provider-card-head";
    const name = document.createElement("strong");
    name.textContent = humanProvider(provider);
    const status = document.createElement("span");
    status.className = `provider-state${health === "ready" && usable ? " ready" : ""}`;
    status.textContent = health === "ready" && usable ? "Ready"
      : health === "ready" && rosterProvider.usable === false ? "Disabled"
      : health === "signed-out" ? "Signed out"
        : health === "capacity-limited" ? "Capacity limited"
          : health === "unavailable" ? "Unavailable" : "Checking";
    head.append(name, status);
    const detail = document.createElement("p");
    detail.textContent = rosterProvider.reason || (provider === "chatgpt-web" ? "Use the dedicated profile for a normal ChatGPT Web sign-in, then refresh." : provider === "antigravity" ? "Use Advanced settings to pin a dedicated Antigravity account." : provider === "economy" ? "Trusted Economy configuration is active; metered budget controls remain outside renderer settings." : info.found ? (info.version || "CLI detected") : "Install the local CLI, then refresh.");
    const actions = document.createElement("div");
    actions.className = "provider-actions";
    const signIn = document.createElement("button");
    signIn.type = "button";
    signIn.textContent = provider === "economy" ? "Refresh" : ["chatgpt-web", "antigravity"].includes(provider) ? "Sign in" : info.found ? "Open sign-in" : "Try detection";
    signIn.addEventListener("click", async () => {
      try {
        if (provider !== "economy" && (provider === "chatgpt-web" || info.found)) await window.sovereignbot.providers.openLogin({ provider });
        else await window.sovereignbot.providers.refresh({});
        await refreshSettingsData();
      } catch (error) {
        $("provider-action-result").textContent = text(error?.message || error).replace(/^.*Error: /, "");
      }
    });
    const toggle = document.createElement("button");
    toggle.type = "button";
    const enabled = state.settings?.providers?.[provider]?.enabled !== false;
    toggle.textContent = enabled ? "Disable" : "Enable";
    toggle.addEventListener("click", async () => {
      try {
        await window.sovereignbot.settings.update({ providers: { [provider]: { enabled: !enabled } } });
        await window.sovereignbot.providers.refresh({});
        await refreshSettingsData();
      } catch (error) {
        $("provider-action-result").textContent = text(error?.message || error).replace(/^.*Error: /, "");
      }
    });
    actions.append(signIn, toggle);
    card.append(head, detail, actions);
    root.append(card);
  }
}

function renderWorkspaces() {
  const root = $("workspace-manager-list");
  clearNode(root);
  const list = state.workspaces.workspaces ?? [];
  if (!list.length) {
    const empty = document.createElement("p");
    empty.className = "setting-feedback";
    empty.textContent = "No trusted folders yet.";
    root.append(empty);
    return;
  }
  for (const workspace of list) {
    const card = document.createElement("div");
    card.className = "workspace-card";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "default-workspace";
    radio.checked = workspace.id === state.workspaces.defaultWorkspaceId;
    radio.title = "Default workspace";
    radio.addEventListener("change", async () => {
      await window.sovereignbot.workspaces.setDefault({ id: workspace.id });
      await refreshSettingsData();
    });
    const label = document.createElement("span");
    label.textContent = workspace.kind === "shared-project" ? "Shared project workspace" : workspace.label || "Private workspace";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      await window.sovereignbot.workspaces.remove({ id: workspace.id });
      await refreshSettingsData();
    });
    card.append(radio, label, remove);
    root.append(card);
  }
}

function renderAdvancedRoster() {
  const lines = (state.roster?.agents ?? []).map((agent) => `${agent.name}\n  ${agent.harnessKind} · ${agent.capabilities.join(", ")}`);
  $("advanced-roster").textContent = lines.join("\n\n") || "No active runtime agents.";
}

function ensureVoiceSettingsCard() {
  if ($("voice-settings-card")) return;
  const grid = document.querySelector("#view-settings .settings-grid");
  if (!grid) return;
  const card = document.createElement("section");
  card.id = "voice-settings-card";
  card.className = "settings-card span-2 voice-settings";
  const heading = document.createElement("div");
  heading.className = "card-heading";
  const copy = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = "Voice / 语音";
  const description = document.createElement("p");
  description.textContent = "Uses this device's Web Speech support. Voice input only fills the open conversation composer; no audio is saved.";
  copy.append(title, description);
  const stop = document.createElement("button");
  stop.id = "voice-stop";
  stop.type = "button";
  stop.className = "quiet-action";
  stop.textContent = "Stop / 停止";
  stop.setAttribute("aria-label", "Stop voice playback or input / 停止语音播放或输入");
  heading.append(copy, stop);
  const languageLabel = document.createElement("label");
  languageLabel.className = "setting-field";
  languageLabel.textContent = "Voice language / 语音语言";
  const language = document.createElement("select");
  language.id = "setting-voice-language";
  language.setAttribute("aria-label", "Voice language / 语音语言");
  for (const [value, label] of [["system", "System / 系统"], ["zh-CN", "简体中文"], ["en", "English"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    language.append(option);
  }
  languageLabel.append(language);
  const toggle = (id, titleText, descriptionText) => {
    const row = document.createElement("label");
    row.className = "toggle-row";
    const span = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = titleText;
    const small = document.createElement("small");
    small.textContent = descriptionText;
    span.append(strong, small);
    const input = document.createElement("input");
    input.id = id;
    input.type = "checkbox";
    row.append(span, input);
    return row;
  };
  const speak = toggle("setting-speak-replies", "Speak replies / 朗读回复", "Only final Coworker replies; off by default / 仅朗读同事最终回复，默认关闭");
  const muted = toggle("setting-voice-muted", "Mute voice / 静音语音", "Stops current speech and blocks new playback / 停止当前播放并阻止新播放");
  const status = document.createElement("p");
  status.id = "voice-status";
  status.className = "setting-feedback";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Voice is ready / 语音已就绪";
  card.append(heading, languageLabel, speak, muted, status);
  grid.insertBefore(card, grid.firstElementChild);
  stop.addEventListener("click", () => voiceController?.stop("stopped"));
  language.addEventListener("change", (event) => saveSimpleSetting("voiceLanguage", event.target.value));
  speak.querySelector("input").addEventListener("change", (event) => saveSimpleSetting("speakReplies", event.target.checked));
  muted.querySelector("input").addEventListener("change", (event) => saveSimpleSetting("voiceMuted", event.target.checked));
}

function ensureSettingsPreferences() {
  const appearance = $("setting-notifications")?.closest(".settings-card");
  const advanced = document.querySelector("#view-settings .advanced-card");
  const providerCard = $("provider-cards")?.closest(".settings-card");
  const workspaceCard = $("workspace-manager-list")?.closest(".settings-card");
  const mark = (element, key) => { if (element) element.dataset.i18n = key; };
  const settingsView = $("view-settings");
  mark(settingsView?.querySelector(".page-header h1"), "settings.title");
  mark(settingsView?.querySelector(".page-header p"), "settings.subtitle");
  mark(providerCard?.querySelector("h2"), "settings.providers");
  mark(providerCard?.querySelector("p"), "settings.providersDesc");
  mark(providerCard?.querySelector("#settings-refresh-providers"), "action.refresh");
  mark(workspaceCard?.querySelector("h2"), "settings.workspaces");
  mark(workspaceCard?.querySelector("p"), "settings.workspacesDesc");
  mark(workspaceCard?.querySelector("#add-workspace"), "action.addFolder");
  mark(appearance?.querySelector("h2"), "settings.appearance");
  mark($("setting-close")?.closest(".settings-card")?.querySelector("h2"), "settings.window");
  const computerCard = $("provision-driver")?.closest(".settings-card");
  mark(computerCard?.querySelector("h2"), "settings.computer");
  mark(computerCard?.querySelector("p"), "settings.computerDesc");
  mark($("provision-driver"), "action.provisionBrowser");
  mark(advanced?.querySelector("summary"), "settings.advanced");
  mark([...advanced?.children ?? []].find((element) => element.tagName === "P"), "settings.advancedDesc");
  if (advanced && !advanced.dataset.grouped) {
    const cards = [providerCard, workspaceCard].filter(Boolean);
    const alreadyGrouped = cards.length > 0 && cards.every((card) => advanced.contains(card));
    if (!alreadyGrouped && cards.length) {
      const advancedContent = document.createElement("div");
      advancedContent.className = "advanced-settings-content";
      for (const card of cards) advancedContent.append(card);
      advanced.querySelector("#advanced-roster")?.before(advancedContent);
    }
    advanced.dataset.grouped = "true";
  }
  if (!appearance || $("setting-default-model-profile")) return;
  const model = document.createElement("label");
  model.className = "setting-field";
  const modelLabel = document.createElement("span");
  modelLabel.textContent = "Default Model Profile / 默认模型档位";
  const modelSelect = document.createElement("select");
  modelSelect.id = "setting-default-model-profile";
  for (const [value, label] of [["automatic", "Automatic / 自动"], ["efficient", "Efficient / 高效"], ["deep", "Deep / 深度"], ["economy", "Economy / 经济"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    modelSelect.append(option);
  }
  model.append(modelLabel, modelSelect);
  appearance.insertBefore(model, $("setting-notifications").closest(".toggle-row"));
  const notifications = $("setting-notifications").closest(".toggle-row");
  const group = document.createElement("div");
  group.id = "notification-preferences";
  group.className = "notification-preferences";
  for (const [category, label] of [["attention", "Attention"], ["routine-completed", "Routine completed"], ["trigger-fired", "Trigger fired"], ["coworker-finished", "Coworker finished"], ["channel-unread", "Channel unread"]]) {
    const row = document.createElement("label");
    row.className = "toggle-row";
    const labelText = document.createElement("span");
    labelText.textContent = label;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.notificationCategory = category;
    row.append(labelText, input);
    group.append(row);
  }
  notifications.after(group);
  $("setting-default-model-profile").addEventListener("change", (event) => saveSimpleSetting("defaultModelProfile", event.target.value));
  for (const input of group.querySelectorAll("input")) input.addEventListener("change", (event) => saveSimpleSetting("notificationPreferences", { [event.target.dataset.notificationCategory]: event.target.checked }));
}

function ensureDataLifecycleCard() {
  if ($("data-lifecycle-card")) return;
  const settingsGrid = $("view-settings")?.querySelector(".settings-grid");
  if (!settingsGrid || !window.sovereignbot.dataLifecycle) return;
  const card = document.createElement("section");
  card.id = "data-lifecycle-card";
  card.className = "settings-card span-2";
  const heading = document.createElement("div"); heading.className = "card-heading";
  const copy = document.createElement("div"); const title = document.createElement("h2"); title.textContent = "Data lifecycle"; const description = document.createElement("p"); description.textContent = "Local backups, redacted export, and confirmed product-state reset. Credentials, browser profiles, leases, and private computer state stay local."; copy.append(title, description);
  const refreshButton = document.createElement("button"); refreshButton.id = "data-lifecycle-refresh"; refreshButton.className = "quiet-action"; refreshButton.type = "button"; refreshButton.textContent = "Refresh"; heading.append(copy, refreshButton);
  const status = document.createElement("div"); status.id = "data-lifecycle-status"; status.className = "setting-feedback"; status.textContent = "Checking local state…";
  const actions = document.createElement("div"); actions.className = "detail-actions";
  for (const [id, label] of [["data-lifecycle-backup", "Create backup"], ["data-lifecycle-export", "Export data"], ["data-lifecycle-reset", "Clean reset…"]]) { const button = document.createElement("button"); button.id = id; button.className = "quiet-action"; button.type = "button"; button.textContent = label; actions.append(button); }
  const backups = document.createElement("div"); backups.id = "data-lifecycle-backups"; backups.className = "workspace-cards";
  const result = document.createElement("p"); result.id = "data-lifecycle-result"; result.className = "setting-feedback";
  card.append(heading, status, actions, backups, result);
  settingsGrid.prepend(card);
  const refresh = async () => {
    try {
      const [status, listed] = await Promise.all([window.sovereignbot.dataLifecycle.status({}), window.sovereignbot.dataLifecycle.listBackups({})]);
      $("data-lifecycle-status").textContent = `State V${status.stateVersion} · ${listed.backups.length} validated backup(s)`;
      const root = $("data-lifecycle-backups"); clearNode(root);
      for (const backup of listed.backups) {
        const row = document.createElement("div"); row.className = "workspace-card";
        const label = document.createElement("span"); label.textContent = `${backup.id} · ${backup.files} files · ${backup.createdAt}`;
        const restore = document.createElement("button"); restore.className = "quiet-action"; restore.type = "button"; restore.textContent = "Restore";
        restore.addEventListener("click", async () => { if (!window.confirm("Restore this validated backup? Current product state will be backed up first.")) return; try { await window.sovereignbot.dataLifecycle.restore({ id: backup.id }); $("data-lifecycle-result").textContent = "Backup restored. Restarting runtime surfaces is required."; await refresh(); } catch (error) { $("data-lifecycle-result").textContent = text(error?.message || error); } });
        row.append(label, restore); root.append(row);
      }
    } catch (error) { if ($("data-lifecycle-status")) $("data-lifecycle-status").textContent = text(error?.message || error); }
  };
  $("data-lifecycle-refresh").addEventListener("click", refresh);
  $("data-lifecycle-backup").addEventListener("click", async () => { try { const result = await window.sovereignbot.dataLifecycle.backup({}); $("data-lifecycle-result").textContent = `Backup ${result.id} created.`; await refresh(); } catch (error) { $("data-lifecycle-result").textContent = text(error?.message || error); } });
  $("data-lifecycle-export").addEventListener("click", async () => { try { const result = await window.sovereignbot.dataLifecycle.export({}); $("data-lifecycle-result").textContent = `Redacted export ${result.id} created.`; } catch (error) { $("data-lifecycle-result").textContent = text(error?.message || error); } });
  $("data-lifecycle-reset").addEventListener("click", async () => { if (!window.confirm("Create a backup and prepare a confirmed clean reset? Protected credentials, browser profiles, and computer state are retained.")) return; try { const prepared = await window.sovereignbot.dataLifecycle.prepareReset({}); const phrase = window.prompt(`Type RESET to confirm clean reset. Backup: ${prepared.backupId}`); if (phrase !== "RESET") return; await window.sovereignbot.dataLifecycle.reset({ confirmation: prepared.confirmation, backupId: prepared.backupId }); $("data-lifecycle-result").textContent = "Product state reset completed."; await refresh(); } catch (error) { $("data-lifecycle-result").textContent = text(error?.message || error); } });
  void refresh();
}

function ensureUpdateCard() {
  if ($("update-card")) return;
  const grid = $("view-settings")?.querySelector(".settings-grid");
  if (!grid || !window.sovereignbot.updates) return;
  const card = document.createElement("section"); card.id = "update-card"; card.className = "settings-card span-2";
  const heading = document.createElement("div"); heading.className = "card-heading";
  const copy = document.createElement("div"); const title = document.createElement("h2"); title.textContent = "Release updates"; const description = document.createElement("p"); description.textContent = "Stable updates are verified locally before staging. Nothing downloads or applies automatically."; copy.append(title, description);
  const refresh = document.createElement("button"); refresh.id = "update-check"; refresh.type = "button"; refresh.className = "quiet-action"; refresh.textContent = "Check for updates"; heading.append(copy, refresh);
  const channelLabel = document.createElement("label"); channelLabel.textContent = "Channel / 通道 "; const channel = document.createElement("select"); channel.id = "update-channel";
  for (const [value, label] of [["stable", "Stable"], ["preview", "Preview"], ["off", "Off"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; channel.append(option); }
  channelLabel.append(channel);
  const status = document.createElement("div"); status.id = "update-status"; status.className = "setting-feedback";
  const actions = document.createElement("div"); actions.className = "detail-actions";
  const stage = document.createElement("button"); stage.id = "update-stage"; stage.type = "button"; stage.className = "quiet-action"; stage.textContent = "Stage verified update";
  const apply = document.createElement("button"); apply.id = "update-apply"; apply.type = "button"; apply.className = "quiet-action"; apply.textContent = "Apply on restart"; actions.append(stage, apply);
  card.append(heading, channelLabel, status, actions); grid.prepend(card);
  const showError = (error) => { status.textContent = text(error?.message || error).replace(/^.*Error: /, ""); };
  const render = (value) => { state.updateStatus = value; channel.value = value.channel ?? "stable"; const a = value.available; const staged = value.staged; status.textContent = `Current ${value.currentVersion} · ${value.channel} · ${a ? `Available ${a.version} · ${a.signature?.status ?? "unknown"} / verified` : "No verified update"}${staged ? ` · Backup ${staged.backupId} · restart required` : ""}`; };
  channel.addEventListener("change", async () => { try { render(await window.sovereignbot.updates.setChannel({ channel: channel.value })); } catch (error) { showError(error); } });
  refresh.addEventListener("click", async () => { refresh.disabled = true; try { render(await window.sovereignbot.updates.check({})); } catch (error) { showError(error); } finally { refresh.disabled = false; } });
  stage.addEventListener("click", async () => { try { render(await window.sovereignbot.updates.stage({})); } catch (error) { showError(error); } });
  apply.addEventListener("click", async () => { if (!window.confirm("Apply the verified update and restart the app?")) return; try { const result = await window.sovereignbot.updates.apply({}); status.textContent = `Update ${result.version} requested; restart required.`; } catch (error) { showError(error); } });
  void window.sovereignbot.updates.status({}).then(render).catch(showError);
}

async function refreshSettingsData() {
  try {
    ensureVoiceSettingsCard();
    ensureDataLifecycleCard();
    ensureUpdateCard();
    const [settings, workspaces, firstRun, roster, connectedApps, updateStatus] = await Promise.all([
      window.sovereignbot.settings.get({}),
      window.sovereignbot.workspaces.list({}),
      window.sovereignbot.firstRun.getStatus({}),
      window.sovereignbot.providers.getRoster({}),
      window.sovereignbot.connectedApps.list({}),
      window.sovereignbot.updates?.status?.({}) ?? Promise.resolve(undefined),
    ]);
    state.settings = settings;
    state.workspaces = workspaces;
    state.firstRun = firstRun;
    state.roster = roster;
    state.connectedApps = connectedApps;
    state.updateStatus = updateStatus;
    renderSettings();
    renderProviderCards();
    renderWorkspaces();
    renderAdvancedRoster();
    renderConnectedApps();
    if ($("update-status") && updateStatus) { $("update-channel").value = updateStatus.channel; $("update-status").textContent = `Current ${updateStatus.currentVersion} · ${updateStatus.channel} · ${updateStatus.available ? `Available ${updateStatus.available.version} · ${updateStatus.available.signature?.status ?? "unknown"} / verified` : "No verified update"}`; }
    renderReadiness();
    renderSidebar();
    const browsers = firstRun?.browsers ?? [];
    $("browser-summary").textContent = browsers.length
      ? browsers.map((entry) => `${entry.browser} ${entry.version}`).join(" · ")
      : "No supported browser detected yet.";
  } catch {
    // Smoke mode does not bind the settings surface.
  }
}

async function saveSimpleSetting(key, value) {
  try {
    state.settings = await window.sovereignbot.settings.update({ [key]: value });
    renderSettings();
    if (key === "demoMode") {
      await window.sovereignbot.providers.refresh({});
      await Promise.all([refreshRoster(), refreshCoworkers()]);
    }
  } catch (error) {
    $("provider-action-result").textContent = text(error?.message || error).replace(/^.*Error: /, "");
  }
}

const ACTIVITY_STATUS_LABELS = Object.freeze({
  working: "Working / 工作中",
  active: "Active / 活跃",
  completed: "Complete / 已完成",
  available: "Complete / 已完成",
  attention: "Attention / 需处理",
  "needs-attention": "Attention / 需处理",
  stopped: "Stopped / 已停止",
  waiting: "Waiting / 等待中",
});

const ACTIVITY_STAGE_LABELS = Object.freeze({
  chief: "Chief",
  "coding-lead": "Coding Lead",
  specialist: "Specialist",
  reviewer: "Reviewer",
  synthesis: "Synthesis",
  complete: "Complete",
});

function activityStatusLabel(value) {
  return ACTIVITY_STATUS_LABELS[value] ?? "Team activity / 团队动态";
}

function activityStageLabel(value) {
  return ACTIVITY_STAGE_LABELS[value] ?? "Unassigned phase / 未分配阶段";
}

function renderActivityTeamSelector(context = activityContext()) {
  const select = $("activity-team-select");
  if (!select) return;
  select.textContent = "";
  if (!state.teams.length) {
    const option = document.createElement("option");
    option.textContent = "No managed Teams / 没有受管团队";
    option.value = "";
    select.append(option);
    select.disabled = true;
    return;
  }
  for (const team of state.teams) {
    const option = document.createElement("option");
    option.value = team.id;
    option.textContent = team.name;
    option.selected = team.id === context.teamId;
    select.append(option);
  }
  select.disabled = Boolean(context.contextual);
  if (context.teamId) select.value = context.teamId;
}

function appendActivitySummaryRow(root, label, value) {
  const row = document.createElement("div");
  row.className = "team-activity-summary-row";
  const key = document.createElement("span");
  key.className = "team-activity-summary-label";
  key.textContent = label;
  const copy = document.createElement("strong");
  copy.textContent = value;
  row.append(key, copy);
  root.append(row);
}

function renderTeamActivitySummary(context = activityContext()) {
  const contextEl = $("team-activity-context");
  const summary = $("team-activity-summary");
  if (!summary) return;
  summary.textContent = "";
  if (!context.team) {
    if (contextEl) contextEl.textContent = "Choose a managed Team to inspect its bounded collaboration history. / 请选择受管团队以查看有界协作历史。";
    const empty = document.createElement("p");
    empty.className = "activity-empty-copy";
    empty.textContent = "No managed Team is available yet. / 当前还没有可用的受管团队。";
    summary.append(empty);
    return;
  }
  const channel = context.conversationId ? channelForConversation(context.conversationId) : undefined;
  const flow = context.team.flow ?? {};
  if (contextEl) contextEl.textContent = channel
    ? `Context: ${context.team.name} · ${channel.name}${channel.archived ? " · Archived / 已归档" : ""}`
    : `Scope: ${context.team.name} · all Team Channels / 全部团队频道`;
  appendActivitySummaryRow(summary, "Team / 团队", context.team.name);
  appendActivitySummaryRow(summary, "Status / 状态", activityStatusLabel(flow.status ?? "waiting"));
  appendActivitySummaryRow(summary, "Phase / 阶段", activityStageLabel(flow.stage));
  appendActivitySummaryRow(summary, "Current owner / 当前负责人", flow.currentOwner ?? "No active owner / 当前无负责人");
  if (flow.activeFanout?.children?.length) {
    const children = flow.activeFanout.children;
    const done = children.filter((entry) => entry.status === "completed").length;
    const progress = `${done}/${children.length} specialists complete · ${flow.activeFanout.state === "reviewing" ? "Reviewing" : flow.activeFanout.state === "joining" || flow.activeFanout.state === "join_requested" ? "Joining results" : "Parallel work"}`;
    appendActivitySummaryRow(summary, "Parallel / 并行", progress);
  } else if (flow.activeProtocol) {
    const protocol = flow.activeProtocol;
    const kind = protocol.kind === "review" ? "Review" : "Handoff";
    appendActivitySummaryRow(summary, "Collaboration / 协作", `${kind} · ${protocol.targetCoworker ?? "teammate"} · ${protocol.state}`);
  } else {
    appendActivitySummaryRow(summary, "Collaboration / 协作", flow.status === "needs-attention" ? (flow.attentionReason ?? "Needs a decision / 需要决策") : "No active request / 当前无活动请求");
  }
}

function appendActivityAction(root, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quiet-action";
  button.textContent = label;
  button.addEventListener("click", onClick);
  root.append(button);
}

function renderTeamActivityEvents(events, context) {
  const status = $("team-activity-status");
  const timeline = $("team-activity-timeline");
  if (!timeline || !status) return;
  timeline.textContent = "";
  status.className = "activity-status";
  if (!events.length) {
    status.textContent = "No Team events in this scope yet. / 当前范围暂无团队动态。";
    return;
  }
  status.textContent = `Showing ${events.length} bounded event${events.length === 1 ? "" : "s"}, newest first. / 显示 ${events.length} 条有界动态，最新在前。`;
  for (const event of events) {
    const row = document.createElement("article");
    row.className = `team-activity-row status-${event.status ?? "working"}`;
    row.setAttribute("role", "listitem");
    const header = document.createElement("div");
    header.className = "team-activity-row-header";
    const title = document.createElement("strong");
    title.textContent = event.label ?? "Team activity";
    const badge = document.createElement("span");
    badge.className = "activity-event-status";
    badge.textContent = activityStatusLabel(event.status);
    const time = document.createElement("time");
    const timestamp = new Date(event.at);
    if (Number.isFinite(timestamp.getTime())) {
      time.dateTime = timestamp.toISOString();
      time.textContent = formatTime(event.at) || "Time";
      time.title = timestamp.toLocaleString();
    } else time.textContent = "Time unavailable / 时间不可用";
    header.append(title, badge, time);
    row.append(header);
    const people = [];
    if (event.owner) people.push(`Owner: ${event.owner}`);
    if (event.targetCoworker) people.push(`Target: ${event.targetCoworker}`);
    if (people.length) {
      const meta = document.createElement("p");
      meta.className = "team-activity-row-meta";
      meta.textContent = people.join(" · ");
      row.append(meta);
    }
    if (event.reason) {
      const reason = document.createElement("p");
      reason.className = "team-activity-row-reason";
      reason.textContent = event.reason;
      row.append(reason);
    }
    const details = [];
    if (event.decision) details.push(`Decision: ${event.decision === "approved" ? "Approved" : "Changes requested"}`);
    if (Number.isInteger(event.revision)) details.push(`Revision ${event.revision}`);
    if (event.artifactIds?.length) details.push(`${event.artifactIds.length} artifact${event.artifactIds.length === 1 ? "" : "s"}`);
    if (details.length) {
      const detail = document.createElement("p");
      detail.className = "team-activity-row-detail";
      detail.textContent = details.join(" · ");
      row.append(detail);
    }
    const actions = document.createElement("div");
    actions.className = "team-activity-row-actions";
    const sourceChannel = state.channels.find((channel) => channel.teamId === context.teamId && channel.conversationId === event.conversationId);
    if (sourceChannel) appendActivityAction(actions, `Open ${sourceChannel.name} / 打开频道`, async () => { hide($("activity-drawer")); await openConversation(sourceChannel.conversationId); });
    if (event.artifactIds?.length) appendActivityAction(actions, `Files & Artifacts (${event.artifactIds.length}) / 文件成果`, () => { hide($("activity-drawer")); $("nav-artifacts")?.click(); });
    if (event.status === "attention" || event.label === "Attention") appendActivityAction(actions, "Open Attention / 打开需关注", () => { hide($("activity-drawer")); $("nav-attention")?.click(); });
    if (actions.childElementCount) row.append(actions);
    timeline.append(row);
  }
}

function renderTeamActivityLoading(context) {
  renderActivityTeamSelector(context);
  renderTeamActivitySummary(context);
  const status = $("team-activity-status");
  const timeline = $("team-activity-timeline");
  if (status) { status.className = "activity-status loading"; status.textContent = "Loading Team activity… / 正在加载团队动态……"; }
  if (timeline) timeline.textContent = "";
}

async function refreshActivity() {
  const requestId = ++state.activityRequestId;
  const context = activityContext();
  const contextKey = activityContextKey(context);
  renderTeamActivityLoading(context);
  const teamPromise = context.teamId
    ? window.sovereignbot.teams.activity(context.conversationId ? { conversationId: context.conversationId, limit: 24 } : { teamId: context.teamId, limit: 24 })
    : Promise.resolve({ events: [] });
  const runtimePromise = Promise.all([
    window.sovereignbot.operator.getOverview({}),
    window.sovereignbot.operator.getAudit({ limit: 30 }),
  ]);
  const [teamResult, runtimeResult] = await Promise.allSettled([teamPromise, runtimePromise]);
  if (requestId !== state.activityRequestId || activityContextKey() !== contextKey) return;
  if (teamResult.status === "fulfilled") renderTeamActivityEvents(Array.isArray(teamResult.value?.events) ? teamResult.value.events : [], context);
  else {
    const status = $("team-activity-status");
    const timeline = $("team-activity-timeline");
    if (status) { status.className = "activity-status error"; status.textContent = "Team activity is unavailable right now. / 团队动态暂不可用。"; }
    if (timeline) timeline.textContent = "";
  }
  if (runtimeResult.status === "fulfilled") {
    const [overview, audit] = runtimeResult.value;
    const agents = (overview.agents ?? []).map((entry) => `${entry.name || entry.id} · ${entry.harnessKind || entry.harness?.kind || ""}`);
    const tasks = overview.tasks ?? [];
    const counts = {};
    for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
    $("overview-block").textContent = `Coworker/runtime agents\n${agents.join("\n") || "…"}\n\nTasks ${JSON.stringify(counts)}`;
    const auditEntries = Array.isArray(audit) ? audit : (audit?.entries ?? []);
    $("audit-block").textContent = auditEntries.map((entry) => `${entry.at ?? ""}  ${entry.type}  ${entry.subject ?? ""}`).join("\n") || "No audit entries.";
  } else {
    $("overview-block").textContent = "Runtime overview is unavailable in this mode.";
    $("audit-block").textContent = "";
  }
}

function showToastError(error) {
  const target = $("provider-action-result");
  target.textContent = text(error?.message || error).replace(/^.*Error: /, "");
}

function bindEvents() {
  ensureVoiceSettingsCard();
  const openNewCoworker = () => { resetCoworkerDialog(); populateCoworkerAdvanced(); openDialog("coworker-dialog"); };
  $("new-coworker").addEventListener("click", openNewCoworker);
  $("welcome-create-coworker")?.addEventListener("click", openNewCoworker);
  $("refresh-coworkers").addEventListener("click", () => Promise.all([refreshCoworkers(), refreshConversations(), refreshRoster()]));
  $("coworker-search")?.addEventListener("input", (event) => { state.coworkerRoster.query = text(event.target.value); state.coworkerRoster.expanded = false; renderCoworkers(); });
  $("coworker-status-filter")?.addEventListener("change", (event) => { state.coworkerRoster.filter = text(event.target.value) || "all"; state.coworkerRoster.expanded = false; renderCoworkers(); });
  $("coworker-show-more")?.addEventListener("click", () => { state.coworkerRoster.expanded = !state.coworkerRoster.expanded; renderCoworkers(); });
  $("new-team").addEventListener("click", () => { populateTeamPicker(); openDialog("team-dialog"); });
  $("welcome-create-team").addEventListener("click", () => { populateTeamPicker(); openDialog("team-dialog"); });
  $("welcome-install-software-team")?.addEventListener("click", installSoftwareTeam);
  $("team-export-pack")?.addEventListener("click", exportCurrentTeamPack);
  $("team-import-pack")?.addEventListener("click", () => openTeamPackDialog());
  $("team-pack-copy")?.addEventListener("click", copyTeamPack);
  $("team-pack-form")?.addEventListener("submit", importTeamPack);
  $("team-export-playbook")?.addEventListener("click", exportCurrentPlaybook);
  $("team-import-playbook")?.addEventListener("click", () => openPlaybookDialog());
  $("playbook-copy")?.addEventListener("click", copyPlaybook);
  $("playbook-form")?.addEventListener("submit", importPlaybook);
  $("team-channel-select")?.addEventListener("change", openSelectedTeamChannel);
  $("team-add-channel-from-template")?.addEventListener("click", addChannelFromTemplate);
  $("team-create-channel")?.addEventListener("click", openNewChannelDialog);
  $("team-edit-channel")?.addEventListener("click", openEditChannelDialog);
  $("team-archive-channel")?.addEventListener("click", () => setSelectedChannelArchived(true));
  $("team-restore-channel")?.addEventListener("click", () => setSelectedChannelArchived(false));
  $("channel-form")?.addEventListener("submit", saveChannel);
  $("welcome-open-chief").addEventListener("click", () => {
    const chief = state.coworkers.find((entry) => /chief of staff/i.test(entry.name)) ?? state.coworkers[0];
    if (chief) openDirect(chief.id);
  });
  $("coworker-form").addEventListener("submit", saveCoworker);
  $("team-form").addEventListener("submit", createTeam);
  for (const button of document.querySelectorAll(".quick-role")) button.addEventListener("click", () => applyCoworkerRolePreset(button.dataset.role));
  for (const button of document.querySelectorAll("[data-close-dialog]")) {
    button.addEventListener("click", () => $(button.dataset.closeDialog)?.close());
  }

  $("composer-form").addEventListener("submit", sendMessage);
  $("collaboration-submit")?.addEventListener("click", submitCollaborationRequest);
  $("collaboration-type")?.addEventListener("change", () => {
    const button = $("collaboration-submit");
    if (button) button.textContent = $("collaboration-type").value === "review" ? "Ask for review / 请求审阅" : "Send to teammate / 发给同事";
  });
  $("composer-input").addEventListener("input", autoSizeComposer);
  $("composer-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage(event);
    }
  });
  setupVoiceInput();
  // composer-add is wired by skills-ui.js to open the real attachment dialog.

  $("conversation-stop")?.addEventListener("click", stopCurrentConversation);
  $("conversation-redirect")?.addEventListener("click", toggleRedirectMode);
  $("conversation-load-older")?.addEventListener("click", () => { void loadOlderMessages(); });
  $("conversation-latest-messages")?.addEventListener("click", () => { void jumpToLatestMessages(); });
  $("open-details").addEventListener("click", () => $("details-panel").classList.toggle("hidden"));
  $("close-details").addEventListener("click", () => hide($("details-panel")));
  $("nav-settings").addEventListener("click", async () => { switchView("settings"); await refreshSettingsData(); });
  $("nav-activity").addEventListener("click", async () => { show($("activity-drawer")); await refreshActivity(); });
  $("activity-refresh")?.addEventListener("click", () => { void refreshActivity(); });
  $("activity-team-select")?.addEventListener("change", (event) => {
    const context = activityContext();
    if (context.contextual) return;
    state.activityScopeTeamId = event.target.value || undefined;
    void refreshActivity();
  });
  $("close-activity").addEventListener("click", () => hide($("activity-drawer")));

  $("settings-refresh-providers").addEventListener("click", async () => {
    $("provider-action-result").textContent = "Refreshing…";
    try {
      await window.sovereignbot.providers.refresh({});
      await refreshSettingsData();
      $("provider-action-result").textContent = "Provider state refreshed.";
    } catch (error) { showToastError(error); }
  });
  $("add-workspace").addEventListener("click", async () => { await window.sovereignbot.workspaces.addViaDialog({}); await refreshSettingsData(); });
  $("provision-driver").addEventListener("click", async () => {
    $("driver-result").textContent = "Setting up managed browser…";
    try {
      const result = await window.sovereignbot.computer.provisionDriver({});
      $("driver-result").textContent = result?.ok === false ? result.reason : `ChromeDriver ${result.driverVersion ?? ""} ready.`;
      await refreshRoster();
    } catch (error) { $("driver-result").textContent = text(error?.message || error).replace(/^.*Error: /, ""); }
  });

  $("setting-theme").addEventListener("change", (event) => saveSimpleSetting("theme", event.target.value));
  $("setting-close").addEventListener("change", (event) => saveSimpleSetting("closeBehavior", event.target.value));
  $("setting-notifications").addEventListener("change", (event) => saveSimpleSetting("notifications", event.target.checked));
  $("setting-demo-mode").addEventListener("change", (event) => saveSimpleSetting("demoMode", event.target.checked));
  $("setting-language").addEventListener("change", async (event) => {
    try {
      state.settings = await window.sovereignbot.settings.update({ language: event.target.value });
      applyLocale(state.settings.language ?? "system", state.handshake?.locale);
      renderSidebar(); renderReadiness(); if (state.selectedConversation) renderConversationHeader(state.selectedConversation);
    } catch (error) { $("provider-action-result").textContent = text(error?.message || error).replace(/^.*Error: /, ""); }
  });
  document.addEventListener("keydown", (event) => {
    const tag = document.activeElement?.tagName;
    const editable = document.activeElement?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if (event.key === "Escape") {
      hide($("details-panel")); hide($("activity-drawer"));
      for (const d of document.querySelectorAll("dialog[open]")) d.close();
      return;
    }
    if (editable) return;
    if ((event.ctrlKey || event.metaKey) && event.key === ",") { event.preventDefault(); switchView("settings"); void refreshSettingsData(); }
  });
  window.sovereignbot?.onNavigate?.((target) => { if (target === "settings") { switchView("settings"); void refreshSettingsData(); } });
  window.sovereignbot?.onNewChat?.(() => {
    const chief = state.coworkers.find((e) => /chief of staff/i.test(e.name)) ?? state.coworkers[0];
    if (chief) void openDirect(chief.id);
  });
  window.sovereignbot?.onToggleComputer?.(() => {
    const btn = document.getElementById("open-computer");
    if (btn) btn.click(); else document.getElementById("details-panel")?.classList.toggle("hidden");
  });
  window.sovereignbot?.onToggleActivity?.(async () => { const d = $("activity-drawer"); const hidden = d.classList.contains("hidden"); if (hidden) { show(d); await refreshActivity(); } else hide(d); });
  document.addEventListener("sovereignbot:navigate-conversation", (event) => {
    const conversationId = event?.detail?.conversationId;
    if (typeof conversationId === "string" && conversationId.trim()) {
      void openConversation(conversationId.trim());
    }
  });
}

async function bootstrap() {
  bindEvents();
  try {
    state.handshake = await window.sovereignbot.handshake({});
    $("chip-version").textContent = state.handshake?.version || "V3";
    applyLocale(state.handshake?.language ?? "system", state.handshake?.locale);
  } catch (error) {
    $("chip-version").textContent = "offline";
    $("provider-summary").textContent = "Offline — restart the app.";
    $("provider-dot")?.classList.add("offline");
    $("provider-action-result").textContent = String(error?.message ?? error).slice(0, 300);
    return;
  }

  const results = await Promise.allSettled([refreshCoworkers(), refreshConversations(), refreshTeams(), refreshProjects(), refreshRoster(), refreshSettingsData()]);
  const rejected = results.filter((entry) => entry.status === "rejected");
  if (rejected.length) {
    const first = rejected[0]?.reason;
    $("provider-action-result").textContent = String(first?.message ?? first ?? "Startup data did not load — use Refresh or check Settings.").slice(0, 300);
  }
  renderSidebar();
  renderReadiness();
  // If bootstrap racing kept stale placeholders, a follow-up pass once providers
  // have settled typically recovers without user action.
  if (!state.coworkers.length || !state.roster || state.roster.providers === undefined) {
    setTimeout(() => Promise.allSettled([refreshCoworkers(), refreshRoster()]).then(() => { renderSidebar(); renderReadiness(); }), 1200);
  }
}

bootstrap();
