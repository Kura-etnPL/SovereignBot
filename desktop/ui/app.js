"use strict";

const state = {
  coworkers: [], conversations: [], activeConversationId: undefined, activeConversation: undefined,
  handshake: undefined, roster: undefined, poll: undefined, busy: false,
};
const $ = (id) => document.getElementById(id);
const show = (el) => el?.classList.remove("hidden");
const hide = (el) => el?.classList.add("hidden");
const cleanError = (error) => String(error?.message ?? error).replace(/^.*Error: /, "").slice(0, 500);

function avatarText(coworker) { return coworker?.avatar || coworker?.name?.slice(0, 1)?.toUpperCase() || "✦"; }
function coworkerById(id) { return state.coworkers.find((entry) => entry.id === id); }
function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function avatar(coworker, large = false) {
  const el = node("div", `avatar${large ? " avatar-large" : ""}`, avatarText(coworker));
  return el;
}

async function loadCoreState() {
  const [coworkerResult, conversationResult, roster] = await Promise.all([
    window.sovereignbot.coworkers.list({}),
    window.sovereignbot.conversations.list({}),
    window.sovereignbot.providers.getRoster().catch(() => undefined),
  ]);
  state.coworkers = coworkerResult?.coworkers ?? [];
  state.conversations = conversationResult?.conversations ?? [];
  state.roster = roster;
  renderSidebar();
  renderWelcome();
}

function entityButton({ label, detail, icon, active, onClick, conversation = false }) {
  const button = node("button", `entity-button${active ? " active" : ""}`);
  button.type = "button";
  const iconEl = conversation ? node("span", "conversation-dot") : node("div", "avatar", icon);
  const copy = node("span", "entity-copy");
  copy.append(node("strong", "", label), node("span", "", detail || ""));
  button.append(iconEl, copy);
  button.addEventListener("click", onClick);
  return button;
}

function renderSidebar() {
  const coworkers = $("coworker-list"); coworkers.textContent = "";
  for (const coworker of state.coworkers.filter((entry) => entry.state !== "archived")) {
    coworkers.append(entityButton({
      label: coworker.name,
      detail: coworker.role,
      icon: avatarText(coworker),
      onClick: () => openDirectConversation(coworker.id),
    }));
  }
  const conversations = $("conversation-list"); conversations.textContent = "";
  for (const conversation of [...state.conversations].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
    const coworkerNames = (conversation.participants ?? []).filter((id) => id !== "user").map((id) => coworkerById(id)?.name).filter(Boolean);
    conversations.append(entityButton({
      label: conversation.title || (conversation.kind === "team" ? "Team" : coworkerNames[0] || "Conversation"),
      detail: conversation.lastMessage?.textPreview || coworkerNames.join(", "),
      active: conversation.id === state.activeConversationId,
      conversation: true,
      onClick: () => openConversation(conversation.id),
    }));
  }
}

function renderWelcome() {
  const grid = $("welcome-coworkers"); grid.textContent = "";
  for (const coworker of state.coworkers.filter((entry) => entry.state === "active").slice(0, 6)) {
    const card = node("button", "welcome-card"); card.type = "button";
    card.append(avatar(coworker), node("strong", "", coworker.name), node("p", "", coworker.role));
    card.addEventListener("click", () => openDirectConversation(coworker.id));
    grid.append(card);
  }
}

async function openDirectConversation(coworkerId) {
  try {
    const summary = await window.sovereignbot.conversations.createDirect({ coworkerId });
    await loadCoreState();
    await openConversation(summary.id);
  } catch (error) { showToast(cleanError(error), true); }
}

function currentRecipientsWithPending(conversation) {
  const last = conversation?.messages?.at(-1);
  if (!last || last.senderId !== "user") return [];
  return Object.entries(last.delivery ?? {}).filter(([, value]) => value?.status === "pending").map(([id]) => id);
}

async function openConversation(conversationId) {
  state.activeConversationId = conversationId;
  await refreshActiveConversation();
  hide($("welcome-view")); show($("chat-view")); show($("detail-content")); hide($("detail-empty"));
  renderSidebar();
  clearTimeout(state.poll);
  state.poll = setTimeout(pollConversation, 900);
}

async function pollConversation() {
  if (!state.activeConversationId) return;
  try { await refreshActiveConversation(); } catch {}
  clearTimeout(state.poll);
  state.poll = setTimeout(pollConversation, currentRecipientsWithPending(state.activeConversation).length ? 700 : 1600);
}

async function refreshActiveConversation() {
  if (!state.activeConversationId) return;
  const conversation = await window.sovereignbot.conversations.get({ conversationId: state.activeConversationId });
  if (conversation.id !== state.activeConversationId) return;
  state.activeConversation = conversation;
  renderConversation(conversation);
}

function renderConversation(conversation) {
  const participantIds = (conversation.participants ?? []).filter((id) => id !== "user");
  const participantCoworkers = participantIds.map(coworkerById).filter(Boolean);
  const primary = participantCoworkers[0];
  $("chat-title").textContent = conversation.title || primary?.name || "Conversation";
  $("chat-kind").textContent = conversation.kind;
  $("chat-avatar").textContent = conversation.kind === "team" ? "◇" : avatarText(primary);
  $("chat-subtitle").textContent = conversation.kind === "team"
    ? participantCoworkers.map((entry) => entry.name).join(" · ")
    : `${primary?.role ?? "Persistent coworker"} · ${primary?.providerPreference ?? "auto"}`;
  const pending = currentRecipientsWithPending(conversation);
  $("chat-presence").lastChild.textContent = pending.length ? ` ${pending.length} working` : " ready";
  $("typing-state").classList.toggle("hidden", pending.length === 0);
  renderMessages(conversation.messages ?? []);
  renderDetail(participantCoworkers);
}

function messageAvatar(senderId) {
  if (senderId === "user") return undefined;
  return avatar(coworkerById(senderId));
}
function deliveryText(message) {
  if (message.senderId !== "user") return "";
  const values = Object.values(message.delivery ?? {});
  if (!values.length) return "sent";
  if (values.some((entry) => entry.status === "pending")) return "working…";
  if (values.some((entry) => entry.status === "failed")) return "attention needed";
  return "delivered";
}
function renderMessages(messages) {
  const stack = $("messages");
  const nearBottom = $("message-scroll").scrollHeight - $("message-scroll").scrollTop - $("message-scroll").clientHeight < 120;
  stack.textContent = "";
  for (const message of messages) {
    const row = node("article", `chat-message${message.senderId === "user" ? " user" : ""}`);
    const av = messageAvatar(message.senderId); if (av) row.append(av);
    const wrap = node("div", "message-content");
    const author = node("div", "message-author");
    author.append(node("strong", "", message.senderId === "user" ? "You" : coworkerById(message.senderId)?.name || "Coworker"), node("time", "", formatTime(message.createdAt)));
    const bubble = node("div", "bubble", message.text);
    wrap.append(author, bubble);
    const delivery = deliveryText(message); if (delivery) wrap.append(node("div", "delivery", delivery));
    row.append(wrap); stack.append(row);
  }
  if (nearBottom) requestAnimationFrame(() => { $("message-scroll").scrollTop = $("message-scroll").scrollHeight; });
}

function renderDetail(coworkers) {
  const list = $("detail-participants"); list.textContent = "";
  for (const coworker of coworkers) {
    const row = node("div", "participant"); row.append(avatar(coworker), node("span", "", coworker.name)); list.append(row);
  }
  const workspaceIds = [...new Set(coworkers.flatMap((entry) => entry.workspaceIds ?? []))];
  $("workspace-summary").textContent = workspaceIds.length ? `${workspaceIds.length} trusted workspace binding${workspaceIds.length > 1 ? "s" : ""}` : "Private coworker workspace";
}

async function sendMessage(event) {
  event?.preventDefault();
  if (!state.activeConversationId || state.busy) return;
  const input = $("composer-input"); const text = input.value.trim(); if (!text) return;
  state.busy = true; $("send-message").disabled = true; hide($("composer-error"));
  try {
    await window.sovereignbot.conversations.send({
      conversationId: state.activeConversationId,
      text,
      clientMessageId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    input.value = "";
    await Promise.all([refreshActiveConversation(), refreshConversationSummaries()]);
  } catch (error) {
    $("composer-error").textContent = cleanError(error); show($("composer-error"));
  } finally { state.busy = false; $("send-message").disabled = false; input.focus(); }
}

async function refreshConversationSummaries() {
  const result = await window.sovereignbot.conversations.list({});
  state.conversations = result?.conversations ?? [];
  renderSidebar();
}

function openModal(title, contentBuilder) {
  $("modal-title").textContent = title; const body = $("modal-body"); body.textContent = ""; contentBuilder(body); show($("modal-backdrop"));
}
function closeModal() { hide($("modal-backdrop")); $("modal-body").textContent = ""; }
function modalForm(fields, submitLabel, onSubmit) {
  const form = node("form", "form-grid");
  const controls = {};
  for (const field of fields) {
    const label = node("label", "", field.label);
    let input;
    if (field.type === "textarea") input = node("textarea");
    else if (field.type === "select") { input = node("select"); for (const option of field.options) { const el = node("option", "", option.label); el.value = option.value; input.append(el); } }
    else input = node("input");
    input.name = field.name; if (field.placeholder) input.placeholder = field.placeholder; if (field.required) input.required = true; if (field.maxLength) input.maxLength = field.maxLength;
    controls[field.name] = input; label.append(input); form.append(label);
  }
  const error = node("p", "error-text hidden"); const actions = node("div", "modal-actions");
  const cancel = node("button", "secondary-action", "Cancel"); cancel.type = "button"; cancel.addEventListener("click", closeModal);
  const submit = node("button", "send-button", submitLabel); submit.type = "submit"; actions.append(cancel, submit); form.append(error, actions);
  form.addEventListener("submit", async (event) => { event.preventDefault(); submit.disabled = true; try { await onSubmit(controls); closeModal(); await loadCoreState(); } catch (e) { error.textContent = cleanError(e); show(error); } finally { submit.disabled = false; } });
  return form;
}

function createCoworkerModal() {
  openModal("Create coworker", (body) => body.append(modalForm([
    { name:"name", label:"Name", placeholder:"e.g. Growth Lead", required:true, maxLength:80 },
    { name:"role", label:"Role", placeholder:"What this coworker owns", required:true, maxLength:120 },
    { name:"instructions", label:"Working style & instructions", type:"textarea", placeholder:"How should this coworker operate?", maxLength:12000 },
    { name:"provider", label:"Preferred intelligence", type:"select", options:[{value:"auto",label:"Automatic"},{value:"codex",label:"Codex"},{value:"claude",label:"Claude Code"}] },
  ], "Create", async (c) => {
    await window.sovereignbot.coworkers.create({ coworker:{ name:c.name.value, role:c.role.value, instructions:c.instructions.value, providerPreference:c.provider.value } });
  })));
}

function createTeamModal() {
  const active = state.coworkers.filter((entry) => entry.state === "active");
  openModal("New team conversation", (body) => {
    const form = node("form", "form-grid");
    const titleLabel = node("label", "", "Team name"); const title = node("input"); title.maxLength = 120; title.placeholder = "e.g. Product Team"; titleLabel.append(title); form.append(titleLabel);
    const peopleLabel = node("label", "", "Coworkers (choose at least two)"); const choices = node("div", "participants");
    const selected = new Set();
    for (const coworker of active) {
      const row = node("label", "participant"); const box = node("input"); box.type = "checkbox"; box.addEventListener("change", () => box.checked ? selected.add(coworker.id) : selected.delete(coworker.id)); row.append(box, avatar(coworker), node("span", "", coworker.name)); choices.append(row);
    }
    peopleLabel.append(choices); form.append(peopleLabel);
    const error = node("p", "error-text hidden"); const actions = node("div", "modal-actions"); const cancel = node("button", "secondary-action", "Cancel"); cancel.type="button"; cancel.addEventListener("click",closeModal); const submit=node("button","send-button","Create team"); submit.type="submit"; actions.append(cancel,submit); form.append(error,actions);
    form.addEventListener("submit", async (event) => { event.preventDefault(); if (selected.size < 2) { error.textContent="Choose at least two coworkers."; show(error); return; } submit.disabled=true; try { const conv=await window.sovereignbot.conversations.createTeam({ title:title.value.trim() || undefined, coworkerIds:[...selected] }); closeModal(); await loadCoreState(); await openConversation(conv.id); } catch(e){ error.textContent=cleanError(e); show(error); } finally {submit.disabled=false;} });
    body.append(form);
  });
}

async function renderControlCenter() {
  try {
    const [status, workspaces] = await Promise.all([window.sovereignbot.firstRun.getStatus(), window.sovereignbot.workspaces.list()]);
    const providerList = $("provider-list"); providerList.textContent = "";
    for (const [name, provider] of Object.entries(status.providers ?? {})) {
      const row=node("div","provider-row"); row.append(node("strong","",name === "claude" ? "Claude Code" : "Codex"),node("span","",provider.found ? `${provider.version ?? "detected"} · ${provider.auth?.state ?? "auth unverified"}` : "Not found")); providerList.append(row);
    }
    const workspaceList=$("workspace-list"); workspaceList.textContent=""; for(const workspace of workspaces.workspaces ?? []) { const row=node("div","workspace-row"); row.append(node("strong","",workspace.path),node("span","",workspace.id===workspaces.defaultWorkspaceId?"Default trusted workspace":"Trusted workspace")); workspaceList.append(row); }
  } catch (error) { $("provider-feedback").textContent=cleanError(error); }
}

async function refreshActivity() {
  try {
    const [overview,audit]=await Promise.all([window.sovereignbot.operator.getOverview(),window.sovereignbot.operator.getAudit({limit:80})]);
    $("overview-block").textContent=JSON.stringify({agents:overview.agents?.map((a)=>({name:a.name,id:a.id,status:a.status,kind:a.harnessKind})),tasks:overview.tasks?.slice(-20),computers:overview.computers},null,2);
    $("audit-block").textContent=JSON.stringify(audit?.records ?? audit,null,2);
  } catch(error){ $("overview-block").textContent=cleanError(error); }
}

function showToast(text, error=false) { $("provider-feedback").textContent=text; $("provider-feedback").style.color=error?"var(--error)":"var(--muted)"; }
function bindEvents() {
  $("composer").addEventListener("submit", sendMessage);
  $("composer-input").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } });
  $("refresh-chat").addEventListener("click", () => refreshActiveConversation());
  $("new-coworker").addEventListener("click", createCoworkerModal);
  $("new-team").addEventListener("click", createTeamModal);
  $("new-chat").addEventListener("click", () => { if (state.coworkers[0]) openDirectConversation(state.coworkers[0].id); else createCoworkerModal(); });
  $("modal-close").addEventListener("click", closeModal); $("modal-backdrop").addEventListener("click", (event) => { if (event.target === $("modal-backdrop")) closeModal(); });
  $("open-activity").addEventListener("click", async()=>{await refreshActivity();show($("activity-drawer"));}); $("close-activity").addEventListener("click",()=>hide($("activity-drawer")));
  $("open-control").addEventListener("click",async()=>{await renderControlCenter();show($("control-drawer"));}); $("open-settings").addEventListener("click",async()=>{await renderControlCenter();show($("control-drawer"));}); $("close-control").addEventListener("click",()=>hide($("control-drawer")));
  $("provider-refresh").addEventListener("click",async()=>{try{await window.sovereignbot.providers.refresh({});await loadCoreState();await renderControlCenter();showToast("Provider roster refreshed.");}catch(e){showToast(cleanError(e),true);}});
  $("login-codex").addEventListener("click",async()=>{try{await window.sovereignbot.providers.openLogin({provider:"codex"});await renderControlCenter();}catch(e){showToast(cleanError(e),true);}});
  $("login-claude").addEventListener("click",async()=>{try{await window.sovereignbot.providers.openLogin({provider:"claude"});await renderControlCenter();}catch(e){showToast(cleanError(e),true);}});
  $("add-workspace").addEventListener("click",async()=>{try{await window.sovereignbot.workspaces.addViaDialog({});await renderControlCenter();}catch(e){showToast(cleanError(e),true);}});
  $("provision-driver").addEventListener("click",async()=>{const el=$("driver-feedback");el.textContent="Provisioning…";try{const r=await window.sovereignbot.computer.provisionDriver({});el.textContent=`Ready: ${r.driverVersion ?? "managed driver"}`;}catch(e){el.textContent=cleanError(e);}});
  $("close-detail").addEventListener("click",()=>hide($("detail-panel")));
  $("computer-action").addEventListener("click",()=>{void refreshActivity();show($("activity-drawer"));});
}

async function main() {
  bindEvents();
  state.handshake = await window.sovereignbot.handshake({});
  $("version-label").textContent = `Desktop ${state.handshake.version}`;
  await loadCoreState();
}

main().catch((error) => {
  hide($("chat-view")); show($("welcome-view"));
  $("welcome-view").querySelector("p").textContent = `SovereignBot could not initialize the coworker workspace: ${cleanError(error)}`;
});
