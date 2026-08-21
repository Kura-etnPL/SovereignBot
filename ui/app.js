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
  version: undefined,
  versions: [],
  recoveryPending: false,
  draftText: "",
  actionText: JSON.stringify({ category: "computer", operation: "navigate", agentId: "worker", target: "https://example.com/" }, null, 2),
  repeatCount: "1",
  label: "",
  validation: undefined,
  result: undefined,
  notice: "",
  error: "",
};

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));

async function api(path, options = {}) {
  const headers = { ...(options.body === undefined ? {} : { "content-type": "application/json" }), authorization: `Bearer ${token}` };
  const response = await fetch(path, { ...options, headers: { ...headers, ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function status(task) { return `<span class="status ${esc(task.status)}">${esc(task.status)}</span>`; }
function taskRow(task) { return `<div class="row"><div class="row-main"><div class="row-title">${esc(task.title)}</div><div class="row-sub">${esc(task.id)} · ${esc(task.assignedAgentId || task.ownerAgentId || "unassigned")}</div></div><div class="actions">${status(task)}<button class="small-btn" data-task="${esc(task.id)}">Inspect</button></div></div>`; }

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

function tasksView() { return `<div class="card full"><h3>All tasks</h3><div class="list">${(overview.tasks || []).slice().reverse().map(taskRow).join("") || '<div class="empty">No tasks</div>'}</div></div>`; }

function workerState(worker) {
  if (worker.inFlightHarnessCount > 0) return { label: "RUNNING", cls: "running" };
  if (worker.reviewCount > 0) return { label: "REVIEW", cls: "review" };
  if (worker.runnableQueuedCount > 0) return { label: "READY", cls: "ready" };
  return { label: "IDLE", cls: "idle" };
}

async function workersView() {
  const workers = await api("/operator/workers");
  return `<div class="grid">${workers.map((worker) => {
    const state = workerState(worker);
    const utilization = worker.maxConcurrency > 0 ? Math.min(100, Math.round((worker.inFlightHarnessCount / worker.maxConcurrency) * 100)) : 0;
    const active = worker.activeTaskIds.length
      ? worker.activeTaskIds.map((id) => `<button class="task-link" data-task="${esc(id)}">${esc(id)}</button>`).join("")
      : '<span class="muted">No active harness task</span>';
    return `<div class="card worker-card">
      <div class="worker-head"><div><h3>${esc(worker.name)}</h3><div class="row-sub">${esc(worker.id)} · ${esc(worker.harnessKind || "unknown")} · ${esc(worker.role)}</div></div><span class="worker-state ${state.cls}">${state.label}</span></div>
      <div class="worker-capacity"><strong>${worker.inFlightHarnessCount}/${worker.maxConcurrency}</strong><span>harness in-flight</span></div>
      <div class="capacity-track"><span style="width:${utilization}%"></span></div>
      <div class="worker-stats"><div><strong>${worker.remainingHarnessCapacity}</strong><span>capacity</span></div><div><strong>${worker.runnableQueuedCount}</strong><span>runnable</span></div><div><strong>${worker.compatibleQueuedCount}</strong><span>compatible queue</span></div><div><strong>${worker.reviewCount}</strong><span>review</span></div></div>
      <div class="worker-meta"><span>Resumable sessions: <strong>${worker.resumableSessionTaskCount}</strong></span>${worker.latestActivity ? `<span>Latest: ${esc(worker.latestActivity.type)} · ${esc(worker.latestActivity.at || "")}</span>` : '<span>No worker activity yet</span>'}</div>
      <div class="active-task-list"><span class="muted">Active task</span>${active}</div>
    </div>`;
  }).join("") || '<div class="card full empty">No workers configured</div>'}</div>`;
}

function lifecycleText(computer) {
  if (computer.lifecycle?.error) return computer.lifecycle.error;
  if (computer.lifecycle?.running === false) return "not started";
  if (computer.lifecycle?.instantiated) return "driver instantiated";
  if (computer.lifecycle?.managed) return "managed · passive state unknown";
  return "no managed driver";
}

function computersView() {
  return `<div class="grid">${(overview.computers || []).map((computer) => `<div class="card computer">
    <h3><span class="health-dot ${computer.lifecycle?.instantiated ? "ok" : ""}"></span> ${esc(computer.agentId)}</h3>
    <div class="row-sub">Control: ${esc(computer.control?.mode || "unknown")} · ${esc(lifecycleText(computer))}</div>
    <div class="actions" style="margin-top:12px"><button class="small-btn" data-control="take" data-agent="${esc(computer.agentId)}">Take control</button><button class="small-btn" data-control="release" data-agent="${esc(computer.agentId)}">Release</button><button class="small-btn" data-life="start" data-agent="${esc(computer.agentId)}">Start</button><button class="small-btn" data-life="stop" data-agent="${esc(computer.agentId)}">Stop</button><button class="small-btn warn" data-life="reset" data-agent="${esc(computer.agentId)}">Reset</button></div>
    ${computer.pendingSecret ? `<form class="secret-box" data-secret-form data-agent="${esc(computer.agentId)}" data-request="${esc(computer.pendingSecret.id)}" autocomplete="off"><strong>Secret requested: ${esc(computer.pendingSecret.label || "Secret")}</strong><div class="row-sub">Task ${esc(computer.pendingSecret.taskId)}</div><input name="secret" type="password" autocomplete="off" required placeholder="Enter value — never stored"><button class="small-btn" type="submit">Supply securely</button></form>` : ""}
  </div>`).join("") || '<div class="card full empty">No computers configured</div>'}</div>`;
}

async function memoryView() { const rows = await api("/operator/memory"); return `<div class="toolbar"><input id="memory-q" class="search" placeholder="Search memory"><button id="memory-search" class="small-btn">Search</button></div><div id="memory-results" class="list">${memoryRows(rows)}</div>`; }
function memoryRows(rows) { return rows.map((row) => `<div class="row"><div class="row-main"><div class="row-title">${esc(row.key)}</div><div class="row-sub">${esc(row.scope)} · ${esc((row.tags || []).join(", "))}</div></div><button class="small-btn" data-json='${esc(JSON.stringify(row))}'>View</button></div>`).join("") || '<div class="empty">No memory records</div>'; }
async function auditView() { const rows = await api("/operator/audit?limit=150"); return `<div class="list">${rows.map((row) => `<div class="row"><div class="row-main"><div class="row-title">${esc(row.type)}</div><div class="row-sub">${esc(row.actor)} · ${esc(row.subject || "")} · ${esc(row.at || row.timestamp || "")}</div></div><button class="small-btn" data-json='${esc(JSON.stringify(row))}'>View</button></div>`).join("") || '<div class="empty">No audit rows</div>'}</div>`; }

async function loadActivePolicy({ resetDraft = false } = {}) {
  const snapshot = await api("/operator/policy");
  policyState.loaded = true;
  policyState.active = snapshot.active;
  policyState.version = snapshot.version;
  policyState.versions = snapshot.versions || [];
  policyState.recoveryPending = Boolean(snapshot.recoveryPending);
  if (resetDraft || !policyState.draftText) policyState.draftText = JSON.stringify(snapshot.active, null, 2);
  return snapshot;
}

function policyResult() {
  if (policyState.error) return `<div class="policy-result error-box">${esc(policyState.error)}</div>`;
  if (policyState.notice) return `<div class="policy-result success-box">${esc(policyState.notice)}</div>`;
  if (policyState.result) return `<div class="policy-result"><div class="decision ${policyState.result.decision.allowed ? "allowed" : "denied"}">${policyState.result.decision.allowed ? "WOULD ALLOW" : "WOULD DENY"} · ${esc(policyState.result.decision.ruleId || "default fail-closed")}</div><div class="json">${esc(JSON.stringify(policyState.result, null, 2))}</div></div>`;
  if (policyState.validation) return `<div class="policy-result"><div class="decision allowed">DRAFT VALID · ${esc(policyState.validation.ruleCount)} rules</div><div class="muted">Validation does not change the active policy.</div></div>`;
  return `<div class="policy-result muted">Run a dry-run before Apply. The server will re-run the same expected decision inside the activation transaction.</div>`;
}

function policyHistory() {
  const rows = [...policyState.versions].reverse().map((version) => `<div class="version-row ${version.active ? "active" : ""}">
    <div class="version-main"><div class="version-title">${version.active ? '<span class="version-tag">ACTIVE</span>' : ""}${esc(version.label || version.source || "policy version")}</div><div class="row-sub">${esc(version.id)} · ${esc(String(version.hash || "").slice(0, 16))}… · ${esc(version.createdAt || "")}</div></div>
    <div class="actions"><button class="small-btn" data-policy-view="${esc(version.id)}">View</button>${version.active ? "" : `<button class="small-btn warn" data-policy-rollback="${esc(version.id)}">Rollback</button>`}</div>
  </div>`).join("");
  return rows || '<div class="empty">No policy versions</div>';
}

async function policyView() {
  if (!policyState.loaded) await loadActivePolicy();
  const recovery = policyState.recoveryPending ? `<div class="policy-banner danger"><strong>RECOVERY REQUIRED</strong><span>A committed policy activation could not clear its transaction marker. Restart/recover before another policy mutation.</span></div>` : "";
  return `${recovery}<div class="policy-banner"><strong>VERSIONED POLICY</strong><span>Draft/validate/dry-run are side-effect free. Apply and rollback are explicit audited authority changes.</span></div>
    <div class="card full policy-active"><div><h3>Active policy</h3><div class="version-title"><span class="version-tag">ACTIVE</span>${esc(policyState.version?.label || policyState.version?.source || "policy")}</div><div class="row-sub">${esc(policyState.version?.id || "")}</div><div class="row-sub">SHA-256 ${esc(policyState.version?.hash || "")}</div></div></div>
    <div class="policy-grid">
      <div class="card policy-card"><div class="card-heading"><h3>Policy draft</h3><button id="policy-reset" class="small-btn">Reset from active</button></div><textarea id="policy-draft" class="code-editor" spellcheck="false" aria-label="Policy draft JSON">${esc(policyState.draftText)}</textarea><label class="field-label">Version label<input id="policy-label" class="search" maxlength="160" value="${esc(policyState.label)}" placeholder="Why are you changing this policy?"></label><div class="actions"><button id="policy-validate" class="small-btn">Validate draft</button><button id="policy-apply" class="small-btn primary-inline" ${policyState.result && !policyState.recoveryPending ? "" : "disabled"}>Apply checked policy</button></div></div>
      <div class="card policy-card"><h3>Simulated action</h3><textarea id="policy-action" class="code-editor action-editor" spellcheck="false" aria-label="Simulated action JSON">${esc(policyState.actionText)}</textarea><label class="field-label">Simulated repeatCount<input id="policy-repeat" class="number-input" type="number" min="1" step="1" value="${esc(policyState.repeatCount)}"></label><div class="actions"><button id="policy-run" class="small-btn">Run dry-run / explain</button></div>${policyResult()}</div>
    </div>
    <div class="card full policy-history"><div class="card-heading"><h3>Immutable policy history</h3><span class="muted">Rollback re-activates a verified existing version</span></div><div class="version-list">${policyHistory()}</div></div>`;
}

async function render() {
  $("#view-title").textContent = currentView[0].toUpperCase() + currentView.slice(1);
  const content = $("#content"); content.innerHTML = '<div class="empty">Loading…</div>';
  if (["overview", "tasks", "computers"].includes(currentView)) {
    overview = await api("/operator/overview");
    $("#audit-badge").textContent = overview.audit.ok ? `Audit ✓ ${overview.audit.count}` : "Audit !";
    $("#audit-badge").className = `badge ${overview.audit.ok ? "good" : "bad"}`;
  }
  if (currentView === "overview") content.innerHTML = overviewView();
  else if (currentView === "tasks") content.innerHTML = tasksView();
  else if (currentView === "workers") content.innerHTML = await workersView();
  else if (currentView === "computers") content.innerHTML = computersView();
  else if (currentView === "policy") content.innerHTML = await policyView();
  else if (currentView === "memory") content.innerHTML = await memoryView();
  else content.innerHTML = await auditView();
  bindContent();
}

function showJson(value, title = "Details") { $("#dialog-body").innerHTML = `<h3>${esc(title)}</h3><div class="json">${esc(JSON.stringify(value, null, 2))}</div>`; if (!$("#detail-dialog").open) $("#detail-dialog").showModal(); }
async function refreshTaskDialog() { if (!selectedTaskId || !$("#detail-dialog").open) return; const id = selectedTaskId; const value = { graph: await api(`/operator/tasks/${encodeURIComponent(id)}/graph`), events: await api(`/operator/tasks/${encodeURIComponent(id)}/events`) }; if (selectedTaskId === id) showJson(value, "Task details"); }
function capturePolicyInputs() { if ($("#policy-draft")) policyState.draftText = $("#policy-draft").value; if ($("#policy-action")) policyState.actionText = $("#policy-action").value; if ($("#policy-repeat")) policyState.repeatCount = $("#policy-repeat").value; if ($("#policy-label")) policyState.label = $("#policy-label").value; }
function clearPolicyFeedback({ keepValidation = false } = {}) { if (!keepValidation) policyState.validation = undefined; policyState.result = undefined; policyState.notice = ""; policyState.error = ""; }

function bindContent() {
  document.querySelectorAll("[data-task]").forEach((button) => { button.onclick = async () => { selectedTaskId = button.dataset.task; const id = selectedTaskId; const value = { graph: await api(`/operator/tasks/${encodeURIComponent(id)}/graph`), events: await api(`/operator/tasks/${encodeURIComponent(id)}/events`) }; if (selectedTaskId === id) showJson(value, "Task details"); }; });
  document.querySelectorAll("[data-json]").forEach((button) => { button.onclick = () => showJson(JSON.parse(button.dataset.json)); });
  document.querySelectorAll("[data-control]").forEach((button) => { button.onclick = async () => { await api(`/operator/computers/${encodeURIComponent(button.dataset.agent)}/control/${button.dataset.control}`, { method: "POST", body: { actorId: "operator-console" } }); await render(); }; });
  document.querySelectorAll("[data-life]").forEach((button) => { button.onclick = async () => { if (button.dataset.life === "reset" && !confirm("Reset this browser session and profile state?")) return; await api(`/operator/computers/${encodeURIComponent(button.dataset.agent)}/lifecycle/${button.dataset.life}`, { method: "POST", body: { actorId: "operator-console" } }); await render(); }; });
  document.querySelectorAll("[data-secret-form]").forEach((form) => { form.onsubmit = async (event) => { event.preventDefault(); const input = form.elements.secret; const value = input.value; input.value = ""; try { await api(`/operator/computers/${encodeURIComponent(form.dataset.agent)}/secrets/${encodeURIComponent(form.dataset.request)}/supply`, { method: "POST", body: { actorId: "operator-console", value } }); await render(); } finally { input.value = ""; } }; });
  $("#memory-search")?.addEventListener("click", async () => { $("#memory-results").innerHTML = memoryRows(await api(`/operator/memory?q=${encodeURIComponent($("#memory-q").value)}`)); bindContent(); });

  $("#policy-draft")?.addEventListener("input", () => { capturePolicyInputs(); clearPolicyFeedback(); });
  $("#policy-action")?.addEventListener("input", () => { capturePolicyInputs(); clearPolicyFeedback({ keepValidation: true }); });
  $("#policy-repeat")?.addEventListener("input", () => { capturePolicyInputs(); clearPolicyFeedback({ keepValidation: true }); });
  $("#policy-label")?.addEventListener("input", capturePolicyInputs);
  $("#policy-reset")?.addEventListener("click", async () => { await loadActivePolicy({ resetDraft: true }); clearPolicyFeedback(); policyState.label = ""; await render(); });
  $("#policy-validate")?.addEventListener("click", async () => { capturePolicyInputs(); clearPolicyFeedback(); try { const policy = JSON.parse(policyState.draftText); policyState.validation = await api("/operator/policy/validate", { method: "POST", body: { policy } }); } catch (error) { policyState.error = error.message; } await render(); });
  $("#policy-run")?.addEventListener("click", async () => { capturePolicyInputs(); clearPolicyFeedback({ keepValidation: true }); try { const policy = JSON.parse(policyState.draftText); const action = JSON.parse(policyState.actionText); const repeatCount = Number(policyState.repeatCount); policyState.result = await api("/operator/policy/dry-run", { method: "POST", body: { policy, action, repeatCount } }); } catch (error) { policyState.error = error.message; } await render(); });
  $("#policy-apply")?.addEventListener("click", async () => {
    capturePolicyInputs();
    if (!policyState.result) { policyState.error = "Run a dry-run on the current draft/action before Apply."; await render(); return; }
    if (!confirm(`Apply this policy as a new immutable version?\n\nCurrent: ${policyState.version?.id || "unknown"}\nDecision check: ${policyState.result.decision.allowed ? "ALLOW" : "DENY"} via ${policyState.result.decision.ruleId || "default"}`)) return;
    try {
      const policy = JSON.parse(policyState.draftText);
      const action = JSON.parse(policyState.actionText);
      const repeatCount = Number(policyState.repeatCount);
      const expected = { allowed: Boolean(policyState.result.decision.allowed) };
      if (policyState.result.decision.ruleId !== undefined) expected.ruleId = policyState.result.decision.ruleId;
      const applied = await api("/operator/policy/apply", { method: "POST", body: { policy, label: policyState.label, checks: [{ action, repeatCount, expect: expected }] } });
      await loadActivePolicy({ resetDraft: true });
      clearPolicyFeedback();
      policyState.label = "";
      policyState.notice = applied.noChange ? "Draft matches the active policy; no new version was created." : `Policy activated: ${applied.active.id}${applied.recoveryPending ? " · restart recovery pending" : ""}`;
    } catch (error) { policyState.error = error.message; }
    await render();
  });
  document.querySelectorAll("[data-policy-view]").forEach((button) => { button.onclick = async () => { try { showJson(await api(`/operator/policy/versions/${encodeURIComponent(button.dataset.policyView)}`), "Policy version"); } catch (error) { policyState.error = error.message; await render(); } }; });
  document.querySelectorAll("[data-policy-rollback]").forEach((button) => { button.onclick = async () => {
    const versionId = button.dataset.policyRollback;
    if (!confirm(`Rollback the active policy to verified version ${versionId}?\n\nThis changes future Governor decisions and will be audited.`)) return;
    try {
      const rolled = await api("/operator/policy/rollback", { method: "POST", body: { versionId } });
      await loadActivePolicy({ resetDraft: true });
      clearPolicyFeedback();
      policyState.label = "";
      policyState.notice = rolled.noChange ? "That policy version is already active." : `Rolled back to ${rolled.active.id}`;
    } catch (error) { policyState.error = error.message; }
    await render();
  }; });
}

function setLiveState(state, label) { const badge = $("#live-badge"); if (!badge) return; badge.className = `badge live ${state}`; badge.textContent = `Live · ${label}`; }
function stopTelemetry() { liveGeneration += 1; clearTimeout(liveReconnectTimer); clearTimeout(liveRefreshTimer); liveReconnectTimer = undefined; liveRefreshTimer = undefined; reconnectAttempt = 0; liveController?.abort(); liveController = undefined; }

function scheduleLiveRefresh(notification) {
  if (notification.source === "task" && notification.taskId && notification.taskId === selectedTaskId && $("#detail-dialog").open) void refreshTaskDialog().catch(() => undefined);
  if (currentView === "policy") return;
  const taskRefresh = notification.source === "task" && ["overview", "tasks", "workers", "memory"].includes(currentView);
  const workerRefresh = notification.source === "worker" && ["overview", "workers"].includes(currentView);
  const auditRefresh = notification.source === "audit" && ["overview", "computers", "audit", "memory"].includes(currentView);
  if (!taskRefresh && !workerRefresh && !auditRefresh) return;
  clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(() => { liveRefreshTimer = undefined; void render().catch(() => undefined); }, 180);
}

async function consumeTelemetry(response, generation) {
  const reader = response.body?.getReader(); if (!reader) throw new Error("telemetry response body is unavailable");
  const decoder = new TextDecoder(); let buffer = "";
  while (generation === liveGeneration) {
    const { done, value } = await reader.read(); if (done) return "ended"; buffer += decoder.decode(value, { stream: true });
    while (true) {
      const newline = buffer.indexOf("\n"); if (newline < 0) break; const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (!line) continue;
      let notification; try { notification = JSON.parse(line); } catch { continue; }
      if (notification.source === "system" && notification.type === "connected") { reconnectAttempt = 0; setLiveState("connected", "Connected"); continue; }
      if (notification.source === "system" && notification.type === "heartbeat") { setLiveState("connected", "Connected"); continue; }
      if (notification.source === "system" && notification.type === "session-ended") { setLiveState("disconnected", "Session ended"); return "session-ended"; }
      scheduleLiveRefresh(notification);
    }
  }
  return "stopped";
}

function scheduleReconnect(generation) { if (!token || generation !== liveGeneration) return; reconnectAttempt += 1; const delay = Math.min(12_000, 750 * (2 ** Math.min(reconnectAttempt - 1, 4))); setLiveState("reconnecting", `Retrying in ${Math.ceil(delay / 1000)}s`); liveReconnectTimer = setTimeout(() => { liveReconnectTimer = undefined; if (generation === liveGeneration) void connectTelemetry(); }, delay); }
async function connectTelemetry() {
  if (!token) return; const generation = ++liveGeneration; clearTimeout(liveReconnectTimer); liveController?.abort(); const controller = new AbortController(); liveController = controller; setLiveState("reconnecting", "Connecting");
  try {
    const response = await fetch("/operator/stream", { method: "GET", headers: { authorization: `Bearer ${token}` }, signal: controller.signal, cache: "no-store" });
    if (generation !== liveGeneration) return;
    if (response.status === 401 || response.status === 403) { setLiveState("disconnected", "Session ended"); return; }
    if (!response.ok) throw new Error(`telemetry failed (${response.status})`);
    const outcome = await consumeTelemetry(response, generation); if (generation !== liveGeneration || outcome === "session-ended" || outcome === "stopped") return; scheduleReconnect(generation);
  } catch (error) { if (generation !== liveGeneration || controller.signal.aborted) return; scheduleReconnect(generation); }
}

$("#login-form").onsubmit = async (event) => { event.preventDefault(); const candidate = $("#token").value.trim(); $("#token").value = ""; token = candidate; try { await api("/operator/session"); $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); await render(); void connectTelemetry(); } catch (error) { token = ""; $("#login-error").textContent = error.message; } };
document.querySelectorAll("nav button").forEach((button) => { button.onclick = async () => { if (currentView === "policy") capturePolicyInputs(); document.querySelectorAll("nav button").forEach((candidate) => candidate.classList.remove("active")); button.classList.add("active"); currentView = button.dataset.view; await render(); }; });
$("#refresh").onclick = async () => { if (currentView === "policy") { capturePolicyInputs(); await loadActivePolicy({ resetDraft: false }); } await render(); };
$("#logout").onclick = async () => { stopTelemetry(); try { await api("/operator/session/revoke", { method: "POST", body: {} }); } catch {} token = ""; location.reload(); };
$("#dialog-close").onclick = () => { selectedTaskId = undefined; $("#detail-dialog").close(); };
