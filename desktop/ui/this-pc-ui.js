"use strict";

(() => {
  const api = window.sovereignbot;
  if (!api?.thisPc || !api.projects) return;
  const $ = (id) => document.getElementById(id);
  const root = $("this-pc-list");
  const projectSelect = $("this-pc-project");
  let projects = [];
  const STATUS_LABELS = new Map([
    ["working", "Working / 工作中"],
    ["takeover", "You have control / 你正在控制"],
    ["idle", "Ready / 就绪"],
    ["attention", "Needs attention / 需要处理"],
    ["unavailable", "Unavailable / 暂不可用"],
  ]);
  const HEALTH_LABELS = new Map([["ready", "Ready / 正常"], ["unavailable", "Unavailable / 暂不可用"]]);

  const clear = (node) => { if (node) node.textContent = ""; };
  const text = (label, value) => {
    const node = document.createElement("p");
    node.className = "this-pc-detail";
    node.textContent = `${label}: ${value === undefined || value === null || value === "" ? "—" : value}`;
    return node;
  };
  const result = (message, error = false) => {
    const node = $("this-pc-result");
    if (!node) return;
    node.textContent = String(message ?? "").slice(0, 240);
    node.classList.toggle("inline-error", error);
  };
  const button = (label, fn, className = "quiet-action") => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = label;
    node.addEventListener("click", async () => {
      node.disabled = true;
      try { await fn(); }
      catch (error) { result(error?.message ?? error, true); }
      finally { node.disabled = false; }
    });
    return node;
  };
  const currentProjectId = () => projectSelect?.value || projects.find((entry) => entry.state === "active")?.projectId;
  const statusLabel = (value) => STATUS_LABELS.get(value) || "Status unknown / 状态未知";
  const healthLabel = (value) => HEALTH_LABELS.get(value) || "Unavailable / 暂不可用";

  function populateProjects() {
    if (!projectSelect) return;
    const current = projectSelect.value;
    clear(projectSelect);
    for (const project of projects.filter((entry) => entry.state !== "archived")) {
      const option = document.createElement("option");
      option.value = project.projectId;
      option.textContent = project.name;
      projectSelect.append(option);
    }
    if ([...projectSelect.options].some((option) => option.value === current)) projectSelect.value = current;
    else if (projectSelect.options.length) projectSelect.value = projectSelect.options[0].value;
  }

  function renderCard(computer, projectId) {
    const card = document.createElement("article");
    card.className = "settings-card this-pc-card";
    card.dataset.coworkerId = computer.coworkerId || "";
    const heading = document.createElement("div");
    heading.className = "this-pc-card-heading";
    const title = document.createElement("h2");
    title.textContent = computer.coworkerName || "Coworker";
    const status = document.createElement("span");
    status.className = `this-pc-status ${computer.status || "unavailable"}`;
    status.textContent = statusLabel(computer.status);
    heading.append(title, status);
    card.append(heading);
    const summary = document.createElement("p");
    summary.className = "this-pc-summary";
    summary.textContent = computer.statusMessage || "No status update yet.";
    card.append(summary);
    const facts = document.createElement("div");
    facts.className = "this-pc-facts";
    facts.append(
      text("Health / 健康", healthLabel(computer.health?.status)),
      text("Context / 上下文", [computer.context?.label, computer.context?.detail].filter(Boolean).join(" · ")),
      text("Current work / 当前工作", computer.currentWork),
      text("Current app / 当前应用", computer.currentApp),
      text("Current site / 当前站点", computer.currentSite),
    );
    card.append(facts);

    const actions = document.createElement("div");
    actions.className = "detail-actions";
    if (computer.canTakeOver) actions.append(button("Take Over / 接管", async () => { window.sovereignbotStopVoice?.(); await api.thisPc.takeOver({ projectId, coworkerId: computer.coworkerId }); result("Coworker actions are paused while you have control / 你控制期间已暂停同事操作"); await refresh(); }, "hero-action"));
    if (computer.canHandBack) actions.append(button("Hand Back / 交还", async () => { await api.thisPc.handBack({ projectId, coworkerId: computer.coworkerId }); result("Control handed back; the Coworker can continue when ready / 已交还控制权，同事准备好后可继续"); await refresh(); }, "hero-action"));
    actions.append(button("Show latest screen / 查看最新画面", async () => {
      const frame = await api.thisPc.frame({ projectId, coworkerId: computer.coworkerId });
      const image = card.querySelector(".this-pc-screen");
      if (image) { image.src = `data:${frame.mimeType};base64,${frame.data}`; image.classList.remove("hidden"); }
      const site = card.querySelector(".this-pc-frame-site");
      if (site) site.textContent = frame.site ? `Current site / 当前站点: ${frame.site}` : "No current site to show.";
    }));
    actions.append(button("Show page details / 查看页面详情", async () => {
      const snapshot = await api.thisPc.snapshot({ projectId, coworkerId: computer.coworkerId });
      const summary = card.querySelector(".this-pc-snapshot-summary");
      if (summary) summary.textContent = `${snapshot.elements?.length ?? 0} page controls${snapshot.site ? ` · ${snapshot.site}` : ""}`;
    }));
    if (computer.artifacts?.length) actions.append(button("Open artifacts / 查看成果", () => document.dispatchEvent(new CustomEvent("sovereignbot:open-artifacts", { detail: { projectId } }))));
    actions.append(button("Open activity / 查看动态", () => document.dispatchEvent(new CustomEvent("sovereignbot:open-computer-history", { detail: { projectId, coworkerId: computer.coworkerId } }))));
    card.append(actions);

    const image = document.createElement("img");
    image.className = "this-pc-screen hidden";
    image.alt = "Latest safe Coworker screen";
    card.append(image);
    const frameSite = document.createElement("p");
    frameSite.className = "this-pc-frame-site";
    frameSite.textContent = "No latest screen yet. Show it when this Coworker is working.";
    card.append(frameSite);
    const snapshotSummary = document.createElement("p");
    snapshotSummary.className = "this-pc-snapshot-summary";
    snapshotSummary.textContent = "No page details loaded.";
    card.append(snapshotSummary);

    const files = document.createElement("div");
    files.className = "this-pc-subsection";
    files.append(document.createElement("h3"), text("Files / 文件", computer.files?.length ? computer.files.map((entry) => `${entry.name} · ${entry.type}`).join(", ") : "No files to show yet"));
    files.querySelector("h3").textContent = "Recent files / 最近文件";
    card.append(files);
    const artifacts = document.createElement("div");
    artifacts.className = "this-pc-subsection";
    artifacts.append(document.createElement("h3"), text("Artifacts / 成果", computer.artifacts?.length ? computer.artifacts.map((entry) => entry.title || entry.fileName).join(", ") : "No artifacts in this Project yet"));
    artifacts.querySelector("h3").textContent = "Artifacts / 成果";
    card.append(artifacts);
    const history = document.createElement("div");
    history.className = "this-pc-subsection";
    history.append(document.createElement("h3"), text("Activity / 动态", computer.history?.length ? computer.history.slice(0, 5).map((entry) => `${entry.activity} · ${entry.status}`).join("; ") : "No activity to show yet"));
    history.querySelector("h3").textContent = "Recent activity / 最近动态";
    card.append(history);
    return card;
  }

  function render(items, projectId) {
    clear(root);
    for (const computer of items) root?.append(renderCard(computer, projectId));
    if (!items.length) root?.append(text("This PC / 此电脑", "No active Coworkers in this Project yet."));
  }

  async function refresh() {
    if (!root) return;
    try {
      const listed = await api.projects.list({ includeArchived: false, limit: 50 });
      projects = listed.projects ?? [];
      populateProjects();
      const projectId = currentProjectId();
      if (!projectId) { render([], ""); result("Create or select a Project to see its Coworkers / 请先创建或选择项目"); return; }
      const computers = await api.thisPc.list({ projectId, limit: 50 });
      render(computers.computers ?? [], projectId);
      result("");
    } catch (error) { clear(root); result(error?.message ?? error, true); }
  }

  function open() {
    if (typeof switchView === "function") switchView("this-pc");
    document.querySelectorAll("[data-product-view]").forEach((node) => node.classList.toggle("active", node.dataset.productView === "this-pc"));
    void refresh();
  }

  $("nav-this-pc")?.addEventListener("click", open);
  $("this-pc-refresh")?.addEventListener("click", () => void refresh());
  projectSelect?.addEventListener("change", () => void refresh());
  api.onNavigate?.((target) => { if (target === "this-pc") open(); });
  window.refreshThisPc = refresh;
  window.addEventListener("DOMContentLoaded", () => { if (document.getElementById("view-this-pc")) void refresh(); });
})();
