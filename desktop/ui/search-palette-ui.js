"use strict";

(() => {
  const api = window.sovereignbot;
  if (!api?.search?.query || !api?.palette?.list || !api?.palette?.execute) return;
  const $ = (id) => document.getElementById(id);
  const make = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const COMMAND_LABELS = new Map([["new-coworker", "New Coworker"], ["new-team", "New Team"], ["new-channel", "New Channel"], ["run-routine", "Run Routine"], ["teach-skill", "Teach Skill"], ["open-computer", "Open Computer"], ["search", "Search"]]);
  const MATCH_REASON_LABELS = new Map([["title-exact", "Exact title match / 标题精确匹配"], ["title-prefix", "Title match / 标题匹配"], ["title-contains", "Title match / 标题匹配"], ["phrase", "Phrase match / 短语匹配"], ["tags", "Tag match / 标签匹配"], ["subtitle", "Metadata match / 元数据匹配"], ["content", "Content match / 内容匹配"], ["token", "Keyword match / 关键词匹配"]]);
  let overlay, input, results, opener, mode = "commands", selected = 0, commandList = [];
  let routineDialog, routineForm, routineSearch, routineList, routineStatus, routineError, routineConfirm, routineOptions = [], selectedRoutineId;
  let searchTypes = new Set(["conversations", "channels", "coworkers", "projects", "artifacts", "skills", "playbooks", "routines", "memory", "jobs", "history"]);
  let projectId;
  let status = "active";
  let refreshSequence = 0;
  const close = () => { if (overlay) overlay.classList.add("hidden"); input?.blur(); opener?.focus?.(); opener = undefined; };
  const setStatus = (value) => { const status = $("palette-status"); if (status) status.textContent = value ?? ""; };
  const routineStateLabel = (routine) => routine.runState === "archived" ? "Archived / 已归档" : routine.runState === "disabled" ? "Disabled / 已停用" : routine.runState === "unavailable" ? "Unavailable / 不可用" : "Ready / 可运行";
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
    if (!visible.length) { routineList.append(make("p", "setting-feedback", routineOptions.length ? "No matching Routines / 没有匹配的例行任务" : "No Routines available / 没有可用例行任务")); if (routineConfirm) routineConfirm.disabled = true; return; }
    for (const routine of visible) {
      const option = make("button", "routine-run-option"); option.type = "button"; option.dataset.routineId = routine.id; option.disabled = routine.canRun !== true; option.setAttribute("role", "option"); option.setAttribute("aria-selected", routine.id === selectedRoutineId ? "true" : "false"); option.classList.toggle("selected", routine.id === selectedRoutineId);
      option.append(make("strong", "", routine.name), make("span", "", `${routineScheduleLabel(routine.schedule)} · ${routineStateLabel(routine)}${routine.lastStatus ? ` · Last: ${routine.lastStatus}` : ""}${routine.nextRunAt ? ` · Next: ${routine.nextRunAt}` : ""}`));
      option.addEventListener("click", () => { selectedRoutineId = routine.id; setRoutineError(); renderRoutineOptions(); }); routineList.append(option);
    }
    if (routineConfirm) routineConfirm.disabled = false;
  }
  async function loadRoutineOptions() {
    ensureRoutineDialog(); selectedRoutineId = undefined; setRoutineError(); if (routineStatus) routineStatus.textContent = "Loading Routines… / 正在加载例行任务…";
    try { const listed = await api.routines.list({ includeArchived: true }); routineOptions = (listed?.routines ?? []).map((routine) => ({ ...routine, canRun: routine.canRun === true, runState: routine.runState ?? (routine.state !== "active" ? "archived" : routine.enabled ? "ready" : "disabled") })); if (routineStatus) routineStatus.textContent = "Select one ready Routine to continue. / 请选择一个可运行的例行任务。"; renderRoutineOptions(); }
    catch (error) { routineOptions = []; renderRoutineOptions(); setRoutineError(String(error?.message ?? error).slice(0, 240)); if (routineStatus) routineStatus.textContent = "Routine list unavailable. / 例行任务列表不可用。"; }
  }
  async function openRoutineSelector() { ensureRoutineDialog(); routineSearch.value = ""; routineDialog?.showModal?.(); routineSearch?.focus(); await loadRoutineOptions(); routineSearch?.focus(); }
  async function runSelectedRoutine(event) {
    event.preventDefault(); const selectedRoutine = routineOptions.find((routine) => routine.id === selectedRoutineId);
    if (!selectedRoutine) { setRoutineError("Choose a ready Routine first. / 请先选择一个可运行的例行任务。"); return; }
    if (selectedRoutine.canRun !== true) { setRoutineError("This Routine is no longer runnable. Refresh and choose another. / 此例行任务已不可运行，请刷新后重新选择。"); return; }
    if (routineConfirm) routineConfirm.disabled = true; setRoutineError(); if (routineStatus) routineStatus.textContent = "Starting Routine… / 正在启动例行任务…";
    try { await api.palette.execute({ paletteId: "run-routine", args: { routineId: selectedRoutine.id } }); if (routineStatus) routineStatus.textContent = `Routine started: ${selectedRoutine.name} / 已启动`; routineDialog?.close(); setStatus(`Routine started: ${selectedRoutine.name} / 已启动`); }
    catch (error) { setRoutineError(String(error?.message ?? error).replace(/^.*Error: /, "").slice(0, 240)); if (routineStatus) routineStatus.textContent = "Routine was not started. / 例行任务未启动。"; if (routineConfirm) routineConfirm.disabled = false; }
  }
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = make("section", "command-palette hidden"); overlay.id = "command-palette"; overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-label", "Search and command palette");
    const card = make("div", "command-palette-card");
    const heading = make("div", "command-palette-heading"); heading.append(make("div", "eyebrow", "COMMAND PALETTE / 命令面板"), make("button", "modal-x", "×")); heading.lastChild.addEventListener("click", close);
    input = document.createElement("input"); input.type = "search"; input.placeholder = "Search people, projects, conversations, skills…"; input.setAttribute("aria-label", "Search or command"); input.setAttribute("aria-controls", "palette-results"); input.addEventListener("input", () => void refresh());
    const controls = make("div", "command-palette-controls");
    const scope = document.createElement("select"); scope.id = "palette-project-scope"; scope.setAttribute("aria-label", "Project scope"); scope.append(new Option("All Projects / 全部项目", "")); scope.addEventListener("change", () => { projectId = scope.value || undefined; void refresh(); });
    const type = document.createElement("select"); type.id = "palette-type-filter"; type.setAttribute("aria-label", "Search type filter"); type.append(new Option("All types / 全部类型", "all")); for (const entry of ["conversations", "channels", "coworkers", "projects", "artifacts", "skills", "playbooks", "routines", "memory", "jobs", "history"]) type.append(new Option(entry, entry)); type.addEventListener("change", () => { searchTypes = type.value === "all" ? new Set(["conversations", "channels", "coworkers", "projects", "artifacts", "skills", "playbooks", "routines", "memory", "jobs", "history"]) : new Set([type.value]); void refresh(); });
    const state = document.createElement("select"); state.id = "palette-status-filter"; state.setAttribute("aria-label", "Search status filter"); state.append(new Option("Active / 活跃", "active"), new Option("Archived / 已归档", "archived"), new Option("All status / 全部状态", "all")); state.addEventListener("change", () => { status = state.value; void refresh(); });
    controls.append(scope, type, state);
    results = make("div", "command-palette-results"); results.id = "palette-results"; results.setAttribute("role", "listbox");
    const status = make("p", "setting-feedback"); status.id = "palette-status";
    card.append(heading, input, controls, results, status); overlay.append(card); document.body.append(overlay);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
    input.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); close(); } else if (event.key === "ArrowDown") { event.preventDefault(); selected = Math.min(selected + 1, Math.max(0, results.children.length - 1)); paintSelection(); } else if (event.key === "ArrowUp") { event.preventDefault(); selected = Math.max(0, selected - 1); paintSelection(); } else if (event.key === "Enter") { event.preventDefault(); results.children[selected]?.click(); } });
    return overlay;
  }
  async function loadProjects() { const scope = $("palette-project-scope"); if (!scope) return; try { const listed = await api.projects.list({ includeArchived: true }); const current = scope.value; while (scope.options.length > 1) scope.remove(1); for (const project of listed.projects ?? []) { const option = new Option(`${project.name} · ${project.state}`, project.projectId); scope.append(option); } scope.value = current; } catch {} }
  function paintSelection() { [...results.children].forEach((node, index) => { node.classList.toggle("selected", index === selected); node.setAttribute("aria-selected", index === selected ? "true" : "false"); }); }
  function addResult(label, subtitle, fn) { const item = make("button", "command-palette-result"); item.type = "button"; item.setAttribute("role", "option"); item.append(make("strong", "command-palette-result-title", label), make("span", "command-palette-result-subtitle", subtitle)); item.addEventListener("click", () => void fn()); results.append(item); }
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
    if (commandId === "teach-skill") { close(); const button = document.querySelector("#details-teach-section button"); if (button) return button.click(); setStatus("Open a coworker conversation to start Teach Skill / 请先打开同事会话再开始教学"); return; }
  }
  async function refresh() {
    const sequence = ++refreshSequence;
    ensureOverlay(); results.textContent = ""; selected = 0; const value = input.value.trim();
    if (mode === "commands" && !value) { const response = await api.palette.list(); if (sequence !== refreshSequence) return; commandList = response.commands ?? []; for (const command of commandList) addResult(COMMAND_LABELS.get(command.id) ?? command.id, command.risk === "governed" ? "Governed action / 受 Governor 约束" : command.risk === "read-only" ? "Read only / 只读" : "Product action / 产品动作", () => void runPaletteCommand(command.id)); paintSelection(); return; }
    mode = "search"; const response = await api.search.query({ query: value, types: [...searchTypes], ...(projectId ? { projectId } : {}), status, limit: 50 }); if (sequence !== refreshSequence) return; for (const item of response.results ?? []) { const reason = MATCH_REASON_LABELS.get(item.matchReason?.key) ?? "Match / 匹配"; const snippet = item.matchSnippet ? ` · ${item.matchSnippet}` : ""; addResult(item.title, `${item.type} · ${item.subtitle} · ${item.status} · ${reason}${snippet}`, () => navigate(item)); } if (!response.results?.length) { results.append(make("p", "setting-feedback", "No matching visible results / 没有匹配的可见结果")); setStatus(""); } else { setStatus(`${response.total ?? response.results.length} result${(response.total ?? response.results.length) === 1 ? "" : "s"}${response.hasMore ? " · refine filters to see more / 可继续缩小筛选" : ""}`); } paintSelection();
  }
  async function open() { ensureOverlay(); opener = document.activeElement; overlay.classList.remove("hidden"); mode = "commands"; input.value = ""; await loadProjects(); await refresh(); input.focus(); }
  function installButton() {
    const existing = document.getElementById("open-command-palette");
    if (existing) {
      existing.addEventListener("click", () => void open());
      return;
    }
    const button = make("button", "quiet-action", "⌘K Search / 搜索");
    button.id = "open-command-palette";
    button.type = "button";
    button.setAttribute("aria-label", "Open search and command palette");
    button.addEventListener("click", () => void open());
    document.querySelector(".sidebar-top")?.append(button);
  }
  window.addEventListener("DOMContentLoaded", () => { installButton(); document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); void open(); } else if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) { event.preventDefault(); void open(); } }); });
})();
