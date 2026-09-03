"use strict";

(() => {
  const api = window.sovereignbot;
  if (!api?.connectedApps?.search || !api.connectedApps.review) return;
  const $ = (id) => document.getElementById(id);
  const clear = (node) => { if (node) node.textContent = ""; };
  const text = (value, fallback = "—") => String(value ?? fallback);
  let projects = [];
  let teams = [];
  let coworkers = [];
  let selectedProjectId = "";

  function addLine(parent, label, value, className = "apps-catalog-line") {
    const line = document.createElement("div"); line.className = className;
    const labelNode = document.createElement("span"); labelNode.className = "apps-catalog-label"; labelNode.textContent = `${label}:`;
    const valueNode = document.createElement("span"); valueNode.textContent = text(value);
    line.append(labelNode, valueNode); parent.append(line); return valueNode;
  }
  function action(label, fn, className = "quiet-action") {
    const button = document.createElement("button"); button.type = "button"; button.className = className; button.textContent = label;
    button.addEventListener("click", () => void fn(button)); return button;
  }
  function setFeedback(value, error = false) { const node = $("apps-catalog-result"); if (!node) return; node.textContent = text(value, ""); node.classList.toggle("inline-error", error); }
  function setOptions(select, values, placeholder, current = "") {
    if (!select) return; select.textContent = ""; select.append(new Option(placeholder, ""));
    for (const item of values) select.append(new Option(item.label, item.value));
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }
  function reviewDetails(app, reviewRoot, review) {
    clear(reviewRoot); reviewRoot.classList.remove("hidden");
    const heading = document.createElement("strong"); heading.textContent = "Review before connecting / 连接前审查"; reviewRoot.append(heading);
    addLine(reviewRoot, "Trusted source / 可信来源", review.trustedSource);
    addLine(reviewRoot, "Version / 版本", review.version);
    addLine(reviewRoot, "Capabilities / 能力", (review.capabilities ?? []).join(" · "));
    addLine(reviewRoot, "Approval / 审批", review.approval?.summary);
    addLine(reviewRoot, "Cost / 费用", review.cost?.summary);
    const actions = document.createElement("div"); actions.className = "detail-actions apps-catalog-review-actions";
    actions.append(action("Cancel / 取消", () => reviewRoot.classList.add("hidden")));
    actions.append(action("Approve & connect / 同意并连接", async (button) => {
      button.disabled = true;
      try { await api.connectedApps.connect({ appId: app.id, ...(selectedProjectId ? { projectId: selectedProjectId } : {}), ...(review.cost?.metered ? { approveMetered: true } : {}) }); await refresh(); }
      catch (error) { setFeedback(error?.message || error, true); button.disabled = false; }
    }, "hero-action"));
    reviewRoot.append(actions);
  }
  function assignmentControls(card, app) {
    const section = document.createElement("div"); section.className = "apps-catalog-assignment";
    const title = document.createElement("strong"); title.textContent = "Assign scope / 分配范围"; section.append(title);
    const team = document.createElement("select"); team.setAttribute("aria-label", `Team assignment for ${app.name}`);
    const coworker = document.createElement("select"); coworker.setAttribute("aria-label", `Coworker assignment for ${app.name}`);
    setOptions(team, teams.map((item) => ({ value: item.id, label: `Team: ${item.name}` })), "Choose Team / 选择团队");
    setOptions(coworker, coworkers.map((item) => ({ value: item.id, label: `Coworker: ${item.name}` })), "Choose Coworker / 选择同事");
    const assignTeam = action("Assign Team / 分配团队", async (button) => {
      if (!team.value) return; button.disabled = true;
      try { await api.connectedApps.assign({ appId: app.id, ...(selectedProjectId ? { projectId: selectedProjectId } : {}), teamId: team.value, enabled: true }); await refresh(); }
      catch (error) { setFeedback(error?.message || error, true); button.disabled = false; }
    });
    const assignCoworker = action("Assign Coworker / 分配同事", async (button) => {
      if (!coworker.value) return; button.disabled = true;
      try { await api.connectedApps.assign({ appId: app.id, ...(selectedProjectId ? { projectId: selectedProjectId } : {}), coworkerId: coworker.value, enabled: true }); await refresh(); }
      catch (error) { setFeedback(error?.message || error, true); button.disabled = false; }
    });
    section.append(team, assignTeam, coworker, assignCoworker);
    const assigned = document.createElement("div"); assigned.className = "apps-catalog-assigned";
    const assignedTeams = (app.assignedTeamIds ?? []).map((id) => teams.find((item) => item.id === id)?.name ?? id);
    const assignedCoworkers = (app.assignedCoworkerIds ?? []).map((id) => coworkers.find((item) => item.id === id)?.name ?? id);
    const addUnassign = (kind, id, name) => {
      const row = document.createElement("div"); row.className = "apps-catalog-assigned-row";
      const label = document.createElement("span"); label.textContent = `${kind}: ${name}`;
      const remove = action(`Unassign ${kind} / 解除${kind === "Team" ? "团队" : "同事"}`, async (button) => {
        button.disabled = true;
        try { await api.connectedApps.assign({ appId: app.id, ...(selectedProjectId ? { projectId: selectedProjectId } : {}), [kind === "Team" ? "teamId" : "coworkerId"]: id, enabled: false }); await refresh(); }
        catch (error) { setFeedback(error?.message || error, true); button.disabled = false; }
      });
      row.append(label, remove); assigned.append(row);
    };
    for (const [index, id] of (app.assignedTeamIds ?? []).entries()) addUnassign("Team", id, assignedTeams[index]);
    for (const [index, id] of (app.assignedCoworkerIds ?? []).entries()) addUnassign("Coworker", id, assignedCoworkers[index]);
    if (!assigned.children.length) { const empty = document.createElement("small"); empty.textContent = "No assignments in this scope. / 此范围暂无分配。"; assigned.append(empty); }
    section.append(assigned);
    return section;
  }
  function render(items) {
    const root = $("apps-catalog-list"); if (!root) return; clear(root);
    if (!items.length) { const empty = document.createElement("p"); empty.className = "setting-feedback"; empty.textContent = "No apps match these filters. / 没有符合筛选条件的应用。"; root.append(empty); return; }
    for (const app of items) {
      const card = document.createElement("article"); card.className = "apps-catalog-card";
      const header = document.createElement("div"); header.className = "apps-catalog-card-head";
      const title = document.createElement("div"); const h2 = document.createElement("h2"); h2.textContent = app.name; const subtitle = document.createElement("p"); subtitle.textContent = `${app.category} · ${app.service}`; title.append(h2, subtitle);
      const status = document.createElement("span"); status.className = `soft-pill apps-catalog-status ${app.status}`; status.textContent = text(app.status); header.append(title, status); card.append(header);
      const summary = document.createElement("p"); summary.className = "apps-catalog-description"; summary.textContent = app.description; card.append(summary);
      const facts = document.createElement("div"); facts.className = "apps-catalog-facts";
      addLine(facts, "Trusted source / 可信来源", app.trustedSource); addLine(facts, "Version / 版本", app.version); addLine(facts, "Catalog / 目录", app.availability?.summary); addLine(facts, "Installation / 安装", app.installationState); addLine(facts, "Connection / 连接", app.connection?.summary); addLine(facts, "Health / 健康", app.health?.summary); addLine(facts, "Capabilities / 能力", app.capabilitySummary); addLine(facts, "Approval / 审批", app.approvalSummary); addLine(facts, "Cost / 费用", `${app.cost?.summary ?? "—"}${app.cost?.metered ? " Metered fee / 按量计费" : ""}`); card.append(facts);
      const capabilities = document.createElement("p"); capabilities.className = "apps-catalog-capabilities"; capabilities.textContent = `Capabilities: ${(app.capabilities ?? []).join(" · ")}`; card.append(capabilities);
      const reviewRoot = document.createElement("div"); reviewRoot.className = "apps-catalog-review hidden"; card.append(reviewRoot);
      const actions = document.createElement("div"); actions.className = "detail-actions apps-catalog-actions";
      if (app.connectionState === "connected") actions.append(action("Disconnect / 断开", async (button) => { button.disabled = true; try { await api.connectedApps.disconnect({ appId: app.id, ...(selectedProjectId ? { projectId: selectedProjectId } : {}) }); await refresh(); } catch (error) { setFeedback(error?.message || error, true); button.disabled = false; } }));
      else if (app.connectable !== false && app.availability?.state === "available") actions.append(action("Review connection / 审查连接", async (button) => { button.disabled = true; try { const result = await api.connectedApps.review({ appId: app.id, ...(selectedProjectId ? { projectId: selectedProjectId } : {}) }); reviewDetails(app, reviewRoot, result.review); } catch (error) { setFeedback(error?.message || error, true); } finally { button.disabled = false; } }));
      if (app.connectionState !== "disabled") actions.append(action("Disable / 禁用", async (button) => { button.disabled = true; try { await api.connectedApps.disable({ appId: app.id, ...(selectedProjectId ? { projectId: selectedProjectId } : {}) }); await refresh(); } catch (error) { setFeedback(error?.message || error, true); button.disabled = false; } }));
      else if (app.connectable !== false) actions.append(action("Review & enable / 审查并启用", async (button) => { button.disabled = true; try { const result = await api.connectedApps.review({ appId: app.id, ...(selectedProjectId ? { projectId: selectedProjectId } : {}) }); reviewDetails(app, reviewRoot, result.review); } catch (error) { setFeedback(error?.message || error, true); } finally { button.disabled = false; } }, "hero-action"));
      card.append(actions);
      if (app.status !== "unavailable") card.append(assignmentControls(card, app));
      root.append(card);
    }
  }
  async function refresh() {
    const resultRoot = $("apps-catalog-result"); if (resultRoot) resultRoot.textContent = "Refreshing… / 刷新中…";
    try {
      const query = $("apps-catalog-search")?.value.trim() || "";
      const category = $("apps-catalog-category")?.value || "";
      const status = $("apps-catalog-status")?.value || "";
      const payload = { limit: 100, ...(query ? { query } : {}), ...(category ? { category } : {}), ...(status ? { status } : {}), ...(selectedProjectId ? { projectId: selectedProjectId } : {}) };
      const result = await api.connectedApps.search(payload);
      const healthy = await Promise.all((result.apps ?? []).map((app) => api.connectedApps.health({ appId: app.id, ...(selectedProjectId ? { projectId: selectedProjectId } : {}) }).catch(() => app)));
      render(healthy);
      setFeedback(`${healthy.length} app${healthy.length === 1 ? "" : "s"} in the trusted catalog. / 可信目录中有 ${healthy.length} 个应用。`);
    } catch (error) { clear($("apps-catalog-list")); setFeedback(error?.message || error, true); }
  }
  async function loadContext() {
    try {
      const [projectResult, teamResult, coworkerResult] = await Promise.all([api.projects?.list ? api.projects.list({ includeArchived: false, limit: 50 }) : { projects: [] }, api.teams?.list ? api.teams.list({}) : { teams: [] }, api.coworkers?.list ? api.coworkers.list({}) : { coworkers: [] }]);
      projects = (projectResult.projects ?? []).filter((item) => item.state !== "archived"); teams = (teamResult.teams ?? []).filter((item) => item.state !== "archived"); coworkers = (coworkerResult.coworkers ?? []).filter((item) => item.state !== "archived");
      setOptions($("apps-catalog-project"), projects.map((item) => ({ value: item.projectId, label: item.name })), "All Projects / 全部项目", selectedProjectId);
    } catch (error) { setFeedback(error?.message || error, true); }
  }
  function setup() {
    const nav = $("nav-apps"); if (!nav) return;
    nav.addEventListener("click", async () => { if (typeof switchView === "function") switchView("apps"); nav.classList.add("active"); await loadContext(); await refresh(); });
    $("apps-catalog-refresh")?.addEventListener("click", () => void refresh());
    $("apps-catalog-search")?.addEventListener("input", () => void refresh());
    $("apps-catalog-category")?.addEventListener("change", () => void refresh());
    $("apps-catalog-status")?.addEventListener("change", () => void refresh());
    $("apps-catalog-project")?.addEventListener("change", (event) => { selectedProjectId = event.target.value; void refresh(); });
  }
  window.addEventListener("DOMContentLoaded", setup);
})();
