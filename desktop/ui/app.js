"use strict";

const state = {
  handshake: undefined,
  coworkers: [],
  conversations: [],
  roster: { ready: false, mode: "provider", roles: {}, agents: [], coworkerBindings: {}, providers: {} },
  settings: undefined,
  workspaces: { workspaces: [], defaultWorkspaceId: undefined },
  firstRun: undefined,
  selectedConversationId: undefined,
  selectedConversation: undefined,
  activeView: "welcome",
  mentionIds: new Set(),
  pollTimer: undefined,
  conversationSignature: undefined,
};

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

function bindingFor(coworkerId) {
  return state.roster?.coworkerBindings?.[coworkerId];
}

function humanProvider(provider) {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude Code";
  return "Automatic";
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

function makeNavItem({ avatar, title, subtitle, meta, status, active, compact, onClick }) {
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
      active: direct?.id === state.selectedConversationId,
      onClick: () => openDirect(coworker.id),
    }));
  }
}

function renderTeams() {
  const list = $("team-list");
  clearNode(list);
  const teams = state.conversations
    .filter((entry) => entry.kind === "team")
    .sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)));
  for (const conversation of teams) {
    list.append(makeNavItem({
      avatar: "#",
      title: conversation.title,
      subtitle: `${Math.max(0, (conversation.participants?.length ?? 1) - 1)} coworkers`,
      meta: formatRelative(conversation.updatedAt),
      active: conversation.id === state.selectedConversationId,
      onClick: () => openConversation(conversation.id),
    }));
  }
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
    summary.textContent = providers.length ? `${providers.join(" + ")} ready 路 ${readyCoworkers} coworker lanes` : `${readyCoworkers} coworker lanes ready`;
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
  state.conversationSignature = undefined;
  switchView("conversation");
  hide($("details-panel"));
  renderSidebar();
  await refreshConversation(true);
  $("composer-input").focus();
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
  everyone.className = `mention-chip${state.mentionIds.size === 0 ? " active" : ""}`;
  everyone.textContent = "@everyone";
  everyone.addEventListener("click", () => {
    state.mentionIds.clear();
    renderMentionRow(conversation);
  });
  row.append(everyone);
  for (const coworker of participantCoworkers(conversation)) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `mention-chip${state.mentionIds.has(coworker.id) ? " active" : ""}`;
    chip.textContent = `@${coworker.name}`;
    chip.addEventListener("click", () => {
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
  $("conversation-avatar").textContent = conversation.kind === "team" ? "#" : avatarFor(direct);
  $("conversation-title").textContent = conversation.title;
  $("conversation-kind").textContent = conversation.kind === "team" ? "Team" : "Coworker";
  $("conversation-subtitle").textContent = conversation.kind === "team"
    ? members.map((entry) => entry.name).join(" 路 ")
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

  renderMentionRow(conversation);
  renderDetails(conversation);
}

function replyPreview(conversation, replyTo) {
  if (!replyTo) return undefined;
  return conversation.messages.find((entry) => entry.id === replyTo)?.text;
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
  const body = document.createElement("div");
  body.className = "chat-text";
  body.textContent = message.text;
  content.append(meta, body);

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
    renderConversationHeader(conversation);
    renderMessages(conversation, forceScroll);
    await refreshConversations();
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
    await window.sovereignbot.conversations.send({
      conversationId: conversation.id,
      text: value,
      ...(state.mentionIds.size ? { mentions: [...state.mentionIds] } : {}),
      clientMessageId: `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });
    area.value = "";
    autoSizeComposer();
    state.mentionIds.clear();
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
    row.append(avatar, name);
    membersEl.append(row);
  }

  const providers = [...new Set(members.map((entry) => bindingFor(entry.id)?.provider).filter(Boolean).map(humanProvider))];
  $("details-provider").textContent = providers.length ? providers.join(" + ") : "Provider unavailable";
  const workspaceIds = [...new Set(members.flatMap((entry) => entry.workspaceIds ?? []))];
  const workspaces = workspaceIds.map((id) => state.workspaces.workspaces?.find((entry) => entry.id === id)?.path).filter(Boolean);
  $("details-workspace").textContent = workspaces.length ? workspaces.join("\n") : "Private coworker workspace";
  const pending = pendingUserRecipients(conversation);
  $("details-current-work").textContent = pending.size ? `${pending.size} coworker${pending.size === 1 ? "" : "s"} working` : "Ready";
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

async function createCoworker(event) {
  event.preventDefault();
  hide($("coworker-form-error"));
  try {
    const result = await window.sovereignbot.coworkers.create({
      coworker: {
        name: $("coworker-name").value.trim(),
        role: $("coworker-role").value.trim(),
        instructions: $("coworker-instructions").value.trim(),
        providerPreference: $("coworker-provider").value,
      },
    });
    $("coworker-dialog").close();
    $("coworker-form").reset();
    await Promise.all([refreshCoworkers(), refreshRoster()]);
    if (result?.coworker?.id) await openDirect(result.coworker.id);
  } catch (error) {
    $("coworker-form-error").textContent = text(error?.message || error).replace(/^.*Error: /, "");
    show($("coworker-form-error"));
  }
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

function renderSettings() {
  const settings = state.settings;
  if (!settings) return;
  $("setting-theme").value = settings.theme ?? "system";
  document.body.dataset.theme = settings.theme ?? "system";
  $("setting-close").value = settings.closeBehavior ?? "ask";
  $("setting-notifications").checked = settings.notifications !== false;
  $("setting-demo-mode").checked = settings.demoMode === true;
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
    const path = document.createElement("code");
    path.textContent = workspace.path;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      await window.sovereignbot.workspaces.remove({ id: workspace.id });
      await refreshSettingsData();
    });
    card.append(radio, path, remove);
    root.append(card);
  }
}

function renderAdvancedRoster() {
  const lines = (state.roster?.agents ?? []).map((agent) => `${agent.name}\n  ${agent.harnessKind} 路 ${agent.capabilities.join(", ")}`);
  $("advanced-roster").textContent = lines.join("\n\n") || "No active runtime agents.";
}

async function refreshSettingsData() {
  try {
    const [settings, workspaces, firstRun, roster] = await Promise.all([
      window.sovereignbot.settings.get({}),
      window.sovereignbot.workspaces.list({}),
      window.sovereignbot.firstRun.getStatus({}),
      window.sovereignbot.providers.getRoster({}),
    ]);
    state.settings = settings;
    state.workspaces = workspaces;
    state.firstRun = firstRun;
    state.roster = roster;
    renderSettings();
    renderProviderCards();
    renderWorkspaces();
    renderAdvancedRoster();
    renderReadiness();
    renderSidebar();
    const browsers = firstRun?.browsers ?? [];
    $("browser-summary").textContent = browsers.length
      ? browsers.map((entry) => `${entry.browser} ${entry.version}`).join(" 路 ")
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
    const agents = (overview.agents ?? []).map((entry) => `${entry.name || entry.id} 路 ${entry.harnessKind || entry.harness?.kind || ""}`);
    const tasks = overview.tasks ?? [];
    const counts = {};
    for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
    $("overview-block").textContent = `Coworker/runtime agents\n${agents.join("\n") || "…"}\n\nTasks ${JSON.stringify(counts)}`;
    $("audit-block").textContent = (audit.entries ?? []).slice().reverse().map((entry) => `${entry.at ?? ""}  ${entry.type}  ${entry.subject ?? ""}`).join("\n") || "No audit entries.";
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
  $("new-coworker").addEventListener("click", () => openDialog("coworker-dialog"));
  $("refresh-coworkers").addEventListener("click", () => Promise.all([refreshCoworkers(), refreshConversations(), refreshRoster()]));
  $("new-team").addEventListener("click", () => { populateTeamPicker(); openDialog("team-dialog"); });
  $("welcome-create-team").addEventListener("click", () => { populateTeamPicker(); openDialog("team-dialog"); });
  $("welcome-open-chief").addEventListener("click", () => {
    const chief = state.coworkers.find((entry) => /chief of staff/i.test(entry.name)) ?? state.coworkers[0];
    if (chief) openDirect(chief.id);
  });
  $("coworker-form").addEventListener("submit", createCoworker);
  $("team-form").addEventListener("submit", createTeam);
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
  // composer-add is wired by skills-ui.js to open the real attachment dialog.

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
}

async function bootstrap() {
  bindEvents();
  try {
    state.handshake = await window.sovereignbot.handshake({});
    $("chip-version").textContent = state.handshake?.version || "V3";
  } catch (error) {
    $("chip-version").textContent = "offline";
    $("provider-summary").textContent = "Offline — restart the app.";
    $("provider-dot")?.classList.add("offline");
    $("provider-action-result").textContent = String(error?.message ?? error).slice(0, 300);
    return;
  }

  const results = await Promise.allSettled([refreshCoworkers(), refreshConversations(), refreshRoster(), refreshSettingsData()]);
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
