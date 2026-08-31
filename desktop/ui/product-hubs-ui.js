"use strict";

(() => {
  const api = window.sovereignbot;
  if (!api?.playbooks || !api?.artifacts?.hub || !api?.computer?.history) return;
  const $ = (id) => document.getElementById(id);
  const clear = (node) => { if (node) node.textContent = ""; };
  const button = (label, fn, className = "quiet-action") => { const b = document.createElement("button"); b.type = "button"; b.className = className; b.textContent = label; b.addEventListener("click", () => void fn(b)); return b; };
  const line = (label, value) => { const span = document.createElement("span"); span.textContent = `${label}: ${value ?? "—"}`; return span; };
  const error = (root, reason) => { const p = document.createElement("p"); p.className = "inline-error"; p.textContent = String(reason?.message ?? reason).slice(0, 220); root.append(p); };
  async function copy(value) { try { await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); } catch {} }
  function renderPlaybooks(items, teams) {
    const root = $("product-playbooks"); clear(root);
    for (const item of items) {
      const card = document.createElement("article"); card.className = "settings-card";
      const h = document.createElement("h3"); h.textContent = item.name; card.append(h);
      card.append(line("Description", item.description), line("Steps", item.steps.join(" → ")), line("Assigned teams", item.assignedTeams.map((x) => x.name).join(", ") || "None"), line("Assigned channels", item.assignedChannels.map((x) => x.name).join(", ") || "None"), line("Updated", item.updatedAt));
      const actions = document.createElement("div"); actions.className = "detail-actions";
      actions.append(button("Export / 导出", () => copy(api.playbooks.export({ playbookId: item.id }))));
      actions.append(button("Duplicate / 复制", async () => { await api.playbooks.duplicate({ playbookId: item.id }); await refresh(); }));
      actions.append(button(item.state === "archived" ? "Restore / 恢复" : "Archive / 归档", async () => { await (item.state === "archived" ? api.playbooks.restore : api.playbooks.archive)({ playbookId: item.id }); await refresh(); }));
      actions.append(button("Edit / 编辑", async () => { const name = window.prompt("Playbook name", item.name); if (!name) return; const description = window.prompt("Description", item.description) ?? item.description; await api.playbooks.update({ playbookId: item.id, patch: { name, description, steps: item.steps } }); await refresh(); }));
      const teamSelect = document.createElement("select"); for (const team of teams) { const option = document.createElement("option"); option.value = team.id; option.textContent = `Team: ${team.name}`; teamSelect.append(option); }
      const channelSelect = document.createElement("select"); for (const team of teams) for (const channel of team.channels ?? []) { const option = document.createElement("option"); option.value = channel.id; option.textContent = `Channel: ${channel.name}`; channelSelect.append(option); }
      if (teams.length) actions.append(teamSelect, button("Assign Team / 分配团队", async () => { await api.playbooks.assign({ playbookId: item.id, teamId: teamSelect.value }); await refresh(); }));
      if (channelSelect.options.length) actions.append(channelSelect, button("Assign Channel / 分配频道", async () => { await api.playbooks.assign({ playbookId: item.id, channelId: channelSelect.value }); await refresh(); }));
      card.append(actions); root.append(card);
    }
    if (!items.length) { const p = document.createElement("p"); p.textContent = "No playbooks yet. Create the first team method."; root.append(p); }
    root.append(button("Import / 导入", async () => { const raw = window.prompt("Paste Playbook JSON"); if (!raw) return; await api.playbooks.import({ playbook: JSON.parse(raw) }); await refresh(); }));
  }
  function renderArtifacts(items) {
    const root = $("product-artifacts"); clear(root);
    for (const item of items) {
      const card = document.createElement("article"); card.className = "settings-card";
      const h = document.createElement("h3"); h.textContent = item.title || item.fileName; card.append(h);
      card.append(line("Type", item.mimeType), line("Creator", item.creator?.name), line("Team", item.team?.name), line("Channel", item.channel?.name), line("Created", item.createdAt), line("Status", item.status));
      const actions = document.createElement("div"); actions.className = "detail-actions";
      actions.append(button("Open preview / 预览", async () => { const result = await api.artifacts.preview({ artifactId: item.id }); window.alert(result?.preview || "Preview is not available."); }));
      actions.append(button("Reveal / 显示", () => api.artifacts.reveal({ artifactId: item.id })));
      if (item.conversationId && typeof openConversation === "function") actions.append(button("Go to conversation / 回到会话", () => openConversation(item.conversationId)));
      card.append(actions); root.append(card);
    }
    if (!items.length) { const p = document.createElement("p"); p.textContent = "No artifacts yet."; root.append(p); }
  }
  function renderHistory(items) {
    const root = $("product-computer-history"); clear(root);
    for (const item of items) { const card = document.createElement("article"); card.className = "settings-card"; const h = document.createElement("h3"); h.textContent = item.activity; card.append(h, line("Activity", item.summary), line("App", item.app), line("Site", item.site), line("Time", item.timestamp), line("Status", item.status)); root.append(card); }
    if (!items.length) { const p = document.createElement("p"); p.textContent = "No safe Computer activity recorded yet."; root.append(p); }
  }
  function renderSkills(items) {
    const root = $("product-skills"); clear(root);
    for (const item of items) { const card = document.createElement("article"); card.className = "settings-card"; const h = document.createElement("h3"); h.textContent = item.name; card.append(h, line("Status", item.state), line("Assigned", item.assignedTeamIds.length ? "Team" : "Not assigned")); const actions = document.createElement("div"); actions.className = "detail-actions"; actions.append(button("Export", async () => copy(await api.skills.export({ skillId: item.id })))); actions.append(button("Duplicate", async () => { await api.skills.duplicate({ skillId: item.id }); await refresh(); })); card.append(actions); root.append(card); }
    root.append(button("Import skill / 导入技能", async () => { const raw = window.prompt("Paste safe Skill JSON"); if (!raw) return; await api.skills.import({ skill: JSON.parse(raw) }); await refresh(); }));
  }
  function renderPacks(items) {
    const root = $("product-packs"); clear(root);
    for (const item of items) { const card = document.createElement("article"); card.className = "settings-card"; const h = document.createElement("h3"); h.textContent = item.name; card.append(h, line("Contents", `${item.coworkerNames?.length ?? 0} coworkers · ${item.channelNames?.length ?? 0} channels · ${item.playbookNames?.length ?? 0} playbooks`), line("Status", item.installed ? "Installed" : "Available")); const actions = document.createElement("div"); actions.className = "detail-actions"; if (!item.installed) actions.append(button("Install", async () => { await api.teams.installPack({ packId: item.id }); await refresh(); })); actions.append(button("Export", async () => { const teams = typeof state !== "undefined" ? state.teams : []; const team = teams.find((entry) => entry.packId === item.id); const pack = team ? await api.teams.exportPack({ teamId: team.id }) : await api.teams.exportPackRecipe({ packId: item.id }); await copy(pack); })); actions.append(button("Duplicate", async () => { await api.teams.duplicatePack({ packId: item.id }); await refresh(); })); if (item.custom) actions.append(button("Edit", async () => { const name = window.prompt("Pack name", item.name); if (!name) return; await api.teams.editPack({ packId: item.id, patch: { name, description: item.description } }); await refresh(); })); card.append(actions); root.append(card); }
  }
  async function refresh() {
    const teams = await api.teams.list({});
    const filter = $("artifact-hub-filter");
    if (filter && filter.options.length === 1) for (const team of teams.teams ?? []) { const option = document.createElement("option"); option.value = `team:${team.id}`; option.textContent = `By Team / 团队: ${team.name}`; filter.append(option); for (const channel of team.channels ?? []) { const channelOption = document.createElement("option"); channelOption.value = `channel:${channel.id}`; channelOption.textContent = `By Channel / 频道: ${channel.name}`; filter.append(channelOption); } }
    const scope = filter?.value ?? "recent"; const artifactPayload = { limit: 100 }; if (scope.startsWith("team:")) artifactPayload.teamId = scope.slice(5); if (scope.startsWith("channel:")) artifactPayload.channelId = scope.slice(8); if (scope.startsWith("coworker:")) artifactPayload.coworkerId = scope.slice(9);
    const [playbooks, artifacts, history, skills] = await Promise.all([api.playbooks.list({ includeArchived: true }), api.artifacts.hub(artifactPayload), api.computer.history({ limit: 100 }), api.skills.list({ includeArchived: true })]);
    renderPlaybooks(playbooks.playbooks ?? [], teams.teams ?? []); renderArtifacts(artifacts.artifacts ?? []); renderHistory(history.history ?? []); renderSkills(skills.skills ?? []); renderPacks(teams.packs ?? []);
  }
  async function createPlaybook() { const name = window.prompt("Playbook name"); if (!name) return; const description = window.prompt("Description") ?? ""; const rawSteps = window.prompt("Steps, comma separated", "chief,coding-lead,reviewer,chief") ?? "chief,coding-lead,reviewer,chief"; await api.playbooks.create({ playbook: { name, description, steps: rawSteps.split(",").map((x) => x.trim()).filter(Boolean) } }); await refresh(); }
  function setup() { const artifactRoot = $("product-artifacts"); const heading = artifactRoot?.parentElement?.querySelector(".card-heading"); if (heading && !$("artifact-hub-filter")) { const filter = document.createElement("select"); filter.id = "artifact-hub-filter"; filter.setAttribute("aria-label", "Artifact filter"); const option = document.createElement("option"); option.value = "recent"; option.textContent = "Recent / 最近"; filter.append(option); heading.append(filter); } $("nav-product-hubs")?.addEventListener("click", async () => { switchView("product-hubs"); try { await refresh(); } catch (e) { error($("product-playbooks"), e); } }); $("product-hubs-refresh")?.addEventListener("click", () => void refresh()); $("artifact-hub-filter")?.addEventListener("change", () => void refresh()); $("playbook-create")?.addEventListener("click", () => void createPlaybook()); }
  window.addEventListener("DOMContentLoaded", setup);
})();
