"use strict";

(() => {
  const api = window.sovereignbot;
  if (!api?.search?.query || !api?.palette?.list || !api?.palette?.execute) return;
  const $ = (id) => document.getElementById(id);
  const make = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const COMMAND_LABELS = new Map([["new-coworker", "New Coworker"], ["new-team", "New Team"], ["new-channel", "New Channel"], ["run-routine", "Run Routine"], ["teach-skill", "Teach Skill"], ["open-computer", "Open Computer"], ["search", "Search"]]);
  let overlay, input, results, opener, mode = "commands", selected = 0, commandList = [];
  let searchTypes = new Set(["conversations", "channels", "coworkers", "projects", "artifacts", "skills", "playbooks", "routines", "memory", "jobs", "history"]);
  let projectId;
  let status = "active";
  const close = () => { if (overlay) overlay.classList.add("hidden"); input?.blur(); opener?.focus?.(); opener = undefined; };
  const setStatus = (value) => { const status = $("palette-status"); if (status) status.textContent = value ?? ""; };
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
    if (nav.conversationId && typeof openConversation === "function") return void openConversation(nav.conversationId);
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
    if (commandId === "run-routine") { const routines = (await api.routines.list({})).routines ?? []; if (!routines.length) return setStatus("No routines available / 没有可用 Routine"); const labels = routines.map((entry, index) => `${index + 1}. ${entry.name}`).join("\n"); const choice = Number(window.prompt(`Choose a routine / 选择 Routine:\n${labels}`, "1")); const selectedRoutine = routines[choice - 1]; if (selectedRoutine) { await api.palette.execute({ paletteId: commandId, args: { routineId: selectedRoutine.id } }); setStatus(`Routine started: ${selectedRoutine.name}`); } return; }
    if (commandId === "teach-skill") { close(); const button = document.querySelector("#details-teach-section button"); if (button) return button.click(); setStatus("Open a coworker conversation to start Teach Skill / 请先打开同事会话再开始教学"); return; }
  }
  async function refresh() {
    ensureOverlay(); results.textContent = ""; selected = 0; const value = input.value.trim();
    if (mode === "commands" && !value) { commandList = (await api.palette.list()).commands ?? []; for (const command of commandList) addResult(COMMAND_LABELS.get(command.id) ?? command.id, command.risk === "governed" ? "Governed action / 受 Governor 约束" : command.risk === "read-only" ? "Read only / 只读" : "Product action / 产品动作", () => void runPaletteCommand(command.id)); paintSelection(); return; }
    mode = "search"; const response = await api.search.query({ query: value, types: [...searchTypes], ...(projectId ? { projectId } : {}), status, limit: 50 }); for (const item of response.results ?? []) addResult(item.title, `${item.type} · ${item.subtitle} · ${item.status}`, () => navigate(item)); if (!response.results?.length) results.append(make("p", "setting-feedback", "No matching visible results / 没有匹配的可见结果")); paintSelection();
  }
  async function open() { ensureOverlay(); opener = document.activeElement; overlay.classList.remove("hidden"); mode = "commands"; input.value = ""; await loadProjects(); await refresh(); input.focus(); }
  function installButton() { const button = make("button", "quiet-action", "⌘K Search / 搜索"); button.id = "open-command-palette"; button.type = "button"; button.setAttribute("aria-label", "Open search and command palette"); button.addEventListener("click", () => void open()); document.querySelector(".sidebar-top")?.append(button); }
  window.addEventListener("DOMContentLoaded", () => { installButton(); document.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); void open(); } else if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) { event.preventDefault(); void open(); } }); });
})();
