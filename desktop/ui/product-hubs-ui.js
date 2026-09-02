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
      card.append(line("Description", item.description), line("Steps", item.steps.join(" → ")), line("Assigned teams", item.assignedTeams.map((x) => x.name).join(", ") || "None"), line("Assigned channels", item.assignedChannels.map((x) => x.name).join(", ") || "None"), line("Updated", item.updatedAt));
      const actions = document.createElement("div"); actions.className = "detail-actions";
      actions.append(button("Export / 导出", () => copy(api.playbooks.export({ playbookId: item.id }))));
      actions.append(button("Create Routine / 创建例行", () => document.dispatchEvent(new CustomEvent("sovereignbot:create-routine-from-source", { detail: { name: `Routine · ${item.name}`, instruction: item.description || item.steps.join("; "), teamId: item.assignedTeams[0]?.id } }))));
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
    root.append(button("Import skill / 导入技能", async () => { const raw = window.prompt("Paste safe Skill JSON"); if (!raw) return; await api.skills.import({ skill: JSON.parse(raw) }); await refresh(); }));
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
  async function createPlaybook() { const name = window.prompt("Playbook name"); if (!name) return; const description = window.prompt("Description") ?? ""; const rawSteps = window.prompt("Steps, comma separated", "chief,coding-lead,reviewer,chief") ?? "chief,coding-lead,reviewer,chief"; await api.playbooks.create({ playbook: { name, description, steps: rawSteps.split(",").map((x) => x.trim()).filter(Boolean) } }); await refresh(); }
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

// First-class Project surface.  Project ids are used only as opaque IPC selectors;
// all visible labels come from the safe Project projection and never from workspaces.
(() => {
  const api = window.sovereignbot;
  if (!api?.projects) return;
  const $ = (id) => document.getElementById(id);
  const clear = (node) => { if (node) node.textContent = ""; };
  const error = (reason) => { const node = $("project-result"); if (node) node.textContent = String(reason?.message ?? reason).slice(0, 240); };
  const setResult = (value) => { const node = $("project-result"); if (node) node.textContent = value; };
  const button = (label, fn) => { const node = document.createElement("button"); node.type = "button"; node.className = "quiet-action"; node.textContent = label; node.addEventListener("click", () => Promise.resolve().then(fn).catch(error)); return node; };
  const element = (tag, textContent) => { const node = document.createElement(tag); if (textContent !== undefined) node.textContent = textContent; return node; };
  async function copy(value) { try { await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); setResult("Project export copied / 项目导出已复制"); } catch { setResult("Clipboard is unavailable / 剪贴板不可用"); } }
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
    const card = element("section"); card.className = "settings-card span-2"; const cardHeading = element("div"); cardHeading.className = "card-heading"; const cardCopy = element("div"); cardCopy.append(element("h2", "Recent Projects / 最近项目"), element("p", "Switch, inspect, archive, restore, export, or back up a Project. Trusted workspace details remain hidden.")); cardHeading.append(cardCopy); const list = element("div"); list.id = "project-list"; list.className = "project-list"; card.append(cardHeading, list); view.append(header, result, card);
    $("view-product-hubs")?.parentElement?.insertBefore(view, $("view-product-hubs"));
    $("project-switcher")?.addEventListener("change", async (event) => { if (!event.target.value) return; try { const project = await api.projects.open({ projectId: event.target.value }); setResult(`Opened ${project.name} / 已打开`); const conversationId = project.teams?.[0]?.channels?.[0]?.conversationId; if (conversationId && typeof openConversation === "function") openConversation(conversationId); await refresh(); } catch (reason) { error(reason); } });
    $("project-refresh")?.addEventListener("click", () => void refresh());
    $("project-create")?.addEventListener("click", async () => { const name = window.prompt("Project name / 项目名称"); if (!name) return; try { await api.projects.create({ name }); setResult("Project created / 项目已创建"); await refresh(); } catch (reason) { error(reason); } });
  }
  function render(projects) {
    const root = $("project-list"); if (!root) return; clear(root);
    const switcher = $("project-switcher"); if (switcher) { const current = switcher.value; switcher.textContent = ""; const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Choose a Project / 选择项目"; switcher.append(placeholder); for (const project of projects) { const option = document.createElement("option"); option.value = project.projectId; option.textContent = `${project.name}${project.state === "archived" ? " · Archived / 已归档" : ""}`; switcher.append(option); } if ([...switcher.options].some((option) => option.value === current)) switcher.value = current; }
    for (const project of projects) {
      const card = document.createElement("article"); card.className = "project-card";
      const title = document.createElement("h3"); title.textContent = project.name;
      const status = document.createElement("p"); status.textContent = `${project.state === "archived" ? "Archived / 已归档" : "Active / 活跃"} · ${project.available ? "Available / 可用" : "Unavailable / 不可用"}`;
      const counts = document.createElement("p"); counts.className = "project-counts"; counts.textContent = Object.entries(project.counts ?? {}).map(([key, value]) => `${key}: ${value}`).join(" · ");
      const contents = document.createElement("p"); contents.textContent = (project.teams ?? []).map((team) => `${team.name} (${team.channels?.length ?? 0} channels)`).join(" · ") || "No Teams yet / 暂无团队";
      const memory = document.createElement("p"); memory.className = "project-memory-summary"; memory.textContent = project.memory?.length ? `Memory / 记忆: ${project.memory.map((entry) => entry.title).join(" · ")}` : "Memory / 记忆: none yet";
      const actions = document.createElement("div"); actions.className = "detail-actions";
      actions.append(button("Open / 打开", async () => { await api.projects.open({ projectId: project.projectId }); const conversationId = project.teams?.[0]?.channels?.[0]?.conversationId; if (conversationId && typeof openConversation === "function") openConversation(conversationId); await refresh(); }));
      actions.append(button(project.state === "archived" ? "Restore / 恢复" : "Archive / 归档", async () => { await (project.state === "archived" ? api.projects.restore : api.projects.archive)({ projectId: project.projectId }); await refresh(); }));
      actions.append(button("Export / 导出", async () => copy(await api.projects.export({ projectId: project.projectId }))));
      actions.append(button("Backup / 备份", async () => { await api.projects.backup({ projectId: project.projectId }); setResult("Portable Project backup created / 可移植项目备份已创建"); }));
      actions.append(button("Memory / 记忆", () => document.dispatchEvent(new CustomEvent("sovereignbot:open-memory", { detail: { view: "memory", scope: "project", ownerId: project.projectId } }))));
      actions.append(button("Add fact / 添加事实", () => document.dispatchEvent(new CustomEvent("sovereignbot:open-memory", { detail: { view: "memory", scope: "project", ownerId: project.projectId, addFact: true } }))));
      card.append(title, status, counts, contents, memory, actions); root.append(card);
    }
    if (!projects.length) { const empty = document.createElement("p"); empty.textContent = "No Projects yet / 暂无项目"; root.append(empty); }
  }
  async function refresh() { ensureView(); try { const result = await api.projects.list({ includeArchived: true, limit: 50 }); render(result.projects ?? []); } catch (reason) { error(reason); } }
  window.addEventListener("DOMContentLoaded", () => { ensureView(); void refresh(); });
  document.addEventListener("sovereignbot:open-project", async (event) => {
    ensureView();
    if (typeof switchView === "function") switchView("projects");
    await refresh();
    const projectId = event.detail?.projectId;
    const switcher = $("project-switcher");
    if (switcher && projectId && [...switcher.options].some((option) => option.value === projectId)) switcher.value = projectId;
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
  const unread = (conversation) => typeof conversationUnread === "function" ? conversationUnread(conversation) : Boolean(conversation?.unread);
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

  function playbooks(items) {
    const root = pageRoots.playbooks; if (!root) return; clear(root);
    for (const item of items) {
      const card = document.createElement("article"); card.className = "settings-card";
      const title = document.createElement("h3"); title.textContent = item.name;
      card.append(title, text("Description", item.description), text("Steps", item.steps.join(" → ")), text("Teams", item.assignedTeams.map((entry) => entry.name).join(", ") || "None"), text("Channels", item.assignedChannels.map((entry) => entry.name).join(", ") || "None"), text("State", item.state), text("Updated", item.updatedAt));
      const actions = document.createElement("div"); actions.className = "detail-actions";
      actions.append(button("Export / 导出", () => api.playbooks.export({ playbookId: item.id }).then(copy), root), button("Duplicate / 复制", async () => { await api.playbooks.duplicate({ playbookId: item.id }); await refresh(); }, root), button(item.state === "archived" ? "Restore / 恢复" : "Archive / 归档", async () => { await (item.state === "archived" ? api.playbooks.restore : api.playbooks.archive)({ playbookId: item.id }); await refresh(); }, root), button("Edit / 编辑", async () => {
        const name = window.prompt("Playbook name", item.name); if (!name) return;
        const description = window.prompt("Description", item.description); if (description === null) return;
        const steps = window.prompt("Steps, comma separated", item.steps.join(",")); if (steps === null) return;
        await api.playbooks.update({ playbookId: item.id, patch: { name, description, steps: steps.split(",").map((entry) => entry.trim()).filter(Boolean) } }); await refresh();
      }, root));
      const teamSelect = select("Team for playbook " + item.name);
      for (const team of cache.teams) { const option = document.createElement("option"); option.value = team.id; option.textContent = `Team: ${team.name}`; teamSelect.append(option); }
      if (teamSelect.options.length) actions.append(teamSelect, button("Assign Team / 分配团队", async () => { await api.playbooks.assign({ playbookId: item.id, teamId: teamSelect.value }); await refresh(); }, root));
      const channelSelect = select("Channel for playbook " + item.name);
      for (const team of cache.teams) for (const channel of team.channels ?? []) { const option = document.createElement("option"); option.value = channel.id; option.textContent = `Channel: ${team.name} / ${channel.name}`; channelSelect.append(option); }
      if (channelSelect.options.length) actions.append(channelSelect, button("Assign Channel / 分配频道", async () => { await api.playbooks.assign({ playbookId: item.id, channelId: channelSelect.value }); await refresh(); }, root));
      card.append(actions); root.append(card);
    }
    if (!items.length) root.append(text("Playbooks", "No methods yet. Create the first human-readable method."));
    root.append(button("Import / 导入", async () => { const playbook = readJson("Paste Playbook JSON"); if (playbook) { await api.playbooks.import({ playbook }); await refresh(); } }, root));
  }

  function artifacts(items) {
    const root = pageRoots.artifacts; if (!root) return; clear(root);
    for (const item of items) {
      const card = document.createElement("article"); card.className = "settings-card";
      const title = document.createElement("h3"); title.textContent = item.title || item.fileName;
      card.append(title, text("Type", item.mimeType), text("Version", item.version ? `v${item.version}` : "Original"), text("Creator", item.creator?.name), text("Team", item.team?.name), text("Channel", item.channel?.name), text("Created", item.createdAt), text("History", item.history?.map((entry) => `${entry.event} · ${entry.timestamp}`).join(", ")), text("Status", item.status));
      const actions = document.createElement("div"); actions.className = "detail-actions";
      actions.append(button("Preview / 预览", async () => { const preview = await api.artifacts.preview({ artifactId: item.id }); window.alert(preview?.preview || "Preview is not available."); }, root), button("Open / 打开", () => api.artifacts.open({ artifactId: item.id }), root), button("Reveal / 显示", () => api.artifacts.reveal({ artifactId: item.id }), root), button("History / 历史", async () => {
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
      card.append(actions); root.append(card);
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

  function skills(items) {
    const root = pageRoots.skills; if (!root) return; clear(root);
    for (const item of items) {
      const card = document.createElement("article"); card.className = "settings-card";
      const title = document.createElement("h3"); title.textContent = item.name;
      const assigned = [...(item.assignedTeamIds ?? []).map((id) => `Team: ${cache.teams.find((entry) => entry.id === id)?.name ?? id}`), ...(item.assignedCoworkerIds ?? []).map((id) => `Coworker: ${cache.coworkers.find((entry) => entry.id === id)?.name ?? id}`)];
      card.append(title, text("Description", item.description), text("Source", item.source), text("Status", item.state), text("Assigned", assigned.join(", ") || "Not assigned"), text("Last definition test", item.lastTestedAt));
      const actions = document.createElement("div"); actions.className = "detail-actions";
      actions.append(button("Export / 导出", () => api.skills.export({ skillId: item.id }).then(copy), root), button("Duplicate / 复制", async () => { await api.skills.duplicate({ skillId: item.id }); await refresh(); }, root), button("Retest definition / 重测定义", async () => { await api.skills.retest({ skillId: item.id }); await refresh(); }, root), button(item.state === "archived" ? "Restore / 恢复" : "Archive / 归档", async () => { await (item.state === "archived" ? api.skills.restore : api.skills.archive)({ skillId: item.id }); await refresh(); }, root), button("Edit / 编辑", async () => {
        const name = window.prompt("Skill name", item.name); if (!name) return;
        const description = window.prompt("Description", item.description); if (description === null) return;
        const instructions = window.prompt("Instructions", item.instructions); if (instructions === null) return;
        await api.skills.update({ skillId: item.id, patch: { name, description, instructions } }); await refresh();
      }, root));
      if (item.state === "active") actions.append(button("Create Routine / 创建例行任务", () => {
        document.dispatchEvent(new CustomEvent("sovereignbot:create-routine-from-skill", { detail: { skillId: item.id } }));
      }, root));
      const teamSelect = select("Team for skill " + item.name); for (const team of cache.teams) { const option = document.createElement("option"); option.value = team.id; option.textContent = `Team: ${team.name}`; teamSelect.append(option); }
      if (teamSelect.options.length) actions.append(teamSelect, button("Assign Team / 分配团队", async () => { await api.skills.assign({ skillId: item.id, targetKind: "team", targetId: teamSelect.value, enabled: !(item.assignedTeamIds ?? []).includes(teamSelect.value) }); await refresh(); }, root));
      const coworkerSelect = select("Coworker for skill " + item.name); for (const coworker of cache.coworkers) { const option = document.createElement("option"); option.value = coworker.id; option.textContent = `Coworker: ${coworker.name}`; coworkerSelect.append(option); }
      if (coworkerSelect.options.length) actions.append(coworkerSelect, button("Assign Coworker / 分配同事", async () => { await api.skills.assign({ skillId: item.id, targetKind: "coworker", targetId: coworkerSelect.value, enabled: !(item.assignedCoworkerIds ?? []).includes(coworkerSelect.value) }); await refresh(); }, root));
      card.append(actions); root.append(card);
    }
    if (!items.length) root.append(text("Skills", "No skills yet. Create a declarative skill."));
    root.append(button("Import skill / 导入技能", async () => { const skill = readJson("Paste safe Skill JSON"); if (skill) { await api.skills.import({ skill }); await refresh(); } }, root));
  }

  function packs(items) {
    const root = pageRoots.packs; if (!root) return; clear(root);
    const query = (selected("team-pack-search-page", "") || "").trim().toLowerCase();
    const category = selected("team-pack-category-page", "all");
    const visible = items.filter((item) => (!query || [item.name, item.description, item.category, ...(item.coworkerNames ?? []), ...(item.channelNames ?? []), ...(item.playbookNames ?? [])].join(" ").toLowerCase().includes(query)) && (category === "all" || item.category === category));
    for (const item of visible) {
      const card = document.createElement("article"); card.className = "settings-card"; const title = document.createElement("h3"); title.textContent = item.name;
      card.append(title, text("Category", item.category), text("Contents", `${item.coworkerNames?.length ?? 0} coworkers · ${item.channelNames?.length ?? 0} channels · ${item.playbookNames?.length ?? 0} playbooks`), text("Status", item.installed ? "Installed" : "Available"));
      const actions = document.createElement("div"); actions.className = "detail-actions";
      if (!item.installed) actions.append(button("Install / 安装", async () => { await api.teams.installPack({ packId: item.id }); await refreshHost(); await refresh(); }, root));
      actions.append(button("Export / 导出", async () => { const team = cache.teams.find((entry) => entry.packId === item.id || entry.packId === `imported:${item.id}`); const recipe = item.custom ? await api.teams.exportPackRecipe({ packId: item.id }) : team ? await api.teams.exportPack({ teamId: team.id }) : await api.teams.exportPackRecipe({ packId: item.id }); await copy(recipe); }, root), button("Duplicate / 复制", async () => { await api.teams.duplicatePack({ packId: item.id }); await refresh(); }, root));
      if (item.custom) actions.append(button("Edit recipe / 编辑配方", async () => { const current = await api.teams.exportPackRecipe({ packId: item.id }); const edited = readJson("Edit declarative Team Pack JSON", current); if (!edited) return; await api.teams.editPack({ packId: item.id, patch: { name: edited.name, description: edited.description, coworkers: edited.coworkers, channels: edited.channels, playbooks: edited.playbooks } }); await refresh(); }, root));
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
      const team = teams.get(channel.teamId); const conversation = conversations.get(channel.conversationId); const card = document.createElement("article"); card.className = "settings-card"; const title = document.createElement("h3"); title.textContent = channel.name; const meta = document.createElement("p"); meta.textContent = `${team?.name ?? "Team"} · ${channel.kind} · ${channel.archived ? "Read-only / 只读" : "Available / 可用"}`; card.append(title, meta, text("Instructions", channel.instructions), text("Last activity", conversation?.updatedAt || channel.updatedAt), text("Latest", conversation?.lastMessage?.textPreview));
      const actions = document.createElement("div"); actions.className = "detail-actions"; actions.append(button(channel.archived ? "View / 查看" : "Open / 打开", () => openConversationSafe(channel.conversationId), root), button("Edit / 编辑", () => openEditor(channel.teamId, channel.id), root), button("Duplicate / 复制", async () => { await api.channels.create({ teamId: channel.teamId, name: `${channel.name} copy`.slice(0, 120), kind: channel.kind, instructions: channel.instructions, workspaceId: channel.workspaceId, playbookId: channel.playbookId }); await refreshHost(); await refresh(); }, root), button(channel.archived ? "Restore / 恢复" : "Archive / 归档", async () => { await (channel.archived ? api.channels.restore : api.channels.archive)({ channelId: channel.id }); await refreshHost(); await refresh(); }, root));
      card.append(actions); root.append(card);
    }
    if (!visible.length) root.append(text("Channels", mode === "archived" ? "No archived channels." : mode === "unread" ? "No unread channels." : "No active channels yet."));
    populate("product-channel-template-team-page", cache.teams.map((team) => ({ value: team.id, label: team.name })), selected("product-channel-template-team-page", cache.teams[0]?.id ?? ""));
    populate("product-channel-template-page", cache.templates.map((template) => ({ value: template.id, label: `${template.name} / ${template.kind}` })), selected("product-channel-template-page", cache.templates[0]?.id ?? ""));
  }
  function openEditor(teamId, channelId) {
    if (typeof window.openProductChannelEditor === "function") { window.openProductChannelEditor({ teamId, channelId }); return; }
    const team = cache.teams.find((entry) => entry.id === teamId); const channel = team?.channels?.find((entry) => entry.id === channelId); if (!team) throw new Error("Choose a team first.");
    const name = window.prompt("Channel name", channel?.name ?? "Project Channel"); if (!name) return; const instructions = window.prompt("Instructions", channel?.instructions ?? "") ?? ""; const payload = { name, kind: channel?.kind ?? "project", instructions, ...(team.sharedWorkspaceId ? { workspaceId: team.sharedWorkspaceId } : {}), ...(team.playbooks?.[0]?.id ? { playbookId: team.playbooks[0].id } : {}) };
    return channelId ? api.channels.update({ channelId, patch: payload }).then(refreshHost).then(refresh) : api.channels.create({ teamId, ...payload }).then(refreshHost).then(refresh);
  }
  async function createPlaybook() { const name = window.prompt("Playbook name"); if (!name) return; const description = window.prompt("Description", "") ?? ""; const steps = window.prompt("Steps, comma separated", "chief,coding-lead,reviewer,chief") ?? "chief,coding-lead,reviewer,chief"; await api.playbooks.create({ playbook: { name, description, steps: steps.split(",").map((entry) => entry.trim()).filter(Boolean) } }); await refresh(); }
  async function createSkill() { const name = window.prompt("Skill name"); if (!name) return; const description = window.prompt("Description", "") ?? ""; const instructions = window.prompt("Instructions"); if (!instructions) return; await api.skills.create({ skill: { name, description, instructions } }); await refresh(); }
  async function importPack() { const pack = readJson("Paste Team Pack JSON"); if (!pack) return; await api.teams.importPack({ pack }); await refreshHost(); await refresh(); }

  async function refresh() {
    const [teams, coworkers, workspaces] = await Promise.all([api.teams.list({}), api.coworkers.list({}), api.workspaces?.list ? api.workspaces.list({}) : Promise.resolve({ workspaces: [] })]);
    cache.teams = teams.teams ?? []; cache.coworkers = coworkers.coworkers ?? []; cache.workspaces = workspaces.workspaces ?? []; cache.templates = teams.channelTemplates ?? [];
    const artifactScope = selected("artifact-hub-filter-page", "recent");
    const artifactOptions = [{ value: "recent", label: "Recent / 最近" }, ...cache.teams.flatMap((team) => [{ value: `team:${team.id}`, label: `By Team / 团队: ${team.name}` }, ...(team.channels ?? []).map((channel) => ({ value: `channel:${channel.id}`, label: `By Channel / 频道: ${channel.name}` }))]), ...cache.coworkers.map((coworker) => ({ value: `coworker:${coworker.id}`, label: `By Coworker / 同事: ${coworker.name}` }))];
    populate("artifact-hub-filter-page", artifactOptions, artifactScope);
    const artifactCatalog = await api.artifacts.hub({ limit: 500 });
    const artifactTypes = [...new Set((artifactCatalog.artifacts ?? []).map((entry) => entry.mimeType).filter(Boolean))].sort();
    const artifactType = selected("artifact-hub-type-page", "");
    populate("artifact-hub-type-page", [{ value: "", label: "All types / 全部类型" }, ...artifactTypes.map((value) => ({ value, label: value }))], artifactType);
    const artifactPayload = { limit: 100 }; const resolvedScope = selected("artifact-hub-filter-page", artifactScope); if (resolvedScope.startsWith("team:")) artifactPayload.teamId = resolvedScope.slice(5); if (resolvedScope.startsWith("channel:")) artifactPayload.channelId = resolvedScope.slice(8); if (resolvedScope.startsWith("coworker:")) artifactPayload.coworkerId = resolvedScope.slice(9); const resolvedType = selected("artifact-hub-type-page", artifactType); if (resolvedType) artifactPayload.type = resolvedType;
    const historyScope = selected("computer-history-filter-page", "all"); populate("computer-history-filter-page", [{ value: "all", label: "All coworkers / 全部同事" }, ...cache.coworkers.map((coworker) => ({ value: coworker.id, label: `By Coworker / 同事: ${coworker.name}` }))], historyScope);
    const [playbookResult, artifactResult, historyResult, skillResult, channelResult, conversations] = await Promise.all([api.playbooks.list({ includeArchived: true }), api.artifacts.hub(artifactPayload), api.computer.history({ limit: 100 }), api.skills.list({ includeArchived: true }), api.channels.list({ includeArchived: true }), api.conversations?.list ? api.conversations.list({}) : Promise.resolve({ conversations: [] })]);
    cache.conversations = conversations.conversations ?? [];
    playbooks(playbookResult.playbooks ?? []); artifacts(artifactResult.artifacts ?? []); history(historyResult.history ?? []); skills(skillResult.skills ?? []); packs(teams.packs ?? []); channels(channelResult.channels ?? []);
  }

  function setup() {
    for (const [id, view] of navViews) $(id)?.addEventListener("click", () => { if (view === "product-hubs") { for (const [navId, target] of navViews) $(navId)?.classList.toggle("active", target === view); } else nav(view); });
    $("playbook-page-create")?.addEventListener("click", () => void createPlaybook().catch((reason) => showError(pageRoots.playbooks, reason)));
    $("playbook-page-import")?.addEventListener("click", () => void (async () => { const playbook = readJson("Paste Playbook JSON"); if (playbook) { await api.playbooks.import({ playbook }); await refresh(); } })().catch((reason) => showError(pageRoots.playbooks, reason)));
    $("skill-page-create")?.addEventListener("click", () => void createSkill().catch((reason) => showError(pageRoots.skills, reason)));
    $("skill-page-import")?.addEventListener("click", () => void (async () => { const skill = readJson("Paste safe Skill JSON"); if (skill) { await api.skills.import({ skill }); await refresh(); } })().catch((reason) => showError(pageRoots.skills, reason)));
    $("team-pack-page-import")?.addEventListener("click", () => void importPack().catch((reason) => showError(pageRoots.packs, reason)));
    $("team-pack-search-page")?.addEventListener("input", () => void refresh()); $("team-pack-category-page")?.addEventListener("change", () => void refresh());
    $("product-channel-create-page")?.addEventListener("click", () => { const teamId = $("product-channel-template-team-page")?.value || cache.teams[0]?.id; if (teamId) { try { openEditor(teamId); } catch (reason) { showError(pageRoots.channels, reason); } } });
    $("product-channel-template-add-page")?.addEventListener("click", () => void (async () => { const teamId = $("product-channel-template-team-page")?.value; const templateId = $("product-channel-template-page")?.value; if (!teamId || !templateId) return; await api.teams.createChannelFromTemplate({ teamId, templateId }); await refreshHost(); await refresh(); })().catch((reason) => showError(pageRoots.channels, reason)));
    for (const id of ["artifact-hub-filter-page", "artifact-hub-type-page", "computer-history-filter-page", "product-channel-filter-page"]) $(id)?.addEventListener("change", () => void refresh());
    $("product-channel-switch-page")?.addEventListener("change", (event) => openConversationSafe(event.target.value));
    api.onNavigate?.((target) => { if (navViews.has("nav-" + target) || ["product-hubs", "playbooks", "artifacts", "computer-history", "skills", "team-packs", "channels"].includes(target)) nav(target); });
    document.addEventListener("sovereignbot:open-artifact", (event) => { if (event.detail?.artifactId) nav("artifacts"); });
    document.addEventListener("sovereignbot:open-artifacts", () => nav("artifacts"));
    document.addEventListener("sovereignbot:open-computer-history", () => nav("computer-history"));
    window.refreshIndependentProductPages = refresh;
  }
  window.addEventListener("DOMContentLoaded", setup);
})();
