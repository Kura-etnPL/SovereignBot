"use strict";
(() => {
  const I18n = () => globalThis.SovereignI18n;
  const $ = (id) => document.getElementById(id);
  function t(key, fallback) { try { return I18n()?.t(key) ?? fallback ?? key; } catch { return fallback ?? key; } }
  const ROUTINE_TEMPLATES = Object.freeze({
    research: Object.freeze({ name: "Daily research brief", description: "Collect a concise evidence-backed research brief for the team's current priorities.", type: "daily" }),
    review: Object.freeze({ name: "Weekly review", description: "Review completed work, open attention items, and the next bounded priorities.", type: "weekly" }),
    operations: Object.freeze({ name: "Daily operations check", description: "Check the team's bounded operational status and report concrete follow-up items.", type: "daily" }),
    content: Object.freeze({ name: "Content publishing prep", description: "Prepare the next content publishing package, flag missing inputs, and return the draft checklist.", type: "weekly" }),
  });

  let jobs = [];
  let attentionJobs = [];
  let attentionPollTimer;
  let attentionRequest = 0;
  let currentJobId;
  let pollTimer;
  let routines = [];
  let routinePollTimer;
  let currentRoutineId;
  const routineActionPending = new Set();
  const routineActionFeedback = new Map();
  let routineRemoveCandidate;
  let workerNodes = [];
  let computerTargets = [];
  let coworkerLabels = new Map();
  let workspaceLabels = new Map();
  let identityRequest = 0;
  let jobDetailRequest = 0;
  const jobActionState = new Map();
  const ATTENTION_CATEGORIES = Object.freeze([
    ["login-required", "Login required / 需要登录"],
    ["secret-required", "Secret required / 需要密钥"],
    ["approval-required", "Approval required / 需要审批"],
    ["provider-unavailable", "Provider unavailable / 提供方不可用"],
    ["computer-takeover", "Computer takeover / 电脑接管"],
    ["dangerous-action", "Dangerous action / 危险操作"],
    ["real-blocker", "Real blocker / 实际阻塞"],
  ]);
  const ATTENTION_CATEGORY_LABELS = Object.freeze(Object.fromEntries(ATTENTION_CATEGORIES));
  const SNOOZE_OPTIONS = Object.freeze([[15, "15 min / 15 分钟"], [60, "1 hour / 1 小时"], [240, "4 hours / 4 小时"], [1440, "1 day / 1 天"]]);
  let attentionActiveCount = 0;

  function attentionActionAllowed(job, action) {
    const actions = job?.attentionState?.actions;
    return Array.isArray(actions) && actions.includes(action);
  }
  function attentionCategoryLabel(category) { return ATTENTION_CATEGORY_LABELS[category] ?? ATTENTION_CATEGORY_LABELS["real-blocker"]; }
  function selectedSnoozeMinutes() {
    const value = Number($("attention-snooze-duration")?.value ?? 60);
    return SNOOZE_OPTIONS.some(([minutes]) => minutes === value) ? value : 60;
  }
  function openAttentionDestination(action) {
    if (action === "open-settings") { $("nav-settings")?.click(); return; }
    if (action === "open-this-pc") { $("nav-this-pc")?.click(); return; }
  }
  function attentionButton(label, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function statusClass(s) { return `job-status ${s}`; }
  function statusLabel(s) { return t(`work.status.${s}`, s); }

  function actionState(jobId) {
    let state = jobActionState.get(jobId);
    if (!state) { state = { pending: new Set(), feedback: "", error: false }; jobActionState.set(jobId, state); }
    return state;
  }
  function safePublicText(value, fallback = "—", limit = 240) {
    const text = String(value ?? "").trim();
    if (!text || /(?:provider\s+session|credential|session(?:Id)?|raw\s+path|workspace\s+path|access\s+token)/i.test(text)) return fallback;
    return text.replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|private|mnt)\/)[^\s]*/gi, "[local detail]").slice(0, limit) || fallback;
  }
  function safeLabel(value, fallback) {
    const text = String(value ?? "").trim();
    return text && !/[\\/]/.test(text) ? safePublicText(text, fallback, 120) : fallback;
  }
  function ownerLabel(job) {
    const owner = coworkerLabels.get(job?.ownerCoworkerId);
    if (!owner) return "Assigned Coworker / 已分配同事";
    const name = I18n()?.displayCoworkerName?.(owner.name) ?? owner.name;
    return `${safeLabel(name, "Coworker")} · ${safeLabel(owner.role, "Coworker")}`;
  }
  function workspaceLabel(job) {
    const executionKind = job?.executionTarget?.kind;
    if (["worker-node", "worker-computer"].includes(executionKind)) {
      return `Worker Node: ${safeLabel(job.workerNodeName, "Worker Node")} · Worker workspace: ${safeLabel(job.workerWorkspaceName, "Worker workspace")}`;
    }
    const workspace = workspaceLabels.get(job?.workspaceId);
    if (workspace) return `Workspace: ${safeLabel(workspace.label, "Trusted workspace")} · ${workspace.kind === "shared-project" ? "Shared project workspace" : "Trusted workspace"}`;
    return executionKind === "local" || !job?.workspaceId ? "This PC / 此电脑" : "Trusted workspace / 受信工作区";
  }
  function jobMeta(job) {
    const priority = safePublicText(job?.priority, "normal", 40);
    const next = job?.nextActionAt ? ` · next ${new Date(job.nextActionAt).toLocaleString()}` : "";
    const error = job?.error ? ` · ${safePublicText(job.error, "Job attention requires review.", 160)}` : "";
    return `${ownerLabel(job)} · ${priority} · ${workspaceLabel(job)}${next}${error}`;
  }
  function feedbackNode(jobId) {
    const state = actionState(jobId);
    const node = document.createElement("p");
    node.className = `job-action-feedback${state.error ? " error" : ""}${state.feedback ? "" : " hidden"}`;
    node.dataset.jobFeedback = jobId;
    node.setAttribute("role", "status");
    node.textContent = state.feedback;
    return node;
  }
  function jobActionPending(jobId) { return actionState(jobId).pending.size > 0; }
  function syncJobDetailActionState() {
    if (!currentJobId) return;
    const state = actionState(currentJobId);
    for (const button of document.querySelectorAll("[data-job-detail-action]")) button.disabled = state.pending.size > 0;
  }
  function renderJobSurfaces() {
    renderList();
    renderAttentionList();
    syncJobDetailActionState();
  }
  async function refreshPublicLabels() {
    const request = ++identityRequest;
    const [coworkers, workspaces] = await Promise.all([
      window.sovereignbot.coworkers?.list ? window.sovereignbot.coworkers.list({}) : Promise.resolve({ coworkers: [] }),
      window.sovereignbot.workspaces?.list ? window.sovereignbot.workspaces.list({}) : Promise.resolve({ workspaces: [] }),
    ]);
    if (request !== identityRequest) return;
    coworkerLabels = new Map((coworkers?.coworkers ?? []).map((entry) => [entry.id, { name: entry.name, role: entry.role }]));
    workspaceLabels = new Map((workspaces?.workspaces ?? []).map((entry) => [entry.id, { label: entry.label, kind: entry.kind }]));
  }
  async function runJobAction(jobId, action, invoke, successMessage = "Job action completed.") {
    const state = actionState(jobId);
    if (state.pending.has(action)) return;
    state.pending.add(action);
    state.feedback = "";
    state.error = false;
    renderJobSurfaces();
    try {
      await invoke();
      state.feedback = successMessage;
    } catch (error) {
      state.error = true;
      state.feedback = `Action failed: ${safePublicText(error?.message ?? error, "Job action failed.", 320)}`;
    } finally {
      state.pending.delete(action);
      try { await refresh(); } catch {}
      renderJobSurfaces();
      if (currentJobId === jobId && $("job-detail-dialog")?.open) await openDetail(jobId);
    }
  }
  function jobActionButton(job, action, label, className, invoke, successMessage) {
    const button = attentionButton(label, className, () => { void runJobAction(job.id, action, invoke, successMessage); });
    button.dataset.jobId = job.id;
    button.dataset.jobAction = action;
    button.disabled = jobActionPending(job.id);
    return button;
  }

  function ensureExecutionTargetSurface() {
    if ($("job-execution") || !$("job-form-error")) return;
    const makeLabel = (caption, control) => { const label = document.createElement("label"); label.textContent = caption; label.append(control); return label; };
    const execution = document.createElement("select"); execution.id = "job-execution";
    for (const [value, caption] of [["local", "This PC / 此电脑"], ["worker-node", "Paired Worker Node / 已配对工作节点"], ["worker-computer", "Worker Computer / 工作电脑"], ["vm", "VM Computer / 虚拟机电脑"], ["local-isolated", "Local Isolated / 本机隔离"], ["cloud", "Cloud Computer / 云电脑"]]) { const option = document.createElement("option"); option.value = value; option.textContent = caption; execution.append(option); }
    const node = document.createElement("select"); node.id = "job-node";
    const workspace = document.createElement("select"); workspace.id = "job-node-workspace";
    const computer = document.createElement("select"); computer.id = "job-computer";
    const profile = document.createElement("select"); profile.id = "job-computer-profile";
    const isolatedWorkspace = document.createElement("select"); isolatedWorkspace.id = "job-computer-workspace";
    const optIn = document.createElement("input"); optIn.id = "job-cloud-optin"; optIn.type = "checkbox";
    const nodeFields = document.createElement("div"); nodeFields.id = "job-node-fields"; nodeFields.className = "hidden";
    nodeFields.append(makeLabel("Worker Node", node), makeLabel("Node workspace", workspace), makeLabel("Computer target", computer));
    const profileFields = document.createElement("div"); profileFields.id = "job-profile-fields"; profileFields.className = "hidden";
    profileFields.append(makeLabel("Computer profile", profile), makeLabel("Trusted workspace", isolatedWorkspace), makeLabel("Cloud cost opt-in", optIn));
    $("job-form-error").before(makeLabel("Execution", execution), nodeFields, profileFields);
  }

  function renderList() {
    const root = $("work-list");
    if (!root) return;
    root.textContent = "";
    if (!jobs.length) {
      const p = document.createElement("p");
      p.className = "setting-feedback";
      p.textContent = t("work.empty", "No jobs yet.");
      root.append(p);
      return;
    }
    for (const job of jobs) {
      const card = document.createElement("div");
      card.className = "job-card";
      card.dataset.jobId = job.id;
      const head = document.createElement("div");
      head.className = "job-card-head";
      const title = document.createElement("strong");
      title.textContent = job.title;
      title.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%";
      const badge = document.createElement("span");
      badge.className = statusClass(job.status);
      badge.textContent = statusLabel(job.status);
      head.append(title, badge);
      const meta = document.createElement("div");
      meta.className = "setting-feedback";
      meta.style.margin = "0";
       meta.textContent = jobMeta(job);
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
      const openBtn = document.createElement("button");
      openBtn.type = "button"; openBtn.className = "quiet-action"; openBtn.textContent = t("action.open", "Open");
      openBtn.addEventListener("click", () => openDetail(job.id));
      if (job.status !== "needs_attention" || attentionActionAllowed(job, "open")) actions.append(openBtn);
      if (job.status === "needs_attention") {
        if (attentionActionAllowed(job, "open-settings")) actions.append(attentionButton("Open settings / 打开设置", "quiet-action", () => openAttentionDestination("open-settings")));
        if (attentionActionAllowed(job, "open-this-pc")) actions.append(attentionButton("Open This PC / 打开此电脑", "quiet-action", () => openAttentionDestination("open-this-pc")));
         if (attentionActionAllowed(job, "retry")) actions.append(jobActionButton(job, "retry", t("attention.retry", "Retry"), "hero-action", () => window.sovereignbot.jobs.approve({ jobId: job.id }), "Retry requested."));
        if (attentionActionAllowed(job, "snooze")) actions.append(attentionButton(t("attention.snooze", "Snooze"), "quiet-action", async () => { await window.sovereignbot.jobs.snooze({ jobId: job.id, minutes: selectedSnoozeMinutes() }); await refresh(); }));
         if (attentionActionAllowed(job, "dismiss")) actions.append(jobActionButton(job, "dismiss", "Dismiss attention / 消退关注", "quiet-action", () => window.sovereignbot.jobs.dismiss({ jobId: job.id }), "Attention dismissed."));
       }
       card.append(head, meta, feedbackNode(job.id), actions);
      root.append(card);
    }
  }

  function updateAttentionBadge() {
    const badge = $("attention-badge");
    if (!badge) return;
    const n = attentionActiveCount;
    badge.textContent = String(n);
    badge.classList.toggle("hidden", n === 0);
  }

  function attentionTime(job) {
    return job.attentionState?.at ?? job.updatedAt ?? job.createdAt;
  }

  function renderAttentionList() {
    const root = $("attention-list");
    if (!root) return;
    root.textContent = "";
    if (!attentionJobs.length) {
      const p = document.createElement("p");
      p.className = "setting-feedback";
      p.textContent = $("attention-visibility-filter")?.value === "snoozed"
        ? t("attention.emptySnoozed", "No snoozed attention items.")
        : t("attention.empty", "Nothing needs your attention.");
      root.append(p);
      return;
    }
    const displayValue = (value) => {
      const span = document.createElement("span");
      span.textContent = value;
      return span;
    };
    const detailRow = (label, value) => {
      const row = document.createElement("div");
      row.className = "setting-feedback";
      row.style.margin = "0";
      const strong = document.createElement("strong");
      strong.textContent = `${label}: `;
      row.append(strong, displayValue(value));
      return row;
    };
    for (const job of attentionJobs) {
      const card = document.createElement("div");
      card.className = "job-card";
      card.dataset.jobId = job.id;
      const head = document.createElement("div");
      head.className = "job-card-head";
      const title = document.createElement("strong");
      title.textContent = job.title;
      title.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:68%";
      const status = document.createElement("span");
      status.className = statusClass(job.status);
      status.textContent = statusLabel(job.status);
      head.append(title, status);
      const category = document.createElement("span");
      category.className = "job-status attention-category";
      category.textContent = attentionCategoryLabel(job.attentionState?.category);
      head.append(category);
      const reason = job.attentionState?.reason || job.error || job.outcomeSummary || "—";
       const owner = ownerLabel(job);
      const priority = t(`attention.priority.${job.priority}`, job.priority ?? "normal");
      const source = job.routineId ? t("attention.source.routine", "Routine") : t("attention.source.job", "Job");
      const raisedAt = attentionTime(job);
      const raised = raisedAt ? new Date(raisedAt).toLocaleString() : "—";
      const details = document.createElement("div");
      details.style.cssText = "display:grid;gap:4px";
      details.append(
        detailRow(t("attention.reason", "Reason"), reason),
        detailRow(t("attention.owner", "Coworker"), owner),
        detailRow(t("attention.priority", "Priority"), priority),
        detailRow(t("attention.source", "Source"), source),
        detailRow(t("attention.raised", "Raised"), raised),
        ...(job.attentionState?.snoozedUntil ? [detailRow(t("attention.snoozedUntil", "Snoozed until"), new Date(job.attentionState.snoozedUntil).toLocaleString())] : []),
      );
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
      if (attentionActionAllowed(job, "open")) actions.append(attentionButton(t("attention.openJob", "Open job"), "quiet-action", () => { void openDetail(job.id); }));
      if (attentionActionAllowed(job, "open-settings")) actions.append(attentionButton(t("attention.openSettings", "Open settings"), "quiet-action", () => openAttentionDestination("open-settings")));
      if (attentionActionAllowed(job, "open-this-pc")) actions.append(attentionButton(t("attention.openThisPc", "Open This PC"), "quiet-action", () => openAttentionDestination("open-this-pc")));
      if (attentionActionAllowed(job, "retry")) {
         const retry = jobActionButton(job, "retry", t("attention.retry", "Retry"), "hero-action", () => window.sovereignbot.jobs.approve({ jobId: job.id }), "Retry requested.");
        actions.append(retry);
      }
      if (attentionActionAllowed(job, "snooze")) {
         const snooze = jobActionButton(job, "snooze", `${t("attention.snooze", "Snooze")} · ${$("attention-snooze-duration")?.selectedOptions?.[0]?.textContent ?? "1 hour"}`, "quiet-action", () => window.sovereignbot.jobs.snooze({ jobId: job.id, minutes: selectedSnoozeMinutes() }), "Attention snoozed.");
        actions.append(snooze);
      }
      if (attentionActionAllowed(job, "dismiss")) {
         const dismiss = jobActionButton(job, "dismiss", "Dismiss attention / 消退关注", "quiet-action", () => window.sovereignbot.jobs.dismiss({ jobId: job.id }), "Attention dismissed.");
        actions.append(dismiss);
      }
       card.append(head, details, feedbackNode(job.id), actions);
      root.append(card);
    }
  }

  async function refresh() {
    try { await refreshPublicLabels(); } catch { coworkerLabels = new Map(); workspaceLabels = new Map(); }
    try {
      const res = await window.sovereignbot.jobs.list({});
      jobs = res?.jobs ?? [];
      renderList();
    } catch {}
    await refreshAttention();
  }

  async function populateExecutionTargetForm() {
    const execution = $("job-execution");
    const node = $("job-node");
    const workspace = $("job-node-workspace");
    if (!execution || !node || !workspace) return;
    try { workerNodes = (await window.sovereignbot.workerNodes.list({})).nodes ?? []; } catch { workerNodes = []; }
    try { computerTargets = (await window.sovereignbot.computerTargets.list({})).targets ?? []; } catch { computerTargets = []; }
    node.textContent = "";
    for (const entry of workerNodes.filter((item) => item.enabled && item.status === "online")) {
      const option = document.createElement("option");
      option.value = entry.nodeId;
      option.textContent = safeLabel(entry.name, "Worker Node");
      node.append(option);
    }
    workspace.textContent = "";
    const selected = workerNodes.find((entry) => entry.nodeId === node.value);
    for (const entry of selected?.workspaces ?? []) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = safeLabel(entry.name, "Worker workspace");
      workspace.append(option);
    }
    const profile = $("job-computer-profile");
    if (profile) {
      profile.textContent = "";
      for (const entry of computerTargets.filter((item) => ["local-isolated", "vm", "cloud"].includes(item.kind))) {
        const option = document.createElement("option"); option.value = entry.id; option.textContent = `${safeLabel(entry.name ?? entry.kind, "Computer profile")} · ${safeLabel(entry.state, "available")}`; profile.append(option);
      }
    }
    const isolatedWorkspace = $("job-computer-workspace");
    if (isolatedWorkspace) {
      let workspaces = [];
      try { workspaces = (await window.sovereignbot.workspaces.list({})).workspaces ?? []; } catch {}
      isolatedWorkspace.textContent = "";
      for (const entry of workspaces) { const option = document.createElement("option"); option.value = entry.id; option.textContent = `${safeLabel(entry.label ?? entry.name, "Trusted workspace")} · ${entry.kind === "shared-project" ? "Shared project workspace" : "Trusted workspace"}`; isolatedWorkspace.append(option); }
    }
    execution.dispatchEvent(new Event("change"));
  }

  async function refreshAttention() {
    const request = ++attentionRequest;
    try {
      const category = $("attention-category-filter")?.value ?? "all";
      const visibility = $("attention-visibility-filter")?.value ?? "active";
      const res = await window.sovereignbot.jobs.attention({ category, visibility });
      if (request !== attentionRequest) return;
      attentionJobs = res?.jobs ?? [];
      attentionActiveCount = Number.isInteger(res?.activeCount) ? res.activeCount : visibility === "active" ? attentionJobs.length : 0;
      const errorEl = $("attention-error");
      errorEl?.classList.add("hidden");
      renderAttentionList();
      updateAttentionBadge();
    } catch {}
  }

  async function openDetail(jobId) {
    currentJobId = jobId;
    const request = ++jobDetailRequest;
    try {
      try { await refreshPublicLabels(); } catch {}
      const job = await window.sovereignbot.jobs.getStatus({ jobId });
      const conv = await window.sovereignbot.jobs.getConversation({ jobId }).catch(() => ({ messages: [] }));
      if (request !== jobDetailRequest || currentJobId !== jobId) return;
      $("job-detail-title").textContent = job.title;
      $("job-detail-meta").textContent = `${statusLabel(job.status)} · ${jobMeta(job)}${job.outcomeSummary ? ` · ${safePublicText(job.outcomeSummary, "Job outcome unavailable.", 200)}` : ""}`;
      const feedback = $("job-detail-feedback");
      const state = actionState(jobId);
      if (feedback) { feedback.textContent = state.feedback; feedback.classList.toggle("hidden", !state.feedback); feedback.classList.toggle("error", state.error); }
      const body = $("job-detail-body");
      const msgs = conv.messages ?? [];
      body.textContent = msgs.length ? msgs.map(m => `[${safePublicText(m.kind ?? m.role, "update", 40)}] ${safePublicText(m.text, "Job update unavailable.", 1000)}`).join("\n\n") : safePublicText(job.outcomeSummary ?? job.error, "Job update unavailable.", 1000);
      const needs = job.status === "needs_attention";
      const waiting = job.status === "waiting";
      const canRetry = needs && attentionActionAllowed(job, "retry");
      const canDismiss = needs && attentionActionAllowed(job, "dismiss");
      const approve = $("job-detail-approve");
      if (approve) approve.textContent = t("attention.retry", "Retry");
      const dismiss = $("job-detail-dismiss");
      if (dismiss) dismiss.textContent = "Dismiss attention / 消退关注";
      $("job-detail-approve")?.classList.toggle("hidden", !canRetry);
      $("job-detail-dismiss")?.classList.toggle("hidden", !canDismiss);
      $("job-detail-pause")?.classList.toggle("hidden", waiting || needs || ["completed","failed","cancelled"].includes(job.status));
      $("job-detail-resume")?.classList.toggle("hidden", !waiting);
      if ($("job-detail-resume")) $("job-detail-resume").textContent = t("action.resume", "Resume");
      if (!$("job-detail-dialog")?.open) $("job-detail-dialog")?.showModal?.();
      syncJobDetailActionState();
    } catch (e) {
      const el = $("provider-action-result");
      if (el) el.textContent = String(e?.message ?? e).slice(0, 300);
    }
  }

  function populateOwnerSelect(coworkers, targetId = "job-owner") {
    const sel = $(targetId);
    if (!sel) return;
    sel.textContent = "";
    for (const c of (coworkers ?? [])) {
      if (c.state !== "active") continue;
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${safeLabel(I18n()?.displayCoworkerName?.(c.name) ?? c.name, "Coworker")} · ${safeLabel(c.role, "Coworker")}`;
      sel.append(opt);
    }
  }

  function ensureRoutineSurface() {
    if (!$("nav-routines")) {
      const nav = document.createElement("button");
      nav.id = "nav-routines";
      nav.className = "utility-nav";
      nav.type = "button";
      const label = document.createElement("span");
      label.dataset.i18n = "nav.routines";
      label.textContent = t("nav.routines", "Routines");
      nav.append(label);
      $("nav-work")?.after(nav);
    }
    if (!$("view-routines")) {
      const section = document.createElement("section");
      section.id = "view-routines";
      section.className = "main-view settings-view hidden";
      section.innerHTML = `
        <header class="page-header"><div><span class="eyebrow" data-i18n="routines.title">Routines</span><h1 data-i18n="routines.title">Routines</h1><p data-i18n="routines.subtitle">Schedule recurring work.</p></div><div style="display:flex;gap:8px;align-items:center"><button id="routine-refresh" class="quiet-action" type="button" data-i18n="action.refresh">Refresh</button><button id="routine-new" class="hero-action" type="button" data-i18n="routines.create">New routine</button></div></header>
        <div id="routine-list" class="workspace-cards"></div>
        <dialog id="routine-dialog" class="modal"><form id="routine-form" method="dialog" class="modal-card"><div class="modal-heading"><div><span class="eyebrow" data-i18n="routines.create">New routine</span><h2 data-i18n="routines.create">New routine</h2></div><button class="modal-x" data-close-dialog="routine-dialog" type="button">×</button></div>
          <label><span>Routine template / 例行模板</span><select id="routine-template"><option value="">Start from scratch / 从头开始</option><option value="research">Daily research brief / 每日研究简报</option><option value="review">Weekly review / 每周复盘</option><option value="operations">Daily operations check / 每日运营检查</option><option value="content">Content publishing prep / 内容发布准备</option></select></label>
          <label><span data-i18n="routines.name">Name</span><input id="routine-name" maxlength="120" required></label>
          <label><span data-i18n="routines.instruction">Instruction</span><textarea id="routine-instruction" maxlength="8000" rows="4" required></textarea></label>
          <label><span data-i18n="routines.coworker">Coworker</span><select id="routine-owner"></select></label>
          <label><span>Team / 团队（可选）</span><select id="routine-team"><option value="">No team binding / 不绑定团队</option></select></label>
          <label><span>Project / 项目（可选）</span><select id="routine-project"><option value="">No project binding / 不绑定项目</option></select></label>
          <label><span data-i18n="routines.skill">Skill</span><select id="routine-skill"></select></label>
          <label><span data-i18n="routines.workspace">Workspace</span><select id="routine-workspace"></select></label>
          <label><span data-i18n="routines.schedule">Schedule</span><select id="routine-type"><option value="one-time" data-i18n="routines.type.one-time">One-time</option><option value="hourly" data-i18n="routines.type.hourly">Hourly</option><option value="daily" data-i18n="routines.type.daily">Daily</option><option value="weekly" data-i18n="routines.type.weekly">Weekly</option><option value="custom">Custom interval / 自定义间隔</option></select></label>
          <label id="routine-field-at"><span data-i18n="routines.at">Run at</span><input id="routine-at" type="datetime-local"></label>
          <label id="routine-field-minute" class="hidden"><span data-i18n="routines.minute">Minute past the hour</span><input id="routine-minute" type="number" min="0" max="59" value="0"></label>
          <label id="routine-field-interval" class="hidden"><span>Interval minutes / 间隔分钟</span><input id="routine-interval" type="number" min="1" max="10080" value="60"></label>
          <label id="routine-field-time" class="hidden"><span data-i18n="routines.time">Time</span><input id="routine-time" type="time" value="09:00"></label>
          <label id="routine-field-weekday" class="hidden"><span data-i18n="routines.weekday">Weekday</span><select id="routine-weekday"></select></label>
          <p id="routine-form-error" class="inline-error hidden"></p><div class="modal-actions"><button class="quiet-action" data-close-dialog="routine-dialog" type="button" data-i18n="action.cancel">Cancel</button><button class="hero-action" type="submit" data-i18n="routines.create">New routine</button></div>
        </form></dialog>
        <p id="routine-action-status" class="setting-feedback hidden" role="status" aria-live="polite"></p>
        <dialog id="routine-detail-dialog" class="modal"><div class="modal-card"><div class="modal-heading"><div><span class="eyebrow" data-i18n="routines.history">History</span><h2 id="routine-detail-title">Routine</h2></div><button class="modal-x" data-close-dialog="routine-detail-dialog" type="button">×</button></div><p id="routine-detail-meta" class="setting-feedback"></p><div id="routine-history" class="workspace-cards"></div><div class="modal-actions"><button class="quiet-action" data-close-dialog="routine-detail-dialog" type="button" data-i18n="action.close">Close</button></div></div></dialog>
        <dialog id="routine-remove-dialog" class="modal"><form id="routine-remove-form" method="dialog" class="modal-card"><div class="modal-heading"><div><span class="eyebrow">ROUTINE LIFECYCLE / 例行任务生命周期</span><h2>Remove Routine? / 移除例行任务？</h2></div><button class="modal-x" data-close-dialog="routine-remove-dialog" type="button">×</button></div><p id="routine-remove-name" class="setting-feedback"></p><p id="routine-remove-impact">This permanently removes the Routine and its schedule/history. Use Archive if you may want to restore it later. / 此操作会永久移除例行任务及其计划/历史；如需以后恢复，请使用归档。</p><div class="modal-actions"><button class="quiet-action" data-close-dialog="routine-remove-dialog" type="button">Cancel / 取消</button><button id="routine-remove-confirm" class="hero-action" type="submit">Remove Routine / 移除例行任务</button></div></form></dialog>`;
      document.querySelector(".workspace-shell")?.append(section);
    }
    applyRoutineLocale();
    ensureRoutineComputerSurface();
    renderRoutineTemplateGallery();
  }

  function ensureRoutineComputerSurface() {
    if ($("routine-execution") || !$("routine-form-error")) return;
    const makeLabel = (caption, control) => { const node = document.createElement("label"); node.textContent = caption; node.append(control); return node; };
    const mode = document.createElement("select"); mode.id = "routine-execution";
    for (const pair of [["local", "This PC / 此电脑"], ["worker-computer", "Worker Computer / 工作电脑"]]) { const option = document.createElement("option"); option.value = pair[0]; option.textContent = pair[1]; mode.append(option); }
    const node = document.createElement("select"); node.id = "routine-computer-node";
    const workspace = document.createElement("select"); workspace.id = "routine-computer-workspace";
    const computer = document.createElement("select"); computer.id = "routine-computer";
    const fields = document.createElement("div"); fields.id = "routine-computer-fields"; fields.className = "hidden";
    fields.append(makeLabel("Worker Node", node), makeLabel("Node workspace", workspace), makeLabel("Computer target", computer));
    $("routine-form-error").before(makeLabel("Execution", mode), fields);
    mode.addEventListener("change", () => { const remote = mode.value === "worker-computer"; fields.classList.toggle("hidden", !remote); workspace.toggleAttribute("required", remote); node.toggleAttribute("required", remote); computer.toggleAttribute("required", remote); });
    node.addEventListener("change", () => {
      const selected = workerNodes.find((entry) => entry.nodeId === node.value);
      workspace.textContent = "";
      for (const item of selected?.workspaces ?? []) { const option = document.createElement("option"); option.value = item.id; option.textContent = safeLabel(item.name, "Worker workspace"); workspace.append(option); }
      const target = selected?.computer; computer.textContent = "";
      if (target?.id) { const option = document.createElement("option"); option.value = target.id; option.textContent = (target.name ?? "Worker Computer") + " (" + target.state + ")"; computer.append(option); }
    });
  }

  function renderRoutineTemplateGallery() {
    if ($("routine-template-gallery") || !$("routine-list")) return;
    const section = document.createElement("section");
    section.id = "routine-template-gallery";
    section.className = "settings-card span-2";
    const heading = document.createElement("div");
    heading.className = "card-heading";
    const copy = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = "Routine Template Gallery / 例行模板库";
    const description = document.createElement("p");
    description.textContent = "Start from a bounded routine template, then review the owner, workspace, and schedule before saving.";
    copy.append(title, description);
    heading.append(copy);
    const cards = document.createElement("div");
    cards.className = "workspace-cards";
    for (const [id, template] of Object.entries(ROUTINE_TEMPLATES)) {
      const card = document.createElement("article");
      card.className = "settings-card";
      const name = document.createElement("h3");
      name.textContent = template.name;
      const details = document.createElement("p");
      details.textContent = `${template.description} · ${template.type}`;
      const use = document.createElement("button");
      use.type = "button";
      use.className = "quiet-action";
      use.textContent = "Use template / 使用模板";
      use.addEventListener("click", async () => {
        await populateRoutineForm();
        const selector = $("routine-template");
        if (selector) selector.value = id;
        applyRoutineTemplate();
        $("routine-dialog")?.showModal?.();
      });
      card.append(name, details, use);
      cards.append(card);
    }
    section.append(heading, cards);
    $("routine-list").before(section);
  }

  function ensureAttentionSurface() {
    if (!$('view-attention')) {
      const section = document.createElement("section");
      section.id = "view-attention";
      section.className = "main-view settings-view hidden";
      section.innerHTML = `
        <header class="page-header"><div><span class="eyebrow" data-i18n="attention.title">Attention</span><h1 data-i18n="attention.title">Attention</h1><p data-i18n="attention.subtitle">Items that need your decision before work can continue.</p></div><button id="attention-refresh" class="quiet-action" type="button" data-i18n="action.refresh">Refresh</button></header>
        <div class="settings-card attention-toolbar"><div class="detail-actions"><label>Category / 分类<select id="attention-category-filter" aria-label="Attention category"><option value="all">All categories / 全部分类</option>${ATTENTION_CATEGORIES.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label><label>Show / 显示<select id="attention-visibility-filter" aria-label="Attention visibility"><option value="active">Active / 活跃</option><option value="snoozed">Snoozed / 已稍后处理</option><option value="all">All / 全部</option></select></label><label>Snooze duration / 稍后处理时长<select id="attention-snooze-duration" aria-label="Snooze duration">${SNOOZE_OPTIONS.map(([minutes, label]) => `<option value="${minutes}"${minutes === 60 ? " selected" : ""}>${label}</option>`).join("")}</select></label></div><p class="detail-help">Categories and allowed actions come from the trusted main-process projection. They do not grant permissions or bypass Governor review.</p></div>
        <p id="attention-error" class="inline-error hidden"></p>
        <div id="attention-list" class="workspace-cards"></div>`;
      document.querySelector(".workspace-shell")?.append(section);
    }
    applyAttentionLocale();
  }

  function applyAttentionLocale() {
    for (const el of $("view-attention")?.querySelectorAll("[data-i18n]") ?? []) el.textContent = t(el.dataset.i18n, el.textContent);
  }

  function applyRoutineLocale() {
    for (const el of $("view-routines")?.querySelectorAll("[data-i18n]") ?? []) el.textContent = t(el.dataset.i18n, el.textContent);
    const navLabel = $("nav-routines")?.querySelector("[data-i18n]");
    if (navLabel) navLabel.textContent = t(navLabel.dataset.i18n, navLabel.textContent);
    populateWeekdays(true);
  }

  function populateWeekdays(force = false) {
    const sel = $("routine-weekday");
    if (!sel) return;
    const selected = sel.value;
    if (sel.options.length && !force) return;
    sel.textContent = "";
    for (let day = 0; day < 7; day += 1) {
      const opt = document.createElement("option");
      opt.value = String(day);
      opt.textContent = t(`weekday.${day}`, String(day));
      sel.append(opt);
    }
    if ([...sel.options].some((opt) => opt.value === selected)) sel.value = selected;
  }

  function scheduleLabel(schedule) {
    if (!schedule) return "—";
    if (schedule.type === "one-time") return `${t("routines.type.one-time", "One-time")} · ${new Date(schedule.at).toLocaleString()}`;
    if (schedule.type === "hourly") return `${t("routines.type.hourly", "Hourly")} · :${String(schedule.minute).padStart(2,"0")}`;
    if (schedule.type === "custom") return `Custom interval / 自定义间隔 · ${schedule.intervalMinutes} min`;
    if (schedule.type === "daily") return `${t("routines.type.daily", "Daily")} · ${schedule.time}`;
    return `${t("routines.type.weekly", "Weekly")} · ${t(`weekday.${schedule.weekday}`, schedule.weekday)} ${schedule.time}`;
  }

  function routineActionError(error, fallback) {
    const message = String(error?.message ?? error).replace(/^.*Error:\s*/, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\b[a-z][a-z0-9-]*_[a-f0-9]{16}\b/gi, "selected item").trim();
    if (!message || /(?:token|secret|password|credential|session|authorization|provider|cwd|workspacePath|storageRelativePath|sourceRelativePath)/i.test(message)) return fallback;
    return message.slice(0, 240) || fallback;
  }

  function setRoutineActionFeedback(routineId, kind, message) {
    if (!message) routineActionFeedback.delete(routineId);
    else routineActionFeedback.set(routineId, { kind, message });
  }

  function setRoutineActionStatus(kind, message) {
    const status = $("routine-action-status");
    if (!status) return;
    status.textContent = message || "";
    status.dataset.kind = message ? kind : "";
    status.classList.toggle("hidden", !message);
  }

  function appendRoutineActionFeedback(card, routineId) {
    const feedback = routineActionFeedback.get(routineId);
    if (!feedback) return;
    const row = document.createElement("div");
    row.className = "routine-action-feedback";
    row.dataset.kind = feedback.kind;
    const message = document.createElement("p");
    message.className = feedback.kind === "error" ? "inline-error" : "setting-feedback";
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    message.textContent = feedback.message;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "quiet-action routine-action-dismiss";
    dismiss.textContent = "Dismiss / 消退";
    dismiss.addEventListener("click", () => { setRoutineActionFeedback(routineId); renderRoutineList(); });
    row.append(message, dismiss);
    card.append(row);
  }

  async function runRoutineFromCard(routineId) {
    if (routineActionPending.has(routineId)) return;
    const routine = routines.find((entry) => entry.id === routineId);
    if (!routine) {
      setRoutineActionFeedback(routineId, "error", "This Routine is no longer available. Refresh and try again. / 此例行任务已不存在，请刷新后重试。");
      renderRoutineList();
      return;
    }
    if (routine.canRun !== true) {
      setRoutineActionFeedback(routineId, "error", "This Routine is not currently runnable. Refresh and try again. / 此例行任务当前不可运行，请刷新后重试。");
      renderRoutineList();
      return;
    }
    routineActionPending.add(routineId);
    setRoutineActionFeedback(routineId);
    renderRoutineList();
    try {
      await window.sovereignbot.routines.runNow({ routineId });
      setRoutineActionFeedback(routineId, "success", `Routine started: ${routine.name} / 例行任务已启动：${routine.name}`);
      await refreshRoutines();
    } catch (error) {
      setRoutineActionFeedback(routineId, "error", routineActionError(error, "Routine could not be started. Check its state and try again. / 例行任务未启动，请检查状态后重试。"));
    } finally {
      routineActionPending.delete(routineId);
      renderRoutineList();
    }
  }

  async function restoreRoutineFromCard(routineId) {
    if (routineActionPending.has(routineId)) return;
    const routine = routines.find((entry) => entry.id === routineId);
    if (!routine) {
      setRoutineActionFeedback(routineId, "error", "This Routine is no longer available. Refresh and try again. / 此例行任务已不存在，请刷新后重试。");
      renderRoutineList();
      return;
    }
    if (routine.state !== "archived") {
      setRoutineActionFeedback(routineId, "error", "This Routine is not archived. Refresh and try again. / 此例行任务未归档，请刷新后重试。");
      renderRoutineList();
      return;
    }
    routineActionPending.add(routineId);
    setRoutineActionFeedback(routineId);
    renderRoutineList();
    try {
      await window.sovereignbot.routines.restore({ routineId });
      setRoutineActionFeedback(routineId, "success", `Routine restored: ${routine.name} / 例行任务已恢复：${routine.name}`);
      await refreshRoutines();
    } catch (error) {
      setRoutineActionFeedback(routineId, "error", routineActionError(error, "Routine could not be restored. Check its state and try again. / 例行任务未恢复，请检查状态后重试。"));
    } finally {
      routineActionPending.delete(routineId);
      renderRoutineList();
    }
  }

  async function toggleRoutineFromCard(routineId) {
    if (routineActionPending.has(routineId)) return;
    const routine = routines.find((entry) => entry.id === routineId);
    if (!routine) {
      setRoutineActionFeedback(routineId, "error", "This Routine is no longer available. Refresh and try again. / 此例行任务已不存在，请刷新后重试。");
      renderRoutineList();
      return;
    }
    if (routine.state !== "active") {
      setRoutineActionFeedback(routineId, "error", "This Routine is not active. Restore it before changing Enable state. / 此例行任务未处于活动状态，请先恢复。");
      renderRoutineList();
      return;
    }
    const enabled = !routine.enabled;
    routineActionPending.add(routineId);
    setRoutineActionFeedback(routineId);
    renderRoutineList();
    try {
      await window.sovereignbot.routines.setEnabled({ routineId, enabled });
      setRoutineActionFeedback(routineId, "success", enabled ? `Routine enabled: ${routine.name} / 例行任务已启用：${routine.name}` : `Routine disabled: ${routine.name} / 例行任务已停用：${routine.name}`);
      await refreshRoutines();
    } catch (error) {
      setRoutineActionFeedback(routineId, "error", routineActionError(error, "Routine Enable state could not be changed. Check its state and try again. / 例行任务启用状态未改变，请检查状态后重试。"));
    } finally {
      routineActionPending.delete(routineId);
      renderRoutineList();
    }
  }

  async function archiveRoutineFromCard(routineId) {
    if (routineActionPending.has(routineId)) return;
    const routine = routines.find((entry) => entry.id === routineId);
    if (!routine) {
      setRoutineActionFeedback(routineId, "error", "This Routine is no longer available. Refresh and try again. / 此例行任务已不存在，请刷新后重试。");
      renderRoutineList();
      return;
    }
    if (routine.state === "archived") {
      setRoutineActionFeedback(routineId, "error", "This Routine is already archived. Refresh and try again. / 此例行任务已归档，请刷新后重试。");
      renderRoutineList();
      return;
    }
    routineActionPending.add(routineId);
    setRoutineActionFeedback(routineId);
    renderRoutineList();
    try {
      await window.sovereignbot.routines.archive({ routineId });
      setRoutineActionFeedback(routineId, "success", `Routine archived: ${routine.name} / 例行任务已归档：${routine.name}`);
      await refreshRoutines();
    } catch (error) {
      setRoutineActionFeedback(routineId, "error", routineActionError(error, "Routine could not be archived. Check its state and try again. / 例行任务未归档，请检查状态后重试。"));
    } finally {
      routineActionPending.delete(routineId);
      renderRoutineList();
    }
  }

  function openRoutineRemoveDialog(routineId) {
    if (routineActionPending.has(routineId)) return;
    const routine = routines.find((entry) => entry.id === routineId);
    if (!routine) {
      setRoutineActionFeedback(routineId, "error", "This Routine is no longer available. Refresh and try again. / 此例行任务已不存在，请刷新后重试。");
      renderRoutineList();
      return;
    }
    routineRemoveCandidate = { routineId, name: routine.name };
    $("routine-remove-name").textContent = `Routine: ${routine.name} / 例行任务：${routine.name}`;
    $("routine-remove-dialog")?.showModal?.();
  }

  async function confirmRoutineRemoval() {
    const candidate = routineRemoveCandidate;
    routineRemoveCandidate = undefined;
    $("routine-remove-dialog")?.close();
    if (!candidate || routineActionPending.has(candidate.routineId)) return;
    const routine = routines.find((entry) => entry.id === candidate.routineId);
    if (!routine) {
      setRoutineActionFeedback(candidate.routineId, "error", "This Routine is no longer available. Refresh and try again. / 此例行任务已不存在，请刷新后重试。");
      renderRoutineList();
      return;
    }
    routineActionPending.add(candidate.routineId);
    setRoutineActionFeedback(candidate.routineId);
    renderRoutineList();
    try {
      await window.sovereignbot.routines.remove({ routineId: candidate.routineId });
      setRoutineActionStatus("success", `Routine removed: ${routine.name} / 例行任务已移除：${routine.name}`);
      await refreshRoutines();
    } catch (error) {
      setRoutineActionFeedback(candidate.routineId, "error", routineActionError(error, "Routine could not be removed. It was not changed; retry when ready. / 例行任务未移除，状态未改变，请稍后重试。"));
    } finally {
      routineActionPending.delete(candidate.routineId);
      renderRoutineList();
    }
  }

  function renderRoutineList() {
    const root = $("routine-list");
    if (!root) return;
    root.textContent = "";
    if (!routines.length) {
      const p = document.createElement("p"); p.className = "setting-feedback"; p.textContent = t("routines.empty", "No routines yet."); root.append(p); return;
    }
    for (const routine of routines) {
      const card = document.createElement("div"); card.className = "job-card";
      const head = document.createElement("div"); head.className = "job-card-head";
      const title = document.createElement("strong"); title.textContent = routine.name;
      const badge = document.createElement("span"); badge.className = `job-status ${routine.state === "archived" ? "failed" : routine.enabled ? "completed" : "waiting"}`; badge.textContent = routine.state === "archived" ? "Archived / 已归档" : routine.enabled ? t("routines.enabled", "Enabled") : t("routines.disabled", "Disabled");
      head.append(title, badge);
      const meta = document.createElement("div"); meta.className = "setting-feedback"; meta.style.margin = "0";
      const next = routine.nextRunAt ? new Date(routine.nextRunAt).toLocaleString() : "—";
      meta.textContent = `${scheduleLabel(routine.schedule)} · ${t("routines.nextRun", "Next run")}: ${next}${routine.lastStatus ? ` · ${t("routines.lastStatus", "Last status")}: ${routine.lastStatus}` : ""}`;
      const actions = document.createElement("div"); actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
      const actionPending = routineActionPending.has(routine.id);
      const open = document.createElement("button"); open.className = "quiet-action"; open.type = "button"; open.textContent = t("routines.history", "History"); open.disabled = actionPending; open.addEventListener("click", () => openRoutineDetail(routine.id));
      const remove = document.createElement("button"); remove.className = "quiet-action"; remove.type = "button"; remove.textContent = actionPending ? "Removing… / 移除中…" : t("routines.remove", "Remove"); remove.disabled = actionPending; remove.addEventListener("click", () => openRoutineRemoveDialog(routine.id));
      const runNow = document.createElement("button"); runNow.className = "hero-action"; runNow.type = "button"; runNow.textContent = actionPending ? "Working… / 处理中…" : "Run now / 立即运行"; runNow.disabled = actionPending || routine.canRun !== true; runNow.addEventListener("click", () => void runRoutineFromCard(routine.id));
      const consumedOneTime = routine.schedule?.type === "one-time" && Boolean(routine.lastRunAt);
      actions.append(open, runNow);
      if (routine.state === "archived") {
        const restore = document.createElement("button"); restore.className = "quiet-action"; restore.type = "button"; restore.textContent = actionPending ? "Restoring… / 恢复中…" : "Restore / 恢复"; restore.disabled = actionPending; restore.addEventListener("click", () => void restoreRoutineFromCard(routine.id)); actions.append(restore);
      } else if (!consumedOneTime) {
        const toggle = document.createElement("button"); toggle.className = "quiet-action"; toggle.type = "button"; toggle.textContent = actionPending ? "Updating… / 更新中…" : routine.enabled ? t("routines.disable", "Disable") : t("routines.enable", "Enable"); toggle.disabled = actionPending; toggle.addEventListener("click", () => void toggleRoutineFromCard(routine.id));
        actions.append(toggle);
      }
      if (routine.state !== "archived") { const archive = document.createElement("button"); archive.className = "quiet-action"; archive.type = "button"; archive.textContent = actionPending ? "Updating… / 更新中…" : "Archive / 归档"; archive.disabled = actionPending; archive.addEventListener("click", () => void archiveRoutineFromCard(routine.id)); actions.append(archive); }
      actions.append(remove);
      card.append(head, meta, actions); appendRoutineActionFeedback(card, routine.id); root.append(card);
    }
  }

  async function refreshRoutines() {
    try { const result = await window.sovereignbot.routines.list({ includeArchived: true }); routines = result?.routines ?? []; renderRoutineList(); } catch {}
  }

  async function openRoutineDetail(routineId) {
    currentRoutineId = routineId;
    try {
      const routine = await window.sovereignbot.routines.get({ routineId });
      const history = await window.sovereignbot.routines.history({ routineId });
      $("routine-detail-title").textContent = routine.name;
      $("routine-detail-meta").textContent = `${scheduleLabel(routine.schedule)} · ${routine.enabled ? t("routines.enabled", "Enabled") : t("routines.disabled", "Disabled")}`;
      const root = $("routine-history"); root.textContent = "";
      if (!(history.history ?? []).length) { const p = document.createElement("p"); p.className = "setting-feedback"; p.textContent = t("routines.historyEmpty", "No runs yet."); root.append(p); }
      for (const run of history.history ?? []) {
        const card = document.createElement("div"); card.className = "job-card";
        const line = document.createElement("div"); line.textContent = `${new Date(run.scheduledFor).toLocaleString()} · ${run.status}${run.error ? ` · ${run.error}` : ""}`;
        card.append(line);
        if (run.jobId) { const btn = document.createElement("button"); btn.className = "quiet-action"; btn.type = "button"; btn.textContent = `${t("action.open", "Open")} ${t("routines.job", "Job")}`; btn.addEventListener("click", async () => { $("routine-detail-dialog")?.close(); await openDetail(run.jobId); }); card.append(btn); }
        if (run.jobId && ["waiting", "needs_attention"].includes(run.status) && routine.state !== "archived") { const retry = document.createElement("button"); retry.className = "hero-action"; retry.type = "button"; retry.textContent = "Retry / 重试"; retry.addEventListener("click", async () => { await window.sovereignbot.routines.retry({ routineId, runId: run.id }); await openRoutineDetail(routineId); }); card.append(retry); }
        root.append(card);
      }
      $("routine-detail-dialog")?.showModal?.();
    } catch {}
  }

  function showScheduleFields() {
    const type = $("routine-type")?.value ?? "one-time";
    $("routine-field-at")?.classList.toggle("hidden", type !== "one-time");
    $("routine-field-minute")?.classList.toggle("hidden", type !== "hourly");
    $("routine-field-interval")?.classList.toggle("hidden", type !== "custom");
    $("routine-field-time")?.classList.toggle("hidden", !["daily","weekly"].includes(type));
    $("routine-field-weekday")?.classList.toggle("hidden", type !== "weekly");
  }

  function scheduleFromForm() {
    const type = $("routine-type").value;
    if (type === "one-time") {
      const value = $("routine-at").value;
      if (!value) throw new Error(t("routines.at", "Run at") + " is required");
      return { type, at: new Date(value).toISOString() };
    }
    if (type === "hourly") return { type, minute: Number($("routine-minute").value) };
    if (type === "custom") return { type, intervalMinutes: Number($("routine-interval").value) };
    if (type === "daily") return { type, time: $("routine-time").value };
    return { type, weekday: Number($("routine-weekday").value), time: $("routine-time").value };
  }

  async function populateRoutineForm() {
    const [cw, skills, workspaces, teams, projects, workerResult] = await Promise.all([
      window.sovereignbot.coworkers.list({}).catch(() => ({ coworkers: [] })),
      window.sovereignbot.skills.list({}).catch(() => ({ skills: [] })),
      window.sovereignbot.workspaces.list({}).catch(() => ({ workspaces: [] })),
      window.sovereignbot.teams.list({}).catch(() => ({ teams: [] })),
      window.sovereignbot.projects.list({}).catch(() => ({ projects: [] })),
      window.sovereignbot.workerNodes.list({}).catch(() => ({ nodes: [] })),
    ]);
    workerNodes = workerResult?.nodes ?? [];
    const routineNode = $("routine-computer-node");
    if (routineNode) { routineNode.textContent = ""; for (const item of workerNodes.filter((entry) => entry.enabled && entry.status === "online" && ["online", "capacity-limited"].includes(entry.computer?.state))) { const option = document.createElement("option"); option.value = item.nodeId; option.textContent = safeLabel(item.name, "Worker Node"); routineNode.append(option); } routineNode.dispatchEvent(new Event("change")); }
    populateOwnerSelect(cw?.coworkers ?? [], "routine-owner");
    const skill = $("routine-skill"); skill.textContent = "";
    const none = document.createElement("option"); none.value = ""; none.textContent = t("routines.noSkill", "No skill"); skill.append(none);
    for (const item of skills?.skills ?? []) { const opt = document.createElement("option"); opt.value = item.id; opt.textContent = item.name; skill.append(opt); }
    const ws = $("routine-workspace"); ws.textContent = "";
    const def = document.createElement("option"); def.value = ""; def.textContent = t("routines.defaultWorkspace", "Coworker default"); ws.append(def);
    for (const item of workspaces?.workspaces ?? []) { const opt = document.createElement("option"); opt.value = item.id; opt.textContent = item.kind === "shared-project" ? "Shared project workspace / 共享项目工作区" : item.label || "Private workspace / 私有工作区"; ws.append(opt); }
    const team = $("routine-team"); team.textContent = ""; const noTeam = document.createElement("option"); noTeam.value = ""; noTeam.textContent = "No team binding / 不绑定团队"; team.append(noTeam); for (const item of teams?.teams ?? []) { if (item.state === "archived") continue; const opt = document.createElement("option"); opt.value = item.id; opt.textContent = item.name; team.append(opt); }
    const project = $("routine-project"); project.textContent = ""; const noProject = document.createElement("option"); noProject.value = ""; noProject.textContent = "No project binding / 不绑定项目"; project.append(noProject); for (const item of projects?.projects ?? []) { if (item.state === "archived") continue; const opt = document.createElement("option"); opt.value = item.projectId; opt.textContent = item.name; project.append(opt); }
    const inOneHour = new Date(Date.now() + 3600_000); const local = new Date(inOneHour.getTime() - inOneHour.getTimezoneOffset() * 60000).toISOString().slice(0,16); $("routine-at").value = local;
    $("routine-minute").value = String(new Date().getMinutes());
    showScheduleFields();
  }

  function applyRoutineTemplate() {
    const value = ROUTINE_TEMPLATES[$("routine-template")?.value];
    if (!value) return;
    $("routine-name").value = value.name;
    $("routine-instruction").value = value.description;
    $("routine-type").value = value.type;
    showScheduleFields();
  }

  async function createRoutineFromSkill(skillId) {
    if (typeof skillId !== "string" || !skillId) return;
    const error = $("routine-form-error");
    error?.classList.add("hidden");
    try {
      const skill = await window.sovereignbot.skills.get({ skillId });
      await populateRoutineForm();
      $("routine-name").value = `Routine · ${skill.name}`.slice(0, 120);
      $("routine-instruction").value = String(skill.instructions ?? "").slice(0, 8000);
      $("routine-skill").value = skill.id;
      const preferredOwner = (skill.assignedCoworkerIds ?? []).find((id) =>
        [...($("routine-owner")?.options ?? [])].some((option) => option.value === id));
      if (preferredOwner) $("routine-owner").value = preferredOwner;
      showRoutinesView();
      $("routine-dialog")?.showModal?.();
    } catch (reason) {
      if (error) {
        error.textContent = String(reason?.message ?? reason).replace(/^.*Error: /, "").slice(0, 400);
        error.classList.remove("hidden");
      }
    }
  }

  async function createRoutineFromSource(detail = {}) {
    await populateRoutineForm();
    if (detail.name) $("routine-name").value = String(detail.name).slice(0, 120);
    if (detail.instruction) $("routine-instruction").value = String(detail.instruction).slice(0, 8000);
    if (detail.teamId && [...$("routine-team").options].some((option) => option.value === detail.teamId)) $("routine-team").value = detail.teamId;
    if (detail.projectId && [...$("routine-project").options].some((option) => option.value === detail.projectId)) $("routine-project").value = detail.projectId;
    showRoutinesView();
    $("routine-dialog")?.showModal?.();
  }

  function showRoutinesView() {
    for (const v of document.querySelectorAll(".main-view")) v.classList.add("hidden");
    $("view-routines")?.classList.remove("hidden");
    for (const id of ["nav-work", "nav-attention", "nav-routines", "nav-triggers", "nav-worker-nodes", "nav-settings"]) $(id)?.classList.remove("active");
    $("nav-routines")?.classList.add("active");
    clearTimeout(routinePollTimer);
    clearTimeout(attentionPollTimer);
    routinePollTimer = setTimeout(function poll(){ refreshRoutines().finally(()=>{ if(!$("view-routines")?.classList.contains("hidden")) routinePollTimer=setTimeout(poll, 5000); }); }, 5000);
    void refreshRoutines();
  }

  function showAttentionView() {
    for (const v of document.querySelectorAll(".main-view")) v.classList.add("hidden");
    $("view-attention")?.classList.remove("hidden");
    for (const id of ["nav-work", "nav-routines", "nav-triggers", "nav-worker-nodes", "nav-settings"]) $(id)?.classList.remove("active");
    $("nav-attention")?.classList.add("active");
    clearTimeout(pollTimer);
    clearTimeout(routinePollTimer);
    clearTimeout(attentionPollTimer);
    const poll = () => {
      refreshAttention().finally(() => {
        if (!$('view-attention')?.classList.contains("hidden")) attentionPollTimer = setTimeout(poll, 5000);
      });
    };
    attentionPollTimer = setTimeout(poll, 5000);
    void refreshAttention();
  }

  function bindEvents() {
    $("nav-work")?.addEventListener("click", async () => {
      for (const v of document.querySelectorAll(".main-view")) v.classList.add("hidden");
      $("view-work")?.classList.remove("hidden");
      await refresh();
      for (const id of ["nav-settings", "nav-routines", "nav-attention", "nav-triggers", "nav-worker-nodes"]) $(id)?.classList.remove("active"); $("nav-work")?.classList.add("active");
      clearTimeout(pollTimer);
      clearTimeout(routinePollTimer);
      clearTimeout(attentionPollTimer);
      pollTimer = setTimeout(function poll(){ refresh().finally(()=>{ if(!$("view-work")?.classList.contains("hidden")) pollTimer=setTimeout(poll, 2500); }); }, 2500);
    });
    $("nav-attention")?.addEventListener("click", showAttentionView);
    $("nav-routines")?.addEventListener("click", showRoutinesView);
    $("nav-settings")?.addEventListener("click", () => {
      clearTimeout(pollTimer); clearTimeout(routinePollTimer); clearTimeout(attentionPollTimer);
      for (const id of ["nav-work", "nav-attention", "nav-routines", "nav-triggers", "nav-worker-nodes"]) $(id)?.classList.remove("active");
      $("nav-settings")?.classList.add("active");
    });
    $("work-refresh")?.addEventListener("click", refresh);
    $("work-new")?.addEventListener("click", async () => { try { const cw = await window.sovereignbot.coworkers.list({}); populateOwnerSelect(cw?.coworkers ?? []); } catch {} await populateExecutionTargetForm(); $("job-dialog")?.showModal?.(); });
    $("job-execution")?.addEventListener("change", () => {
      const mode = $("job-execution").value;
      const remote = ["worker-node", "worker-computer"].includes(mode);
      const computer = mode === "worker-computer";
      const profileMode = ["vm", "local-isolated", "cloud"].includes(mode);
      $("job-node-fields")?.classList.toggle("hidden", !remote);
      $("job-profile-fields")?.classList.toggle("hidden", !profileMode);
      $("job-node-workspace")?.toggleAttribute("required", remote);
      $("job-node")?.toggleAttribute("required", remote);
      $("job-computer")?.toggleAttribute("required", computer);
      $("job-computer-profile")?.toggleAttribute("required", profileMode);
      $("job-computer-workspace")?.toggleAttribute("required", profileMode);
      $("job-cloud-optin")?.closest("label")?.classList.toggle("hidden", mode !== "cloud");
    });
    $("job-node")?.addEventListener("change", () => {
      const workspace = $("job-node-workspace");
      if (!workspace) return;
      workspace.textContent = "";
      const selected = workerNodes.find((entry) => entry.nodeId === $("job-node").value);
      for (const entry of selected?.workspaces ?? []) {
        const option = document.createElement("option"); option.value = entry.id; option.textContent = safeLabel(entry.name, "Worker workspace"); workspace.append(option);
      }
      const computer = $("job-computer");
      if (computer) {
        computer.textContent = "";
        const target = selected?.computer;
        if (target?.id) { const option = document.createElement("option"); option.value = target.id; option.textContent = `${safeLabel(target.name, "Worker Computer")} · ${safeLabel(target.state, "available")}`; computer.append(option); }
      }
    });
    $("job-form")?.addEventListener("submit", async (e) => {
      e.preventDefault(); const errEl = $("job-form-error"); errEl?.classList.add("hidden");
      try {
        const mode = $("job-execution")?.value;
        const target = mode === "worker-node"
          ? { kind: "worker-node", nodeId: $("job-node").value, workspaceId: $("job-node-workspace").value }
          : { kind: "local" };
        let computerTarget;
        if (mode === "worker-computer") computerTarget = { kind: "worker-computer", nodeId: $("job-node").value, workspaceId: $("job-node-workspace").value, computerId: $("job-computer").value };
        if (["vm", "local-isolated", "cloud"].includes(mode)) {
          const profile = computerTargets.find((entry) => entry.id === $("job-computer-profile").value);
          if (!profile?.target || profile.kind !== mode) throw new Error("selected Computer profile is unavailable");
          computerTarget = { ...profile.target, workspaceId: $("job-computer-workspace").value, ...(mode === "cloud" ? { optIn: $("job-cloud-optin").checked } : {}) };
        }
        await window.sovereignbot.jobs.submit({ title: $("job-title").value.trim(), objective: $("job-objective").value.trim(), ownerCoworkerId: $("job-owner").value, executionTarget: target, ...(computerTarget ? { computerTarget, computerActions: [{ operation: "snapshot", input: {} }] } : {}) });
        $("job-dialog")?.close(); $("job-form")?.reset(); await refresh();
      }
      catch (err) { if (errEl) { errEl.textContent = String(err?.message ?? err).replace(/^.*Error: /, "").slice(0, 400); errEl.classList.remove("hidden"); } }
    });
    $("job-detail-approve")?.addEventListener("click", () => { if (!currentJobId) return; const jobId = currentJobId; void runJobAction(jobId, "retry", () => window.sovereignbot.jobs.approve({ jobId }), "Retry requested."); });
    $("job-detail-dismiss")?.addEventListener("click", () => { if (!currentJobId) return; const jobId = currentJobId; void runJobAction(jobId, "dismiss", () => window.sovereignbot.jobs.dismiss({ jobId }), "Attention dismissed."); });
    $("job-detail-pause")?.addEventListener("click", () => { if (!currentJobId) return; const jobId = currentJobId; void runJobAction(jobId, "pause", () => window.sovereignbot.jobs.pause({ jobId }), "Job paused."); });
    $("job-detail-resume")?.addEventListener("click", () => { if (!currentJobId) return; const jobId = currentJobId; void runJobAction(jobId, "resume", () => window.sovereignbot.jobs.resume({ jobId }), "Job resumed."); });
    for (const [id, action] of [["job-detail-approve", "retry"], ["job-detail-dismiss", "dismiss"], ["job-detail-pause", "pause"], ["job-detail-resume", "resume"]]) {
      const button = $(id); if (button) { button.dataset.jobDetailAction = action; button.dataset.jobDetailActionBound = "true"; }
    }
    $("routine-refresh")?.addEventListener("click", refreshRoutines);
    $("attention-refresh")?.addEventListener("click", refreshAttention);
    $("attention-category-filter")?.addEventListener("change", refreshAttention);
    $("attention-visibility-filter")?.addEventListener("change", refreshAttention);
    $("routine-new")?.addEventListener("click", async () => { await populateRoutineForm(); $("routine-dialog")?.showModal?.(); });
    $("routine-type")?.addEventListener("change", showScheduleFields);
    $("routine-template")?.addEventListener("change", applyRoutineTemplate);
    $("routine-form")?.addEventListener("submit", async (e) => {
      e.preventDefault(); const err = $("routine-form-error"); err?.classList.add("hidden");
      try {
        const remoteRoutine = $("routine-execution")?.value === "worker-computer";
        const routineTarget = remoteRoutine ? { kind: "worker-computer", nodeId: $("routine-computer-node").value, workspaceId: $("routine-computer-workspace").value, computerId: $("routine-computer").value } : undefined;
        await window.sovereignbot.routines.create({ name: $("routine-name").value.trim(), instruction: $("routine-instruction").value.trim(), coworkerId: $("routine-owner").value, teamId: $("routine-team").value || undefined, projectId: $("routine-project").value || undefined, skillId: $("routine-skill").value || undefined, workspaceId: $("routine-workspace").value || undefined, schedule: scheduleFromForm(), ...(routineTarget ? { computerTarget: routineTarget, computerActions: [{ operation: "snapshot", input: {} }] } : {}) });
        $("routine-dialog")?.close(); $("routine-form")?.reset(); await refreshRoutines();
      } catch (error) { if (err) { err.textContent = String(error?.message ?? error).replace(/^.*Error: /, "").slice(0,400); err.classList.remove("hidden"); } }
    });
    $("routine-remove-form")?.addEventListener("submit", (e) => { e.preventDefault(); void confirmRoutineRemoval(); });
    $("routine-remove-dialog")?.addEventListener("close", () => { routineRemoveCandidate = undefined; });
    document.addEventListener("sovereignbot:create-routine-from-skill", (event) => {
      void createRoutineFromSkill(event.detail?.skillId);
    });
    document.addEventListener("sovereignbot:create-routine-from-source", (event) => { void createRoutineFromSource(event.detail); });
    document.addEventListener("sovereignbot:navigate-routines", () => { ensureRoutineSurface(); showRoutinesView(); });
    document.addEventListener("sovereignbot:open-routine", (event) => { const routineId = event.detail?.routineId; if (!routineId) return; ensureRoutineSurface(); showRoutinesView(); void openRoutineDetail(routineId); });
    for (const b of document.querySelectorAll("[data-close-dialog]")) b.addEventListener("click", () => $(b.dataset.closeDialog)?.close());
  }

  function init() {
    ensureExecutionTargetSurface();
    ensureAttentionSurface();
    ensureRoutineSurface();
    bindEvents();
    refresh(); refreshRoutines();
    setInterval(refresh, 8000); setInterval(refreshRoutines, 10000);
    new MutationObserver(() => {
      applyRoutineLocale();
      applyAttentionLocale();
      renderRoutineList();
      renderAttentionList();
      if (currentRoutineId && $("routine-detail-dialog")?.open) void openRoutineDetail(currentRoutineId);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  }

  globalThis.SovereignJobsUI = { refresh, renderList, refreshRoutines, refreshAttention, renderAttentionList };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
