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
      actions.append(button("Edit / 编辑", async () => { const name = window.prompt("Playbook name / 工作方法名称", item.name); if (!name) return; const description = window.prompt("Description / 描述", item.description) ?? item.description; const rawSteps = window.prompt("Steps, comma separated / 步骤（逗号分隔）", item.steps.join(",")); if (rawSteps === null) return; const steps = rawSteps.split(",").map((step) => step.trim()).filter(Boolean); try { await api.playbooks.update({ playbookId: item.id, patch: { name, description, steps } }); await refresh(); } catch (e) { error(root, e); } }));
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
  function renderHistory(items, coworkers) {
    const root = $("product-computer-history"); clear(root);
    const selectedCoworker = $("computer-history-filter")?.value ?? "all";
    const visible = items.filter((item) => selectedCoworker === "all" || item.coworkerId === selectedCoworker);
    const names = new Map((coworkers ?? []).map((coworker) => [coworker.id, coworker.name]));
    for (const item of visible) { const card = document.createElement("article"); card.className = "settings-card"; const h = document.createElement("h3"); h.textContent = item.activity; card.append(h, line("Coworker", names.get(item.coworkerId) ?? "Coworker"), line("Activity", item.summary), line("App", item.app), line("Site", item.site), line("Time", item.timestamp), line("Status", item.status)); root.append(card); }
    if (!visible.length) { const p = document.createElement("p"); p.textContent = selectedCoworker === "all" ? "No safe Computer activity recorded yet." : "No activity for this coworker."; root.append(p); }
  }
  function renderChannels(items, teams, conversations, templates) {
    const root = $("product-channels");
    const filter = $("product-channel-filter");
    const switcher = $("product-channel-switch");
    if (!root) return;
    clear(root);
    if (switcher) {
      switcher.textContent = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Quick switch / 快速切换";
      switcher.append(placeholder);
      for (const channel of items.filter((entry) => !entry.archived)) {
        const option = document.createElement("option");
        option.value = channel.conversationId;
        const conversation = conversations.find((entry) => entry.id === channel.conversationId);
        option.textContent = `${conversationUnread(conversation) ? "• " : ""}${channel.name}`;
        switcher.append(option);
      }
    }
    const mode = filter?.value ?? "active";
    const visible = items.filter((channel) => {
      const conversation = conversations.find((entry) => entry.id === channel.conversationId);
      if (mode === "unread") return !channel.archived && conversationUnread(conversation);
      return mode === "all" || (mode === "archived" ? channel.archived : !channel.archived);
    });
    const teamById = new Map(teams.map((team) => [team.id, team]));
    for (const channel of visible) {
      const conversation = conversations.find((entry) => entry.id === channel.conversationId);
      const team = teamById.get(channel.teamId);
      const card = document.createElement("article");
      card.className = "settings-card";
      const heading = document.createElement("div");
      heading.className = "card-heading";
      const title = document.createElement("h3");
      title.textContent = channel.name;
      const meta = document.createElement("p");
      meta.textContent = `${team?.name ?? "Team"} · ${channel.kind} · ${channel.archived ? "Read-only / 只读" : "Available / 可用"}`;
      heading.append(title, meta);
      if (conversationUnread(conversation)) {
        const unread = document.createElement("span");
        unread.className = "soft-pill";
        unread.textContent = "Unread / 未读";
        heading.append(unread);
      }
      card.append(heading);
      card.append(line("Description", channel.instructions || "No channel instructions"));
      card.append(line("Last activity", conversation?.updatedAt || channel.updatedAt));
      if (conversation?.lastMessage?.textPreview) card.append(line("Latest", conversation.lastMessage.textPreview));
      const actions = document.createElement("div");
      actions.className = "detail-actions";
      actions.append(button(channel.archived ? "View / 查看" : "Open / 打开", () => {
        if (channel.conversationId && typeof openConversation === "function") void openConversation(channel.conversationId);
      }));
      actions.append(button("Duplicate / 复制", async () => {
        await api.channels.create({ teamId: channel.teamId, name: `${channel.name} copy`.slice(0, 120), kind: channel.kind, instructions: channel.instructions, workspaceId: channel.workspaceId, playbookId: channel.playbookId });
        if (typeof refreshConversations === "function" && typeof refreshTeams === "function") await Promise.all([refreshConversations(), refreshTeams()]);
        await refresh();
      }));
      actions.append(button(channel.archived ? "Restore / 恢复" : "Archive / 归档", async () => {
        await (channel.archived ? api.channels.restore : api.channels.archive)({ channelId: channel.id });
        if (typeof refreshConversations === "function" && typeof refreshTeams === "function") await Promise.all([refreshConversations(), refreshTeams()]);
        await refresh();
      }));
      card.append(actions);
      root.append(card);
    }
    if (!visible.length) { const p = document.createElement("p"); p.textContent = mode === "archived" ? "No archived channels." : mode === "unread" ? "No unread channels." : "No active channels yet."; root.append(p); }
    const teamSelect = $("product-channel-template-team");
    const templateSelect = $("product-channel-template");
    if (teamSelect && templateSelect) {
      const selectedTeam = teamSelect.value;
      teamSelect.textContent = "";
      for (const team of teams) { const option = document.createElement("option"); option.value = team.id; option.textContent = team.name; teamSelect.append(option); }
      if ([...teamSelect.options].some((option) => option.value === selectedTeam)) teamSelect.value = selectedTeam;
      templateSelect.textContent = "";
      for (const template of templates ?? []) { const option = document.createElement("option"); option.value = template.id; option.textContent = `${template.name} / ${template.kind}`; templateSelect.append(option); }
    }
  }
  function renderSkills(items) {
    const root = $("product-skills"); clear(root);
    for (const item of items) { const card = document.createElement("article"); card.className = "settings-card"; const h = document.createElement("h3"); h.textContent = item.name; card.append(h, line("Status", item.state), line("Assigned", item.assignedTeamIds.length ? "Team" : "Not assigned")); const actions = document.createElement("div"); actions.className = "detail-actions"; actions.append(button("Export", async () => copy(await api.skills.export({ skillId: item.id })))); actions.append(button("Duplicate", async () => { await api.skills.duplicate({ skillId: item.id }); await refresh(); })); card.append(actions); root.append(card); }
    root.append(button("Import skill / 导入技能", async () => { const raw = window.prompt("Paste safe Skill JSON"); if (!raw) return; await api.skills.import({ skill: JSON.parse(raw) }); await refresh(); }));
  }
  function renderPacks(items) {
    const query = $("team-pack-search")?.value.trim().toLowerCase() ?? "";
    if (query) items = items.filter((item) => [item.name, item.description, ...(item.coworkerNames ?? []), ...(item.channelNames ?? []), ...(item.playbookNames ?? [])].join(" ").toLowerCase().includes(query));
    const root = $("product-packs"); clear(root);
    for (const item of items) { const card = document.createElement("article"); card.className = "settings-card"; const h = document.createElement("h3"); h.textContent = item.name; card.append(h, line("Contents", `${item.coworkerNames?.length ?? 0} coworkers · ${item.channelNames?.length ?? 0} channels · ${item.playbookNames?.length ?? 0} playbooks`), line("Status", item.installed ? "Installed" : "Available")); const actions = document.createElement("div"); actions.className = "detail-actions"; if (!item.installed) actions.append(button("Install", async () => { await api.teams.installPack({ packId: item.id }); await refresh(); })); actions.append(button("Export", async () => { const teams = typeof state !== "undefined" ? state.teams : []; const team = teams.find((entry) => entry.packId === item.id); const pack = team ? await api.teams.exportPack({ teamId: team.id }) : await api.teams.exportPackRecipe({ packId: item.id }); await copy(pack); })); actions.append(button("Duplicate", async () => { await api.teams.duplicatePack({ packId: item.id }); await refresh(); })); if (item.custom) actions.append(button("Edit", async () => { const name = window.prompt("Pack name", item.name); if (!name) return; await api.teams.editPack({ packId: item.id, patch: { name, description: item.description } }); await refresh(); })); card.append(actions); root.append(card); }
  }
  function renderWorkspaceSwitcher(snapshot) {
    const select = $("product-workspace-switch");
    if (!select) return;
    const selected = select.value || snapshot?.defaultWorkspaceId;
    select.textContent = "";
    const workspaces = snapshot?.workspaces ?? [];
    if (!workspaces.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No trusted workspaces / 暂无可信工作区";
      select.append(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (const workspace of workspaces) {
      const option = document.createElement("option");
      option.value = workspace.id;
      option.textContent = workspace.kind === "shared-project"
        ? "Shared project workspace / 共享项目工作区"
        : workspace.label || "Private workspace / 私有工作区";
      select.append(option);
    }
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
  }
  function renderActivityFeed(teams, coworkers, conversations) {
    const root = $("product-activity-feed");
    if (!root) return;
    clear(root);
    const names = new Map((coworkers ?? []).map((coworker) => [coworker.id, coworker.name]));
    const channels = new Map();
    for (const team of teams ?? []) {
      for (const channel of team.channels ?? []) channels.set(channel.conversationId, { teamId: team.id, teamName: team.name, channelName: channel.name });
    }
    const filter = $("product-activity-filter")?.value ?? "all";
    const entries = (conversations ?? [])
      .filter((conversation) => conversation.messageCount > 0 && conversation.lastMessage)
      .map((conversation) => {
        const scope = channels.get(conversation.id);
        const senderId = conversation.lastMessage.senderId;
        const sender = senderId === "user" ? "You / 你" : (names.get(senderId) ?? "Coworker / 同事");
        return {
          conversation,
          sender,
          coworkerId: senderId === "user" ? undefined : senderId,
          teamId: scope?.teamId,
          teamName: scope?.teamName ?? (conversation.kind === "team" ? "Team" : "Personal"),
          channelName: scope?.channelName ?? conversation.title,
          time: conversation.lastMessage.createdAt || conversation.updatedAt,
          summary: conversation.lastMessage.textPreview || "Activity updated",
          status: scope?.teamId ? (teams.find((team) => team.id === scope.teamId)?.flow?.status ?? "available") : "recent",
        };
      })
      .filter((entry) => filter === "all" || (filter.startsWith("coworker:") && entry.coworkerId === filter.slice(9)) || (filter.startsWith("team:") && entry.teamId === filter.slice(5)))
      .sort((a, b) => String(b.time).localeCompare(String(a.time)))
      .slice(0, 24);
    for (const entry of entries) {
      const card = document.createElement("article");
      card.className = "settings-card";
      const heading = document.createElement("div");
      heading.className = "card-heading";
      const title = document.createElement("h3");
      title.textContent = `${entry.sender} · ${entry.channelName}`;
      heading.append(title);
      card.append(heading, line("Team", entry.teamName), line("Activity", entry.summary), line("Time", entry.time), line("Status", entry.status));
      const actions = document.createElement("div");
      actions.className = "detail-actions";
      if (entry.conversation.id && typeof openConversation === "function") actions.append(button("Open conversation / 打开会话", () => openConversation(entry.conversation.id)));
      card.append(actions);
      root.append(card);
    }
    if (!entries.length) { const p = document.createElement("p"); p.textContent = "No recent coworker activity yet. / 暂无最近同事动态。"; root.append(p); }
  }
  function renderRecentProjects(teams, workspaces) {
    const root = $("product-recent-projects");
    if (!root) return;
    clear(root);
    const workspaceNames = new Map((workspaces?.workspaces ?? []).map((workspace) => [workspace.id, workspace.kind === "shared-project" ? "Shared project workspace / 共享项目工作区" : (workspace.label || "Private workspace / 私有工作区")]));
    const projects = [...(teams ?? [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 8);
    for (const team of projects) {
      const card = document.createElement("article");
      card.className = "settings-card";
      const heading = document.createElement("div");
      heading.className = "card-heading";
      const title = document.createElement("h3");
      title.textContent = team.name;
      heading.append(title);
      card.append(heading, line("Workspace", workspaceNames.get(team.sharedWorkspaceId) ?? team.sharedWorkspaceLabel ?? "Shared project workspace"), line("Channel", team.channels?.[0]?.name ?? "Project Channel"), line("Coworkers", team.coworkerIds?.length ?? 0), line("Status", team.flow?.status ?? "available"), line("Updated", team.updatedAt));
      const conversationId = team.channels?.[0]?.conversationId;
      if (conversationId && typeof openConversation === "function") card.append(button("Open project / 打开项目", () => openConversation(conversationId)));
      root.append(card);
    }
    if (!projects.length) { const p = document.createElement("p"); p.textContent = "No projects yet. / 暂无项目。"; root.append(p); }
  }
  async function refresh() {
    const [teams, coworkers, workspaces] = await Promise.all([
      api.teams.list({}),
      api.coworkers.list({}),
      api.workspaces?.list ? api.workspaces.list({}) : Promise.resolve({ workspaces: [] }),
    ]);
    renderWorkspaceSwitcher(workspaces);
    renderRecentProjects(teams.teams ?? [], workspaces);
    const filter = $("artifact-hub-filter");
    if (filter && filter.options.length === 1) {
      for (const team of teams.teams ?? []) {
        const option = document.createElement("option"); option.value = `team:${team.id}`; option.textContent = `By Team / 团队: ${team.name}`; filter.append(option);
        for (const channel of team.channels ?? []) { const channelOption = document.createElement("option"); channelOption.value = `channel:${channel.id}`; channelOption.textContent = `By Channel / 频道: ${channel.name}`; filter.append(channelOption); }
      }
      for (const coworker of coworkers.coworkers ?? []) { const option = document.createElement("option"); option.value = `coworker:${coworker.id}`; option.textContent = `By Coworker / 同事: ${coworker.name}`; filter.append(option); }
    }
    const scope = filter?.value ?? "recent"; const artifactPayload = { limit: 100 }; if (scope.startsWith("team:")) artifactPayload.teamId = scope.slice(5); if (scope.startsWith("channel:")) artifactPayload.channelId = scope.slice(8); if (scope.startsWith("coworker:")) artifactPayload.coworkerId = scope.slice(9);
    const historyFilter = $("computer-history-filter");
    if (historyFilter && historyFilter.options.length === 1) for (const coworker of coworkers.coworkers ?? []) { const option = document.createElement("option"); option.value = coworker.id; option.textContent = `By Coworker / 同事: ${coworker.name}`; historyFilter.append(option); }
    const activityFilter = $("product-activity-filter");
    if (activityFilter && activityFilter.options.length === 1) {
      for (const team of teams.teams ?? []) { const option = document.createElement("option"); option.value = `team:${team.id}`; option.textContent = `By Team / 团队: ${team.name}`; activityFilter.append(option); }
      for (const coworker of coworkers.coworkers ?? []) { const option = document.createElement("option"); option.value = `coworker:${coworker.id}`; option.textContent = `By Coworker / 同事: ${coworker.name}`; activityFilter.append(option); }
    }
    const [playbooks, artifacts, history, skills, channels, conversations] = await Promise.all([api.playbooks.list({ includeArchived: true }), api.artifacts.hub(artifactPayload), api.computer.history({ limit: 100 }), api.skills.list({ includeArchived: true }), api.channels.list({ includeArchived: true }), api.conversations.list({})]);
    renderPlaybooks(playbooks.playbooks ?? [], teams.teams ?? []); renderArtifacts(artifacts.artifacts ?? []); renderHistory(history.history ?? [], coworkers.coworkers ?? []); renderChannels(channels.channels ?? [], teams.teams ?? [], conversations.conversations ?? [], teams.channelTemplates ?? []); renderActivityFeed(teams.teams ?? [], coworkers.coworkers ?? [], conversations.conversations ?? []); renderSkills(skills.skills ?? []); renderPacks(teams.packs ?? []);
  }
  async function createPlaybook() { const name = window.prompt("Playbook name"); if (!name) return; const description = window.prompt("Description") ?? ""; const rawSteps = window.prompt("Steps, comma separated", "chief,coding-lead,reviewer,chief") ?? "chief,coding-lead,reviewer,chief"; await api.playbooks.create({ playbook: { name, description, steps: rawSteps.split(",").map((x) => x.trim()).filter(Boolean) } }); await refresh(); }
  function setup() {
    const artifactRoot = $("product-artifacts");
    const heading = artifactRoot?.parentElement?.querySelector(".card-heading");
    if (heading && !$("artifact-hub-filter")) { const filter = document.createElement("select"); filter.id = "artifact-hub-filter"; filter.setAttribute("aria-label", "Artifact filter"); const option = document.createElement("option"); option.value = "recent"; option.textContent = "Recent / 最近"; filter.append(option); heading.append(filter); }
    const channelFilter = $("product-channel-filter");
    if (channelFilter && ![...channelFilter.options].some((option) => option.value === "unread")) { const option = document.createElement("option"); option.value = "unread"; option.textContent = "Unread / 未读"; channelFilter.insertBefore(option, channelFilter.options[channelFilter.options.length - 1] ?? null); }
    const productHeader = $("view-product-hubs")?.querySelector(".page-header");
    if (productHeader && !$("product-workspace-switch") && api.workspaces?.list && api.workspaces?.setDefault) {
      const controls = document.createElement("div");
      controls.className = "detail-actions";
      const label = document.createElement("span");
      label.textContent = "Project / workspace / 项目工作区";
      const select = document.createElement("select");
      select.id = "product-workspace-switch";
      select.setAttribute("aria-label", "Project workspace switcher");
      const feedback = document.createElement("span");
      feedback.id = "product-workspace-result";
      feedback.className = "setting-feedback";
      select.addEventListener("change", async () => {
        if (!select.value) return;
        select.disabled = true;
        try {
          const result = await api.workspaces.setDefault({ id: select.value });
          if (!result?.ok) throw new Error("Workspace selection was not accepted.");
          feedback.textContent = "Active workspace updated / 已切换工作区";
          if (typeof refreshSettingsData === "function") await refreshSettingsData();
          await refresh();
        } catch (e) {
          feedback.textContent = String(e?.message ?? e).slice(0, 180);
        } finally {
          select.disabled = false;
        }
      });
      controls.append(label, select);
      productHeader.append(controls, feedback);
    }
    $("nav-product-hubs")?.addEventListener("click", async () => { switchView("product-hubs"); try { await refresh(); } catch (e) { error($("product-playbooks"), e); } }); $("product-hubs-refresh")?.addEventListener("click", () => void refresh()); $("artifact-hub-filter")?.addEventListener("change", () => void refresh()); $("product-channel-filter")?.addEventListener("change", () => void refresh()); $("product-channel-switch")?.addEventListener("change", (event) => { if (event.target.value && typeof openConversation === "function") void openConversation(event.target.value); }); $("playbook-create")?.addEventListener("click", () => void createPlaybook());
  }
  window.addEventListener("DOMContentLoaded", setup);
  window.addEventListener("DOMContentLoaded", () => {
    const root = $("product-packs");
    const heading = root?.parentElement?.querySelector(".card-heading");
    if (!heading || $("team-pack-search")) return;
    const input = document.createElement("input");
    input.id = "team-pack-search";
    input.type = "search";
    input.maxLength = 120;
    input.placeholder = "Search packs / 搜索团队包";
    input.setAttribute("aria-label", "Search Team Packs");
    input.addEventListener("input", () => void refresh());
    heading.append(input);
  });
  window.addEventListener("DOMContentLoaded", () => {
    const root = $("product-activity-feed");
    const heading = root?.parentElement?.querySelector(".card-heading");
    if (!heading || $("product-activity-filter")) return;
    const filter = document.createElement("select");
    filter.id = "product-activity-filter";
    filter.setAttribute("aria-label", "Recent activity filter");
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = "All activity / 全部动态";
    filter.append(all);
    filter.addEventListener("change", () => void refresh());
    heading.append(filter);
  });
  window.addEventListener("DOMContentLoaded", () => {
    const root = $("product-computer-history");
    const heading = root?.parentElement?.querySelector(".card-heading");
    if (!heading || $("computer-history-filter")) return;
    const filter = document.createElement("select");
    filter.id = "computer-history-filter";
    filter.setAttribute("aria-label", "Computer activity coworker filter");
    const option = document.createElement("option");
    option.value = "all";
    option.textContent = "All coworkers / 全部同事";
    filter.append(option);
    filter.addEventListener("change", () => void refresh());
    heading.append(filter);
  });
  window.addEventListener("DOMContentLoaded", () => {
    const root = $("product-channels");
    const heading = root?.parentElement?.querySelector(".card-heading");
    if (!heading || $("product-channel-template-team")) return;
    const controls = document.createElement("div");
    controls.className = "detail-actions";
    const team = document.createElement("select");
    team.id = "product-channel-template-team";
    team.setAttribute("aria-label", "Team for channel template");
    const template = document.createElement("select");
    template.id = "product-channel-template";
    template.setAttribute("aria-label", "Channel template");
    const add = button("From template / 从模板创建", async () => {
      if (!team.value || !template.value) return;
      try {
        const result = await api.teams.createChannelFromTemplate({ teamId: team.value, templateId: template.value });
        if (typeof refreshConversations === "function" && typeof refreshTeams === "function") await Promise.all([refreshConversations(), refreshTeams()]);
        await refresh();
        if (result?.channel?.conversationId && typeof openConversation === "function") await openConversation(result.channel.conversationId);
      } catch (e) { error(root, e); }
    });
    controls.append(team, template, add);
    heading.append(controls);
  });
})();
