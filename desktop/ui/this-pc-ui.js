"use strict";

(() => {
  const api = window.sovereignbot;
  if (!api?.thisPc || !api.projects) return;
  const $ = (id) => document.getElementById(id);
  const t = (key, params) => globalThis.SovereignI18n?.t(key, params) ?? key;
  const root = $("this-pc-list");
  const projectSelect = $("this-pc-project");
  let projects = [];
  const STATUS_KEY_MAP = {
    working: "state.working",
    takeover: "thisPc.takeoverStatus",
    idle: "state.ready",
    attention: "state.attention",
    unavailable: "state.unavailable",
  };
  const HEALTH_KEY_MAP = {
    ready: "state.ready",
    unavailable: "state.unavailable",
  };

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
  const statusLabel = (value) => STATUS_KEY_MAP[value] ? t(STATUS_KEY_MAP[value]) : t("thisPc.statusUnknown");
  const healthLabel = (value) => HEALTH_KEY_MAP[value] ? t(HEALTH_KEY_MAP[value]) : t("state.unavailable");

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
      text(t("thisPc.healthLabel"), healthLabel(computer.health?.status)),
      text(t("thisPc.contextLabel"), [computer.context?.label, computer.context?.detail].filter(Boolean).join(" · ")),
      text(t("thisPc.currentWorkLabel"), computer.currentWork),
      text(t("thisPc.currentAppLabel"), computer.currentApp),
      text(t("thisPc.currentSiteLabel"), computer.currentSite),
    );
    card.append(facts);

    const actions = document.createElement("div");
    actions.className = "detail-actions";
    if (computer.canTakeOver) actions.append(button(t("thisPc.takeControl"), async () => { window.sovereignbotStopVoice?.(); await api.thisPc.takeOver({ projectId, coworkerId: computer.coworkerId }); result(t("thisPc.takeOverFeedback")); await refresh(); }, "hero-action"));
    if (computer.canHandBack) actions.append(button(t("thisPc.handBack"), async () => { await api.thisPc.handBack({ projectId, coworkerId: computer.coworkerId }); result(t("thisPc.handBackFeedback")); await refresh(); }, "hero-action"));
    actions.append(button(t("thisPc.showLatestScreen"), async () => {
      const frame = await api.thisPc.frame({ projectId, coworkerId: computer.coworkerId });
      const image = card.querySelector(".this-pc-screen");
      if (image) { image.src = `data:${frame.mimeType};base64,${frame.data}`; image.classList.remove("hidden"); }
      const site = card.querySelector(".this-pc-frame-site");
      if (site) site.textContent = frame.site ? `${t("thisPc.currentSiteLabel")}: ${frame.site}` : t("thisPc.noCurrentSite");
    }));
    actions.append(button(t("thisPc.showPageDetails"), async () => {
      const snapshot = await api.thisPc.snapshot({ projectId, coworkerId: computer.coworkerId });
      const summary = card.querySelector(".this-pc-snapshot-summary");
      if (summary) summary.textContent = `${snapshot.elements?.length ?? 0} page controls${snapshot.site ? ` · ${snapshot.site}` : ""}`;
    }));
    if (computer.artifacts?.length) actions.append(button(t("thisPc.openArtifacts"), () => document.dispatchEvent(new CustomEvent("sovereignbot:open-artifacts", { detail: { projectId, coworkerId: computer.coworkerId } }))));
    actions.append(button(t("thisPc.openActivity"), () => document.dispatchEvent(new CustomEvent("sovereignbot:open-computer-history", { detail: { projectId, coworkerId: computer.coworkerId } }))));
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
    files.append(document.createElement("h3"), text(t("thisPc.filesLabel"), computer.files?.length ? computer.files.map((entry) => `${entry.name} · ${entry.type}`).join(", ") : "No files to show yet"));
    files.querySelector("h3").textContent = t("thisPc.recentFiles");
    card.append(files);
    const artifacts = document.createElement("div");
    artifacts.className = "this-pc-subsection";
    artifacts.append(document.createElement("h3"), text(t("thisPc.artifactsLabel"), computer.artifacts?.length ? computer.artifacts.map((entry) => entry.title || entry.fileName).join(", ") : "No artifacts in this Project yet"));
    artifacts.querySelector("h3").textContent = t("thisPc.artifactsHeading");
    card.append(artifacts);
    const history = document.createElement("div");
    history.className = "this-pc-subsection";
    history.append(document.createElement("h3"), text(t("thisPc.activityLabel"), computer.history?.length ? computer.history.slice(0, 5).map((entry) => `${entry.activity} · ${entry.status}`).join("; ") : "No activity to show yet"));
    history.querySelector("h3").textContent = t("thisPc.recentActivity");
    card.append(history);
    return card;
  }

  function render(items, projectId) {
    clear(root);
    for (const computer of items) root?.append(renderCard(computer, projectId));
    if (!items.length) root?.append(text(t("thisPc.title"), t("thisPc.emptyProject")));
  }

  async function refresh() {
    if (!root) return;
    try {
      const listed = await api.projects.list({ includeArchived: false, limit: 50 });
      projects = listed.projects ?? [];
      populateProjects();
      const projectId = currentProjectId();
      if (!projectId) { render([], ""); result(t("thisPc.createOrSelectProject")); return; }
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
