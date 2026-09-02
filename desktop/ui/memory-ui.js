"use strict";

(() => {
  const api = window.sovereignbot;
  if (!api?.memory?.list || !api?.memory?.listSuggestions) return;
  const $ = (id) => document.getElementById(id);
  let selectedMemoryId;
  let pendingOwnerId;
  let owners = { coworker: [], team: [], project: [] };
  const text = (value) => String(value ?? "");
  const errorText = (reason) => text(reason?.message ?? reason).replace(/^.*Error: /, "").slice(0, 240);
  const setResult = (value) => { const node = $("memory-result"); if (node) node.textContent = value ?? ""; };
  const button = (label, fn) => { const node = document.createElement("button"); node.type = "button"; node.className = "quiet-action"; node.textContent = label; node.addEventListener("click", () => Promise.resolve().then(fn).catch((reason) => setResult(errorText(reason)))); return node; };
  const selected = (id) => $(id)?.value || "";
  const scopeTarget = () => ({ scope: selected("memory-scope"), ownerId: selected("memory-owner") });
  const listTarget = () => ({ ...scopeTarget(), limit: 100, ...(selected("memory-state") === "all" ? { includeForgotten: true } : {}) });
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
      project: (projects.projects ?? []).map((entry) => ({ value: entry.projectId, label: `${entry.name} · ${entry.state}` })),
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
      const source = document.createElement("small"); source.textContent = `Source: ${memory.source?.label ?? "Unavailable"}`;
      const actions = document.createElement("div"); actions.className = "detail-actions";
      actions.append(button(memory.pinned ? "Unpin / 取消置顶" : "Pin / 置顶", async () => { await api.memory.pin({ ...scopeTarget(), memoryId: memory.id, pinned: !memory.pinned }); await refresh(); }), button("Edit / 编辑", async () => {
        const contentValue = window.prompt("Edit memory content / 编辑记忆内容", memory.content); if (contentValue === null) return;
        const titleValue = window.prompt("Edit memory title / 编辑记忆标题", memory.title); if (titleValue === null) return;
        await api.memory.update({ ...scopeTarget(), memoryId: memory.id, patch: { title: titleValue, content: contentValue, tags: memory.tags } }); await refresh();
      }), button("Forget / 忘记", async () => { if (memory.state === "forgotten") return; await api.memory.forget({ ...scopeTarget(), memoryId: memory.id }); await refresh(); }), button("Delete / 删除", async () => { if (!window.confirm("Delete this memory? / 删除这条记忆？")) return; await api.memory.delete({ ...scopeTarget(), memoryId: memory.id }); await refresh(); }), sourceAction(memory, source));
      card.append(title, content, meta, source, actions); root.append(card);
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
    try {
      await loadOwners();
      renderOwnerOptions();
      const request = listTarget();
      if (!request.ownerId) { renderMemories([]); setResult("Choose a scope owner / 请选择归属"); } else {
        const result = await api.memory.list({ ...request, ...(selected("memory-search") ? { query: selected("memory-search") } : {}) });
        renderMemories(result.memories ?? []);
        setResult(`${result.memories?.length ?? 0} memories · rebuilt locally / 条记忆 · 已在本地重建`);
      }
      renderSuggestions((await api.memory.listSuggestions()).suggestions ?? []);
    } catch (reason) { setResult(errorText(reason)); }
  }
  window.addEventListener("DOMContentLoaded", () => {
    $("nav-memory")?.addEventListener("click", () => { activate(); void refresh(); });
    $("memory-scope")?.addEventListener("change", () => { renderOwnerOptions(); void refresh(); });
    $("memory-owner")?.addEventListener("change", () => void refresh());
    $("memory-state")?.addEventListener("change", () => void refresh());
    $("memory-search")?.addEventListener("input", () => void refresh());
    $("memory-refresh")?.addEventListener("click", () => void refresh());
    document.addEventListener("sovereignbot:open-memory", (event) => {
      const detail = event.detail ?? {};
      if (["coworker", "team", "project"].includes(detail.scope)) $("memory-scope").value = detail.scope;
      pendingOwnerId = detail.ownerId;
      selectedMemoryId = detail.memoryId;
      activate();
      void refresh();
    });
    void refresh();
  });
})();
