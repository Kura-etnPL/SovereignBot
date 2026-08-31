"use strict";
(() => {
  const I18n = () => globalThis.SovereignI18n;
  const $ = (id) => document.getElementById(id);
  function t(key, fallback) { try { return I18n()?.t(key) ?? fallback ?? key; } catch { return fallback ?? key; } }

  let jobs = [];
  let attentionJobs = [];
  let attentionPollTimer;
  let attentionRequest = 0;
  let currentJobId;
  let pollTimer;
  let routines = [];
  let routinePollTimer;
  let currentRoutineId;
  let workerNodes = [];

  function statusClass(s) { return `job-status ${s}`; }
  function statusLabel(s) { return t(`work.status.${s}`, s); }

  function ensureExecutionTargetSurface() {
    if ($("job-execution") || !$("job-form-error")) return;
    const makeLabel = (caption, control) => { const label = document.createElement("label"); label.textContent = caption; label.append(control); return label; };
    const execution = document.createElement("select"); execution.id = "job-execution";
    for (const [value, caption] of [["local", "This PC / 此电脑"], ["worker-node", "Paired Worker Node / 已配对工作节点"]]) { const option = document.createElement("option"); option.value = value; option.textContent = caption; execution.append(option); }
    const node = document.createElement("select"); node.id = "job-node";
    const workspace = document.createElement("select"); workspace.id = "job-node-workspace";
    const nodeFields = document.createElement("div"); nodeFields.id = "job-node-fields"; nodeFields.className = "hidden";
    nodeFields.append(makeLabel("Worker Node", node), makeLabel("Node workspace", workspace));
    $("job-form-error").before(makeLabel("Execution", execution), nodeFields);
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
       const target = job.executionTarget?.kind === "worker-node" ? ` · ${job.workerNodeName ?? job.executionTarget.nodeId} / ${job.workerWorkspaceName ?? job.executionTarget.workspaceId}` : " · This PC / 此电脑";
       meta.textContent = `${job.ownerCoworkerId} · ${job.priority}${target}${job.nextActionAt ? ` · next ${new Date(job.nextActionAt).toLocaleString()}` : ""}${job.error ? ` · ${job.error.slice(0,80)}` : ""}`;
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
      const openBtn = document.createElement("button");
      openBtn.type = "button"; openBtn.className = "quiet-action"; openBtn.textContent = t("action.open", "Open");
      openBtn.addEventListener("click", () => openDetail(job.id));
      actions.append(openBtn);
      if (job.status === "needs_attention") {
        const ap = document.createElement("button"); ap.type = "button"; ap.className = "hero-action"; ap.textContent = t("action.approve", "Approve");
        ap.addEventListener("click", async () => { await window.sovereignbot.jobs.approve({ jobId: job.id }); await refresh(); });
        const dm = document.createElement("button"); dm.type = "button"; dm.className = "quiet-action"; dm.textContent = t("action.dismiss", "Dismiss");
        dm.addEventListener("click", async () => { await window.sovereignbot.jobs.dismiss({ jobId: job.id }); await refresh(); });
        actions.append(ap, dm);
      }
      card.append(head, meta, actions);
      root.append(card);
    }
  }

  function updateAttentionBadge() {
    const badge = $("attention-badge");
    if (!badge) return;
    const n = attentionJobs.length;
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
      p.textContent = t("attention.empty", "Nothing needs your attention.");
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
      const reason = job.attentionState?.reason || job.error || job.outcomeSummary || "—";
      const owner = I18n()?.displayCoworkerName?.(job.ownerCoworkerId) ?? job.ownerCoworkerId ?? "—";
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
      );
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
      const runAction = async (button, action) => {
        button.disabled = true;
        try {
          await action();
          await refreshAttention();
          await refresh();
        } catch (error) {
          const errorEl = $("attention-error");
          if (errorEl) { errorEl.textContent = String(error?.message ?? error).slice(0, 400); errorEl.classList.remove("hidden"); }
        } finally {
          button.disabled = false;
        }
      };
      const open = document.createElement("button");
      open.type = "button"; open.className = "quiet-action"; open.textContent = t("attention.openJob", "Open job");
      open.addEventListener("click", () => { void openDetail(job.id); });
      const retry = document.createElement("button");
      retry.type = "button"; retry.className = "hero-action"; retry.textContent = t("attention.retry", "Retry");
      retry.addEventListener("click", () => runAction(retry, () => window.sovereignbot.jobs.approve({ jobId: job.id })));
      const dismiss = document.createElement("button");
      dismiss.type = "button"; dismiss.className = "quiet-action"; dismiss.textContent = t("attention.dismiss", "Dismiss");
      dismiss.addEventListener("click", () => runAction(dismiss, () => window.sovereignbot.jobs.dismiss({ jobId: job.id })));
      actions.append(open, retry, dismiss);
      card.append(head, details, actions);
      root.append(card);
    }
  }

  async function refresh() {
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
    node.textContent = "";
    for (const entry of workerNodes.filter((item) => item.enabled && item.status === "online")) {
      const option = document.createElement("option");
      option.value = entry.nodeId;
      option.textContent = `${entry.name} (${entry.nodeId})`;
      node.append(option);
    }
    workspace.textContent = "";
    const selected = workerNodes.find((entry) => entry.nodeId === node.value);
    for (const entry of selected?.workspaces ?? []) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = `${entry.name} (${entry.id})`;
      workspace.append(option);
    }
    execution.dispatchEvent(new Event("change"));
  }

  async function refreshAttention() {
    const request = ++attentionRequest;
    try {
      const res = await window.sovereignbot.jobs.attention({});
      if (request !== attentionRequest) return;
      attentionJobs = res?.jobs ?? [];
      const errorEl = $("attention-error");
      errorEl?.classList.add("hidden");
      renderAttentionList();
      updateAttentionBadge();
    } catch {}
  }

  async function openDetail(jobId) {
    currentJobId = jobId;
    try {
      const job = await window.sovereignbot.jobs.getStatus({ jobId });
      const conv = await window.sovereignbot.jobs.getConversation({ jobId }).catch(() => ({ messages: [] }));
      $("job-detail-title").textContent = job.title;
      $("job-detail-meta").textContent = `${job.status} · ${job.ownerCoworkerId} · ${job.priority}${job.error ? ` · ${job.error}` : ""}${job.outcomeSummary ? ` · ${job.outcomeSummary.slice(0,200)}` : ""}`;
      const body = $("job-detail-body");
      const msgs = conv.messages ?? [];
      body.textContent = msgs.length ? msgs.map(m => `[${m.kind ?? m.role}] ${m.text}`).join("\n\n") : (job.outcomeSummary ?? job.error ?? "");
      const needs = job.status === "needs_attention";
      const waiting = job.status === "waiting";
      const approve = $("job-detail-approve");
      if (approve) approve.textContent = t("attention.retry", "Retry");
      $("job-detail-approve")?.classList.toggle("hidden", !needs);
      $("job-detail-dismiss")?.classList.toggle("hidden", !needs);
      $("job-detail-pause")?.classList.toggle("hidden", waiting || needs || ["completed","failed","cancelled"].includes(job.status));
      $("job-detail-resume")?.classList.toggle("hidden", !waiting);
      if ($("job-detail-resume")) $("job-detail-resume").textContent = t("action.resume", "Resume");
      $("job-detail-dialog")?.showModal?.();
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
      opt.textContent = I18n()?.displayCoworkerName?.(c.name) ?? c.name;
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
          <label><span data-i18n="routines.skill">Skill</span><select id="routine-skill"></select></label>
          <label><span data-i18n="routines.workspace">Workspace</span><select id="routine-workspace"></select></label>
          <label><span data-i18n="routines.schedule">Schedule</span><select id="routine-type"><option value="one-time" data-i18n="routines.type.one-time">One-time</option><option value="hourly" data-i18n="routines.type.hourly">Hourly</option><option value="daily" data-i18n="routines.type.daily">Daily</option><option value="weekly" data-i18n="routines.type.weekly">Weekly</option></select></label>
          <label id="routine-field-at"><span data-i18n="routines.at">Run at</span><input id="routine-at" type="datetime-local"></label>
          <label id="routine-field-minute" class="hidden"><span data-i18n="routines.minute">Minute past the hour</span><input id="routine-minute" type="number" min="0" max="59" value="0"></label>
          <label id="routine-field-time" class="hidden"><span data-i18n="routines.time">Time</span><input id="routine-time" type="time" value="09:00"></label>
          <label id="routine-field-weekday" class="hidden"><span data-i18n="routines.weekday">Weekday</span><select id="routine-weekday"></select></label>
          <p id="routine-form-error" class="inline-error hidden"></p><div class="modal-actions"><button class="quiet-action" data-close-dialog="routine-dialog" type="button" data-i18n="action.cancel">Cancel</button><button class="hero-action" type="submit" data-i18n="routines.create">New routine</button></div>
        </form></dialog>
        <dialog id="routine-detail-dialog" class="modal"><div class="modal-card"><div class="modal-heading"><div><span class="eyebrow" data-i18n="routines.history">History</span><h2 id="routine-detail-title">Routine</h2></div><button class="modal-x" data-close-dialog="routine-detail-dialog" type="button">×</button></div><p id="routine-detail-meta" class="setting-feedback"></p><div id="routine-history" class="workspace-cards"></div><div class="modal-actions"><button class="quiet-action" data-close-dialog="routine-detail-dialog" type="button" data-i18n="action.close">Close</button></div></div></dialog>`;
      document.querySelector(".workspace-shell")?.append(section);
    }
    applyRoutineLocale();
  }

  function ensureAttentionSurface() {
    if (!$('view-attention')) {
      const section = document.createElement("section");
      section.id = "view-attention";
      section.className = "main-view settings-view hidden";
      section.innerHTML = `
        <header class="page-header"><div><span class="eyebrow" data-i18n="attention.title">Attention</span><h1 data-i18n="attention.title">Attention</h1><p data-i18n="attention.subtitle">Items that need your decision before work can continue.</p></div><button id="attention-refresh" class="quiet-action" type="button" data-i18n="action.refresh">Refresh</button></header>
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
    if (schedule.type === "daily") return `${t("routines.type.daily", "Daily")} · ${schedule.time}`;
    return `${t("routines.type.weekly", "Weekly")} · ${t(`weekday.${schedule.weekday}`, schedule.weekday)} ${schedule.time}`;
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
      const badge = document.createElement("span"); badge.className = `job-status ${routine.enabled ? "completed" : "waiting"}`; badge.textContent = routine.enabled ? t("routines.enabled", "Enabled") : t("routines.disabled", "Disabled");
      head.append(title, badge);
      const meta = document.createElement("div"); meta.className = "setting-feedback"; meta.style.margin = "0";
      const next = routine.nextRunAt ? new Date(routine.nextRunAt).toLocaleString() : "—";
      meta.textContent = `${scheduleLabel(routine.schedule)} · ${t("routines.nextRun", "Next run")}: ${next}${routine.lastStatus ? ` · ${t("routines.lastStatus", "Last status")}: ${routine.lastStatus}` : ""}`;
      const actions = document.createElement("div"); actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
      const open = document.createElement("button"); open.className = "quiet-action"; open.type = "button"; open.textContent = t("routines.history", "History"); open.addEventListener("click", () => openRoutineDetail(routine.id));
      const remove = document.createElement("button"); remove.className = "quiet-action"; remove.type = "button"; remove.textContent = t("routines.remove", "Remove"); remove.addEventListener("click", async () => { await window.sovereignbot.routines.remove({ routineId: routine.id }); await refreshRoutines(); });
      const consumedOneTime = routine.schedule?.type === "one-time" && Boolean(routine.lastRunAt);
      actions.append(open);
      if (!consumedOneTime) {
        const toggle = document.createElement("button"); toggle.className = "quiet-action"; toggle.type = "button"; toggle.textContent = routine.enabled ? t("routines.disable", "Disable") : t("routines.enable", "Enable"); toggle.addEventListener("click", async () => { await window.sovereignbot.routines.setEnabled({ routineId: routine.id, enabled: !routine.enabled }); await refreshRoutines(); });
        actions.append(toggle);
      }
      actions.append(remove);
      card.append(head, meta, actions); root.append(card);
    }
  }

  async function refreshRoutines() {
    try { const result = await window.sovereignbot.routines.list({}); routines = result?.routines ?? []; renderRoutineList(); } catch {}
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
        root.append(card);
      }
      $("routine-detail-dialog")?.showModal?.();
    } catch {}
  }

  function showScheduleFields() {
    const type = $("routine-type")?.value ?? "one-time";
    $("routine-field-at")?.classList.toggle("hidden", type !== "one-time");
    $("routine-field-minute")?.classList.toggle("hidden", type !== "hourly");
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
    if (type === "daily") return { type, time: $("routine-time").value };
    return { type, weekday: Number($("routine-weekday").value), time: $("routine-time").value };
  }

  async function populateRoutineForm() {
    const [cw, skills, workspaces] = await Promise.all([
      window.sovereignbot.coworkers.list({}).catch(() => ({ coworkers: [] })),
      window.sovereignbot.skills.list({}).catch(() => ({ skills: [] })),
      window.sovereignbot.workspaces.list({}).catch(() => ({ workspaces: [] })),
    ]);
    populateOwnerSelect(cw?.coworkers ?? [], "routine-owner");
    const skill = $("routine-skill"); skill.textContent = "";
    const none = document.createElement("option"); none.value = ""; none.textContent = t("routines.noSkill", "No skill"); skill.append(none);
    for (const item of skills?.skills ?? []) { const opt = document.createElement("option"); opt.value = item.id; opt.textContent = item.name; skill.append(opt); }
    const ws = $("routine-workspace"); ws.textContent = "";
    const def = document.createElement("option"); def.value = ""; def.textContent = t("routines.defaultWorkspace", "Coworker default"); ws.append(def);
    for (const item of workspaces?.workspaces ?? []) { const opt = document.createElement("option"); opt.value = item.id; opt.textContent = item.kind === "shared-project" ? "Shared project workspace / 共享项目工作区" : item.label || "Private workspace / 私有工作区"; ws.append(opt); }
    const inOneHour = new Date(Date.now() + 3600_000); const local = new Date(inOneHour.getTime() - inOneHour.getTimezoneOffset() * 60000).toISOString().slice(0,16); $("routine-at").value = local;
    $("routine-minute").value = String(new Date().getMinutes());
    showScheduleFields();
  }

  function applyRoutineTemplate() {
    const templates = {
      research: ["Daily research brief", "Collect a concise evidence-backed research brief for the team's current priorities.", "daily"],
      review: ["Weekly review", "Review completed work, open attention items, and the next bounded priorities.", "weekly"],
      operations: ["Daily operations check", "Check the team's bounded operational status and report concrete follow-up items.", "daily"],
      content: ["Content publishing prep", "Prepare the next content publishing package, flag missing inputs, and return the draft checklist.", "weekly"],
    };
    const value = templates[$("routine-template")?.value];
    if (!value) return;
    $("routine-name").value = value[0];
    $("routine-instruction").value = value[1];
    $("routine-type").value = value[2];
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
      const remote = $("job-execution").value === "worker-node";
      $("job-node-fields")?.classList.toggle("hidden", !remote);
      $("job-node-workspace")?.toggleAttribute("required", remote);
      $("job-node")?.toggleAttribute("required", remote);
    });
    $("job-node")?.addEventListener("change", () => {
      const workspace = $("job-node-workspace");
      if (!workspace) return;
      workspace.textContent = "";
      const selected = workerNodes.find((entry) => entry.nodeId === $("job-node").value);
      for (const entry of selected?.workspaces ?? []) {
        const option = document.createElement("option"); option.value = entry.id; option.textContent = `${entry.name} (${entry.id})`; workspace.append(option);
      }
    });
    $("job-form")?.addEventListener("submit", async (e) => {
      e.preventDefault(); const errEl = $("job-form-error"); errEl?.classList.add("hidden");
      try {
        const target = $("job-execution")?.value === "worker-node"
          ? { kind: "worker-node", nodeId: $("job-node").value, workspaceId: $("job-node-workspace").value }
          : { kind: "local" };
        await window.sovereignbot.jobs.submit({ title: $("job-title").value.trim(), objective: $("job-objective").value.trim(), ownerCoworkerId: $("job-owner").value, executionTarget: target });
        $("job-dialog")?.close(); $("job-form")?.reset(); await refresh();
      }
      catch (err) { if (errEl) { errEl.textContent = String(err?.message ?? err).replace(/^.*Error: /, "").slice(0, 400); errEl.classList.remove("hidden"); } }
    });
    $("job-detail-approve")?.addEventListener("click", async () => { if(!currentJobId) return; await window.sovereignbot.jobs.approve({ jobId: currentJobId }); $("job-detail-dialog")?.close(); await refreshAttention(); await refresh(); });
    $("job-detail-dismiss")?.addEventListener("click", async () => { if(!currentJobId) return; await window.sovereignbot.jobs.dismiss({ jobId: currentJobId }); $("job-detail-dialog")?.close(); await refreshAttention(); await refresh(); });
    $("job-detail-pause")?.addEventListener("click", async () => { if(!currentJobId) return; await window.sovereignbot.jobs.pause({ jobId: currentJobId }); $("job-detail-dialog")?.close(); await refresh(); });
    $("job-detail-resume")?.addEventListener("click", async () => { if(!currentJobId) return; await window.sovereignbot.jobs.resume({ jobId: currentJobId }); $("job-detail-dialog")?.close(); await refresh(); });
    $("routine-refresh")?.addEventListener("click", refreshRoutines);
    $("attention-refresh")?.addEventListener("click", refreshAttention);
    $("routine-new")?.addEventListener("click", async () => { await populateRoutineForm(); $("routine-dialog")?.showModal?.(); });
    $("routine-type")?.addEventListener("change", showScheduleFields);
    $("routine-template")?.addEventListener("change", applyRoutineTemplate);
    $("routine-form")?.addEventListener("submit", async (e) => {
      e.preventDefault(); const err = $("routine-form-error"); err?.classList.add("hidden");
      try {
        await window.sovereignbot.routines.create({ name: $("routine-name").value.trim(), instruction: $("routine-instruction").value.trim(), coworkerId: $("routine-owner").value, skillId: $("routine-skill").value || undefined, workspaceId: $("routine-workspace").value || undefined, schedule: scheduleFromForm() });
        $("routine-dialog")?.close(); $("routine-form")?.reset(); await refreshRoutines();
      } catch (error) { if (err) { err.textContent = String(error?.message ?? error).replace(/^.*Error: /, "").slice(0,400); err.classList.remove("hidden"); } }
    });
    document.addEventListener("sovereignbot:create-routine-from-skill", (event) => {
      void createRoutineFromSkill(event.detail?.skillId);
    });
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
