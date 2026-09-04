"use strict";

(() => {
  const api = window.sovereignbot;
  if (!api?.search?.query || !api?.palette?.list || !api?.palette?.execute) return;
  const $ = (id) => document.getElementById(id);
  const t = (k, p) => globalThis.SovereignI18n?.t(k, p) || k;
  const make = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const COMMAND_LABELS = new Map([["new-coworker", "New Coworker"], ["new-team", "New Team"], ["new-channel", "New Channel"], ["run-routine", "Run Routine"], ["teach-skill", "Teach Skill"], ["open-computer", "Open Computer"], ["search", "Search"]]);
  const getMatchReasonLabel = (key) => {
    switch (key) {
      case "title-exact": return t("search.match.titleExact");
      case "title-prefix": return t("search.match.titlePrefix");
      case "title-contains": return t("search.match.titleContains");
      case "phrase": return t("search.match.phrase");
      case "tags": return t("search.match.tags");
      case "subtitle": return t("search.match.subtitle");
      case "content": return t("search.match.content");
      case "token": return t("search.match.token");
      default: return t("search.match.default");
    }
  };
  const MATCH_REASON_LABELS = { get: (key) => getMatchReasonLabel(key) };
  let overlay, input, results, opener, mode = "commands", selected = 0, commandList = [];
  let routineDialog, routineForm, routineSearch, routineList, routineStatus, routineError, routineConfirm, routineOptions = [], selectedRoutineId;
  let searchTypes = new Set(["conversations", "channels", "coworkers", "projects", "artifacts", "skills", "playbooks", "routines", "memory", "jobs", "history"]);
  let projectId;
  let status = "active";
  let refreshSequence = 0;
  const close = () => { if (overlay) overlay.classList.add("hidden"); input?.blur(); opener?.focus?.(); opener = undefined; };
  const setStatus = (value) => { const status = $("palette-status"); if (status) status.textContent = value ?? ""; };
  const routineStateLabel = (routine) => routine.runState === "archived" ? t("state.archived") : routine.runState === "disabled" ? t("state.disabled") : routine.runState === "unavailable" ? t("state.unavailable") : t("state.ready");
  const routineScheduleLabel = (schedule) => { if (!schedule) return "No schedule"; if (schedule.type === "one-time") return `One-time · ${schedule.at}`; if (schedule.type === "custom") return `Custom · every ${schedule.intervalMinutes} min`; if (schedule.type === "hourly") return `Hourly · :${String(schedule.minute).padStart(2, "0")}`; if (schedule.type === "daily") return `Daily · ${schedule.time}`; return `Weekly · day ${schedule.weekday} · ${schedule.time}`; };
  function ensureRoutineDialog() {
    if (routineDialog) return routineDialog;
    routineDialog = $("routine-run-dialog"); routineForm = $("routine-run-form"); routineSearch = $("routine-run-search"); routineList = $("routine-run-list"); routineStatus = $("routine-run-status"); routineError = $("routine-run-form-error"); routineConfirm = $("routine-run-confirm");
    routineSearch?.addEventListener("input", renderRoutineOptions); routineForm?.addEventListener("submit", runSelectedRoutine);
    return routineDialog;
  }
  function setRoutineError(value = "") { if (!routineError) return; routineError.textContent = value; routineError.classList.toggle("hidden", !value); }
  function renderRoutineOptions() {
    if (!routineList) return; routineList.textContent = ""; const query = routineSearch?.value.trim().toLowerCase() ?? "";
    const visible = routineOptions.filter((routine) => !query || [routine.name, routineScheduleLabel(routine.schedule), routineStateLabel(routine)].join(" ").toLowerCase().includes(query));
    if (!visible.length) { routineList.append(make("p", "setting-feedback", routineOptions.length ? t("routines.noMatch") : t("routines.empty"))); if (routineConfirm) routineConfirm.disabled = true; return; }
    for (const routine of visible) {
      const option = make("button", "routine-run-option"); option.type = "button"; option.dataset.routineId = routine.id; option.disabled = routine.canRun !== true; option.setAttribute("role", "option"); option.setAttribute("aria-selected", routine.id === selectedRoutineId ? "true" : "false"); option.classList.toggle("selected", routine.id === selectedRoutineId);
      option.append(make("strong", "", routine.name), make("span", "", `${routineScheduleLabel(routine.schedule)} · ${routineStateLabel(routine)}${routine.lastStatus ? ` · Last: ${routine.lastStatus}` : ""}${routine.nextRunAt ? ` · Next: ${routine.nextRunAt}` : ""}`));
      option.addEventListener("click", () => { selectedRoutineId = routine.id; setRoutineError(); renderRoutineOptions(); }); routineList.append(option);
    }
    if (routineConfirm) routineConfirm.disabled = false;
  }
  async function loadRoutineOptions() {
    ensureRoutineDialog(); selectedRoutineId = undefined; setRoutineError(); if (routineStatus) routineStatus.textContent = t("routines.loading");
    try { const listed = await api.routines.list({ includeArchived: true }); routineOptions = (listed?.routines ?? []).map((routine) => ({ ...routine, canRun: routine.canRun === true, runState: routine.runState ?? (routine.state !== "active" ? "archived" : routine.enabled ? "ready" : "disabled") })); if (routineStatus) routineStatus.textContent = t("routines.selectReady"); renderRoutineOptions(); }
    catch (error) { routineOptions = []; renderRoutineOptions(); setRoutineError(String(error?.message ?? error).slice(0, 240)); if (routineStatus) routineStatus.textContent = t("routines.unavailable"); }
  }
  async function openRoutineSelector() { ensureRoutineDialog(); routineSearch.value = ""; routineDialog?.showModal?.(); routineSearch?.focus(); await loadRoutineOptions(); routineSearch?.focus(); }
  async function runSelectedRoutine(event) {
    event.preventDefault(); const selectedRoutine = routineOptions.find((routine) => routine.id === selectedRoutineId);
    if (!selectedRoutine) { setRoutineError(t("routines.chooseFirst")); return; }
    if (selectedRoutine.canRun !== true) { setRoutineError(t("routines.noLongerRunnable")); return; }
    if (routineConfirm) routineConfirm.disabled = true; setRoutineError(); if (routineStatus) routineStatus.textContent = t("routines.starting");
    try { await api.palette.execute({ paletteId: "run-routine", args: { routineId: selectedRoutine.id } }); const msg = t("routines.started", { name: selectedRoutine.name }); if (routineStatus) routineStatus.textContent = msg; routineDialog?.close(); setStatus(msg); }
    catch (error) { setRoutineError(String(error?.message ?? error).replace(/^.*Error: /, "").slice(0, 240)); if (routineStatus) routineStatus.textContent = t("routines.notStarted"); if (routineConfirm) routineConfirm.disabled = false; }
  }
  const COMMAND_ICONS = new Map([
    ["new-coworker", "👤"],
    ["new-team", "👥"],
    ["new-channel", "💬"],
    ["run-routine", "⚡"],
    ["teach-skill", "🧠"],
    ["open-computer", "💻"],
    ["search", "🔍"]
  ]);
  const TYPE_ICONS = {
    conversations: "💬",
    channels: "📢",
    coworkers: "👤",
    projects: "📁",
    artifacts: "📄",
    skills: "🧠",
    playbooks: "📋",
    routines: "⚡",
    memory: "💡",
    jobs: "⚙",
    history: "🕒"
  };
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = make("section", "command-palette hidden"); overlay.id = "command-palette"; overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-label", "Search and command palette");
    const card = make("div", "command-palette-card");
    const heading = make("div", "command-palette-heading"); heading.append(make("div", "eyebrow", t("searchPalette.eyebrow")), make("button", "modal-x", "×")); heading.lastChild.addEventListener("click", close);
    const inputWrap = make("div", "command-palette-input-wrap");
    const searchIcon = make("span", "command-palette-search-icon", "🔍");
    input = document.createElement("input"); input.type = "search"; input.placeholder = t("search.placeholder") || "Search people, projects, conversations, skills…"; input.setAttribute("aria-label", "Search or command"); input.setAttribute("aria-controls", "palette-results"); input.addEventListener("input", () => void refresh());
    inputWrap.append(searchIcon, input);
    const controls = make("div", "command-palette-controls");
    const scope = document.createElement("select"); scope.id = "palette-project-scope"; scope.setAttribute("aria-label", "Project scope"); scope.append(new Option(t("apps.allProjects"), "")); scope.addEventListener("change", () => { projectId = scope.value || undefined; void refresh(); });
    const type = document.createElement("select"); type.id = "palette-type-filter"; type.setAttribute("aria-label", "Search type filter"); type.append(new Option(t("artifacts.allTypes"), "all")); for (const entry of ["conversations", "channels", "coworkers", "projects", "artifacts", "skills", "playbooks", "routines", "memory", "jobs", "history"]) type.append(new Option(entry, entry)); type.addEventListener("change", () => { searchTypes = type.value === "all" ? new Set(["conversations", "channels", "coworkers", "projects", "artifacts", "skills", "playbooks", "routines", "memory", "jobs", "history"]) : new Set([type.value]); void refresh(); });
    const state = document.createElement("select"); state.id = "palette-status-filter"; state.setAttribute("aria-label", "Search status filter"); state.append(new Option(t("state.active"), "active"), new Option(t("state.archived"), "archived"), new Option(t("state.all"), "all")); state.addEventListener("change", () => { status = state.value; void refresh(); });
    controls.append(scope, type, state);
    results = make("div", "command-palette-results"); results.id = "palette-results"; results.setAttribute("role", "listbox");
    const status = make("p", "setting-feedback"); status.id = "palette-status";
    card.append(heading, inputWrap, controls, results, status); overlay.append(card); document.body.append(overlay);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
    input.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); close(); } else if (event.key === "ArrowDown") { event.preventDefault(); selected = Math.min(selected + 1, Math.max(0, results.children.length - 1)); paintSelection(); } else if (event.key === "ArrowUp") { event.preventDefault(); selected = Math.max(0, selected - 1); paintSelection(); } else if (event.key === "Enter") { event.preventDefault(); results.children[selected]?.click(); } });
    return overlay;
  }
  async function loadProjects() { const scope = $("palette-project-scope"); if (!scope) return; try { const listed = await api.projects.list({ includeArchived: true }); const current = scope.value; while (scope.options.length > 1) scope.remove(1); for (const project of listed.projects ?? []) { const option = new Option(`${project.name} · ${project.state}`, project.projectId); scope.append(option); } scope.value = current; } catch {} }
  function paintSelection() { [...results.children].forEach((node, index) => { node.classList.toggle("selected", index === selected); node.setAttribute("aria-selected", index === selected ? "true" : "false"); }); }
  function addResult(label, subtitle, fn, icon = "🔍") {
    const item = make("button", "command-palette-result");
    item.type = "button";
    item.setAttribute("role", "option");
    const iconEl = make("span", "command-palette-result-icon", icon);
    const textWrap = make("div", "command-palette-result-text");
    textWrap.append(make("strong", "command-palette-result-title", label), make("span", "command-palette-result-subtitle", subtitle));
    item.append(iconEl, textWrap);
    item.addEventListener("click", () => void fn());
    results.append(item);
  }
  function navigate(item) {
    const nav = item.navigation ?? {};
    close();
    if (nav.view === "memory") return void document.dispatchEvent(new CustomEvent("sovereignbot:open-memory", { detail: nav }));
    if (nav.view === "projects") return void document.dispatchEvent(new CustomEvent("sovereignbot:open-project", { detail: nav }));
    if (nav.view === "artifacts" && nav.artifactId) return void document.dispatchEvent(new CustomEvent("sovereignbot:open-artifact", { detail: nav }));
    if (nav.coworkerId && typeof openDirect === "function") return void openDirect(nav.coworkerId);
    if (nav.conversationId && typeof openConversation === "function") return void openConversation(nav.conversationId, { messageId: nav.messageId });
    if (nav.view === "skills" && nav.skillId) { if (typeof switchView === "function") switchView("skills"); return void document.dispatchEvent(new CustomEvent("sovereignbot:open-skill-editor", { detail: { item: { id: nav.skillId } } })); }
    if (nav.view === "playbooks" && nav.playbookId) { if (typeof switchView === "function") switchView("playbooks"); return void document.dispatchEvent(new CustomEvent("sovereignbot:open-playbook-editor", { detail: { item: { id: nav.playbookId } } })); }
    if (nav.view === "routines" && nav.routineId) return void document.dispatchEvent(new CustomEvent("sovereignbot:open-routine", { detail: nav }));
    if (nav.view === "projects" && typeof switchView === "function") return void switchView("projects");
    const allowedViews = new Set(["conversation", "projects", "artifacts", "skills", "playbooks", "routines", "channels", "memory", "work", "computer-history"]);
    if (typeof switchView === "function" && allowedViews.has(nav.view)) switchView(nav.view);
  }
  async function runPaletteCommand(commandId) {
    if (["new-coworker", "new-team", "new-channel"].includes(commandId)) {
      close(); const target = { "new-coworker": "new-coworker", "new-team": "new-team", "new-channel": "team-create-channel" }[commandId]; if ($(target)) $(target).click(); else if (commandId === "new-channel") $("product-channel-create-page")?.click(); return;
    }
    if (commandId === "search") { mode = "search"; input.value = ""; await refresh(); input.focus(); return; }
    if (commandId === "open-computer") { close(); const button = $("open-computer"); if (button) return button.click(); const coworkers = (await api.coworkers.list({})).coworkers ?? []; const coworker = coworkers[0]; if (coworker) await api.palette.execute({ paletteId: commandId, args: { coworkerId: coworker.id } }); return; }
    if (commandId === "run-routine") return openRoutineSelector();
    if (commandId === "teach-skill") { close(); const button = document.querySelector("#details-teach-section button"); if (button) return button.click(); setStatus(t("teach.openFirst")); return; }
  }
  async function refresh() {
    const sequence = ++refreshSequence;
    ensureOverlay(); results.textContent = ""; selected = 0; const value = input.value.trim();
    if (mode === "commands" && !value) {
      const response = await api.palette.list();
      if (sequence !== refreshSequence) return;
      commandList = response.commands ?? [];
      for (const command of commandList) {
        const icon = COMMAND_ICONS.get(command.id) ?? "⚡";
        addResult(COMMAND_LABELS.get(command.id) ?? command.id, command.risk === "governed" ? t("searchPalette.riskGoverned") : command.risk === "read-only" ? t("searchPalette.riskReadOnly") : t("searchPalette.riskProduct"), () => void runPaletteCommand(command.id), icon);
      }
      paintSelection();
      return;
    }
    mode = "search";
    const response = await api.search.query({ query: value, types: [...searchTypes], ...(projectId ? { projectId } : {}), status, limit: 50 });
    if (sequence !== refreshSequence) return;
    for (const item of response.results ?? []) {
      const reason = getMatchReasonLabel(item.matchReason?.key);
      const snippet = item.matchSnippet ? ` · ${item.matchSnippet}` : "";
      const icon = TYPE_ICONS[item.type] ?? "🔍";
      addResult(item.title, `${item.type} · ${item.subtitle} · ${item.status} · ${reason}${snippet}`, () => navigate(item), icon);
    }
    if (!response.results?.length) {
      results.append(make("p", "setting-feedback", t("searchPalette.noResults")));
      setStatus("");
    } else {
      setStatus(`${response.total ?? response.results.length} result${(response.total ?? response.results.length) === 1 ? "" : "s"}${response.hasMore ? ` · ${t("searchPalette.refineFilters")}` : ""}`);
    }
    paintSelection();
  }
  async function open() { ensureOverlay(); opener = document.activeElement; overlay.classList.remove("hidden"); mode = "commands"; input.value = ""; await loadProjects(); await refresh(); input.focus(); }
  function installButton() {
    const existing = document.getElementById("open-command-palette");
    if (existing) {
      existing.addEventListener("click", () => void open());
      return;
    }
    const button = make("button", "quiet-action", `⌘K ${t("nav.search")}`);
    button.id = "open-command-palette";
    button.type = "button";
    button.setAttribute("aria-label", "Open search and command palette");
    button.addEventListener("click", () => void open());
    document.querySelector(".sidebar-top")?.append(button);
  }
  window.addEventListener("DOMContentLoaded", () => { installButton(); document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); void open(); } else if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) { event.preventDefault(); void open(); } }); });
})();
