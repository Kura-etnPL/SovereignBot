"use strict";

(() => {
  const api = window.sovereignbot;
  if (!api?.memory?.list || !api?.memory?.listSuggestions) return;
  const $ = (id) => document.getElementById(id);
  let selectedMemoryId;
  let pendingOwnerId;
  let editingMemory;
  let deleteCandidate;
  const pendingMemoryActions = new Set();
  let refreshSequence = 0;
  let owners = { coworker: [], team: [], project: [] };
  const text = (value) => String(value ?? "");
  const errorText = (reason) => text(reason?.message ?? reason).replace(/^.*Error: /, "").slice(0, 240);
  const setResult = (value) => { const node = $("memory-result"); if (node) node.textContent = value ?? ""; };
  const memoryActionKey = (memory, action, target = scopeTarget()) => `${target.scope}:${target.ownerId}:${memory.id}:${action}`;
  const button = (label, fn, { key, busyLabel = "Working… / 处理中…" } = {}) => {
    const node = document.createElement("button"); node.type = "button"; node.className = "quiet-action"; node.textContent = label;
    node.addEventListener("click", () => {
      if (key && pendingMemoryActions.has(key)) return;
      if (key) { pendingMemoryActions.add(key); node.disabled = true; node.textContent = busyLabel; }
      Promise.resolve().then(fn).catch((reason) => setResult(errorText(reason))).finally(() => { if (key) { pendingMemoryActions.delete(key); node.disabled = false; node.textContent = label; } });
    });
    return node;
  };
  const selected = (id) => $(id)?.value || "";
  const scopeTarget = () => ({ scope: selected("memory-scope"), ownerId: selected("memory-owner") });
  const listTarget = () => ({ ...scopeTarget(), limit: 100, ...(selected("memory-state") === "all" ? { includeForgotten: true } : {}) });
  const canAddProjectFact = () => selected("memory-scope") === "project" && owners.project.some((entry) => entry.value === selected("memory-owner") && entry.state === "active");
  function syncAddFactButton() {
    const node = $("memory-add-fact");
    if (!node) return;
    const enabled = canAddProjectFact();
    node.disabled = !enabled;
    node.classList.toggle("hidden", !enabled);
  }
  function openFactDialog() {
    if (!canAddProjectFact()) { setResult("Choose an active Project first / 请先选择一个活跃项目"); return; }
    const dialog = $("memory-fact-dialog");
    if (!dialog?.showModal) return;
    $("memory-fact-form")?.reset();
    $("memory-fact-form-error")?.classList.add("hidden");
    dialog.showModal();
    $("memory-fact-title")?.focus();
  }
  async function saveFact(event) {
    event.preventDefault();
    if (!canAddProjectFact()) { $("memory-fact-form-error").textContent = "Choose an active Project first / 请先选择一个活跃项目"; $("memory-fact-form-error").classList.remove("hidden"); return; }
    const title = text($("memory-fact-title")?.value).trim();
    const content = text($("memory-fact-content")?.value).trim();
    const tags = text($("memory-fact-tags")?.value).split(",").map((entry) => entry.trim()).filter(Boolean);
    const error = $("memory-fact-form-error");
    if (!title || !content) { if (error) { error.textContent = "Title and content are required / 标题和内容不能为空"; error.classList.remove("hidden"); } return; }
    if (tags.length > 16) { if (error) { error.textContent = "Use at most 16 tags / 最多使用 16 个标签"; error.classList.remove("hidden"); } return; }
    try {
      const fact = await api.memory.putFact({ scope: "project", ownerId: selected("memory-owner"), draft: { key: title, title, content, ...(tags.length ? { tags } : {}) }, label: "User-added Project fact" });
      $("memory-fact-dialog")?.close();
      selectedMemoryId = fact?.id;
      setResult("Approved Project fact saved / 项目事实已保存");
      await refresh();
    } catch (reason) {
      if (error) { error.textContent = errorText(reason); error.classList.remove("hidden"); }
    }
  }
  function openEditDialog(memory, target = scopeTarget(), onSaved) {
    const dialog = $("memory-edit-dialog");
    if (!dialog?.showModal) return;
    editingMemory = { id: memory.id, scope: target.scope, ownerId: target.ownerId, onSaved };
    $("memory-edit-title").value = memory.title;
    $("memory-edit-content").value = memory.content;
    $("memory-edit-tags").value = (memory.tags ?? []).join(", ");
    $("memory-edit-form-error")?.classList.add("hidden");
    dialog.showModal();
    $("memory-edit-title")?.focus();
  }
  async function saveEdit(event) {
    event.preventDefault();
    const error = $("memory-edit-form-error");
    if (!editingMemory) { if (error) { error.textContent = "Choose a memory to edit / 请选择要编辑的记忆"; error.classList.remove("hidden"); } return; }
    const title = text($("memory-edit-title")?.value).trim();
    const content = text($("memory-edit-content")?.value).trim();
    const tags = text($("memory-edit-tags")?.value).split(",").map((entry) => entry.trim()).filter(Boolean);
    if (!title || !content) { if (error) { error.textContent = "Title and content are required / 标题和内容不能为空"; error.classList.remove("hidden"); } return; }
    if (tags.length > 16) { if (error) { error.textContent = "Use at most 16 tags / 最多使用 16 个标签"; error.classList.remove("hidden"); } return; }
    const current = editingMemory;
    const key = `${current.scope}:${current.ownerId}:${current.id}:edit`;
    if (pendingMemoryActions.has(key)) return;
    const submit = event.currentTarget?.querySelector("button[type=submit]");
    pendingMemoryActions.add(key);
    if (submit) { submit.disabled = true; submit.textContent = "Saving… / 保存中…"; }
    try {
      const updated = await api.memory.update({ scope: current.scope, ownerId: current.ownerId, memoryId: current.id, patch: { title, content, tags } });
      $("memory-edit-dialog")?.close();
      editingMemory = undefined;
      selectedMemoryId = updated?.id ?? selectedMemoryId;
      setResult("Memory updated / 记忆已更新");
      await refresh();
      await current.onSaved?.(updated);
    } catch (reason) {
      if (error) { error.textContent = errorText(reason); error.classList.remove("hidden"); }
    } finally {
      pendingMemoryActions.delete(key);
      if (submit) { submit.disabled = false; submit.textContent = "Save changes / 保存修改"; }
    }
  }
  function openDeleteDialog(memory, target = scopeTarget(), onDeleted) {
    const dialog = $("memory-delete-dialog");
    if (!dialog?.showModal) return;
    const key = memoryActionKey(memory, "delete", target);
    if (pendingMemoryActions.has(key)) return;
    deleteCandidate = { id: memory.id, title: memory.title, content: memory.content, scope: target.scope, ownerId: target.ownerId, onDeleted, key };
    $("memory-delete-scope").textContent = `Scope / 归属: ${target.scope}`;
    $("memory-delete-summary").textContent = `${memory.title || "Untitled memory"} — ${text(memory.content).replace(/\s+/g, " ").trim().slice(0, 240)}${text(memory.content).length > 240 ? "…" : ""}`;
    $("memory-delete-form-error")?.classList.add("hidden");
    dialog.showModal();
  }
  async function confirmDelete(event) {
    event.preventDefault();
    const current = deleteCandidate;
    const error = $("memory-delete-form-error");
    if (!current) { if (error) { error.textContent = "Choose a memory to delete / 请选择要删除的记忆"; error.classList.remove("hidden"); } return; }
    if (pendingMemoryActions.has(current.key)) return;
    const submit = $("memory-delete-confirm");
    const cancel = $("memory-delete-form")?.querySelector("[data-close-dialog]");
    pendingMemoryActions.add(current.key);
    if (submit) { submit.disabled = true; submit.textContent = "Deleting… / 删除中…"; }
    if (cancel) cancel.disabled = true;
    try {
      await api.memory.delete({ scope: current.scope, ownerId: current.ownerId, memoryId: current.id });
      $("memory-delete-dialog")?.close();
      deleteCandidate = undefined;
      if (selectedMemoryId === current.id) selectedMemoryId = undefined;
      setResult("Memory deleted / 记忆已删除");
      await refresh();
      await current.onDeleted?.();
    } catch (reason) {
      if (error) { error.textContent = errorText(reason); error.classList.remove("hidden"); }
    } finally {
      pendingMemoryActions.delete(current.key);
      if (submit) { submit.disabled = false; submit.textContent = "Delete memory / 删除记忆"; }
      if (cancel) cancel.disabled = false;
    }
  }
  function activate() {
    if (typeof switchView === "function") switchView("memory");
    document.querySelectorAll(".utility-nav").forEach((node) => node.classList.toggle("active", node.id === "nav-memory"));
  }
  async function loadOwners() {
    const [coworkers, teams, projects] = await Promise.all([
      api.coworkers?.list ? api.coworkers.list({ includeArchived: true }) : { coworkers: [] },
      api.teams?.list ? api.teams.list({}) : { teams: [] },
      api.projects?.list ? api.projects.list({ includeArchived: true, limit: 100 }) : { projects: [] },
    ]);
    owners = {
      coworker: (coworkers.coworkers ?? []).map((entry) => ({ value: entry.id, label: `${entry.name} · ${entry.state}` })),
      team: (teams.teams ?? []).map((entry) => ({ value: entry.id, label: entry.name })),
      project: (projects.projects ?? []).map((entry) => ({ value: entry.projectId, label: `${entry.name} · ${entry.state}`, state: entry.state })),
    };
  }
  function renderOwnerOptions() {
    const node = $("memory-owner");
    if (!node) return;
    const current = node.value;
    node.textContent = "";
    const options = owners[selected("memory-scope")] ?? [];
    if (!options.length) node.append(new Option("No scope owners / 没有可用归属", ""));
    for (const entry of options) node.append(new Option(entry.label, entry.value));
    if ([...node.options].some((option) => option.value === pendingOwnerId)) node.value = pendingOwnerId;
    else if ([...node.options].some((option) => option.value === current)) node.value = current;
    else if (options[0]) node.value = options[0].value;
    pendingOwnerId = undefined;
    syncAddFactButton();
  }
  function sourceAction(memory, sourceNode) {
    return button("Source / 来源", async () => {
      const trace = await api.memory.sourceTrace({ ...scopeTarget(), memoryId: memory.id });
      sourceNode.textContent = `Source: ${trace?.label ?? "Unavailable"}`;
      const navigation = trace?.navigation;
      if (navigation?.conversationId && typeof openConversation === "function") openConversation(navigation.conversationId);
      else if (navigation?.view === "artifacts") document.dispatchEvent(new CustomEvent("sovereignbot:open-artifact", { detail: navigation }));
      else if (navigation?.view === "memory") { selectedMemoryId = memory.id; activate(); }
      else if (navigation?.view && typeof switchView === "function") switchView(navigation.view);
    });
  }
  function renderMemories(memories) {
    const root = $("memory-list");
    if (!root) return;
    root.textContent = "";
    for (const memory of memories) {
      const card = document.createElement("article"); card.className = "settings-card memory-row"; if (memory.id === selectedMemoryId) card.classList.add("selected");
      const title = document.createElement("h3"); title.textContent = `${memory.title}${memory.pinned ? " · pinned" : ""}`;
      const content = document.createElement("p"); content.textContent = memory.content;
      const meta = document.createElement("small"); meta.textContent = `${memory.state} · ${(memory.tags ?? []).join(", ") || "no tags"}`;
      const reason = document.createElement("small"); reason.className = "memory-match-reason"; reason.textContent = `Match: ${memory.matchReason?.label ?? "Recent memory / 最近记忆"}`;
      const source = document.createElement("small"); source.textContent = `Source: ${memory.source?.label ?? "Unavailable"}`;
      const actions = document.createElement("div"); actions.className = "detail-actions";
      const target = scopeTarget();
      actions.append(button(memory.pinned ? "Unpin / 取消置顶" : "Pin / 置顶", async () => { await api.memory.pin({ ...target, memoryId: memory.id, pinned: !memory.pinned }); await refresh(); }, { key: memoryActionKey(memory, "pin", target) }), button("Edit / 编辑", () => openEditDialog(memory, target)), button("Forget / 忘记", async () => { if (memory.state === "forgotten") return; await api.memory.forget({ ...target, memoryId: memory.id }); await refresh(); }, { key: memoryActionKey(memory, "forget", target) }), button("Delete / 删除", () => openDeleteDialog(memory, target), { key: memoryActionKey(memory, "delete", target) }), sourceAction(memory, source));
      card.append(title, content, meta, reason, source, actions); root.append(card);
    }
    if (!memories.length) { const empty = document.createElement("p"); empty.textContent = "No memories in this scope / 此归属暂无记忆"; root.append(empty); }
  }
  function renderSuggestions(suggestions) {
    const root = $("memory-suggestions"); if (!root) return; root.textContent = "";
    for (const suggestion of suggestions) {
      const card = document.createElement("article"); card.className = "settings-card memory-row";
      const title = document.createElement("h3"); title.textContent = suggestion.title;
      const content = document.createElement("p"); content.textContent = suggestion.content;
      const source = document.createElement("small"); source.textContent = `${suggestion.scope} · Source: ${suggestion.source?.label ?? "Unavailable"}`;
      const actions = document.createElement("div"); actions.className = "detail-actions";
      actions.append(button("Approve / 批准", async () => { await api.memory.approveSuggestion({ suggestionId: suggestion.suggestionId }); setResult("Suggestion approved / 建议已批准"); await refresh(); }), button("Reject / 拒绝", async () => { await api.memory.rejectSuggestion({ suggestionId: suggestion.suggestionId }); setResult("Suggestion rejected / 建议已拒绝"); await refresh(); }));
      card.append(title, content, source, actions); root.append(card);
    }
    if (!suggestions.length) { const empty = document.createElement("p"); empty.textContent = "No pending suggestions / 暂无待审建议"; root.append(empty); }
  }
  async function refresh() {
    const sequence = ++refreshSequence;
    try {
      await loadOwners();
      if (sequence !== refreshSequence) return;
      renderOwnerOptions();
      const request = listTarget();
      if (!request.ownerId) { renderMemories([]); setResult("Choose a scope owner / 请选择归属"); } else {
        const result = await api.memory.list({ ...request, ...(selected("memory-search") ? { query: selected("memory-search") } : {}) });
        if (sequence !== refreshSequence) return;
        renderMemories(result.memories ?? []);
        const count = result.resultCount ?? result.memories?.length ?? 0;
        const returned = result.returnedCount ?? result.memories?.length ?? 0;
        setResult(`${count} matches${returned !== count ? ` · showing ${returned}` : ""} · rebuilt locally / ${count} 条匹配 · 已在本地重建`);
      }
      const suggestions = await api.memory.listSuggestions();
      if (sequence === refreshSequence) renderSuggestions(suggestions.suggestions ?? []);
    } catch (reason) { setResult(errorText(reason)); }
  }
  function handleOpenMemory(event) {
    const detail = event.detail ?? {};
    if (["coworker", "team", "project"].includes(detail.scope)) $("memory-scope").value = detail.scope;
    pendingOwnerId = detail.ownerId;
    selectedMemoryId = detail.memoryId;
    const addFact = detail.addFact === true;
    activate();
    void refresh().then(() => { if (addFact) openFactDialog(); });
  }
  // Install the cross-surface deep link immediately. Product pages can be
  // created asynchronously, so this must not depend on a later DOMContentLoaded
  // callback winning a race with a Project card click.
  document.addEventListener("sovereignbot:open-memory", handleOpenMemory);
  window.addEventListener("DOMContentLoaded", () => {
    $("nav-memory")?.addEventListener("click", () => { activate(); void refresh(); });
    $("memory-scope")?.addEventListener("change", () => { renderOwnerOptions(); syncAddFactButton(); void refresh(); });
    $("memory-owner")?.addEventListener("change", () => { syncAddFactButton(); void refresh(); });
    $("memory-state")?.addEventListener("change", () => void refresh());
    $("memory-search")?.addEventListener("input", () => void refresh());
    $("memory-refresh")?.addEventListener("click", () => void refresh());
    $("memory-add-fact")?.addEventListener("click", openFactDialog);
    $("memory-fact-form")?.addEventListener("submit", (event) => void saveFact(event));
    $("memory-edit-form")?.addEventListener("submit", (event) => void saveEdit(event));
    $("memory-delete-form")?.addEventListener("submit", (event) => void confirmDelete(event));
    $("memory-delete-dialog")?.addEventListener("close", () => { if (!pendingMemoryActions.has(deleteCandidate?.key)) deleteCandidate = undefined; });
    window.sovereignbotMemoryUi = Object.freeze({ openEditDialog, openDeleteDialog, refresh });
    void refresh();
  });
})();
