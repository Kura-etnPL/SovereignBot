"use strict";

(() => {
  const api = window.sovereignbot;
  if (!api?.playbooks || !api?.artifacts?.hub || !api?.computer?.history || !api?.connectedApps || typeof api.connectedApps.list !== "function" || typeof api.connectedApps.search !== "function") return;
  const $ = (id) => document.getElementById(id);
  const clear = (node) => { if (node) node.textContent = ""; };
  const button = (label, fn, className = "quiet-action") => { const b = document.createElement("button"); b.type = "button"; b.className = className; b.textContent = label; b.addEventListener("click", () => void fn(b)); return b; };
  const line = (label, value) => { const span = document.createElement("span"); span.textContent = `${label}: ${value ?? "—"}`; return span; };
  const error = (root, reason) => { const p = document.createElement("p"); p.className = "inline-error"; p.textContent = String(reason?.message ?? reason).slice(0, 220); root.append(p); };
  let connectedAppsProjectId = "";
  async function copy(value) { try { await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); } catch {} }
  function renderPlaybooks(items, teams) {
    const root = $("product-playbooks"); clear(root);
    for (const item of items) {
      const card = document.createElement("article"); card.className = "settings-card";
      const h = document.createElement("h3"); h.textContent = item.name; card.append(h);
      card.append(line("Description", item.description), line("Steps", (item.steps ?? []).join(" → ")), line("Assigned teams", (item.assignedTeams ?? []).map((x) => x.name).join(", ") || "None"), line("Assigned channels", (item.assignedChannels ?? []).map((x) => x.name).join(", ") || "None"), line("Updated", item.updatedAt));
      const actions = document.createElement("div"); actions.className = "detail-actions";
      actions.append(button("Export / 导出", async () => { const result = await api.playbooks.exportViaDialog({ playbookId: item.id }); const status = $("playbook-file-result"); if (status) status.textContent = result.canceled ? "Export canceled." : "Exported " + result.fileName + "."; }));
      actions.append(button("Create Routine / 创建例行", () => document.dispatchEvent(new CustomEvent("sovereignbot:create-routine-from-source", { detail: { name: `Routine · ${item.name}`, instruction: item.description || item.steps.join("; "), teamId: item.assignedTeams[0]?.id } }))));
      actions.append(button("Duplicate / 复制", async () => { await api.playbooks.duplicate({ playbookId: item.id }); await refresh(); }));
      actions.append(button(item.state === "archived" ? "Restore / 恢复" : "Archive / 归档", async () => { await (item.state === "archived" ? api.playbooks.restore : api.playbooks.archive)({ playbookId: item.id }); await refresh(); }));
      actions.append(button("Edit / 编辑", () => document.dispatchEvent(new CustomEvent("sovereignbot:open-playbook-editor", { detail: { item } }))));
      const teamSelect = document.createElement("select"); for (const team of teams) { const option = document.createElement("option"); option.value = team.id; option.textContent = `Team: ${team.name}`; teamSelect.append(option); }
      const channelSelect = document.createElement("select"); for (const team of teams) for (const channel of team.channels ?? []) { const option = document.createElement("option"); option.value = channel.id; option.textContent = `Channel: ${channel.name}`; channelSelect.append(option); }
      if (item.state !== "archived" && teams.length) actions.append(teamSelect, button("Assign Team / 分配团队", async () => { await api.playbooks.assign({ playbookId: item.id, teamId: teamSelect.value }); await refresh(); }));
      if (item.state !== "archived" && channelSelect.options.length) actions.append(channelSelect, button("Assign Channel / 分配频道", async () => { await api.playbooks.assign({ playbookId: item.id, channelId: channelSelect.value }); await refresh(); }));
      card.append(actions); root.append(card);
    }
    if (!items.length) { const p = document.createElement("p"); p.textContent = "No playbooks yet. Create the first team method."; root.append(p); }
    root.append(button("Import / 导入", async () => { const result = await api.playbooks.importViaDialog({}); const status = $("playbook-file-result"); if (result.canceled) { if (status) status.textContent = "Import canceled."; return; } await refresh(); if (status) status.textContent = "Imported " + result.fileName + "."; }));
  }
  function renderArtifacts(items) {
    const root = $("product-artifacts"); clear(root);
    for (const item of items) {
      const card = document.createElement("article"); card.className = "settings-card";
      const h = document.createElement("h3"); h.textContent = item.title || item.fileName; card.append(h);
      card.append(line("Type", item.mimeType), line("Creator", item.creator?.name), line("Team", item.team?.name), line("Channel", item.channel?.name), line("Created", item.createdAt), line("Status", item.status));
      const actions = document.createElement("div"); actions.className = "detail-actions";
      actions.append(button("Open preview / 预览", () => document.dispatchEvent(new CustomEvent("sovereignbot:open-artifact-preview", { detail: { item } }))));
      actions.append(button("Open / 打开", async () => { try { await api.artifacts.open({ artifactId: item.id }); } catch (e) { error(root, e); } }));
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
    root.append(button("Import skill / 导入技能", async () => { await api.skills.importViaDialog({}); await refresh(); }));
  }
  function renderConnectedApps(items, teams, coworkers, projects) {
    const root = $("product-connected-apps"); if (!root) return; clear(root);
    const project = (projects ?? []).find((entry) => entry.projectId === connectedAppsProjectId);
    const projectTeamIds = new Set((project?.teams ?? []).map((entry) => entry.id));
    const projectCoworkerIds = new Set((project?.coworkers ?? []).map((entry) => entry.id));
    const visibleTeams = connectedAppsProjectId ? teams.filter((entry) => projectTeamIds.has(entry.id)) : teams;
    const visibleCoworkers = connectedAppsProjectId ? coworkers.filter((entry) => projectCoworkerIds.has(entry.id)) : coworkers;
    for (const item of items) {
      const card = document.createElement("article"); card.className = "settings-card";
      const h = document.createElement("h3"); h.textContent = item.name; card.append(h, line("Connection", item.connection?.state), line("Health", `${item.health?.state ?? item.state} · ${item.health?.summary ?? ""}`), line("Capabilities", (item.capabilities ?? []).join(" · ")), line("Approval", item.approval?.summary || "Governor-controlled"));
      const actions = document.createElement("div"); actions.className = "detail-actions";
      if (item.connectionState === "connected") actions.append(button("Disconnect / 断开", async () => { try { await api.connectedApps.disconnect({ appId: item.id, ...(connectedAppsProjectId ? { projectId: connectedAppsProjectId } : {}) }); await refresh(); } catch (e) { error(root, e); } }));
      else actions.append(button("Connect / 连接", async () => { try { await api.connectedApps.connect({ appId: item.id, ...(connectedAppsProjectId ? { projectId: connectedAppsProjectId } : {}) }); await refresh(); } catch (e) { error(root, e); } }));
      const teamSelect = document.createElement("select"); teamSelect.setAttribute("aria-label", "Team for " + item.name);
      for (const team of visibleTeams) { const option = document.createElement("option"); option.value = team.id; option.textContent = "Team: " + team.name; teamSelect.append(option); }
      if (teamSelect.options.length) actions.append(teamSelect, button("Assign team / 分配团队", async () => { try { await api.connectedApps.assign({ appId: item.id, ...(connectedAppsProjectId ? { projectId: connectedAppsProjectId } : {}), teamId: teamSelect.value, enabled: !item.assignedTeamIds.includes(teamSelect.value) }); await refresh(); } catch (e) { error(root, e); } }));
      const coworkerSelect = document.createElement("select"); coworkerSelect.setAttribute("aria-label", "Coworker for " + item.name);
      for (const coworker of visibleCoworkers) { const option = document.createElement("option"); option.value = coworker.id; option.textContent = "Coworker: " + coworker.name; coworkerSelect.append(option); }
      if (coworkerSelect.options.length) actions.append(coworkerSelect, button("Assign coworker / 分配同事", async () => { try { await api.connectedApps.assign({ appId: item.id, ...(connectedAppsProjectId ? { projectId: connectedAppsProjectId } : {}), coworkerId: coworkerSelect.value, enabled: !item.assignedCoworkerIds.includes(coworkerSelect.value) }); await refresh(); } catch (e) { error(root, e); } }));
      card.append(actions); root.append(card);
    }
    if (!items.length) { const p = document.createElement("p"); p.textContent = "No connected apps available. / 暂无可用连接。"; root.append(p); }
  }
  function renderPacks(items) {
    const query = $("team-pack-search")?.value.trim().toLowerCase() ?? "";
    if (query) items = items.filter((item) => [item.name, item.description, ...(item.coworkerNames ?? []), ...(item.channelNames ?? []), ...(item.playbookNames ?? [])].join(" ").toLowerCase().includes(query));
    const root = $("product-packs"); clear(root);
    for (const item of items) {
      const card = document.createElement("article"); card.className = "settings-card"; card.dataset.teamPackId = item.id;
      const h = document.createElement("h3"); h.textContent = item.name;
      card.append(h, line("Contents", `${item.coworkerNames?.length ?? 0} coworkers · ${item.channelNames?.length ?? 0} channels · ${item.playbookNames?.length ?? 0} playbooks`), line("Status", item.installed ? "Installed" : "Available"));
      const actions = document.createElement("div"); actions.className = "detail-actions";
      if (!item.installed) actions.append(button("Install", async () => { await api.teams.installPack({ packId: item.id }); await refresh(); }));
      actions.append(button("Export / 导出", () => document.dispatchEvent(new CustomEvent("sovereignbot:export-team-pack", { detail: { item } }))));
      actions.append(button("Duplicate / 复制", async () => { await api.teams.duplicatePack({ packId: item.id }); await refresh(); }));
      if (item.custom) actions.append(button("Edit recipe / 编辑配方", () => document.dispatchEvent(new CustomEvent("sovereignbot:open-team-pack-editor", { detail: { item } }))));
      card.append(actions); root.append(card);
    }
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
    const ledgerEntries = (teams ?? []).flatMap((team) => (team.flow?.activity ?? []).map((event) => {
      const scope = channels.get(event.conversationId);
      const conversation = (conversations ?? []).find((entry) => entry.id === event.conversationId);
      const summary = event.kind === "handoff.requested" && event.targetCoworker
        ? `Handoff to ${event.targetCoworker} / 交接给 ${event.targetCoworker}`
        : event.kind === "work.completed" ? "Result ready / 结果已就绪"
          : event.kind === "handoff.blocked" ? "Needs attention / 需要处理"
            : event.kind === "run.stopped" ? "Work stopped / 工作已停止"
              : event.kind === "run.started" ? "Work started / 工作已开始" : "Team activity / 团队动态";
      return {
        conversation,
        sender: event.owner || (event.actorId === "user" ? "You / 你" : "Team / 团队"),
        coworkerId: event.ownerId,
        teamId: team.id,
        teamName: team.name,
        channelName: scope?.channelName ?? conversation?.title ?? "Team Channel",
        time: event.at,
        summary: `${event.stage ? `${event.stage} · ` : ""}${summary}`,
        status: event.status,
        event,
      };
    }));
    const fallbackEntries = (conversations ?? [])
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
      });
    const entries = (ledgerEntries.length ? ledgerEntries : fallbackEntries)
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
      card.append(heading, line("Team", entry.teamName), line("Owner", entry.event?.owner), line("Stage", entry.event?.stage), line("Activity", entry.summary), line("Result", entry.event?.artifactIds?.length ? `${entry.event.artifactIds.length} artifact(s)` : undefined), line("Time", entry.time), line("Status", entry.status));
      const actions = document.createElement("div");
      actions.className = "detail-actions";
      if (entry.conversation?.id && typeof openConversation === "function") actions.append(button("Open conversation / 打开会话", () => openConversation(entry.conversation.id)));
      card.append(actions);
      root.append(card);
    }
    if (!entries.length) { const p = document.createElement("p"); p.textContent = "No recent coworker activity yet. / 暂无最近同事动态。"; root.append(p); }
  }
  function renderRecentProjects(projects) {
    const root = $("product-recent-projects");
    if (!root) return;
    clear(root);
    for (const project of (projects ?? []).slice(0, 8)) {
      const card = document.createElement("article");
      card.className = "settings-card";
      const heading = document.createElement("div");
      heading.className = "card-heading";
      const title = document.createElement("h3");
      title.textContent = project.name;
      heading.append(title);
      card.append(heading, line("Teams", project.counts?.teams), line("Channels", project.counts?.channels), line("Coworkers", project.counts?.coworkers), line("Status", project.state), line("Updated", project.updatedAt));
      const conversationId = project.teams?.[0]?.channels?.[0]?.conversationId;
      if (conversationId && typeof openConversation === "function") card.append(button("Open project / 打开项目", async () => { await api.projects.open({ projectId: project.projectId }); openConversation(conversationId); }));
      root.append(card);
    }
    if (!(projects ?? []).length) { const p = document.createElement("p"); p.textContent = "No Projects yet. / 暂无项目。"; root.append(p); }
  }
  async function refresh() {
    const [teams, coworkers, workspaces, projects] = await Promise.all([
      api.teams.list({}),
      api.coworkers.list({}),
      api.workspaces?.list ? api.workspaces.list({}) : Promise.resolve({ workspaces: [] }),
      api.projects?.list ? api.projects.list({ limit: 50 }) : Promise.resolve({ projects: [] }),
    ]);
    renderWorkspaceSwitcher(workspaces);
    renderRecentProjects(projects.projects ?? []);
    const connectedAppsProject = $("connected-app-project");
    if (connectedAppsProject) {
      const selectedProject = connectedAppsProject.value;
      connectedAppsProject.textContent = "";
      connectedAppsProject.append(new Option("All Projects / 全部项目", ""));
      for (const project of (projects.projects ?? []).filter((entry) => entry.state === "active")) connectedAppsProject.append(new Option(project.name, project.projectId));
      connectedAppsProject.value = [...connectedAppsProject.options].some((option) => option.value === selectedProject) ? selectedProject : "";
      connectedAppsProjectId = connectedAppsProject.value;
    }
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
    const connectedAppPayload = { limit: 64, ...(connectedAppsProjectId ? { projectId: connectedAppsProjectId } : {}), ...($("connected-app-search")?.value.trim() ? { query: $("connected-app-search").value.trim() } : {}) };
    const [playbooks, artifacts, history, skills, channels, conversations, connectedApps] = await Promise.all([api.playbooks.list({ includeArchived: true }), api.artifacts.hub(artifactPayload), api.computer.history({ limit: 100 }), api.skills.list({ includeArchived: true }), api.channels.list({ includeArchived: true }), api.conversations.list({}), api.connectedApps.search(connectedAppPayload)]);
    const healthApps = await Promise.all((connectedApps.apps ?? []).map((item) => api.connectedApps.health({ appId: item.id, ...(connectedAppsProjectId ? { projectId: connectedAppsProjectId } : {}) }).catch(() => item)));
    connectedApps.apps = healthApps;
    renderPlaybooks(playbooks.playbooks ?? [], teams.teams ?? []); renderArtifacts(artifacts.artifacts ?? []); renderHistory(history.history ?? [], coworkers.coworkers ?? []); renderChannels(channels.channels ?? [], teams.teams ?? [], conversations.conversations ?? [], teams.channelTemplates ?? []); renderActivityFeed(teams.teams ?? [], coworkers.coworkers ?? [], conversations.conversations ?? []); renderSkills(skills.skills ?? []); renderConnectedApps(connectedApps.apps ?? [], teams.teams ?? [], coworkers.coworkers ?? [], projects.projects ?? []); renderPacks(teams.packs ?? []);
  }
  async function createPlaybook() { document.dispatchEvent(new CustomEvent("sovereignbot:open-playbook-editor")); }
  function setup() {
    const artifactRoot = $("product-artifacts");
    const heading = artifactRoot?.parentElement?.querySelector(".card-heading");
    if (heading && !$("artifact-hub-filter")) { const filter = document.createElement("select"); filter.id = "artifact-hub-filter"; filter.setAttribute("aria-label", "Artifact filter"); const option = document.createElement("option"); option.value = "recent"; option.textContent = "Recent / 最近"; filter.append(option); heading.append(filter); }
    const skillRoot = $("product-skills");
    if (skillRoot && !$("product-connected-apps")) {
      const section = document.createElement("section"); section.className = "settings-card";
      const heading = document.createElement("div"); heading.className = "card-heading";
      const copy = document.createElement("div"); const title = document.createElement("h2"); title.textContent = "Connected Apps / 已连接应用"; const description = document.createElement("p"); description.textContent = "Governed capabilities assigned to a Team or Coworker; every action remains task-bound."; copy.append(title, description);
      const controls = document.createElement("div"); controls.className = "detail-actions"; const search = document.createElement("input"); search.id = "connected-app-search"; search.type = "search"; search.maxLength = 120; search.placeholder = "Search apps / 搜索应用"; search.setAttribute("aria-label", "Search Connected Apps"); const project = document.createElement("select"); project.id = "connected-app-project"; project.setAttribute("aria-label", "Project scope for Connected Apps"); project.append(new Option("All Projects / 全部项目", "")); controls.append(search, project); heading.append(copy, controls);
      const root = document.createElement("div"); root.id = "product-connected-apps"; root.className = "workspace-cards"; section.append(heading, root); skillRoot.closest(".settings-grid")?.insertBefore(section, skillRoot.closest(".settings-card")?.nextElementSibling);
      search.addEventListener("input", () => void refresh()); project.addEventListener("change", () => { connectedAppsProjectId = project.value; void refresh(); });
    }
    const channelFilter = $("product-channel-filter");
    if (channelFilter && ![...channelFilter.options].some((option) => option.value === "unread")) { const option = document.createElement("option"); option.value = "unread"; option.textContent = "Unread / 未读"; channelFilter.insertBefore(option, channelFilter.options[channelFilter.options.length - 1] ?? null); }
    $("nav-product-hubs")?.addEventListener("click", async () => { switchView("product-hubs"); try { await refresh(); } catch (e) { error($("product-playbooks"), e); } }); $("product-hubs-refresh")?.addEventListener("click", () => void refresh()); $("artifact-hub-filter")?.addEventListener("change", () => void refresh()); $("product-channel-filter")?.addEventListener("change", () => void refresh()); $("product-channel-switch")?.addEventListener("change", (event) => { if (event.target.value && typeof openConversation === "function") void openConversation(event.target.value); }); $("playbook-create")?.addEventListener("click", () => void createPlaybook());
  }
  setup();
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

// First-class Project surface.  Project ids are used only as opaque IPC selectors;
// all visible labels come from the safe Project projection and never from workspaces.
(() => {
  const api = window.sovereignbot;
  if (!api?.projects) return;
  const $ = (id) => document.getElementById(id);
  const state = { projects: [], selectedProjectId: "" };
  const clear = (node) => { if (node) node.textContent = ""; };
  const error = (reason) => { const node = $("project-result"); if (node) node.textContent = String(reason?.message ?? reason).slice(0, 240); };
  const setResult = (value) => { const node = $("project-result"); if (node) node.textContent = value; };
  const button = (label, fn, { disabled = false, className = "quiet-action" } = {}) => { const node = document.createElement("button"); node.type = "button"; node.className = className; node.textContent = label; node.disabled = disabled; if (!disabled) node.addEventListener("click", () => Promise.resolve().then(fn).catch(error)); return node; };
  const element = (tag, textContent) => { const node = document.createElement(tag); if (textContent !== undefined) node.textContent = textContent; return node; };
  async function exportProject(projectId) { const result = await api.projects.exportViaDialog({ projectId }); setResult(result.canceled ? "Project export canceled / 已取消项目导出" : `Project exported: ${result.fileName} / 项目已导出`); }
  function navigateCanonical(kind, entry) {
    if (kind === "channels" && entry.conversationId && typeof openConversation === "function") { void openConversation(entry.conversationId); return; }
    if (kind === "memory") { document.dispatchEvent(new CustomEvent("sovereignbot:open-memory", { detail: { view: "memory", scope: "project", ownerId: state.selectedProjectId, memoryId: entry.id } })); return; }
    const target = kind === "triggers" ? $("nav-triggers") : kind === "connectedApps" ? $("nav-apps") : kind === "files" || kind === "artifacts" ? $("nav-artifacts") : kind === "skills" ? $("nav-skills") : kind === "playbooks" ? $("nav-playbooks") : kind === "routines" ? $("nav-routines") : kind === "coworkers" ? $("nav-settings") : $("nav-work");
    if (target) target.click(); else if (typeof switchView === "function") switchView(kind === "coworkers" ? "settings" : kind === "connectedApps" ? "apps" : kind === "triggers" ? "triggers" : "work");
    const surfaceLabels = { triggers: "Triggers / 触发器", connectedApps: "Connected Apps / 已连接应用", files: "Files / 文件", artifacts: "Artifacts / 成果", skills: "Skills / 技能", playbooks: "Playbooks / 工作方法", routines: "Routines / 例行任务", coworkers: "Coworkers / 同事", teams: "Teams / 团队" };
    setResult(`${surfaceLabels[kind] ?? kind} canonical surface opened / 已打开标准页面`);
  }
  function renderContentSection(root, kind, label, section) {
    const card = element("section"); card.className = "project-content-section";
    const heading = element("div"); heading.className = "card-heading";
    const title = element("h3", `${label} / ${section.total ?? 0}${section.truncated ? " · showing first 50 / 仅显示前 50 项" : ""}`);
    const summary = element("p", section.total ? "Bounded Project contents / 已按项目范围限制" : `No ${label} yet / 暂无${label}`);
    heading.append(title, summary); card.append(heading);
    const list = element("div"); list.className = "project-content-list";
    for (const entry of section.items ?? []) {
      const row = element("article"); row.className = "project-content-item";
      const copy = element("div");
      const name = element("strong", entry.name ?? entry.title ?? entry.fileName ?? "Unnamed");
      const meta = element("p", [entry.state, entry.status, entry.summary].filter(Boolean).join(" · ") || "Project item");
      copy.append(name, meta); row.append(copy);
      const actions = element("div"); actions.className = "detail-actions";
      const canNavigate = kind !== "teams" || entry.navigation;
      const actionLabels = { teams: "Open Team / 打开团队", channels: "Open Channel / 打开频道", coworkers: "Open Coworker / 打开同事", files: "Open File / 打开文件", artifacts: "Open Artifact / 打开成果", skills: "Open Skill / 打开技能", playbooks: "Open Playbook / 打开工作方法", routines: "Open Routine / 打开例行任务", triggers: "Open Trigger / 打开触发器", memory: "Open Memory / 打开记忆", connectedApps: "Open Connected Apps / 打开已连接应用" };
      actions.append(button(actionLabels[kind] ?? `Open ${label}`, () => navigateCanonical(kind, entry), { disabled: !canNavigate }));
      if ((kind === "files" || kind === "artifacts") && entry.conversationId) actions.append(button("Source conversation / 来源会话", () => { if (typeof openConversation === "function") void openConversation(entry.conversationId); }));
      row.append(actions); list.append(row);
    }
    if (!section.items?.length) list.append(element("p", `No ${label} in this Project / 此项目暂无${label}`));
    card.append(list); root.append(card);
  }
  function renderDetail(project) {
    const root = $("project-detail"); if (!root) return; clear(root);
    if (!project) { root.append(element("p", "Choose a Project to inspect its command center / 请选择项目查看项目指挥中心")); return; }
    const heading = element("div"); heading.className = "project-workbench-heading";
    heading.append(element("h2", project.name), element("p", `${project.state === "archived" ? "Archived / 已归档" : "Active / 活跃"} · ${project.available ? "Available / 可用" : "Unavailable / 不可用"} · ${project.summary ?? ""}`));
    if (project.lastOpenedAt || project.updatedAt) heading.append(element("p", `Recent activity / 最近活动: ${project.lastOpenedAt ?? project.updatedAt}`));
    root.append(heading);
    if (!project.available) { const unavailable = element("p", "This Project is inspectable but read-only until its trusted workspace is available. / 此项目可查看，但可信工作区不可用期间为只读。"); unavailable.className = "inline-error"; root.append(unavailable); }
    const contents = project.contents ?? {};
    const groups = [["teams", "Teams / 团队"], ["channels", "Channels / 频道"], ["coworkers", "Coworkers / 同事"], ["files", "Files / 文件"], ["artifacts", "Artifacts / 成果"], ["skills", "Skills / 技能"], ["playbooks", "Playbooks / 工作方法"], ["routines", "Routines / 例行任务"], ["triggers", "Triggers / 触发器"], ["memory", "Memory / 记忆"], ["connectedApps", "Connected Apps / 已连接应用"]];
    for (const [kind, label] of groups) renderContentSection(root, kind, label, contents[kind] ?? { items: [], total: 0, truncated: false });
  }
  function selectProject(projectId, message = true) { state.selectedProjectId = projectId || ""; const project = state.projects.find((entry) => entry.projectId === state.selectedProjectId); renderDetail(project); const switcher = $("project-switcher"); if (switcher) switcher.value = state.selectedProjectId; if (message && project) setResult(`Selected ${project.name} / 已选择项目`); }
  function openProjectCreateDialog() { const form = $("project-create-form"); const errorNode = $("project-create-form-error"); form?.reset(); if (errorNode) { errorNode.textContent = ""; errorNode.classList.add("hidden"); } const dialog = $("project-create-dialog"); if (dialog?.showModal) { dialog.showModal(); $("project-create-name")?.focus(); } }
  async function createProjectFromDialog(event) {
    event.preventDefault();
    const name = $("project-create-name")?.value.trim() ?? "";
    const errorNode = $("project-create-form-error");
    if (!name) { if (errorNode) { errorNode.textContent = "Enter a Project name / 请输入项目名称"; errorNode.classList.remove("hidden"); } return; }
    if (errorNode) { errorNode.textContent = ""; errorNode.classList.add("hidden"); }
    const saveButton = $("project-create-save"); if (saveButton) saveButton.disabled = true;
    try { const created = await api.projects.create({ name }); $("project-create-dialog")?.close(); $("project-create-form")?.reset(); setResult("Project created / 项目已创建"); await refresh(created?.projectId); }
    catch (reason) { if (errorNode) { errorNode.textContent = String(reason?.message ?? reason).replace(/^.*Error: /, "").slice(0, 240); errorNode.classList.remove("hidden"); } }
    finally { if (saveButton) saveButton.disabled = false; }
  }
  function ensureView() {
    if ($("nav-projects") && $("view-projects")) return;
    const nav = document.createElement("button"); nav.id = "nav-projects"; nav.type = "button"; nav.className = "utility-nav"; nav.textContent = "◈ Projects / 项目";
    nav.addEventListener("click", () => { if (typeof switchView === "function") switchView("projects"); document.querySelectorAll(".utility-nav").forEach((item) => item.classList.toggle("active", item === nav)); void refresh(); });
    $("nav-work")?.parentElement?.prepend(nav);
    const view = document.createElement("section"); view.id = "view-projects"; view.className = "main-view settings-view hidden";
    const header = element("header"); header.className = "page-header";
    const intro = element("div"); const eyebrow = element("span", "PROJECTS / 项目"); eyebrow.className = "eyebrow"; intro.append(eyebrow, element("h1", "Projects"), element("p", "Projects organize Teams, Channels, Coworkers, Files, Artifacts, Skills, Playbooks, Routines, Triggers, Memory, and Connected Apps."));
    const controls = element("div"); controls.className = "detail-actions"; const switcher = element("select"); switcher.id = "project-switcher"; switcher.setAttribute("aria-label", "Project switcher"); switcher.append(element("option", "Choose a Project / 选择项目")); const refreshButton = element("button", "Refresh / 刷新"); refreshButton.id = "project-refresh"; refreshButton.type = "button"; refreshButton.className = "quiet-action"; const createButton = element("button", "New Project / 新建项目"); createButton.id = "project-create"; createButton.type = "button"; createButton.className = "hero-action"; controls.append(switcher, refreshButton, createButton); header.append(intro, controls);
    const result = element("p"); result.id = "project-result"; result.className = "setting-feedback";
    const card = element("section"); card.className = "settings-card span-2"; const cardHeading = element("div"); cardHeading.className = "card-heading"; const cardCopy = element("div"); cardCopy.append(element("h2", "Projects / 项目"), element("p", "Select a Project to inspect its command center. Trusted workspace details remain hidden.")); cardHeading.append(cardCopy); const list = element("div"); list.id = "project-list"; list.className = "project-list"; card.append(cardHeading, list);
    const detailCard = element("section"); detailCard.className = "settings-card span-2"; const detailHeading = element("div"); detailHeading.className = "card-heading"; const detailCopy = element("div"); detailCopy.append(element("h2", "Project Command Center / 项目指挥中心"), element("p", "One bounded view of the selected Project and its canonical related surfaces.")); detailHeading.append(detailCopy); const detail = element("div"); detail.id = "project-detail"; detail.className = "project-workbench"; detailCard.append(detailHeading, detail); view.append(header, result, card, detailCard);
    $("view-product-hubs")?.parentElement?.insertBefore(view, $("view-product-hubs"));
    $("project-switcher")?.addEventListener("change", (event) => selectProject(event.target.value));
    $("project-refresh")?.addEventListener("click", () => void refresh());
    $("project-create")?.addEventListener("click", openProjectCreateDialog);
    $("project-create-form")?.addEventListener("submit", createProjectFromDialog);
  }
  function render(projects, preferredProjectId = state.selectedProjectId) {
    state.projects = Array.isArray(projects) ? projects : [];
    const root = $("project-list"); if (!root) return; clear(root);
    const switcher = $("project-switcher"); if (switcher) { switcher.textContent = ""; const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Choose a Project / 选择项目"; switcher.append(placeholder); for (const project of state.projects) { const option = document.createElement("option"); option.value = project.projectId; option.textContent = `${project.name}${project.state === "archived" ? " · Archived / 已归档" : ""}${!project.available ? " · Unavailable / 不可用" : ""}`; switcher.append(option); } }
    const selectedId = state.projects.some((entry) => entry.projectId === preferredProjectId) ? preferredProjectId : state.projects[0]?.projectId ?? "";
    for (const project of projects) {
      const card = document.createElement("article"); card.className = "project-card";
      const title = document.createElement("h3"); title.textContent = project.name;
      const status = document.createElement("p"); status.textContent = `${project.state === "archived" ? "Archived / 已归档" : "Active / 活跃"} · ${project.available ? "Available / 可用" : "Unavailable / 不可用"}`;
      card.classList.toggle("selected", project.projectId === selectedId);
      const counts = document.createElement("p"); counts.className = "project-counts"; counts.textContent = Object.entries(project.counts ?? {}).map(([key, value]) => `${key}: ${value}`).join(" · ");
      const contents = document.createElement("p"); contents.textContent = project.summary ?? ((project.teams ?? []).map((team) => `${team.name} (${team.channels?.length ?? 0} channels)`).join(" · ") || "No Teams yet / 暂无团队");
      const actions = document.createElement("div"); actions.className = "detail-actions";
      actions.append(button("Inspect / 查看", () => selectProject(project.projectId), { className: "hero-action" }));
      actions.append(button("Open / 打开", async () => { await api.projects.open({ projectId: project.projectId }); setResult(`Opened ${project.name} / 已打开`); await refresh(project.projectId); }, { disabled: project.state === "archived" || !project.available }));
      actions.append(button(project.state === "archived" ? "Restore / 恢复" : "Archive / 归档", async () => { await (project.state === "archived" ? api.projects.restore : api.projects.archive)({ projectId: project.projectId }); await refresh(project.projectId); }, { disabled: !project.available }));
      actions.append(button("Export / 导出", () => exportProject(project.projectId), { disabled: !project.available }));
      actions.append(button("Backup / 备份", async () => { await api.projects.backup({ projectId: project.projectId }); setResult("Portable Project backup created / 可移植项目备份已创建"); }, { disabled: !project.available }));
      actions.append(button("Memory / 记忆", () => document.dispatchEvent(new CustomEvent("sovereignbot:open-memory", { detail: { view: "memory", scope: "project", ownerId: project.projectId } }))));
      actions.append(button("Add fact / 添加事实", () => document.dispatchEvent(new CustomEvent("sovereignbot:open-memory", { detail: { view: "memory", scope: "project", ownerId: project.projectId, addFact: true } })), { disabled: project.state === "archived" || !project.available }));
      card.append(title, status, counts, contents, actions); root.append(card);
    }
    if (!projects.length) { const empty = document.createElement("p"); empty.textContent = "No Projects yet / 暂无项目"; root.append(empty); }
    if (switcher) switcher.value = selectedId;
    selectProject(selectedId, false);
  }
  async function refresh(preferredProjectId = state.selectedProjectId) { ensureView(); try { const result = await api.projects.list({ includeArchived: true, limit: 50 }); render(result.projects ?? [], preferredProjectId); } catch (reason) { error(reason); } }
  const initializeProjectSurface = () => { ensureView(); void refresh(); };
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", initializeProjectSurface, { once: true }); else initializeProjectSurface();
  document.addEventListener("sovereignbot:open-project", async (event) => {
    ensureView();
    if (typeof switchView === "function") switchView("projects");
    document.querySelectorAll(".utility-nav").forEach((item) => item.classList.toggle("active", item.id === "nav-projects"));
    const projectId = event.detail?.projectId;
    await refresh(projectId);
  });
})();

// Independent product pages. The original Product Hubs overview remains a
// compact dashboard; these page controllers provide full-library workflows
// without creating another store or execution engine.
(() => {
  const api = window.sovereignbot;
  if (!api?.playbooks || !api?.artifacts?.hub || typeof api.artifacts.history !== "function" || typeof api.artifacts.restoreAsNewVersion !== "function" || typeof api.artifacts.reviseViaDialog !== "function" || !api?.skills || !api?.teams) return;
  const $ = (id) => document.getElementById(id);
  const pageRoots = {
    playbooks: $("product-playbooks-page"),
    artifacts: $("product-artifacts-page"),
    history: $("product-computer-history-page"),
    skills: $("product-skills-page"),
    packs: $("product-packs-page"),
    channels: $("product-channels-page"),
  };
  const cache = { teams: [], coworkers: [], workspaces: [], conversations: [], templates: [] };
  const navViews = new Map([
    ["nav-product-hubs", "product-hubs"], ["nav-playbooks", "playbooks"], ["nav-artifacts", "artifacts"],
    ["nav-computer-history", "computer-history"], ["nav-skills", "skills"], ["nav-team-packs", "team-packs"], ["nav-channels", "channels"],
  ]);
  const clear = (node) => { if (node) node.textContent = ""; };
  const text = (label, value) => { const node = document.createElement("span"); node.textContent = `${label}: ${value === undefined || value === null || value === "" ? "—" : value}`; return node; };
  const showError = (root, reason) => { if (!root) return; const node = document.createElement("p"); node.className = "inline-error"; node.textContent = String(reason?.message ?? reason).slice(0, 240); root.append(node); };
  const button = (label, fn, root, className = "quiet-action") => { const node = document.createElement("button"); node.type = "button"; node.className = className; node.textContent = label; node.addEventListener("click", () => Promise.resolve().then(fn).catch((reason) => showError(root, reason))); return node; };
  const select = (label) => { const node = document.createElement("select"); node.setAttribute("aria-label", label); return node; };
  const copy = async (value) => { try { await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); } catch { window.alert("Clipboard is unavailable."); } };
  const readJson = (label, value = "") => { const raw = window.prompt(label, value ? JSON.stringify(value, null, 2) : ""); if (!raw) return undefined; try { return JSON.parse(raw); } catch { throw new Error("Paste valid JSON."); } };
  const openConversationSafe = (id) => id && typeof openConversation === "function" ? openConversation(id) : undefined;
  const refreshHost = () => Promise.all([typeof refreshConversations === "function" ? refreshConversations() : undefined, typeof refreshTeams === "function" ? refreshTeams() : undefined, typeof refreshCoworkers === "function" ? refreshCoworkers() : undefined]);
  const unread = (conversation) => {
    const last = conversation?.lastMessage;
    if (!conversation?.id || !last?.createdAt || last.senderId === "user") return false;
    return typeof conversationUnread === "function" ? conversationUnread(conversation) : true;
  };
  function nav(view) {
    if (typeof switchView === "function") switchView(view);
    for (const [id, target] of navViews) $(id)?.classList.toggle("active", target === view);
    void refresh().catch((reason) => showError(pageRoots[view === "computer-history" ? "history" : view] ?? pageRoots.playbooks, reason));
  }
  function populate(id, options, selected) {
    const node = $(id); if (!node) return;
    node.textContent = "";
    for (const entry of options) { const option = document.createElement("option"); option.value = entry.value; option.textContent = entry.label; node.append(option); }
    if ([...node.options].some((option) => option.value === selected)) node.value = selected;
  }
  function selected(id, fallback) { return $(id)?.value || fallback; }
  let focusedArtifactId;
  let pendingArtifactId;
  let artifactScopeOverride = "";
  let historyScopeOverride = "";
  let artifactDeepLinkNotice = "";
  let historyDeepLinkNotice = "";
  let artifactPreviewRequest = 0;
  let refreshGeneration = 0;
  const safeOpaqueId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : "";
  async function openArtifactPreview(item) {
    const dialog = $("artifact-preview-dialog");
    if (!dialog) return;
    const request = ++artifactPreviewRequest;
    const title = $("artifact-preview-title"); const meta = $("artifact-preview-meta"); const status = $("artifact-preview-status"); const body = $("artifact-preview-body");
    title.textContent = item.title || item.fileName || "Artifact";
    meta.textContent = `${item.mimeType || "application/octet-stream"} · ${item.size ?? 0} bytes · v${item.version ?? 1}`;
    status.textContent = "Loading a bounded preview…"; body.textContent = "";
    dialog.showModal?.();
    try {
      const result = await api.artifacts.preview({ artifactId: item.id });
      if (request !== artifactPreviewRequest) return;
      const artifact = result?.artifact ?? item;
      title.textContent = artifact.title || artifact.fileName || "Artifact";
      meta.textContent = `${artifact.mimeType || "application/octet-stream"} · ${artifact.size ?? 0} bytes · v${artifact.version ?? 1}`;
      if (typeof result?.preview === "string") {
        body.textContent = result.preview;
        status.textContent = result.truncated ? "Readable text preview · truncated to a safe limit." : "Readable text preview.";
      } else {
        body.textContent = "This artifact type is not previewable in the product surface. The managed file was not opened in the renderer.";
        status.textContent = "Preview unavailable for this MIME type.";
      }
    } catch {
      if (request !== artifactPreviewRequest) return;
      body.textContent = "No preview is available.";
      status.textContent = "Preview unavailable: the managed artifact could not be read safely.";
    }
  }

  function playbookSemanticPlan(item) {
    return Object.fromEntries(["stages", "reviewPoints", "expectedOutput", "recommendedCoworkerRoles", "recommendedSkillIds"].map((field) => [field, item[field]]).filter(([, value]) => value !== undefined));
  }
  function appendPlaybookPlan(card, item) {
    const plan = playbookSemanticPlan(item); const hasPlan = Object.keys(plan).length > 0; if (!hasPlan) return;
    const details = document.createElement("details"); details.className = "playbook-plan";
    const summary = document.createElement("summary"); summary.textContent = `Plan / 计划 · ${item.stages?.length ?? 0} stages · ${item.reviewPoints?.length ?? 0} review points`; details.append(summary);
    details.append(text("Guidance / 使用方式", "Current owner may skip or reorder stages, bring in a specialist, or request review. Recommendations are advisory."));
    if (item.expectedOutput) details.append(text("Expected output / 预期产出", item.expectedOutput));
    if (item.recommendedCoworkerRoles?.length) details.append(text("Recommended Coworker roles / 推荐同事角色", item.recommendedCoworkerRoles.join(", ")));
    if (item.recommendedSkillIds?.length) details.append(text("Recommended Skills / 推荐技能", item.recommendedSkillIds.join(", ")));
    for (const [index, stage] of (item.stages ?? []).entries()) {
      const stageNode = document.createElement("div"); stageNode.className = "playbook-stage";
      stageNode.append(text(`Stage ${index + 1} / 阶段 ${index + 1}`, stage.name), text("Instructions / 指引", stage.instructions));
      if (stage.expectedOutput) stageNode.append(text("Stage output / 阶段产出", stage.expectedOutput));
      if (stage.recommendedCoworkerRole) stageNode.append(text("Coworker role / 同事角色", stage.recommendedCoworkerRole));
      if (stage.recommendedSkillIds?.length) stageNode.append(text("Skills / 技能", stage.recommendedSkillIds.join(", ")));
      details.append(stageNode);
    }
    for (const [index, point] of (item.reviewPoints ?? []).entries()) {
      const pointNode = document.createElement("div"); pointNode.className = "playbook-review-point";
      pointNode.append(text(`Review point ${index + 1} / 复核点 ${index + 1}`, point.name), text("Review instructions / 复核指引", point.instructions));
      if (point.recommendedCoworkerRole) pointNode.append(text("Reviewer role / 复核角色", point.recommendedCoworkerRole));
      if (point.recommendedSkillIds?.length) pointNode.append(text("Skills / 技能", point.recommendedSkillIds.join(", ")));
      details.append(pointNode);
    }
    card.append(details);
  }

  let editingPlaybook;
  const playbookEditorClone = (value) => structuredClone(value);
  const playbookEditorId = (prefix) => prefix + "-" + String(globalThis.crypto?.randomUUID?.() || (Date.now() + "-" + Math.random())).replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  const playbookEditorError = (message = "") => { const node = $("playbook-form-error"); if (node) { node.textContent = message; node.classList.toggle("hidden", !message); } };
  const playbookEditorField = (label, value, className, { textarea = false, maxLength = 0 } = {}) => { const wrapper = document.createElement("label"); wrapper.className = "setting-field"; const caption = document.createElement("span"); caption.textContent = label; wrapper.append(caption); const field = document.createElement(textarea ? "textarea" : "input"); field.className = className; field.value = value ?? ""; if (maxLength) field.maxLength = maxLength; wrapper.append(field); return wrapper; };
  const playbookEditorButton = (label, handler) => { const node = document.createElement("button"); node.type = "button"; node.className = "quiet-action"; node.textContent = label; node.addEventListener("click", () => void handler()); return node; };
  const playbookEditorOriginal = (list, id) => list.find((entry) => entry.id === id) ?? {};
  const playbookEditorList = (value) => String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);

  function readPlaybookEditor() {
    if (!editingPlaybook) throw new Error("Playbook editor is not open.");
    const playbook = playbookEditorClone(editingPlaybook);
    playbook.name = $("playbook-editor-name")?.value.trim() ?? "";
    playbook.description = $("playbook-editor-description")?.value.trim() ?? "";
    playbook.expectedOutput = $("playbook-editor-output")?.value.trim() ?? "";
    playbook.recommendedCoworkerRoles = playbookEditorList($("playbook-editor-roles")?.value);
    playbook.recommendedSkillIds = playbookEditorList($("playbook-editor-skills")?.value);
    playbook.steps = [...(document.querySelectorAll("#playbook-editor-steps .playbook-editor-step-value") ?? [])].map((field) => field.value.trim()).filter(Boolean);
    playbook.stages = [...(document.querySelector("#playbook-editor-stages")?.children ?? [])].map((row) => {
      const original = playbookEditorOriginal(playbook.stages ?? [], row.dataset.id);
      const next = { ...original, id: row.dataset.id, name: row.querySelector(".playbook-editor-stage-name")?.value.trim() ?? "", instructions: row.querySelector(".playbook-editor-stage-instructions")?.value.trim() ?? "" };
      const output = row.querySelector(".playbook-editor-stage-output")?.value.trim() ?? ""; const role = row.querySelector(".playbook-editor-stage-role")?.value.trim() ?? ""; const skills = playbookEditorList(row.querySelector(".playbook-editor-stage-skills")?.value);
      if (output) next.expectedOutput = output; else delete next.expectedOutput;
      if (role) next.recommendedCoworkerRole = role; else delete next.recommendedCoworkerRole;
      if (skills.length) next.recommendedSkillIds = skills; else delete next.recommendedSkillIds;
      return next;
    });
    playbook.reviewPoints = [...(document.querySelector("#playbook-editor-reviews")?.children ?? [])].map((row) => {
      const original = playbookEditorOriginal(playbook.reviewPoints ?? [], row.dataset.id);
      const next = { ...original, id: row.dataset.id, name: row.querySelector(".playbook-editor-review-name")?.value.trim() ?? "", instructions: row.querySelector(".playbook-editor-review-instructions")?.value.trim() ?? "" };
      const role = row.querySelector(".playbook-editor-review-role")?.value.trim() ?? ""; const skills = playbookEditorList(row.querySelector(".playbook-editor-review-skills")?.value);
      if (role) next.recommendedCoworkerRole = role; else delete next.recommendedCoworkerRole;
      if (skills.length) next.recommendedSkillIds = skills; else delete next.recommendedSkillIds;
      return next;
    });
    if (!playbook.expectedOutput) delete playbook.expectedOutput;
    if (!playbook.recommendedCoworkerRoles.length) delete playbook.recommendedCoworkerRoles;
    if (!playbook.recommendedSkillIds.length) delete playbook.recommendedSkillIds;
    return playbook;
  }

  function movePlaybookEditorEntry(collection, index, delta) {
    const next = readPlaybookEditor(); const list = next[collection] ?? []; const target = index + delta; if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]]; next[collection] = list; renderPlaybookEditor(next);
  }

  function renderPlaybookEditor(playbook) {
    editingPlaybook = playbookEditorClone(playbook);
    $("playbook-editor-id").value = editingPlaybook.id ?? "";
    $("playbook-editor-title").textContent = editingPlaybook.id ? "Edit playbook / 编辑工作方法" : "New playbook / 新建工作方法";
    $("playbook-editor-name").value = editingPlaybook.name ?? "";
    $("playbook-editor-description").value = editingPlaybook.description ?? "";
    $("playbook-editor-output").value = editingPlaybook.expectedOutput ?? "";
    $("playbook-editor-roles").value = (editingPlaybook.recommendedCoworkerRoles ?? []).join(", ");
    $("playbook-editor-skills").value = (editingPlaybook.recommendedSkillIds ?? []).join(", ");
    playbookEditorError();
    const stepsRoot = $("playbook-editor-steps"); clear(stepsRoot);
    for (const [index, step] of (editingPlaybook.steps ?? []).entries()) {
      const row = document.createElement("div"); row.className = "playbook-editor-row playbook-editor-step-row";
      row.append(playbookEditorField("Step " + (index + 1) + " / 步骤", step, "playbook-editor-step-value", { maxLength: 128 }));
      const actions = document.createElement("div"); actions.className = "detail-actions"; actions.append(playbookEditorButton("↑", () => movePlaybookEditorEntry("steps", index, -1)), playbookEditorButton("↓", () => movePlaybookEditorEntry("steps", index, 1)), playbookEditorButton("Remove / 删除", () => { const next = readPlaybookEditor(); next.steps.splice(index, 1); renderPlaybookEditor(next); })); row.append(actions); stepsRoot.append(row);
    }
    const stagesRoot = $("playbook-editor-stages"); clear(stagesRoot);
    for (const [index, stage] of (editingPlaybook.stages ?? []).entries()) {
      const row = document.createElement("article"); row.className = "playbook-editor-row"; row.dataset.id = stage.id;
      const heading = document.createElement("div"); heading.className = "playbook-editor-heading"; const title = document.createElement("strong"); title.textContent = stage.name || "Stage"; const actions = document.createElement("div"); actions.className = "detail-actions"; actions.append(playbookEditorButton("↑", () => movePlaybookEditorEntry("stages", index, -1)), playbookEditorButton("↓", () => movePlaybookEditorEntry("stages", index, 1)), playbookEditorButton("Remove / 删除", () => { const next = readPlaybookEditor(); next.stages.splice(index, 1); renderPlaybookEditor(next); })); heading.append(title, actions); row.append(heading);
      const grid = document.createElement("div"); grid.className = "playbook-editor-grid"; grid.append(playbookEditorField("Name / 名称", stage.name, "playbook-editor-stage-name", { maxLength: 120 }), playbookEditorField("Expected output / 阶段产出", stage.expectedOutput, "playbook-editor-stage-output", { maxLength: 500 }), playbookEditorField("Recommended role / 推荐角色", stage.recommendedCoworkerRole, "playbook-editor-stage-role", { maxLength: 120 }), playbookEditorField("Recommended Skills / 推荐技能", (stage.recommendedSkillIds ?? []).join(", "), "playbook-editor-stage-skills", { maxLength: 1000 })); row.append(grid, playbookEditorField("Instructions / 指引", stage.instructions, "playbook-editor-stage-instructions", { textarea: true, maxLength: 2000 })); stagesRoot.append(row);
    }
    const reviewsRoot = $("playbook-editor-reviews"); clear(reviewsRoot);
    for (const [index, point] of (editingPlaybook.reviewPoints ?? []).entries()) {
      const row = document.createElement("article"); row.className = "playbook-editor-row"; row.dataset.id = point.id;
      const heading = document.createElement("div"); heading.className = "playbook-editor-heading"; const title = document.createElement("strong"); title.textContent = point.name || "Review point"; const actions = document.createElement("div"); actions.className = "detail-actions"; actions.append(playbookEditorButton("↑", () => movePlaybookEditorEntry("reviewPoints", index, -1)), playbookEditorButton("↓", () => movePlaybookEditorEntry("reviewPoints", index, 1)), playbookEditorButton("Remove / 删除", () => { const next = readPlaybookEditor(); next.reviewPoints.splice(index, 1); renderPlaybookEditor(next); })); heading.append(title, actions); row.append(heading);
      const grid = document.createElement("div"); grid.className = "playbook-editor-grid"; grid.append(playbookEditorField("Name / 名称", point.name, "playbook-editor-review-name", { maxLength: 120 }), playbookEditorField("Recommended role / 推荐角色", point.recommendedCoworkerRole, "playbook-editor-review-role", { maxLength: 120 }), playbookEditorField("Recommended Skills / 推荐技能", (point.recommendedSkillIds ?? []).join(", "), "playbook-editor-review-skills", { maxLength: 1000 })); row.append(grid, playbookEditorField("Instructions / 复核指引", point.instructions, "playbook-editor-review-instructions", { textarea: true, maxLength: 2000 })); reviewsRoot.append(row);
    }
    $("playbook-dialog")?.showModal?.();
    $("playbook-editor-name")?.focus();
  }

  function newPlaybook() { renderPlaybookEditor({ name: "", description: "", steps: ["chief"], stages: [], reviewPoints: [] }); }
  async function editPlaybook(item) { renderPlaybookEditor(await api.playbooks.export({ playbookId: item.id })); }
  async function exportPlaybookToFile(item) { const result = await api.playbooks.exportViaDialog({ playbookId: item.id }); const status = $("playbook-file-result"); if (status) status.textContent = result.canceled ? "Export canceled." : "Exported " + result.fileName + "."; }
  async function importPlaybookFromFile() { const result = await api.playbooks.importViaDialog({}); const status = $("playbook-file-result"); if (result.canceled) { if (status) status.textContent = "Import canceled."; return; } await refresh(); if (status) status.textContent = "Imported " + result.fileName + "."; }

  function playbooks(items) {
    const root = pageRoots.playbooks; if (!root) return; clear(root);
    for (const item of items) {
      const card = document.createElement("article"); card.className = "settings-card"; card.dataset.playbookId = item.id;
      const title = document.createElement("h3"); title.textContent = item.name;
      card.append(title, text("Description", item.description), text("Steps", item.steps.join(" → ")), text("Teams", item.assignedTeams.map((entry) => entry.name).join(", ") || "None"), text("Channels", item.assignedChannels.map((entry) => entry.name).join(", ") || "None"), text("State", item.state), text("Updated", item.updatedAt)); appendPlaybookPlan(card, item);
      const actions = document.createElement("div"); actions.className = "detail-actions";
      actions.append(button("Export / 导出", () => exportPlaybookToFile(item), root), button("Duplicate / 复制", async () => { await api.playbooks.duplicate({ playbookId: item.id }); await refresh(); }, root), button(item.state === "archived" ? "Restore / 恢复" : "Archive / 归档", async () => { await (item.state === "archived" ? api.playbooks.restore : api.playbooks.archive)({ playbookId: item.id }); await refresh(); }, root), button("Edit / 编辑", () => editPlaybook(item), root));
      const teamSelect = select("Team for playbook " + item.name);
      for (const team of cache.teams) { const option = document.createElement("option"); option.value = team.id; option.textContent = "Team: " + team.name; teamSelect.append(option); }
      const channelSelect = select("Channel for playbook " + item.name);
      for (const team of cache.teams) for (const channel of team.channels ?? []) { const option = document.createElement("option"); option.value = channel.id; option.textContent = "Channel: " + team.name + " / " + channel.name; channelSelect.append(option); }
      if (item.state !== "archived" && teamSelect.options.length) actions.append(teamSelect, button("Assign Team / 分配团队", async () => { await api.playbooks.assign({ playbookId: item.id, teamId: teamSelect.value }); await refresh(); }, root));
      if (item.state !== "archived" && channelSelect.options.length) actions.append(channelSelect, button("Assign Channel / 分配频道", async () => { await api.playbooks.assign({ playbookId: item.id, channelId: channelSelect.value }); await refresh(); }, root));
      card.append(actions); root.append(card);
    }
    if (!items.length) root.append(text("Playbooks", "No methods yet. Create the first human-readable method."));
  }

  function artifacts(items) {
    const root = pageRoots.artifacts; if (!root) return; clear(root);
    for (const item of items) {
      const card = document.createElement("article"); card.className = "settings-card"; card.dataset.artifactId = item.id;
      if (item.id === focusedArtifactId) { card.classList.add("artifact-focused"); card.setAttribute("aria-current", "true"); }
      const title = document.createElement("h3"); title.textContent = item.title || item.fileName;
      card.append(title, text("Type", item.mimeType), text("Version", item.version ? `v${item.version}` : "Original"), text("Creator", item.creator?.name), text("Team", item.team?.name), text("Channel", item.channel?.name), text("Created", item.createdAt), text("History", item.history?.map((entry) => `${entry.event} · ${entry.timestamp}`).join(", ")), text("Status", item.status));
      const actions = document.createElement("div"); actions.className = "detail-actions";
      const exportStatus = document.createElement("p"); exportStatus.className = "setting-feedback"; exportStatus.setAttribute("role", "status");
      actions.append(button("Preview / 预览", () => openArtifactPreview(item), root), button("Open / 打开", () => api.artifacts.open({ artifactId: item.id }), root), button("Reveal / 显示", () => api.artifacts.reveal({ artifactId: item.id }), root), button(item.archived ? "Restore / 恢复" : "Archive / 归档", async () => {
        await (item.archived ? api.artifacts.restore : api.artifacts.archive)({ artifactId: item.id });
        await refresh();
      }, root), button("Export copy / 导出副本", async () => {
        const result = await api.artifacts.exportViaDialog({ artifactId: item.id });
        exportStatus.textContent = result?.canceled ? "Export canceled / 已取消导出" : `Exported ${result.fileName} / 已导出副本`;
      }, root), button("History / 历史", async () => {
        const existing = card.querySelector(".artifact-history-panel");
        if (existing) { existing.remove(); return; }
        const result = await api.artifacts.history({ artifactId: item.id });
        const panel = document.createElement("div"); panel.className = "artifact-history-panel";
        for (const entry of result.artifacts ?? []) {
          const row = document.createElement("div"); row.className = "artifact-history-row";
          row.append(text("Version", `v${entry.version ?? 1}`), text("Created", entry.createdAt), text("State", entry.parentArtifactId ? "Restored" : "Original"));
          row.append(button(`Restore v${entry.version ?? 1} as new version / 恢复为新版本`, async () => { await api.artifacts.restoreAsNewVersion({ artifactId: entry.id }); await refresh(); }, root));
          panel.append(row);
        }
        if (!result.artifacts?.length) panel.append(text("History", "No history available."));
        card.append(panel);
      }, root), button("Restore as new version / 恢复为新版本", async () => { await api.artifacts.restoreAsNewVersion({ artifactId: item.id }); await refresh(); }, root), button("Revise with local file / 选择文件生成修订版", async () => {
        const result = await api.artifacts.reviseViaDialog({ artifactId: item.id });
        if (result?.error) throw new Error(result.error);
        if (!result?.canceled && result?.artifact) await refresh();
      }, root));
      if (item.conversationId) actions.append(button("Go to conversation / 前往会话", () => openConversationSafe(item.conversationId), root));
      card.append(actions, exportStatus); root.append(card);
      if (item.id === focusedArtifactId) requestAnimationFrame(() => card.scrollIntoView?.({ block: "center" }));
    }
    if (!items.length) root.append(text("Artifacts", "No artifacts yet."));
  }

  function history(items) {
    const root = pageRoots.history; if (!root) return; clear(root);
    const coworkerId = selected("computer-history-filter-page", "all");
    const names = new Map(cache.coworkers.map((entry) => [entry.id, entry.name]));
    const visible = items.filter((entry) => coworkerId === "all" || entry.coworkerId === coworkerId);
    for (const item of visible) { const card = document.createElement("article"); card.className = "settings-card"; const title = document.createElement("h3"); title.textContent = item.activity; card.append(title, text("Source", item.source), text("Event", item.eventType), text("Coworker", names.get(item.coworkerId) ?? "Coworker"), text("Activity", item.summary), text("App", item.app), text("Site", item.site), text("Time", item.timestamp), text("Status", item.status)); root.append(card); }
    if (!visible.length) root.append(text("Computer History", coworkerId === "all" ? "No safe Computer activity recorded yet." : "No activity for this coworker."));
  }

  let editingSkill;
  const skillEditorClone = (value) => structuredClone(value);
  const skillEditorList = (value) => String(value ?? "").split("\n").map((entry) => entry.trim()).filter(Boolean);
  const skillEditorError = (message = "") => { const node = $("skill-form-error"); if (node) { node.textContent = message; node.classList.toggle("hidden", !message); } };
  const skillEditorField = (label, value, className, { textarea = false, maxLength = 0 } = {}) => { const wrapper = document.createElement("label"); wrapper.className = "setting-field"; const caption = document.createElement("span"); caption.textContent = label; wrapper.append(caption); const field = document.createElement(textarea ? "textarea" : "input"); field.className = className; field.value = value ?? ""; if (maxLength) field.maxLength = maxLength; wrapper.append(field); return wrapper; };
  const skillEditorButton = (label, handler) => { const node = document.createElement("button"); node.type = "button"; node.className = "quiet-action"; node.textContent = label; node.addEventListener("click", () => void handler()); return node; };
  function readSkillEditor() {
    if (!editingSkill) throw new Error("Skill editor is not open.");
    const skill = skillEditorClone(editingSkill);
    skill.name = $("skill-editor-name")?.value.trim() ?? ""; skill.description = $("skill-editor-description")?.value.trim() ?? ""; skill.instructions = $("skill-editor-instructions")?.value.trim() ?? ""; skill.source = $("skill-editor-source")?.value || "manual"; skill.expectedOutput = $("skill-editor-output")?.value.trim() ?? "";
    skill.inputs = [...($("skill-editor-inputs")?.children ?? [])].map((row) => ({ name: row.querySelector(".skill-editor-input-name")?.value.trim() ?? "", type: row.querySelector(".skill-editor-input-type")?.value.trim() ?? "string", description: row.querySelector(".skill-editor-input-description")?.value.trim() ?? "", required: row.querySelector(".skill-editor-input-required")?.checked !== false }));
    skill.steps = [...($("skill-editor-steps")?.children ?? [])].map((row) => row.querySelector(".skill-editor-step-value")?.value.trim() ?? "").filter(Boolean); skill.validators = [...($("skill-editor-validators")?.children ?? [])].map((row) => row.querySelector(".skill-editor-validator-value")?.value.trim() ?? "").filter(Boolean); skill.requestedCapabilities = [...document.querySelectorAll(".skill-editor-capability:checked")].map((field) => field.value); return skill;
  }
  function moveSkillEditorEntry(collection, index, delta) { const next = readSkillEditor(); const list = next[collection] ?? []; const target = index + delta; if (target < 0 || target >= list.length) return; [list[index], list[target]] = [list[target], list[index]]; next[collection] = list; renderSkillEditor(next); }
  function renderSkillEditor(skill) {
    editingSkill = skillEditorClone(skill); const archived = editingSkill.state === "archived"; $("skill-editor-id").value = editingSkill.id ?? ""; $("skill-editor-title").textContent = editingSkill.id ? "Edit skill / 编辑技能" : "New skill / 新建技能"; $("skill-editor-name").value = editingSkill.name ?? ""; $("skill-editor-description").value = editingSkill.description ?? ""; $("skill-editor-instructions").value = editingSkill.instructions ?? ""; $("skill-editor-source").value = editingSkill.source ?? "manual"; $("skill-editor-output").value = editingSkill.expectedOutput ?? "";
    for (const field of document.querySelectorAll("#skill-form input, #skill-form textarea, #skill-form select")) field.disabled = archived; $("skill-save").disabled = archived; $("skill-editor-readonly").classList.toggle("hidden", !archived); skillEditorError(); for (const field of document.querySelectorAll(".skill-editor-capability")) field.checked = (editingSkill.requestedCapabilities ?? []).includes(field.value);
    const inputsRoot = $("skill-editor-inputs"); clear(inputsRoot); for (const [index, entry] of (editingSkill.inputs ?? []).entries()) { const row = document.createElement("article"); row.className = "skill-editor-row"; row.append(skillEditorField("Name / 名称", entry.name, "skill-editor-input-name", { maxLength: 80 }), skillEditorField("Type / 类型", entry.type, "skill-editor-input-type", { maxLength: 40 }), skillEditorField("Description / 描述", entry.description, "skill-editor-input-description", { maxLength: 240 })); const required = document.createElement("label"); required.textContent = "Required / 必填 "; const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.className = "skill-editor-input-required"; checkbox.checked = entry.required !== false; required.append(checkbox); const actions = document.createElement("div"); actions.className = "detail-actions"; actions.append(skillEditorButton("↑", () => moveSkillEditorEntry("inputs", index, -1)), skillEditorButton("↓", () => moveSkillEditorEntry("inputs", index, 1)), skillEditorButton("Remove / 删除", () => { const next = readSkillEditor(); next.inputs.splice(index, 1); renderSkillEditor(next); })); row.append(required, actions); inputsRoot.append(row); }
    const stepsRoot = $("skill-editor-steps"); clear(stepsRoot); for (const [index, value] of (editingSkill.steps ?? []).entries()) { const row = document.createElement("div"); row.className = "skill-editor-row"; row.append(skillEditorField("Step " + (index + 1) + " / 步骤", value, "skill-editor-step-value", { maxLength: 800 })); const actions = document.createElement("div"); actions.className = "detail-actions"; actions.append(skillEditorButton("↑", () => moveSkillEditorEntry("steps", index, -1)), skillEditorButton("↓", () => moveSkillEditorEntry("steps", index, 1)), skillEditorButton("Remove / 删除", () => { const next = readSkillEditor(); next.steps.splice(index, 1); renderSkillEditor(next); })); row.append(actions); stepsRoot.append(row); }
    const validatorsRoot = $("skill-editor-validators"); clear(validatorsRoot); for (const [index, value] of (editingSkill.validators ?? []).entries()) { const row = document.createElement("div"); row.className = "skill-editor-row"; row.append(skillEditorField("Validator " + (index + 1) + " / 验证器", value, "skill-editor-validator-value", { maxLength: 500 })); const actions = document.createElement("div"); actions.className = "detail-actions"; actions.append(skillEditorButton("↑", () => moveSkillEditorEntry("validators", index, -1)), skillEditorButton("↓", () => moveSkillEditorEntry("validators", index, 1)), skillEditorButton("Remove / 删除", () => { const next = readSkillEditor(); next.validators.splice(index, 1); renderSkillEditor(next); })); row.append(actions); validatorsRoot.append(row); }
    $("skill-dialog")?.showModal?.(); $("skill-editor-name")?.focus();
  }
  function newSkill() { renderSkillEditor({ name: "", description: "", instructions: "", inputs: [], steps: [], validators: [], expectedOutput: "", requestedCapabilities: [], source: "manual" }); }
  async function editSkill(item) { renderSkillEditor(await api.skills.get({ skillId: item.id })); }

  function skills(items) {
    const root = pageRoots.skills; if (!root) return; clear(root);
    for (const item of items) {
      const card = document.createElement("article"); card.className = "settings-card"; card.dataset.skillId = item.id;
      const title = document.createElement("h3"); title.textContent = item.name;
      const assigned = [...(item.assignedTeamIds ?? []).map((id) => `Team: ${cache.teams.find((entry) => entry.id === id)?.name ?? id}`), ...(item.assignedCoworkerIds ?? []).map((id) => `Coworker: ${cache.coworkers.find((entry) => entry.id === id)?.name ?? id}`)];
      card.append(title, text("Description", item.description), text("Source", item.source), text("Status", item.state), text("Assigned", assigned.join(", ") || "Not assigned"), text("Last definition test", item.lastTestedAt));
      const actions = document.createElement("div"); actions.className = "detail-actions";
      actions.append(button("Edit / 编辑", () => editSkill(item), root));
      actions.append(button("Export / 导出", () => api.skills.exportViaDialog({ skillId: item.id }), root), button("Duplicate / 复制", async () => { await api.skills.duplicate({ skillId: item.id }); await refresh(); }, root), button("Retest definition / 重测定义", async () => { await api.skills.retest({ skillId: item.id }); await refresh(); }, root), button(item.state === "archived" ? "Restore / 恢复" : "Archive / 归档", async () => { await (item.state === "archived" ? api.skills.restore : api.skills.archive)({ skillId: item.id }); await refresh(); }, root));
      if (item.state === "active") actions.append(button("Create Routine / 创建例行任务", () => {
        document.dispatchEvent(new CustomEvent("sovereignbot:create-routine-from-skill", { detail: { skillId: item.id } }));
      }, root));
      const teamSelect = select("Team for skill " + item.name); for (const team of cache.teams) { const option = document.createElement("option"); option.value = team.id; option.textContent = `Team: ${team.name}`; teamSelect.append(option); }
      if (item.state === "active" && teamSelect.options.length) actions.append(teamSelect, button("Assign Team / 分配团队", async () => { await api.skills.assign({ skillId: item.id, targetKind: "team", targetId: teamSelect.value, enabled: !(item.assignedTeamIds ?? []).includes(teamSelect.value) }); await refresh(); }, root));
      const coworkerSelect = select("Coworker for skill " + item.name); for (const coworker of cache.coworkers) { const option = document.createElement("option"); option.value = coworker.id; option.textContent = `Coworker: ${coworker.name}`; coworkerSelect.append(option); }
      if (item.state === "active" && coworkerSelect.options.length) actions.append(coworkerSelect, button("Assign Coworker / 分配同事", async () => { await api.skills.assign({ skillId: item.id, targetKind: "coworker", targetId: coworkerSelect.value, enabled: !(item.assignedCoworkerIds ?? []).includes(coworkerSelect.value) }); await refresh(); }, root));
      card.append(actions); root.append(card);
    }
    if (!items.length) root.append(text("Skills", "No skills yet. Create a declarative skill."));
    root.append(button("Import skill / 导入技能", async () => { await api.skills.importViaDialog({}); await refresh(); }, root));
  }

  let editingPack;
  const editorRoot = (id) => $(id);
  const editorClone = (value) => structuredClone(value);
  const editorId = (prefix) => `${prefix}-${(globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9]/g, "").slice(0, 16)}`;
  const editorTextField = (label, value, className, { textarea = false, maxLength } = {}) => {
    const wrapper = document.createElement("label"); wrapper.className = "setting-field";
    const caption = document.createElement("span"); caption.textContent = label; wrapper.append(caption);
    const field = document.createElement(textarea ? "textarea" : "input"); field.className = className; field.value = value ?? ""; if (maxLength) field.maxLength = maxLength; wrapper.append(field); return wrapper;
  };
  const editorSelectField = (label, value, className, options) => {
    const wrapper = document.createElement("label"); wrapper.className = "setting-field";
    const caption = document.createElement("span"); caption.textContent = label; wrapper.append(caption);
    const field = document.createElement("select"); field.className = className;
    for (const option of options) { const node = document.createElement("option"); node.value = option.value; node.textContent = option.label; field.append(node); }
    field.value = options.some((option) => option.value === value) ? value : options[0]?.value ?? ""; wrapper.append(field); return wrapper;
  };
  const editorAction = (label, handler, className = "quiet-action") => { const node = document.createElement("button"); node.type = "button"; node.className = className; node.textContent = label; node.addEventListener("click", () => void handler()); return node; };
  const editorError = (message = "") => { const node = $("team-pack-editor-error"); if (node) { node.textContent = message; node.classList.toggle("hidden", !message); } };
  const editorOriginal = (collection, id, key = "id") => collection.find((entry) => entry[key] === id) ?? {};

  function readPackEditor() {
    if (!editingPack) throw new Error("Team Pack editor is not open.");
    const pack = editorClone(editingPack);
    pack.name = $("team-pack-editor-name")?.value.trim() ?? "";
    pack.description = $("team-pack-editor-description")?.value.trim() ?? "";
    pack.coworkers = [...(editorRoot("team-pack-editor-coworkers")?.children ?? [])].map((row) => {
      const original = editorOriginal(pack.coworkers, row.dataset.key, "key");
      const profile = row.querySelector(".team-pack-editor-coworker-profile")?.value || "automatic";
      const modelBinding = { ...(original.modelBinding ?? {}), profile };
      if (profile === "custom") {
        modelBinding.provider = row.querySelector(".team-pack-editor-coworker-provider")?.value.trim() ?? "";
        modelBinding.model = row.querySelector(".team-pack-editor-coworker-model")?.value.trim() ?? "";
      }
      return { ...original, name: row.querySelector(".team-pack-editor-coworker-name")?.value.trim() ?? "", role: row.querySelector(".team-pack-editor-coworker-role")?.value.trim() ?? "", instructions: row.querySelector(".team-pack-editor-coworker-instructions")?.value.trim() ?? "", modelBinding };
    });
    pack.channels = [...(editorRoot("team-pack-editor-channels")?.children ?? [])].map((row) => {
      const original = editorOriginal(pack.channels, row.dataset.key, "key");
      return { ...original, name: row.querySelector(".team-pack-editor-channel-name")?.value.trim() ?? "", kind: row.querySelector(".team-pack-editor-channel-kind")?.value || "project", instructions: row.querySelector(".team-pack-editor-channel-instructions")?.value.trim() ?? "", playbookId: row.querySelector(".team-pack-editor-channel-playbook")?.value || pack.playbooks[0]?.id };
    });
    pack.playbooks = [...(editorRoot("team-pack-editor-playbooks")?.children ?? [])].map((row) => {
      const original = editorOriginal(pack.playbooks, row.dataset.id, "id");
      const expectedOutput = row.querySelector(".team-pack-editor-playbook-output")?.value.trim() ?? "";
      const recommended = row.querySelector(".team-pack-editor-playbook-roles")?.value.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
      const next = { ...original, name: row.querySelector(".team-pack-editor-playbook-name")?.value.trim() ?? "", description: row.querySelector(".team-pack-editor-playbook-description")?.value.trim() ?? "", steps: [...row.querySelectorAll(".team-pack-editor-step select")].map((field) => field.value).filter(Boolean) };
      if (expectedOutput) next.expectedOutput = expectedOutput; else delete next.expectedOutput;
      if (recommended.length) next.recommendedCoworkerRoles = [...new Set(recommended)]; else delete next.recommendedCoworkerRoles;
      return next;
    });
    return pack;
  }

  function renderPackEditor(pack) {
    editingPack = editorClone(pack);
    $("team-pack-editor-id").value = editingPack.id;
    $("team-pack-editor-name").value = editingPack.name;
    $("team-pack-editor-description").value = editingPack.description ?? "";
    editorError();
    const coworkersRoot = editorRoot("team-pack-editor-coworkers"); clear(coworkersRoot);
    for (const entry of editingPack.coworkers) {
      const row = document.createElement("article"); row.className = "team-pack-editor-row"; row.dataset.key = entry.key;
      const heading = document.createElement("div"); heading.className = "team-pack-editor-heading"; const title = document.createElement("strong"); title.textContent = entry.name || "Coworker"; heading.append(title); heading.append(editorAction("Remove / 删除", () => { if (editingPack.coworkers.length <= 2) return editorError("A Team Pack needs at least two coworkers."); const next = readPackEditor(); next.coworkers = next.coworkers.filter((item) => item.key !== entry.key); next.playbooks = next.playbooks.map((book) => ({ ...book, steps: book.steps.filter((step) => step !== entry.key) })); renderPackEditor(next); })); row.append(heading);
      const grid = document.createElement("div"); grid.className = "team-pack-editor-grid";
      grid.append(editorTextField("Name / 名称", entry.name, "team-pack-editor-coworker-name", { maxLength: 80 }), editorTextField("Role / 角色", entry.role, "team-pack-editor-coworker-role", { maxLength: 120 }), editorSelectField("Model profile / 模型档位", entry.modelBinding?.profile ?? "automatic", "team-pack-editor-coworker-profile", ["automatic", "efficient", "deep", "economy", "custom"].map((value) => ({ value, label: value })))); row.append(grid);
      row.append(editorTextField("Instructions / 指引", entry.instructions, "team-pack-editor-coworker-instructions", { textarea: true, maxLength: 12000 }));
      if (entry.modelBinding?.profile === "custom") row.append(document.createElement("div"));
      const customGrid = document.createElement("div"); customGrid.className = "team-pack-editor-grid"; customGrid.append(editorTextField("Custom provider id / 自定义提供方", entry.modelBinding?.provider, "team-pack-editor-coworker-provider", { maxLength: 128 }), editorTextField("Custom model id / 自定义模型", entry.modelBinding?.model, "team-pack-editor-coworker-model", { maxLength: 128 })); row.append(customGrid);
      coworkersRoot.append(row);
    }
    const channelsRoot = editorRoot("team-pack-editor-channels"); clear(channelsRoot);
    for (const entry of editingPack.channels) {
      const row = document.createElement("article"); row.className = "team-pack-editor-row"; row.dataset.key = entry.key;
      const heading = document.createElement("div"); heading.className = "team-pack-editor-heading"; const title = document.createElement("strong"); title.textContent = entry.name || "Channel"; heading.append(title); heading.append(editorAction("Remove / 删除", () => { if (editingPack.channels.length <= 1) return editorError("A Team Pack needs at least one channel."); const next = readPackEditor(); next.channels = next.channels.filter((item) => item.key !== entry.key); renderPackEditor(next); })); row.append(heading);
      const grid = document.createElement("div"); grid.className = "team-pack-editor-grid"; grid.append(editorTextField("Name / 名称", entry.name, "team-pack-editor-channel-name", { maxLength: 120 }), editorSelectField("Kind / 类型", entry.kind, "team-pack-editor-channel-kind", [{ value: "work", label: "Work" }, { value: "personal", label: "Personal" }, { value: "project", label: "Project" }]), editorSelectField("Playbook / 工作方法", entry.playbookId, "team-pack-editor-channel-playbook", editingPack.playbooks.map((book) => ({ value: book.id, label: book.name })))); row.append(grid); row.append(editorTextField("Instructions / 指引", entry.instructions, "team-pack-editor-channel-instructions", { textarea: true, maxLength: 12000 })); channelsRoot.append(row);
    }
    const playbooksRoot = editorRoot("team-pack-editor-playbooks"); clear(playbooksRoot);
    for (const entry of editingPack.playbooks) {
      const row = document.createElement("article"); row.className = "team-pack-editor-row"; row.dataset.id = entry.id;
      const heading = document.createElement("div"); heading.className = "team-pack-editor-heading"; const title = document.createElement("strong"); title.textContent = entry.name || "Playbook"; heading.append(title); heading.append(editorAction("Remove / 删除", () => { if (editingPack.playbooks.length <= 1) return editorError("A Team Pack needs at least one playbook."); const next = readPackEditor(); next.playbooks = next.playbooks.filter((item) => item.id !== entry.id); const fallback = next.playbooks[0]?.id; next.channels = next.channels.map((channel) => channel.playbookId === entry.id ? { ...channel, playbookId: fallback } : channel); renderPackEditor(next); })); row.append(heading);
      const grid = document.createElement("div"); grid.className = "team-pack-editor-grid"; grid.append(editorTextField("Name / 名称", entry.name, "team-pack-editor-playbook-name", { maxLength: 120 }), editorTextField("Description / 描述", entry.description, "team-pack-editor-playbook-description", { maxLength: 500 }), editorTextField("Expected output / 预期产出", entry.expectedOutput, "team-pack-editor-playbook-output", { maxLength: 500 }), editorTextField("Recommended roles / 推荐角色", (entry.recommendedCoworkerRoles ?? []).join(", "), "team-pack-editor-playbook-roles", { maxLength: 1000 })); row.append(grid);
      const steps = document.createElement("div"); steps.className = "team-pack-editor-step-list"; const stepsHeading = document.createElement("strong"); stepsHeading.textContent = "Ordered steps / 顺序步骤"; steps.append(stepsHeading);
      for (const step of entry.steps ?? []) { const line = document.createElement("div"); line.className = "team-pack-editor-step"; const select = document.createElement("select"); select.className = "team-pack-editor-step-select"; for (const coworker of editingPack.coworkers) { const option = document.createElement("option"); option.value = coworker.key; option.textContent = coworker.name; select.append(option); } select.value = step; line.append(select, editorAction("Remove", () => { const next = readPackEditor(); const book = next.playbooks.find((item) => item.id === entry.id); book.steps = book.steps.filter((value, index) => !(value === step && index === [...(entry.steps ?? [])].indexOf(step))); renderPackEditor(next); })); steps.append(line); }
      steps.append(editorAction("Add step / 添加步骤", () => { const next = readPackEditor(); const book = next.playbooks.find((item) => item.id === entry.id); book.steps.push(next.coworkers[0]?.key); renderPackEditor(next); })); row.append(steps); playbooksRoot.append(row);
    }
  }

  async function openPackEditor(item) {
    if (!item.custom) return;
    const pack = await api.teams.exportPackRecipe({ packId: item.id });
    renderPackEditor(pack);
    $("team-pack-editor-dialog")?.showModal?.();
    $("team-pack-editor-name")?.focus();
  }

  document.addEventListener("sovereignbot:open-team-pack-editor", (event) => {
    const item = event.detail?.item;
    if (item) void openPackEditor(item).catch((reason) => showError(pageRoots.packs, reason));
  });
  document.addEventListener("sovereignbot:export-team-pack", (event) => {
    const item = event.detail?.item;
    if (item) void exportPackToFile(item).catch((reason) => showError(pageRoots.packs, reason));
  });

  function packs(items) {
    const root = pageRoots.packs; if (!root) return; clear(root);
    const query = (selected("team-pack-search-page", "") || "").trim().toLowerCase();
    const category = selected("team-pack-category-page", "all");
    const visible = items.filter((item) => (!query || [item.name, item.description, item.category, ...(item.coworkerNames ?? []), ...(item.channelNames ?? []), ...(item.playbookNames ?? [])].join(" ").toLowerCase().includes(query)) && (category === "all" || item.category === category));
    for (const item of visible) {
      const card = document.createElement("article"); card.className = "settings-card"; card.dataset.teamPackId = item.id; const title = document.createElement("h3"); title.textContent = item.name;
      card.append(title, text("Category", item.category), text("Contents", `${item.coworkerNames?.length ?? 0} coworkers · ${item.channelNames?.length ?? 0} channels · ${item.playbookNames?.length ?? 0} playbooks`), text("Status", item.installed ? "Installed" : "Available"));
      const actions = document.createElement("div"); actions.className = "detail-actions";
      if (!item.installed) actions.append(button("Install / 安装", async () => { await api.teams.installPack({ packId: item.id }); await refreshHost(); await refresh(); }, root));
      actions.append(button("Preview / 预览", async () => {
        const existing = card.querySelector(".team-pack-preview");
        if (existing) { existing.remove(); return; }
        const recipe = await api.teams.exportPackRecipe({ packId: item.id });
        const panel = document.createElement("div"); panel.className = "team-pack-preview";
        const heading = document.createElement("h4"); heading.textContent = "Composition / 组成"; panel.append(heading);
        panel.append(text("Description", recipe.description));
        for (const coworker of recipe.coworkers ?? []) panel.append(text("Coworker", `${coworker.name} — ${coworker.role}`));
        for (const channel of recipe.channels ?? []) panel.append(text("Channel", `${channel.name} — ${channel.instructions}`));
        for (const playbook of recipe.playbooks ?? []) panel.append(text("Playbook", `${playbook.name}: ${playbook.steps.join(" → ")}`));
        card.insertBefore(panel, actions);
      }, root));
      actions.append(button("Export / 导出", () => exportPackToFile(item), root), button("Duplicate / 复制", async () => { await api.teams.duplicatePack({ packId: item.id }); await refresh(); }, root));
      if (item.custom) actions.append(button("Edit recipe / 编辑配方", () => openPackEditor(item), root));
      card.append(actions); root.append(card);
    }
    if (!visible.length) root.append(text("Team Packs", "No matching recipes."));
  }

  function channels(items) {
    const root = pageRoots.channels; if (!root) return; clear(root);
    const mode = selected("product-channel-filter-page", "active");
    const conversations = new Map(cache.conversations.map((entry) => [entry.id, entry]));
    const teams = new Map(cache.teams.map((entry) => [entry.id, entry]));
    const visible = items.filter((channel) => { const conversation = conversations.get(channel.conversationId); if (mode === "unread") return !channel.archived && unread(conversation); return mode === "all" || (mode === "archived" ? channel.archived : !channel.archived); });
    const switcher = $("product-channel-switch-page"); if (switcher) { const current = switcher.value; switcher.textContent = ""; const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Quick switch / 快速切换"; switcher.append(placeholder); for (const channel of items.filter((entry) => !entry.archived)) { const option = document.createElement("option"); option.value = channel.conversationId; option.textContent = `${unread(conversations.get(channel.conversationId)) ? "• " : ""}${channel.name}`; switcher.append(option); } if ([...switcher.options].some((option) => option.value === current)) switcher.value = current; }
    for (const channel of visible) {
      const team = teams.get(channel.teamId); const conversation = conversations.get(channel.conversationId); const card = document.createElement("article"); card.className = "settings-card"; const title = document.createElement("h3"); title.textContent = channel.name; const meta = document.createElement("p"); meta.textContent = `${team?.name ?? "Team"} · ${channel.kind} · ${channel.archived ? "Read-only / 只读" : "Available / 可用"}`; card.append(title, meta); if (unread(conversation)) { const badge = document.createElement("span"); badge.className = "soft-pill"; badge.textContent = "Unread / 未读"; card.append(badge); } card.append(text("Instructions", channel.instructions), text("Last activity", conversation?.updatedAt || channel.updatedAt), text("Latest", conversation?.lastMessage?.textPreview));
      const actions = document.createElement("div"); actions.className = "detail-actions"; actions.append(button(channel.archived ? "View / 查看" : "Open / 打开", () => openConversationSafe(channel.conversationId), root), button("Edit / 编辑", () => void openEditor(channel.teamId, channel.id).catch((reason) => error(root, reason)), root), button("Duplicate / 复制", async () => { await api.channels.create({ teamId: channel.teamId, name: `${channel.name} copy`.slice(0, 120), kind: channel.kind, instructions: channel.instructions, workspaceId: channel.workspaceId, playbookId: channel.playbookId }); await refreshHost(); await refresh(); }, root), button(channel.archived ? "Restore / 恢复" : "Archive / 归档", async () => { await (channel.archived ? api.channels.restore : api.channels.archive)({ channelId: channel.id }); await refreshHost(); await refresh(); }, root));
      card.append(actions); root.append(card);
    }
    if (!visible.length) root.append(text("Channels", mode === "archived" ? "No archived channels." : mode === "unread" ? "No unread channels." : "No active channels yet."));
    populate("product-channel-template-team-page", cache.teams.map((team) => ({ value: team.id, label: team.name })), selected("product-channel-template-team-page", cache.teams[0]?.id ?? ""));
    populate("product-channel-template-page", cache.templates.map((template) => ({ value: template.id, label: `${template.name} / ${template.kind}` })), selected("product-channel-template-page", cache.templates[0]?.id ?? ""));
  }
  function openEditor(teamId, channelId) {
    if (typeof window.openProductChannelEditor !== "function") throw new Error("Channel editor is unavailable.");
    return window.openProductChannelEditor({ teamId, channelId });
  }
  async function createPlaybook() { newPlaybook(); }
    async function createSkill() { newSkill(); }
  async function exportPackToFile(item) {
    const team = cache.teams.find((entry) => entry.packId === item.id || entry.packId === `imported:${item.id}`);
    const result = team
      ? await api.teams.exportPackViaDialog({ teamId: team.id })
      : await api.teams.exportPackViaDialog({ packId: item.id });
    const status = $("team-pack-file-result");
    if (status) status.textContent = result.canceled ? "Export canceled." : `Exported ${result.fileName}.`;
  }
  async function importPack() {
    const result = await api.teams.importPackViaDialog({});
    const status = $("team-pack-file-result");
    if (result.canceled) { if (status) status.textContent = "Import canceled."; return; }
    await refreshHost();
    await refresh();
    if (status) status.textContent = `Imported ${result.fileName}.`;
  }

  async function refresh() {
    const generation = ++refreshGeneration;
    const [teams, coworkers, workspaces] = await Promise.all([api.teams.list({}), api.coworkers.list({}), api.workspaces?.list ? api.workspaces.list({}) : Promise.resolve({ workspaces: [] })]);
    cache.teams = teams.teams ?? []; cache.coworkers = coworkers.coworkers ?? []; cache.workspaces = workspaces.workspaces ?? []; cache.templates = teams.channelTemplates ?? [];
    const artifactScope = artifactScopeOverride || selected("artifact-hub-filter-page", "recent");
    const artifactVisibility = selected("artifact-hub-visibility-page", "active");
    const artifactOptions = [{ value: "recent", label: "Recent / 最近" }, ...cache.teams.flatMap((team) => [{ value: `team:${team.id}`, label: `By Team / 团队: ${team.name}` }, ...(team.channels ?? []).map((channel) => ({ value: `channel:${channel.id}`, label: `By Channel / 频道: ${channel.name}` }))]), ...cache.coworkers.map((coworker) => ({ value: `coworker:${coworker.id}`, label: `By Coworker / 同事: ${coworker.name}` }))];
    populate("artifact-hub-filter-page", artifactOptions, artifactScope);
    populate("artifact-hub-visibility-page", [{ value: "active", label: "Active / 活跃" }, { value: "archived", label: "Archived / 已归档" }, { value: "all", label: "All / 全部" }], artifactVisibility);
    const artifactCatalog = await api.artifacts.hub({ limit: 500, visibility: artifactVisibility });
    const artifactTypes = [...new Set((artifactCatalog.artifacts ?? []).map((entry) => entry.mimeType).filter(Boolean))].sort();
    const artifactType = selected("artifact-hub-type-page", "");
    populate("artifact-hub-type-page", [{ value: "", label: "All types / 全部类型" }, ...artifactTypes.map((value) => ({ value, label: value }))], artifactType);
    const artifactPayload = { limit: 100, visibility: selected("artifact-hub-visibility-page", artifactVisibility) }; const resolvedScope = selected("artifact-hub-filter-page", artifactScope); if (resolvedScope.startsWith("team:")) artifactPayload.teamId = resolvedScope.slice(5); if (resolvedScope.startsWith("channel:")) artifactPayload.channelId = resolvedScope.slice(8); if (resolvedScope.startsWith("coworker:")) artifactPayload.coworkerId = resolvedScope.slice(9); const resolvedType = selected("artifact-hub-type-page", artifactType); if (resolvedType) artifactPayload.type = resolvedType;
    const historyScope = historyScopeOverride || selected("computer-history-filter-page", "all");
    populate("computer-history-filter-page", [{ value: "all", label: "All coworkers / 全部同事" }, ...cache.coworkers.map((coworker) => ({ value: coworker.id, label: `By Coworker / 同事: ${coworker.name}` }))], historyScope);
    const historyPayload = { limit: 100, ...(historyScope !== "all" && safeOpaqueId(historyScope) ? { coworkerId: historyScope } : {}) };
    let [playbookResult, artifactResult, historyResult, skillResult, channelResult, conversations] = await Promise.all([api.playbooks.list({ includeArchived: true }), api.artifacts.hub(artifactPayload), api.computer.history(historyPayload), api.skills.list({ includeArchived: true }), api.channels.list({ includeArchived: true }), api.conversations?.list ? api.conversations.list({}) : Promise.resolve({ conversations: [] })]);
    const requestedArtifactId = pendingArtifactId;
    pendingArtifactId = undefined;
    let requestedArtifactError = "";
    if (requestedArtifactId && !artifactResult.artifacts?.some((entry) => entry.id === requestedArtifactId)) {
      try {
        const exact = await api.artifacts.get({ artifactId: requestedArtifactId });
        artifactResult = { ...artifactResult, artifacts: [...(artifactResult.artifacts ?? []), exact] };
      } catch {
        requestedArtifactError = "The requested artifact is unavailable or no longer published.";
      }
    }
    if (generation !== refreshGeneration) return;
    cache.conversations = conversations.conversations ?? [];
    playbooks(playbookResult.playbooks ?? []); artifacts(artifactResult.artifacts ?? []); history(historyResult.history ?? []); skills(skillResult.skills ?? []); packs(teams.packs ?? []); channels(channelResult.channels ?? []);
    const artifactNotice = $("product-artifacts-deeplink-status"); if (artifactNotice) artifactNotice.textContent = artifactDeepLinkNotice;
    const historyNotice = $("product-computer-history-deeplink-status"); if (historyNotice) historyNotice.textContent = historyDeepLinkNotice;
    if (requestedArtifactError) showError(pageRoots.artifacts, requestedArtifactError);
  }

  function setup() {
    for (const [id, view] of navViews) $(id)?.addEventListener("click", () => { if (view === "product-hubs") { for (const [navId, target] of navViews) $(navId)?.classList.toggle("active", target === view); } else nav(view); });
    $("playbook-page-create")?.addEventListener("click", () => void createPlaybook().catch((reason) => showError(pageRoots.playbooks, reason)));
    $("playbook-page-import")?.addEventListener("click", () => void importPlaybookFromFile().catch((reason) => showError(pageRoots.playbooks, reason)));
    $("playbook-editor-add-step")?.addEventListener("click", () => { try { const next = readPlaybookEditor(); next.steps.push(next.steps[next.steps.length - 1] || "chief"); renderPlaybookEditor(next); } catch (reason) { playbookEditorError(String(reason?.message ?? reason)); } });
    $("playbook-editor-add-stage")?.addEventListener("click", () => { try { const next = readPlaybookEditor(); next.stages.push({ id: playbookEditorId("stage"), name: "New stage", instructions: "" }); renderPlaybookEditor(next); } catch (reason) { playbookEditorError(String(reason?.message ?? reason)); } });
    $("playbook-editor-add-review")?.addEventListener("click", () => { try { const next = readPlaybookEditor(); next.reviewPoints.push({ id: playbookEditorId("review"), name: "New review point", instructions: "" }); renderPlaybookEditor(next); } catch (reason) { playbookEditorError(String(reason?.message ?? reason)); } });
    $("playbook-form")?.addEventListener("submit", (event) => void (async () => {
      event.preventDefault();
      playbookEditorError();
      const playbook = readPlaybookEditor();
      const patch = { name: playbook.name, description: playbook.description, steps: playbook.steps, stages: playbook.stages, reviewPoints: playbook.reviewPoints, ...(playbook.expectedOutput !== undefined ? { expectedOutput: playbook.expectedOutput } : {}), ...(playbook.recommendedCoworkerRoles !== undefined ? { recommendedCoworkerRoles: playbook.recommendedCoworkerRoles } : {}), ...(playbook.recommendedSkillIds !== undefined ? { recommendedSkillIds: playbook.recommendedSkillIds } : {}) };
      if (playbook.id) await api.playbooks.update({ playbookId: playbook.id, patch });
      else await api.playbooks.create({ playbook: patch });
      $("playbook-dialog")?.close?.();
      editingPlaybook = undefined;
      await refresh();
    })().catch((reason) => playbookEditorError(String(reason?.message ?? reason).slice(0, 240))));
    document.addEventListener("sovereignbot:open-playbook-editor", (event) => { if (event.detail?.item) void editPlaybook(event.detail.item).catch((reason) => showError(pageRoots.playbooks, reason)); else newPlaybook(); });
    $("skill-page-create")?.addEventListener("click", () => newSkill());
    $("skill-page-import")?.addEventListener("click", () => void (async () => { const result = await api.skills.importViaDialog({}); if (!result.canceled) await refresh(); })().catch((reason) => showError(pageRoots.skills, reason)));
    $("skill-editor-add-input")?.addEventListener("click", () => { try { const next = readSkillEditor(); next.inputs.push({ name: "input", type: "string", description: "", required: true }); renderSkillEditor(next); } catch (reason) { skillEditorError(String(reason?.message ?? reason)); } });
    $("skill-editor-add-step")?.addEventListener("click", () => { try { const next = readSkillEditor(); next.steps.push("New step"); renderSkillEditor(next); } catch (reason) { skillEditorError(String(reason?.message ?? reason)); } });
    $("skill-editor-add-validator")?.addEventListener("click", () => { try { const next = readSkillEditor(); next.validators.push("New validator"); renderSkillEditor(next); } catch (reason) { skillEditorError(String(reason?.message ?? reason)); } });
    $("skill-form")?.addEventListener("submit", (event) => void (async () => { event.preventDefault(); skillEditorError(); if (editingSkill?.state === "archived") return; const skill = readSkillEditor(); const payload = { name: skill.name, description: skill.description, instructions: skill.instructions, inputs: skill.inputs, steps: skill.steps, expectedOutput: skill.expectedOutput, validators: skill.validators, requestedCapabilities: skill.requestedCapabilities, source: skill.source }; if (skill.id) await api.skills.update({ skillId: skill.id, patch: payload }); else await api.skills.create({ skill: payload }); $("skill-dialog")?.close?.(); await refresh(); })().catch((reason) => skillEditorError(String(reason?.message ?? reason).slice(0, 240))));
    document.addEventListener("sovereignbot:open-skill-editor", (event) => { if (event.detail?.item) void editSkill(event.detail.item).catch((reason) => showError(pageRoots.skills, reason)); else newSkill(); });
    $("team-pack-page-import")?.addEventListener("click", () => void importPack().catch((reason) => showError(pageRoots.packs, reason)));
    $("team-pack-editor-add-coworker")?.addEventListener("click", () => {
      try {
        const next = readPackEditor();
        next.coworkers.push({ key: editorId("coworker"), name: "New coworker", role: "", instructions: "", modelBinding: { profile: "automatic" } });
        renderPackEditor(next);
      } catch (reason) { editorError(String(reason?.message ?? reason)); }
    });
    $("team-pack-editor-add-channel")?.addEventListener("click", () => {
      try {
        const next = readPackEditor();
        next.channels.push({ key: editorId("channel"), name: "New channel", kind: "project", instructions: "", playbookId: next.playbooks[0]?.id });
        renderPackEditor(next);
      } catch (reason) { editorError(String(reason?.message ?? reason)); }
    });
    $("team-pack-editor-add-playbook")?.addEventListener("click", () => {
      try {
        const next = readPackEditor();
        next.playbooks.push({ id: editorId("playbook"), name: "New playbook", description: "", steps: [next.coworkers[0]?.key].filter(Boolean) });
        renderPackEditor(next);
      } catch (reason) { editorError(String(reason?.message ?? reason)); }
    });
    $("team-pack-editor-form")?.addEventListener("submit", (event) => void (async () => {
      event.preventDefault();
      editorError();
      const pack = readPackEditor();
      await api.teams.editPack({ packId: editingPack.id, patch: { name: pack.name, description: pack.description, coworkers: pack.coworkers, channels: pack.channels, playbooks: pack.playbooks } });
      $("team-pack-editor-dialog")?.close?.();
      editingPack = undefined;
      await refresh();
    })().catch((reason) => editorError(String(reason?.message ?? reason).slice(0, 240))));
    $("team-pack-search-page")?.addEventListener("input", () => void refresh()); $("team-pack-category-page")?.addEventListener("change", () => void refresh());
    $("product-channel-create-page")?.addEventListener("click", () => { const teamId = $("product-channel-template-team-page")?.value || cache.teams[0]?.id; if (teamId) void openEditor(teamId).catch((reason) => showError(pageRoots.channels, reason)); });
    $("product-channel-template-add-page")?.addEventListener("click", () => void (async () => { const teamId = $("product-channel-template-team-page")?.value; const templateId = $("product-channel-template-page")?.value; if (!teamId || !templateId) return; await api.teams.createChannelFromTemplate({ teamId, templateId }); await refreshHost(); await refresh(); })().catch((reason) => showError(pageRoots.channels, reason)));
    for (const id of ["artifact-hub-filter-page", "artifact-hub-visibility-page", "artifact-hub-type-page", "computer-history-filter-page", "product-channel-filter-page"]) $(id)?.addEventListener("change", () => { if (id === "artifact-hub-filter-page") { artifactScopeOverride = ""; artifactDeepLinkNotice = ""; } if (id === "computer-history-filter-page") { historyScopeOverride = ""; historyDeepLinkNotice = ""; } void refresh().catch((reason) => showError(pageRoots[id === "product-channel-filter-page" ? "channels" : id === "computer-history-filter-page" ? "history" : id.startsWith("artifact-") ? "artifacts" : "playbooks"], reason)); });
    $("product-channel-switch-page")?.addEventListener("change", (event) => openConversationSafe(event.target.value));
    api.onNavigate?.((target) => { if (navViews.has("nav-" + target) || ["product-hubs", "playbooks", "artifacts", "computer-history", "skills", "team-packs", "channels"].includes(target)) nav(target); });
    document.addEventListener("sovereignbot:open-artifact", (event) => { const artifactId = event.detail?.artifactId; if (!artifactId) return; focusedArtifactId = String(artifactId); pendingArtifactId = focusedArtifactId; nav("artifacts"); });
    document.addEventListener("sovereignbot:open-artifact-preview", (event) => { if (event.detail?.item) void openArtifactPreview(event.detail.item); });
    document.addEventListener("sovereignbot:open-artifacts", (event) => {
      const coworkerId = safeOpaqueId(event.detail?.coworkerId);
      artifactScopeOverride = coworkerId ? `coworker:${coworkerId}` : "recent";
      artifactDeepLinkNotice = coworkerId ? "Showing artifacts created by this Coworker / 已显示此同事创建的成果" : "Showing recent artifacts / 已显示最近成果";
      nav("artifacts");
    });
    document.addEventListener("sovereignbot:open-computer-history", (event) => {
      const coworkerId = safeOpaqueId(event.detail?.coworkerId);
      historyScopeOverride = coworkerId || "all";
      historyDeepLinkNotice = coworkerId ? "Showing activity for this Coworker / 已显示此同事的动态" : "Showing all Coworker activity / 已显示全部同事动态";
      nav("computer-history");
    });
    window.refreshIndependentProductPages = refresh;
  }
  setup();
})();
