(function () {
  const $ = (id) => document.getElementById(id);
  const t = (key, fallback) => globalThis.SovereignI18n?.t(key) ?? fallback ?? key;
  let triggers = [];
  let routines = [];
  let workspaces = [];
  let pollTimer;

  function ensureSurface() {
    if ($("view-triggers")) return;
    const section = document.createElement("section");
    section.id = "view-triggers";
    section.className = "main-view settings-view hidden";
    section.innerHTML = `
      <header class="page-header"><div><span class="eyebrow" data-i18n="triggers.title">Triggers</span><h1 data-i18n="triggers.title">Triggers</h1><p data-i18n="triggers.subtitle">Run an enabled recurring Routine when a trusted workspace changes.</p><p class="setting-feedback" data-i18n="triggers.safetyCopy">Events are observed only while SovereignBot is running. File contents are never read automatically.</p></div><div style="display:flex;gap:8px;align-items:center"><button id="triggers-refresh" class="quiet-action" type="button" data-i18n="action.refresh">Refresh</button><button id="triggers-new" class="hero-action" type="button" data-i18n="triggers.create">New trigger</button></div></header>
      <p id="triggers-error" class="inline-error hidden"></p>
      <div id="trigger-list" class="workspace-cards"></div>
      <dialog id="trigger-dialog" class="modal"><form id="trigger-form" method="dialog" class="modal-card"><div class="modal-heading"><div><span class="eyebrow" data-i18n="triggers.title">TRIGGERS</span><h2 data-i18n="triggers.create">New trigger</h2></div><button class="modal-x" data-close-dialog="trigger-dialog" type="button">×</button></div><label><span data-i18n="triggers.name">Name</span><input id="trigger-name" maxlength="120" required></label><label><span data-i18n="triggers.routine">Routine</span><select id="trigger-routine" required></select></label><label><span data-i18n="triggers.workspace">Trusted workspace</span><select id="trigger-workspace" required></select></label><label><span data-i18n="triggers.pathPrefix">Path prefix</span><input id="trigger-prefix" maxlength="512" placeholder="inbox/reports"><small data-i18n="triggers.pathPrefixHint">Optional relative path prefix; leave empty for the whole workspace.</small></label><p id="trigger-form-error" class="inline-error hidden"></p><div class="modal-actions"><button class="quiet-action" data-close-dialog="trigger-dialog" type="button" data-i18n="action.cancel">Cancel</button><button class="hero-action" type="submit" data-i18n="triggers.create">New trigger</button></div></form></dialog>`;
    document.querySelector(".workspace-shell")?.append(section);
    applyLocale();
  }

  function applyLocale() {
    for (const el of $("view-triggers")?.querySelectorAll("[data-i18n]") ?? []) el.textContent = t(el.dataset.i18n, el.textContent);
    const nav = $("nav-triggers")?.querySelector("[data-i18n]");
    if (nav) nav.textContent = t(nav.dataset.i18n, nav.textContent);
    renderList();
  }

  function showError(message) {
    const el = $("triggers-error");
    if (!el) return;
    el.textContent = message ? String(message).slice(0, 400) : "";
    el.classList.toggle("hidden", !message);
  }

  function statusLabel(status, enabled) {
    if (status === "blocked") return t("triggers.blocked", "Blocked");
    if (status === "error") return t("triggers.error", "Error");
    if (!enabled) return t("triggers.disabled", "Disabled");
    if (status === "fired") return t("triggers.fired", "Fired");
    if (status === "pending") return t("triggers.pending", "Pending");
    return t("triggers.ready", "Ready");
  }

  function renderList() {
    const root = $("trigger-list");
    if (!root) return;
    root.textContent = "";
    if (!triggers.length) {
      const empty = document.createElement("p"); empty.className = "setting-feedback"; empty.textContent = t("triggers.empty", "No event triggers yet."); root.append(empty); return;
    }
    const routineById = new Map(routines.map((item) => [item.id, item]));
    const workspaceById = new Map(workspaces.map((item) => [item.id, item]));
    for (const trigger of triggers) {
      const card = document.createElement("div"); card.className = "job-card";
      const head = document.createElement("div"); head.className = "job-card-head";
      const title = document.createElement("strong"); title.textContent = trigger.name;
      const badge = document.createElement("span"); badge.className = `job-status ${trigger.lastStatus === "blocked" || trigger.lastStatus === "error" ? "failed" : trigger.enabled ? "completed" : "waiting"}`; badge.textContent = statusLabel(trigger.lastStatus, trigger.enabled);
      head.append(title, badge);
      const routine = routineById.get(trigger.routineId);
      const workspace = workspaceById.get(trigger.workspaceId);
      const meta = document.createElement("div"); meta.className = "setting-feedback"; meta.style.margin = "0";
      meta.textContent = `${t("triggers.routine", "Routine")}: ${routine?.name ?? trigger.routineId} · ${t("triggers.workspace", "Workspace")}: ${workspace?.path ?? trigger.workspaceId} · ${t("triggers.pathPrefix", "Path prefix")}: ${trigger.pathPrefix || t("triggers.wholeWorkspace", "whole workspace")}`;
      const event = document.createElement("div"); event.className = "setting-feedback"; event.style.margin = "8px 0 0";
      const eventTime = trigger.lastEventAt ? new Date(trigger.lastEventAt).toLocaleString() : "—";
      event.textContent = `${t("triggers.lastEvent", "Last event")}: ${eventTime} · ${t("triggers.lastPath", "Path")}: ${trigger.lastRelativePath || "—"} · ${t("triggers.lastStatus", "Status")}: ${statusLabel(trigger.lastStatus, trigger.enabled)} · ${t("triggers.failureCount", "Failures")}: ${trigger.failureCount ?? 0}`;
      const actions = document.createElement("div"); actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:10px";
      const toggle = document.createElement("button"); toggle.className = "quiet-action"; toggle.type = "button"; toggle.textContent = trigger.enabled ? t("triggers.disable", "Disable") : t("triggers.enable", "Enable");
      toggle.addEventListener("click", async () => { try { await window.sovereignbot.eventTriggers.setEnabled({ triggerId: trigger.id, enabled: !trigger.enabled }); await refresh(); } catch (error) { showError(error?.message ?? error); } });
      const remove = document.createElement("button"); remove.className = "quiet-action"; remove.type = "button"; remove.textContent = t("triggers.remove", "Remove");
      remove.addEventListener("click", async () => { try { await window.sovereignbot.eventTriggers.remove({ triggerId: trigger.id }); await refresh(); } catch (error) { showError(error?.message ?? error); } });
      actions.append(toggle, remove);
      card.append(head, meta, event);
      if (trigger.lastError) { const error = document.createElement("p"); error.className = "inline-error"; error.textContent = `${t("triggers.lastError", "Error")}: ${trigger.lastError}`; card.append(error); }
      card.append(actions); root.append(card);
    }
  }

  async function refresh() {
    try {
      const [triggerResult, routineResult, workspaceResult] = await Promise.all([
        window.sovereignbot.eventTriggers.list({}),
        window.sovereignbot.routines.list({}),
        window.sovereignbot.workspaces.list({}),
      ]);
      triggers = triggerResult?.triggers ?? [];
      routines = routineResult?.routines ?? [];
      workspaces = workspaceResult?.workspaces ?? [];
      showError("");
      renderList();
    } catch (error) { showError(error?.message ?? error); }
  }

  function populateForm() {
    const routineSelect = $("trigger-routine");
    const workspaceSelect = $("trigger-workspace");
    if (!routineSelect || !workspaceSelect) return;
    routineSelect.textContent = "";
    workspaceSelect.textContent = "";
    const eligible = routines.filter((routine) => routine.enabled && routine.workspaceId && ["hourly", "daily", "weekly"].includes(routine.schedule?.type));
    for (const routine of eligible) { const option = document.createElement("option"); option.value = routine.id; option.textContent = routine.name; option.dataset.workspaceId = routine.workspaceId; routineSelect.append(option); }
    for (const workspace of workspaces) { const option = document.createElement("option"); option.value = workspace.id; option.textContent = workspace.path; workspaceSelect.append(option); }
    if (!eligible.length) { const option = document.createElement("option"); option.value = ""; option.textContent = t("triggers.noRoutines", "No enabled recurring workspace routines"); routineSelect.append(option); }
    const syncWorkspace = () => { const selected = routineSelect.selectedOptions[0]?.dataset.workspaceId; if (selected && [...workspaceSelect.options].some((option) => option.value === selected)) workspaceSelect.value = selected; };
    routineSelect.onchange = syncWorkspace;
    syncWorkspace();
  }

  function showTriggers() {
    ensureSurface();
    for (const view of document.querySelectorAll(".main-view")) view.classList.add("hidden");
    $("view-triggers")?.classList.remove("hidden");
    for (const id of ["nav-work", "nav-attention", "nav-routines", "nav-worker-nodes", "nav-settings"]) $(id)?.classList.remove("active");
    $("nav-triggers")?.classList.add("active");
    clearTimeout(pollTimer);
    const poll = () => refresh().finally(() => { if (!$('view-triggers')?.classList.contains("hidden")) pollTimer = setTimeout(poll, 5000); });
    pollTimer = setTimeout(poll, 5000);
    void refresh();
  }

  function bindEvents() {
    $("nav-triggers")?.addEventListener("click", showTriggers);
    $("triggers-refresh")?.addEventListener("click", refresh);
    $("triggers-new")?.addEventListener("click", async () => { await refresh(); populateForm(); $("trigger-dialog")?.showModal?.(); });
    $("trigger-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const error = $("trigger-form-error"); error?.classList.add("hidden");
      try {
        await window.sovereignbot.eventTriggers.create({ name: $("trigger-name").value.trim(), routineId: $("trigger-routine").value, workspaceId: $("trigger-workspace").value, pathPrefix: $("trigger-prefix").value.trim() });
        $("trigger-dialog")?.close(); $("trigger-form")?.reset(); await refresh();
      } catch (failure) { if (error) { error.textContent = String(failure?.message ?? failure).slice(0, 400); error.classList.remove("hidden"); } }
    });
  }

  function init() {
    ensureSurface();
    bindEvents();
    void refresh();
    new MutationObserver(() => applyLocale()).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  }

  globalThis.SovereignTriggersUI = { refresh, showTriggers };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
