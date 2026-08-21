let token = "";
let overview;
let currentView = "overview";
let liveController;
let liveReconnectTimer;
let liveRefreshTimer;
let liveGeneration = 0;
let reconnectAttempt = 0;
let selectedTaskId;

const policyState = {
  loaded: false,
  active: undefined,
  draftText: "",
  actionText: JSON.stringify({
    category: "computer",
    operation: "navigate",
    agentId: "worker",
    target: "https://example.com/",
  }, null, 2),
  repeatCount: "1",
  validation: undefined,
  result: undefined,
  error: "",
};

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[ch]));

async function api(path, options = {}) {
  const headers = {
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    authorization: `Bearer ${token}`,
  };
  const response = await fetch(path, {
    ...options,
    headers: { ...headers, ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function status(task) {
  return `<span class="status ${esc(task.status)}">${esc(task.status)}</span>`;
}

function taskRow(task) {
  return `<div class="row"><div class="row-main"><div class="row-title">${esc(task.title)}</div><div class="row-sub">${esc(task.id)} · ${esc(task.assignedAgentId || task.ownerAgentId || "unassigned")}</div></div><div class="actions">${status(task)}<button class="small-btn" data-task="${esc(task.id)}">Inspect</button></div></div>`;
}

function overviewView() {
  const tasks = overview.tasks || [];
  const running = tasks.filter((task) => task.status === "running").length;
  const review = tasks.filter((task) => ["awaiting_review", "changes_requested"].includes(task.status)).length;
  const pending = (overview.computers || []).filter((computer) => computer.pendingSecret).length;
  return `<div class="grid">
    <div class="card"><h3>Tasks</h3><div class="metric">${tasks.length}</div><div class="muted">${running} running · ${review} review</div></div>
    <div class="card"><h3>Workers</h3><div class="metric">${overview.agents.length}</div><div class="muted">${overview.agents.filter((agent) => agent.role === "supervisor").length} supervisors</div></div>
    <div class="card"><h3>Operator attention</h3><div class="metric">${pending}</div><div class="muted">pending secret requests</div></div>
    <div class="card wide"><h3>Active / recent tasks</h3><div class="list">${tasks.slice().reverse().slice(0, 8).map(taskRow).join("") || '<div class="empty">No tasks yet</div>'}</div></div>
    <div class="card"><h3>Audit integrity</h3><div class="metric">${overview.audit.ok ? "✓" : "!"}</div><div class="muted">${overview.audit.ok ? `${overview.audit.count} verified rows` : esc(overview.audit.error || "verification failed")}</div></div>
  </div>`;
}

function tasksView() {
  return `<div class="card full"><h3>All tasks</h3><div class="list">${(overview.tasks || []).slice().reverse().map(taskRow).join("") || '<div class="empty">No tasks</div>'}</div></div>`;
}

function lifecycleText(computer) {
  if (computer.lifecycle?.error)
    return computer.lifecycle.error;
  if (computer.lifecycle?.running === false)
    return "not started";
  if (computer.lifecycle?.instantiated)
    return "driver instantiated";
  if (computer.lifecycle?.managed)
    return "managed · passive state unknown";
  return "no managed driver";
}

function computersView() {
  return `<div class="grid">${(overview.computers || []).map((computer) => `
    <div class="card computer">
      <h3><span class="health-dot ${computer.lifecycle?.instantiated ? "ok" : ""}"></span> ${esc(computer.agentId)}</h3>
      <div class="row-sub">Control: ${esc(computer.control?.mode || "unknown")} · ${esc(lifecycleText(computer))}</div>
      <div class="actions" style="margin-top:12px">
        <button class="small-btn" data-control="take" data-agent="${esc(computer.agentId)}">Take control</button>
        <button class="small-btn" data-control="release" data-agent="${esc(computer.agentId)}">Release</button>
        <button class="small-btn" data-life="start" data-agent="${esc(computer.agentId)}">Start</button>
        <button class="small-btn" data-life="stop" data-agent="${esc(computer.agentId)}">Stop</button>
        <button class="small-btn warn" data-life="reset" data-agent="${esc(computer.agentId)}">Reset</button>
      </div>
      ${computer.pendingSecret ? `<form class="secret-box" data-secret-form data-agent="${esc(computer.agentId)}" data-request="${esc(computer.pendingSecret.id)}" autocomplete="off"><strong>Secret requested: ${esc(computer.pendingSecret.label || "Secret")}</strong><div class="row-sub">Task ${esc(computer.pendingSecret.taskId)}</div><input name="secret" type="password" autocomplete="off" required placeholder="Enter value — never stored"><button class="small-btn" type="submit">Supply securely</button></form>` : ""}
    </div>`).join("") || '<div class="card full empty">No computers configured</div>'}</div>`;
}

async function memoryView() {
  const rows = await api("/operator/memory");
  return `<div class="toolbar"><input id="memory-q" class="search" placeholder="Search memory"><button id="memory-search" class="small-btn">Search</button></div><div id="memory-results" class="list">${memoryRows(rows)}</div>`;
}

function memoryRows(rows) {
  return rows.map((row) => `<div class="row"><div class="row-main"><div class="row-title">${esc(row.key)}</div><div class="row-sub">${esc(row.scope)} · ${esc((row.tags || []).join(", "))}</div></div><button class="small-btn" data-json='${esc(JSON.stringify(row))}'>View</button></div>`).join("") || '<div class="empty">No memory records</div>';
}

async function auditView() {
  const rows = await api("/operator/audit?limit=150");
  return `<div class="list">${rows.map((row) => `<div class="row"><div class="row-main"><div class="row-title">${esc(row.type)}</div><div class="row-sub">${esc(row.actor)} · ${esc(row.subject || "")} · ${esc(row.at || row.timestamp || "")}</div></div><button class="small-btn" data-json='${esc(JSON.stringify(row))}'>View</button></div>`).join("") || '<div class="empty">No audit rows</div>'}</div>`;
}

async function loadActivePolicy({ resetDraft = false } = {}) {
  const snapshot = await api("/operator/policy");
  policyState.loaded = true;
  policyState.active = snapshot.active;
  if (resetDraft || !policyState.draftText)
    policyState.draftText = JSON.stringify(snapshot.active, null, 2);
  return snapshot;
}

function policyResult() {
  if (policyState.error)
    return `<div class="policy-result error-box">${esc(policyState.error)}</div>`;
  if (policyState.result)
    return `<div class="policy-result"><div class="decision ${policyState.result.decision.allowed ? "allowed" : "denied"}">${policyState.result.decision.allowed ? "WOULD ALLOW" : "WOULD DENY"} · ${esc(policyState.result.decision.ruleId || "default fail-closed")}</div><div class="json">${esc(JSON.stringify(policyState.result, null, 2))}</div></div>`;
  if (policyState.validation)
    return `<div class="policy-result"><div class="decision allowed">DRAFT VALID · ${esc(policyState.validation.ruleCount)} rules</div><div class="muted">No active policy was changed.</div></div>`;
  return `<div class="policy-result muted">Validate the draft or run a simulated action. Nothing here changes the active runtime policy.</div>`;
}

async function policyView() {
  if (!policyState.loaded)
    await loadActivePolicy();
  return `<div class="policy-banner"><strong>DRAFT ONLY</strong><span>This editor cannot apply or reload policy. Validation and dry-run are side-effect free.</span></div>
    <div class="policy-grid">
      <div class="card policy-card">
        <div class="card-heading"><h3>Policy draft</h3><button id="policy-reset" class="small-btn">Reset from active</button></div>
        <textarea id="policy-draft" class="code-editor" spellcheck="false" aria-label="Policy draft JSON">${esc(policyState.draftText)}</textarea>
        <div class="actions"><button id="policy-validate" class="small-btn">Validate draft</button></div>
      </div>
      <div class="card policy-card">
        <h3>Simulated action</h3>
        <textarea id="policy-action" class="code-editor action-editor" spellcheck="false" aria-label="Simulated action JSON">${esc(policyState.actionText)}</textarea>
        <label class="field-label">Simulated repeatCount<input id="policy-repeat" class="number-input" type="number" min="1" step="1" value="${esc(policyState.repeatCount)}"></label>
        <div class="actions"><button id="policy-run" class="small-btn primary-inline">Run dry-run / explain</button></div>
        ${policyResult()}
      </div>
    </div>`;
}

async function render() {
  $("#view-title").textContent = currentView[0].toUpperCase() + currentView.slice(1);
  const content = $("#content");
  content.innerHTML = '<div class="empty">Loading…</div>';
  if (["overview", "tasks", "computers"].includes(currentView)) {
    overview = await api("/operator/overview");
    $("#audit-badge").textContent = overview.audit.ok ? `Audit ✓ ${overview.audit.count}` : "Audit !";
    $("#audit-badge").className = `badge ${overview.audit.ok ? "good" : "bad"}`;
  }
  if (currentView === "overview")
    content.innerHTML = overviewView();
  else if (currentView === "tasks")
    content.innerHTML = tasksView();
  else if (currentView === "computers")
    content.innerHTML = computersView();
  else if (currentView === "policy")
    content.innerHTML = await policyView();
  else if (currentView === "memory")
    content.innerHTML = await memoryView();
  else
    content.innerHTML = await auditView();
  bindContent();
}

function showJson(value, title = "Details") {
  $("#dialog-body").innerHTML = `<h3>${esc(title)}</h3><div class="json">${esc(JSON.stringify(value, null, 2))}</div>`;
  if (!$("#detail-dialog").open)
    $("#detail-dialog").showModal();
}

async function refreshTaskDialog() {
  if (!selectedTaskId || !$("#detail-dialog").open)
    return;
  const id = selectedTaskId;
  const value = {
    graph: await api(`/operator/tasks/${encodeURIComponent(id)}/graph`),
    events: await api(`/operator/tasks/${encodeURIComponent(id)}/events`),
  };
  if (selectedTaskId === id)
    showJson(value, "Task details");
}

function capturePolicyInputs() {
  if ($("#policy-draft"))
    policyState.draftText = $("#policy-draft").value;
  if ($("#policy-action"))
    policyState.actionText = $("#policy-action").value;
  if ($("#policy-repeat"))
    policyState.repeatCount = $("#policy-repeat").value;
}

function bindContent() {
  document.querySelectorAll("[data-task]").forEach((button) => {
    button.onclick = async () => {
      selectedTaskId = button.dataset.task;
      const id = selectedTaskId;
      const value = {
        graph: await api(`/operator/tasks/${encodeURIComponent(id)}/graph`),
        events: await api(`/operator/tasks/${encodeURIComponent(id)}/events`),
      };
      if (selectedTaskId === id)
        showJson(value, "Task details");
    };
  });
  document.querySelectorAll("[data-json]").forEach((button) => {
    button.onclick = () => showJson(JSON.parse(button.dataset.json));
  });
  document.querySelectorAll("[data-control]").forEach((button) => {
    button.onclick = async () => {
      await api(`/operator/computers/${encodeURIComponent(button.dataset.agent)}/control/${button.dataset.control}`, { method: "POST", body: { actorId: "operator-console" } });
      await render();
    };
  });
  document.querySelectorAll("[data-life]").forEach((button) => {
    button.onclick = async () => {
      if (button.dataset.life === "reset" && !confirm("Reset this browser session and profile state?"))
        return;
      await api(`/operator/computers/${encodeURIComponent(button.dataset.agent)}/lifecycle/${button.dataset.life}`, { method: "POST", body: { actorId: "operator-console" } });
      await render();
    };
  });
  document.querySelectorAll("[data-secret-form]").forEach((form) => {
    form.onsubmit = async (event) => {
      event.preventDefault();
      const input = form.elements.secret;
      const value = input.value;
      input.value = "";
      try {
        await api(`/operator/computers/${encodeURIComponent(form.dataset.agent)}/secrets/${encodeURIComponent(form.dataset.request)}/supply`, { method: "POST", body: { actorId: "operator-console", value } });
        await render();
      }
      finally {
        input.value = "";
      }
    };
  });
  $("#memory-search")?.addEventListener("click", async () => {
    $("#memory-results").innerHTML = memoryRows(await api(`/operator/memory?q=${encodeURIComponent($("#memory-q").value)}`));
    bindContent();
  });

  $("#policy-draft")?.addEventListener("input", capturePolicyInputs);
  $("#policy-action")?.addEventListener("input", capturePolicyInputs);
  $("#policy-repeat")?.addEventListener("input", capturePolicyInputs);
  $("#policy-reset")?.addEventListener("click", async () => {
    await loadActivePolicy({ resetDraft: true });
    policyState.validation = undefined;
    policyState.result = undefined;
    policyState.error = "";
    await render();
  });
  $("#policy-validate")?.addEventListener("click", async () => {
    capturePolicyInputs();
    policyState.validation = undefined;
    policyState.result = undefined;
    policyState.error = "";
    try {
      const policy = JSON.parse(policyState.draftText);
      policyState.validation = await api("/operator/policy/validate", { method: "POST", body: { policy } });
    }
    catch (error) {
      policyState.error = error.message;
    }
    await render();
  });
  $("#policy-run")?.addEventListener("click", async () => {
    capturePolicyInputs();
    policyState.validation = undefined;
    policyState.result = undefined;
    policyState.error = "";
    try {
      const policy = JSON.parse(policyState.draftText);
      const action = JSON.parse(policyState.actionText);
      const repeatCount = Number(policyState.repeatCount);
      policyState.result = await api("/operator/policy/dry-run", { method: "POST", body: { policy, action, repeatCount } });
    }
    catch (error) {
      policyState.error = error.message;
    }
    await render();
  });
}

function setLiveState(state, label) {
  const badge = $("#live-badge");
  if (!badge)
    return;
  badge.className = `badge live ${state}`;
  badge.textContent = `Live · ${label}`;
}

function stopTelemetry() {
  liveGeneration += 1;
  clearTimeout(liveReconnectTimer);
  clearTimeout(liveRefreshTimer);
  liveReconnectTimer = undefined;
  liveRefreshTimer = undefined;
  reconnectAttempt = 0;
  liveController?.abort();
  liveController = undefined;
}

function scheduleLiveRefresh(notification) {
  if (notification.source === "task" && notification.taskId && notification.taskId === selectedTaskId && $("#detail-dialog").open) {
    void refreshTaskDialog().catch(() => undefined);
  }

  // Do not rebuild Policy while the operator is typing. The in-memory draft remains entirely local
  // and telemetry cannot replace or reset it.
  if (currentView === "policy")
    return;

  const shouldRefresh =
    notification.source === "task"
    || (notification.source === "audit" && ["overview", "computers", "audit", "memory"].includes(currentView));
  if (!shouldRefresh)
    return;

  clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(() => {
    liveRefreshTimer = undefined;
    void render().catch(() => undefined);
  }, 180);
}

async function consumeTelemetry(response, generation) {
  const reader = response.body?.getReader();
  if (!reader)
    throw new Error("telemetry response body is unavailable");
  const decoder = new TextDecoder();
  let buffer = "";
  while (generation === liveGeneration) {
    const { done, value } = await reader.read();
    if (done)
      return "ended";
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0)
        break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line)
        continue;
      let notification;
      try {
        notification = JSON.parse(line);
      }
      catch {
        continue;
      }
      if (notification.source === "system" && notification.type === "connected") {
        reconnectAttempt = 0;
        setLiveState("connected", "Connected");
        continue;
      }
      if (notification.source === "system" && notification.type === "heartbeat") {
        setLiveState("connected", "Connected");
        continue;
      }
      if (notification.source === "system" && notification.type === "session-ended") {
        setLiveState("disconnected", "Session ended");
        return "session-ended";
      }
      scheduleLiveRefresh(notification);
    }
  }
  return "stopped";
}

function scheduleReconnect(generation) {
  if (!token || generation !== liveGeneration)
    return;
  reconnectAttempt += 1;
  const delay = Math.min(12_000, 750 * (2 ** Math.min(reconnectAttempt - 1, 4)));
  setLiveState("reconnecting", `Retrying in ${Math.ceil(delay / 1000)}s`);
  liveReconnectTimer = setTimeout(() => {
    liveReconnectTimer = undefined;
    if (generation === liveGeneration)
      void connectTelemetry();
  }, delay);
}

async function connectTelemetry() {
  if (!token)
    return;
  const generation = ++liveGeneration;
  clearTimeout(liveReconnectTimer);
  liveController?.abort();
  const controller = new AbortController();
  liveController = controller;
  setLiveState("reconnecting", "Connecting");

  try {
    const response = await fetch("/operator/stream", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
      cache: "no-store",
    });
    if (generation !== liveGeneration)
      return;
    if (response.status === 401 || response.status === 403) {
      setLiveState("disconnected", "Session ended");
      return;
    }
    if (!response.ok)
      throw new Error(`telemetry failed (${response.status})`);
    const outcome = await consumeTelemetry(response, generation);
    if (generation !== liveGeneration || outcome === "session-ended" || outcome === "stopped")
      return;
    scheduleReconnect(generation);
  }
  catch (error) {
    if (generation !== liveGeneration || controller.signal.aborted)
      return;
    scheduleReconnect(generation);
  }
}

$("#login-form").onsubmit = async (event) => {
  event.preventDefault();
  const candidate = $("#token").value.trim();
  $("#token").value = "";
  token = candidate;
  try {
    await api("/operator/session");
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    await render();
    void connectTelemetry();
  }
  catch (error) {
    token = "";
    $("#login-error").textContent = error.message;
  }
};

document.querySelectorAll("nav button").forEach((button) => {
  button.onclick = async () => {
    if (currentView === "policy")
      capturePolicyInputs();
    document.querySelectorAll("nav button").forEach((candidate) => candidate.classList.remove("active"));
    button.classList.add("active");
    currentView = button.dataset.view;
    await render();
  };
});

$("#refresh").onclick = () => render();
$("#logout").onclick = async () => {
  stopTelemetry();
  try {
    await api("/operator/session/revoke", { method: "POST", body: {} });
  }
  catch {
  }
  token = "";
  location.reload();
};
$("#dialog-close").onclick = () => {
  selectedTaskId = undefined;
  $("#detail-dialog").close();
};
