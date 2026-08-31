"use strict";

const state = {
  handshake: undefined,
  coworkers: [],
  conversations: [],
  teams: [],
  teamPacks: [],
  channelTemplates: [],
  channels: [],
  roster: { ready: false, mode: "provider", roles: {}, agents: [], coworkerBindings: {}, providers: {} },
  settings: undefined,
  workspaces: { workspaces: [], defaultWorkspaceId: undefined },
  firstRun: undefined,
  connectedApps: { apps: [] },
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
  pollTimer: undefined,
  conversationSignature: undefined,
  inlineAttentionFor: undefined,
  inlineAttentionAt: 0,
  inlineAttentionRequest: 0,
};

const READ_MARKERS_KEY = "sovereignbot.conversation-read-v1";
let readMarkers = {};
try {
  const stored = JSON.parse(window.localStorage.getItem(READ_MARKERS_KEY) || "{}");
  if (stored && typeof stored === "object" && !Array.isArray(stored)) readMarkers = stored;
} catch {}

const $ = (id) => document.getElementById(id);
const show = (el) => el?.classList.remove("hidden");
const hide = (el) => el?.classList.add("hidden");

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

function conversationUnread(conversation) {
  const last = conversation?.lastMessage;
  return Boolean(conversation?.id && last?.senderId !== "user" && last?.createdAt && conversation.id !== state.selectedConversationId
    && (!readMarkers[conversation.id] || readMarkers[conversation.id] < last.createdAt));
}

function markConversationRead(conversation) {
  const stamp = conversation?.messages?.at(-1)?.createdAt;
  if (!conversation?.id || !stamp) return;
  readMarkers[conversation.id] = stamp;
  try { window.localStorage.setItem(READ_MARKERS_KEY, JSON.stringify(readMarkers)); } catch {}
}

function channelForConversation(conversationId) {
  return state.channels.find((entry) => entry.conversationId === conversationId);
}

function teamForConversation(conversationId) {
  const channel = channelForConversation(conversationId);
  return channel ? state.teams.find((entry) => entry.id === channel.teamId) : undefined;
}

function bindingFor(coworkerId) {
  return state.roster?.coworkerBindings?.[coworkerId];
}

function humanProvider(provider) {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude Code";
  return "Automatic";
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

function makeNavItem({ avatar, title, subtitle, meta, status, unread, active, compact, onClick }) {
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
  const visible = state.coworkers.filter((entry) => entry.state !== "archived");
  $("coworker-count").textContent = `${visible.length} persistent coworker${visible.length === 1 ? "" : "s"}`;
  $("coworker-empty").classList.toggle("hidden", visible.length > 0);

  for (const coworker of visible) {
    const binding = bindingFor(coworker.id);
    const direct = state.conversations.find((entry) => entry.kind === "direct" && entry.participants?.includes(coworker.id));
    list.append(makeNavItem({
      avatar: avatarFor(coworker),
      title: coworker.name,
      subtitle: coworker.role,
      status: coworker.state === "paused" ? "offline" : binding?.ready ? "ready" : "offline",
      unread: conversationUnread(direct),
      active: direct?.id === state.selectedConversationId,
      onClick: () => openDirect(coworker.id),
    }));
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
  const providers = Object.entries(state.roster?.providers ?? {}).filter(([, value]) => value?.usable).map(([key]) => humanProvider(key));
  const summary = $("provider-summary");
  const dot = $("provider-dot");
  if (state.roster?.mode === "demo") {
    summary.textContent = "Demo mode";
    dot.classList.add("offline");
  } else if (state.roster?.ready) {
    summary.textContent = providers.length ? `${providers.join(" + ")} ready · ${readyCoworkers} coworker lanes` : `${readyCoworkers} coworker lanes ready`;
    dot.classList.remove("offline");
  } else {
    summary.textContent = "Connect Codex or Claude Code";
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
  state.selectedConversationId = conversationId;
  state.mentionIds.clear();
  state.replyTo = undefined;
  state.redirectMode = false;
  state.conversationSignature = undefined;
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
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "hero-action";
      retry.textContent = "Retry / 重试";
      retry.addEventListener("click", async () => { retry.disabled = true; try { await window.sovereignbot.jobs.approve({ jobId: job.id }); await refreshInlineAttention(conversationId, true); } finally { retry.disabled = false; } });
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "quiet-action";
      dismiss.textContent = "Dismiss / 忽略";
      dismiss.addEventListener("click", async () => { dismiss.disabled = true; try { await window.sovereignbot.jobs.dismiss({ jobId: job.id }); await refreshInlineAttention(conversationId, true); } finally { dismiss.disabled = false; } });
      card.append(copy, retry, dismiss);
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

function speakMessage(messageText, button) {
  const synthesis = window.speechSynthesis;
  const Utterance = window.SpeechSynthesisUtterance;
  if (!synthesis || typeof Utterance !== "function") return;
  synthesis.cancel();
  const utterance = new Utterance(messageText);
  utterance.lang = document.documentElement.lang?.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  button?.classList.add("speaking");
  const clear = () => button?.classList.remove("speaking");
  utterance.onend = clear;
  utterance.onerror = clear;
  synthesis.speak(utterance);
}

function renderMessage(conversation, message) {
  const row = document.createElement("li");
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
  if (!user && window.speechSynthesis && typeof window.SpeechSynthesisUtterance === "function") {
    const speak = document.createElement("button");
    speak.type = "button";
    speak.className = "message-action";
    speak.textContent = "Speak / 播放";
    speak.addEventListener("click", () => speakMessage(message.text, speak));
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

function renderMessages(conversation, forceScroll = false) {
  const list = $("conversation-messages");
  const signature = JSON.stringify(conversation.messages ?? []);
  if (signature === state.conversationSignature) return;
  state.conversationSignature = signature;
  clearNode(list);
  for (const message of conversation.messages ?? []) list.append(renderMessage(conversation, message));

  const members = participantCoworkers(conversation);
  const start = $("conversation-start");
  start.classList.toggle("hidden", (conversation.messages?.length ?? 0) > 0);
  if ((conversation.messages?.length ?? 0) === 0) {
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
  const scroller = $("message-scroller");
  if (forceScroll || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160)
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
}

async function refreshConversation(forceScroll = false) {
  const id = state.selectedConversationId;
  if (!id || state.activeView !== "conversation") return;
  try {
    const conversation = await window.sovereignbot.conversations.get({ conversationId: id });
    if (state.selectedConversationId !== id) return;
    state.selectedConversation = conversation;
    markConversationRead(conversation);
    renderConversationHeader(conversation);
    renderMessages(conversation, forceScroll);
    void refreshInlineAttention(id);
    await refreshConversations();
    if (state.teams.length) await refreshTeams();
  } catch (error) {
    $("composer-error").textContent = text(error?.message || error);
    show($("composer-error"));
  }
  clearTimeout(state.pollTimer);
  if (state.activeView === "conversation") state.pollTimer = setTimeout(() => refreshConversation(false), 850);
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
      status.textContent = attention.has(member.id) ? "Needs attention" : member.id === flow.currentOwnerId && flow.status === "active" ? "Active" : member.id === flow.currentOwnerId ? "Waiting" : "Available";
      row.append(name, status);
      roster.append(row);
    }
  }
  const pending = pendingUserRecipients(conversation);
  $("details-current-work").textContent = team?.flow?.currentOwner
    ? `${team.flow.status === "needs-attention" ? "Needs attention" : team.flow.status === "active" ? "Active" : "Waiting"} · ${team.flow.currentOwner}`
    : pending.size ? `${pending.size} coworker${pending.size === 1 ? "" : "s"} working` : "Ready";
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
  if (team) populateChannelDialog(undefined, team);
}

function openEditChannelDialog() {
  const team = teamForConversation(state.selectedConversationId);
  const channel = team?.channels?.find((entry) => entry.conversationId === state.selectedConversationId);
  if (team && channel) populateChannelDialog(channel, team);
}

async function saveChannel(event) {
  event.preventDefault();
  const team = teamForConversation(state.selectedConversationId);
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
    if (result?.channel?.conversationId) await openConversation(result.channel.conversationId);
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
  const button = $("voice-input");
  if (!button) return;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (typeof Recognition !== "function") {
    button.disabled = true;
    button.title = "Voice input is unavailable in this environment / 当前环境不支持语音输入";
    return;
  }
  let recognition;
  try {
    recognition = new Recognition();
  } catch {
    button.disabled = true;
    button.title = "Voice input is unavailable in this environment / 当前环境不支持语音输入";
    return;
  }
  let held = false;
  const setListening = (listening) => {
    state.voice.listening = listening;
    button.classList.toggle("recording", listening);
    button.setAttribute("aria-pressed", String(listening));
    button.textContent = listening ? "■" : "🎙";
    button.title = listening ? "Release to finish / 松开完成" : "Hold to talk / 按住说话";
    if (listening) $("composer-hint").textContent = "Listening… release to finish · 松开完成";
  };
  const start = () => {
    held = true;
    if (state.voice.listening) return;
    recognition.lang = document.documentElement.lang?.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
    try { recognition.start(); }
    catch (error) {
      held = false;
      if (error?.name !== "InvalidStateError") {
        $("composer-error").textContent = "Voice input could not start / 语音输入无法启动";
        show($("composer-error"));
      }
    }
  };
  const stop = () => {
    held = false;
    if (!state.voice.listening) return;
    try { recognition.stop(); } catch { /* recognition may already be ending */ }
  };
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    setListening(true);
    if (!held) stop();
  };
  recognition.onresult = (event) => {
    const transcript = [...event.results].map((result) => result[0]?.transcript ?? "").join(" ").trim();
    if (!transcript) return;
    const input = $("composer-input");
    const existing = input.value.trim();
    input.value = existing ? `${existing} ${transcript}` : transcript;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  recognition.onerror = (event) => {
    if (event.error === "aborted" || event.error === "no-speech") return;
    $("composer-error").textContent = "Voice input needs permission or is unavailable / 语音输入需要权限或暂不可用";
    show($("composer-error"));
  };
  recognition.onend = () => {
    setListening(false);
    const conversation = state.selectedConversation;
    const pending = conversation ? pendingUserRecipients(conversation).size : 0;
    if ($("composer-hint")) $("composer-hint").textContent = state.redirectMode
      ? "Enter to redirect the active work · Shift+Enter for a new line"
      : pending ? "Active work is running · Redirect changes its direction" : "Enter to send · Shift+Enter for a new line";
  };
  const keyStart = (event) => {
    if ((event.key === " " || event.key === "Enter") && !event.repeat) {
      event.preventDefault();
      start();
    }
  };
  const keyStop = (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      stop();
    }
  };
  button.addEventListener("pointerdown", (event) => { event.preventDefault(); start(); });
  button.addEventListener("pointerup", stop);
  button.addEventListener("pointercancel", stop);
  button.addEventListener("pointerleave", stop);
  button.addEventListener("keydown", keyStart);
  button.addEventListener("keyup", keyStop);
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
  $("coworker-provider").value = coworker?.modelBinding?.profile ?? "automatic";
  $("coworker-state").value = coworker?.state === "paused" ? "paused" : "active";
  $("coworker-workspace").value = coworker?.workspaceIds?.[0] ?? "";
  $("coworker-computer-profile").value = coworker?.computerProfileId ?? "";
  $("coworker-advanced-provider").value = "";
  $("coworker-advanced-account").value = "";
  $("coworker-advanced-model").value = "";
  for (const id of ["coworker-advanced-provider", "coworker-advanced-account", "coworker-advanced-model"]) $(id).disabled = true;
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
    const providerAccountId = $("coworker-advanced-account").value.trim();
    const model = $("coworker-advanced-model").value.trim();
    if (!provider && (providerAccountId || model)) throw new Error("Choose a provider before pinning an account or model.");
    const fields = {
          name: $("coworker-name").value.trim(),
          role: $("coworker-role").value.trim(),
          instructions: $("coworker-instructions").value.trim(),
          ...(!state.editingCoworkerId ? {
            modelBinding: {
              profile,
              ...(provider ? { provider } : {}),
              ...(providerAccountId ? { providerAccountId } : {}),
              ...(model ? { model } : {}),
            },
            ...($("coworker-workspace").value ? { workspaceIds: [$("coworker-workspace").value] } : {}),
            ...($("coworker-computer-profile").value.trim() ? { computerProfileId: $("coworker-computer-profile").value.trim() } : {}),
          } : {
            ...(profile !== state.editingCoworkerSnapshot?.modelBinding?.profile ? { modelBinding: { profile } } : {}),
            ...(JSON.stringify($("coworker-workspace").value ? [$("coworker-workspace").value] : []) !== JSON.stringify(state.editingCoworkerSnapshot?.workspaceIds ?? [])
              ? { workspaceIds: $("coworker-workspace").value ? [$("coworker-workspace").value] : [] } : {}),
            ...($("coworker-computer-profile").value.trim() !== (state.editingCoworkerSnapshot?.computerProfileId ?? "")
              ? { computerProfileId: $("coworker-computer-profile").value.trim() || undefined } : {}),
            ...($("coworker-state").value !== (state.editingCoworkerSnapshot?.state ?? "active")
              ? { state: $("coworker-state").value } : {}),
          }),
    };
    const wasEditing = Boolean(state.editingCoworkerId);
    const result = wasEditing
      ? await window.sovereignbot.coworkers.update({ coworkerId: state.editingCoworkerId, patch: fields })
      : await window.sovereignbot.coworkers.create({ coworker: fields });
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
  $("setting-theme").value = settings.theme ?? "system";
  document.body.dataset.theme = settings.theme ?? "system";
  $("setting-close").value = settings.closeBehavior ?? "ask";
  $("setting-notifications").checked = settings.notifications !== false;
  $("setting-demo-mode").checked = settings.demoMode === true;
  $("setting-language").value = settings.language ?? "system";
  applyLocale(settings.language ?? "system", state.handshake?.locale);
}

function renderProviderCards() {
  const root = $("provider-cards");
  clearNode(root);
  const firstRunProviders = state.firstRun?.providers ?? {};
  for (const provider of ["codex", "claude"]) {
    const info = firstRunProviders[provider] ?? {};
    const usable = state.roster?.providers?.[provider]?.usable;
    const card = document.createElement("article");
    card.className = "provider-card";
    const head = document.createElement("div");
    head.className = "provider-card-head";
    const name = document.createElement("strong");
    name.textContent = humanProvider(provider);
    const status = document.createElement("span");
    status.className = `provider-state${usable ? " ready" : ""}`;
    status.textContent = usable ? "Ready" : info.found ? `Auth ${info.auth?.state ?? "unverified"}` : "Not found";
    head.append(name, status);
    const detail = document.createElement("p");
    detail.textContent = info.found ? (info.version || "CLI detected") : "Install the local CLI, then refresh.";
    const actions = document.createElement("div");
    actions.className = "provider-actions";
    const signIn = document.createElement("button");
    signIn.type = "button";
    signIn.textContent = info.found ? "Open sign-in" : "Try detection";
    signIn.addEventListener("click", async () => {
      try {
        if (info.found) await window.sovereignbot.providers.openLogin({ provider });
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

async function refreshSettingsData() {
  try {
    const [settings, workspaces, firstRun, roster, connectedApps] = await Promise.all([
      window.sovereignbot.settings.get({}),
      window.sovereignbot.workspaces.list({}),
      window.sovereignbot.firstRun.getStatus({}),
      window.sovereignbot.providers.getRoster({}),
      window.sovereignbot.connectedApps.list({}),
    ]);
    state.settings = settings;
    state.workspaces = workspaces;
    state.firstRun = firstRun;
    state.roster = roster;
    state.connectedApps = connectedApps;
    renderSettings();
    renderProviderCards();
    renderWorkspaces();
    renderAdvancedRoster();
    renderConnectedApps();
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

async function refreshActivity() {
  try {
    const [overview, audit] = await Promise.all([
      window.sovereignbot.operator.getOverview({}),
      window.sovereignbot.operator.getAudit({ limit: 30 }),
    ]);
    const agents = (overview.agents ?? []).map((entry) => `${entry.name || entry.id} · ${entry.harnessKind || entry.harness?.kind || ""}`);
    const tasks = overview.tasks ?? [];
    const counts = {};
    for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
    $("overview-block").textContent = `Coworker/runtime agents\n${agents.join("\n") || "…"}\n\nTasks ${JSON.stringify(counts)}`;
    const auditEntries = Array.isArray(audit) ? audit : (audit?.entries ?? []);
    $("audit-block").textContent = auditEntries.map((entry) => `${entry.at ?? ""}  ${entry.type}  ${entry.subject ?? ""}`).join("\n") || "No audit entries.";
  } catch {
    $("overview-block").textContent = "Activity is unavailable in this runtime mode.";
    $("audit-block").textContent = "";
  }
}

function showToastError(error) {
  const target = $("provider-action-result");
  target.textContent = text(error?.message || error).replace(/^.*Error: /, "");
}

function bindEvents() {
  $("new-coworker").addEventListener("click", () => { resetCoworkerDialog(); populateCoworkerAdvanced(); openDialog("coworker-dialog"); });
  $("refresh-coworkers").addEventListener("click", () => Promise.all([refreshCoworkers(), refreshConversations(), refreshRoster()]));
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
  $("open-details").addEventListener("click", () => $("details-panel").classList.toggle("hidden"));
  $("close-details").addEventListener("click", () => hide($("details-panel")));
  $("nav-settings").addEventListener("click", async () => { switchView("settings"); await refreshSettingsData(); });
  $("nav-activity").addEventListener("click", async () => { show($("activity-drawer")); await refreshActivity(); });
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

  const results = await Promise.allSettled([refreshCoworkers(), refreshConversations(), refreshTeams(), refreshRoster(), refreshSettingsData()]);
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
