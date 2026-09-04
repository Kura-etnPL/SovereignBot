"use strict";

(() => {
  if (!window.sovereignbot?.computer || !window.sovereignbot?.operator || typeof renderDetails !== "function") return;

  // Conversation details keeps a compact, safe compatibility view. It resolves
  // the Project server-side through the public Project projection and never uses
  // the legacy operator/agent-shaped Computer payload.
  if (window.sovereignbot?.thisPc) {
    const baseRenderDetails = renderDetails;
    function ensureSafeSection() {
      const panel = document.getElementById("details-panel");
      if (!panel) return undefined;
      let section = document.getElementById("details-computer-section");
      const t = (k, p) => globalThis.SovereignI18n?.t(k, p) || k;
      if (!section) {
        section = document.createElement("section");
        section.id = "details-computer-section";
        section.className = "detail-section computer-section";
        const label = document.createElement("span"); label.className = "detail-label"; label.textContent = t("thisPc.title");
        const root = document.createElement("div"); root.id = "details-computers"; root.className = "computer-list";
        section.append(label, root);
        panel.insertBefore(section, document.getElementById("details-artifacts-section") || panel.querySelector(".future-section") || null);
      }
      if (!section.querySelector(".computer-context-help")) {
        const productTitle = document.createElement("strong");
        productTitle.className = "computer-product-title";
        productTitle.textContent = t("thisPc.title");
        const help = document.createElement("p");
        help.className = "computer-context-help computer-note";
        help.textContent = t("thisPc.contextOptions");
        section.insertBefore(productTitle, section.querySelector("#details-computers"));
        section.insertBefore(help, section.querySelector("#details-computers"));
      }
      return section;
    }
    async function safeRender(conversation) {
      const t = (k, p) => globalThis.SovereignI18n?.t(k, p) || k;
      const section = ensureSafeSection(); const root = section?.querySelector("#details-computers"); if (!root) return;
      root.textContent = "Checking This PC…";
      try {
        const projects = (await window.sovereignbot.projects.list({ includeArchived: false, limit: 50 })).projects ?? [];
        const project = projects.find((entry) => entry.teams?.some((team) => team.channels?.some((channel) => channel.conversationId === conversation.id)));
        if (!project) { root.textContent = t("thisPc.openToChoose"); return; }
        const result = await window.sovereignbot.thisPc.list({ projectId: project.projectId, limit: 50 });
        root.textContent = "";
        for (const computer of (result.computers ?? []).filter((entry) => participantCoworkers(conversation).some((member) => member.id === entry.coworkerId))) {
          const card = document.createElement("article"); card.className = "computer-card";
          const name = document.createElement("strong"); name.textContent = computer.coworkerName || "Coworker";
          const mode = document.createElement("span"); mode.textContent = `${t("thisPc.profileLabel")}: ${computer.context?.kind === "private" ? t("thisPc.privateContext") : t("thisPc.sharedContext")}`;
          const status = document.createElement("span"); status.textContent = `${t("thisPc.statusLabel")}: ${computer.status} · ${computer.statusMessage}`;
          card.append(name, mode, status);
          const actions = document.createElement("div"); actions.className = "computer-actions-row";
          if (computer.canTakeOver) actions.append(Object.assign(document.createElement("button"), { type: "button", className: "computer-action primary", textContent: t("thisPc.takeControl"), onclick: async () => { window.sovereignbotStopVoice?.(); await window.sovereignbot.thisPc.takeOver({ projectId: project.projectId, coworkerId: computer.coworkerId }); await safeRender(conversation); } }));
          if (computer.canHandBack) actions.append(Object.assign(document.createElement("button"), { type: "button", className: "computer-action primary", textContent: t("thisPc.handBack"), onclick: async () => { await window.sovereignbot.thisPc.handBack({ projectId: project.projectId, coworkerId: computer.coworkerId }); await safeRender(conversation); } }));
          card.append(actions); root.append(card);
        }
        if (!root.children.length) root.textContent = "No Coworker Computer lane in this Project.";
      } catch { root.textContent = "This PC status is unavailable."; }
    }
    renderDetails = function renderDetailsWithSafeComputer(conversation) { baseRenderDetails(conversation); void safeRender(conversation); };
    ensureSafeSection();
    return;
  }

  const baseRenderDetails = renderDetails;
  let refreshSeq = 0;

  function ensureComputerSection() {
    const panel = document.getElementById("details-panel");
    if (!panel) return undefined;
    let section = document.getElementById("details-computer-section");
    if (!section) {
      section = document.createElement("section");
      section.id = "details-computer-section";
      section.className = "detail-section computer-section";
      const label = document.createElement("span");
      label.className = "detail-label";
      label.textContent = "Computer";
      const root = document.createElement("div");
      root.id = "details-computers";
      root.className = "computer-list";
      section.append(label, root);
      const artifacts = document.getElementById("details-artifacts-section");
      const future = panel.querySelector(".future-section");
      panel.insertBefore(section, artifacts || future || null);
    }
    for (const chip of panel.querySelectorAll(".future-chip-row span")) {
      if (chip.textContent.trim() === "Computer") chip.remove();
    }
    ensureTopbarButton();
    return section;
  }

  function ensureTopbarButton() {
    const actions = document.querySelector(".conversation-actions");
    const details = document.getElementById("open-details");
    if (!actions || !details || document.getElementById("open-computer")) return;
    const button = document.createElement("button");
    button.id = "open-computer";
    button.className = "icon-button";
    button.type = "button";
    button.title = "Computer";
    button.setAttribute("aria-label", "Open computer controls");
    button.textContent = "▣";
    button.addEventListener("click", () => {
      const panel = document.getElementById("details-panel");
      panel?.classList.remove("hidden");
      ensureComputerSection()?.scrollIntoView({ block: "start" });
    });
    actions.insertBefore(button, details);
  }

  function isKnownStopped(computer) {
    return computer?.lifecycle?.running === false && computer?.lifecycle?.instantiated !== true;
  }

  function statusLabel(computer) {
    const lifecycle = computer?.lifecycle;
    if (!lifecycle?.managed) return "Not configured";
    if (isKnownStopped(computer)) return "Stopped";
    if (computer?.control?.mode === "human") return "You have control";
    if (computer?.control?.mode === "requested") return "Needs you";
    if (lifecycle?.instantiated === true) return "Computer active";
    return "Computer ready";
  }

  function statusClass(computer) {
    if (!computer?.lifecycle?.managed || isKnownStopped(computer)) return "offline";
    if (computer?.control?.mode === "requested") return "attention";
    if (computer?.control?.mode === "human") return "human";
    return "ready";
  }

  function stageLabel(stage) {
    return ({
      chief: "Chief scopes",
      "coding-lead": "Coding Lead works",
      specialist: "Specialist works",
      reviewer: "Reviewer checks",
      synthesis: "Chief summarizes",
      complete: "Ready",
    })[stage] || "Team work";
  }

  function makeButton(label, className = "computer-action") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    return button;
  }

  async function runAction(button, action, refresh) {
    button.disabled = true;
    try {
      await action();
      await refresh();
    } catch (error) {
      const card = button.closest(".computer-card");
      const errorEl = card?.querySelector(".computer-error");
      if (errorEl) {
        errorEl.textContent = String(error?.message || error).replace(/^.*Error: /, "").slice(0, 220);
        errorEl.classList.remove("hidden");
      }
    } finally {
      button.disabled = false;
    }
  }

  function renderSecretRequest(card, computer, refresh) {
    const request = computer?.pendingSecret;
    if (!request?.id) return;
    const box = document.createElement("div");
    box.className = "secret-box";
    const copy = document.createElement("div");
    copy.className = "secret-copy";
    const title = document.createElement("strong");
    title.textContent = "Credential needed";
    const label = document.createElement("span");
    label.textContent = request.label || "Enter the requested secret";
    copy.append(title, label);
    const form = document.createElement("form");
    form.className = "secret-form";
    form.autocomplete = "off";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "new-password";
    input.spellcheck = false;
    input.placeholder = request.label || "Secret";
    input.maxLength = 10000;
    const submit = makeButton("Supply", "computer-action primary");
    form.append(input, submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = input.value;
      if (!value) return;
      input.value = "";
      await runAction(submit, () => window.sovereignbot.computer.supplySecret({
        agentId: computer.agentId,
        requestId: request.id,
        value,
      }), refresh);
    });
    box.append(copy, form);
    card.append(box);
  }

  function renderComputerCard({ coworker, binding, computer, team, refresh }) {
    const card = document.createElement("article");
    card.className = "computer-card";

    const head = document.createElement("div");
    head.className = "computer-head";
    const identity = document.createElement("div");
    identity.className = "computer-identity";
    const icon = document.createElement("span");
    icon.className = "computer-icon";
    icon.textContent = "▣";
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = coworker?.name || binding?.agentId || "Coworker";
    const agent = document.createElement("span");
    agent.textContent = t("thisPc.title");
    copy.append(name, agent);
    identity.append(icon, copy);
    const stateEl = document.createElement("span");
    stateEl.className = `computer-state ${statusClass(computer)}`;
    stateEl.textContent = statusLabel(computer);
    head.append(identity, stateEl);
    card.append(head);

    const modeRow = document.createElement("label");
    modeRow.className = "computer-mode-row";
    const modeLabel = document.createElement("span");
    modeLabel.textContent = t("thisPc.profileLabel");
    const mode = document.createElement("select");
    mode.className = "computer-mode-select";
    for (const option of [
      ["shared-login", t("thisPc.sharedContext")],
      ["private-profile", t("thisPc.privateContext")],
    ]) {
      const item = document.createElement("option");
      item.value = option[0];
      item.textContent = option[1];
      mode.append(item);
    }
    mode.value = coworker?.computerMode || "shared-login";
    mode.disabled = !coworker?.id || !window.sovereignbot.coworkers?.update;
    mode.addEventListener("change", async () => {
      mode.disabled = true;
      try {
        await window.sovereignbot.coworkers.update({ coworkerId: coworker.id, patch: { computerMode: mode.value } });
      } catch (error) {
        mode.value = coworker?.computerMode || "shared-login";
        const errorEl = card.querySelector(".computer-error");
        if (errorEl) {
          errorEl.textContent = String(error?.message || error).replace(/^.*Error: /, "").slice(0, 220);
          errorEl.classList.remove("hidden");
        }
      } finally {
        mode.disabled = false;
      }
    });
    modeRow.append(modeLabel, mode);
    card.append(modeRow);

    if (!binding?.agentId) {
      const note = document.createElement("p");
      note.className = "computer-note";
      note.textContent = "This coworker has no computer lane yet.";
      card.append(note);
      return card;
    }

    if (!computer) {
      const note = document.createElement("p");
      note.className = "computer-note";
      note.textContent = "Computer state is not available yet.";
      card.append(note);
      return card;
    }

    const details = document.createElement("div");
    details.className = "computer-details";
    const control = document.createElement("span");
    control.textContent = `Control: ${computer.control?.mode || "agent"}`;
    const activity = document.createElement("span");
    const flow = team?.flow;
    const ownsCurrentWork = flow?.currentOwnerId === coworker?.id;
    activity.textContent = ownsCurrentWork && flow?.status === "active"
      ? `Activity: ${flow.currentOwner || coworker.name} is working`
      : computer.lifecycle?.instantiated === true
        ? "Activity: governed browser lane active"
        : "Activity: waiting for a governed browser lane";
    const context = document.createElement("span");
    context.textContent = team
      ? `Context: Project Channel · ${stageLabel(flow?.stage)}`
      : "Context: Private workspace";
    const runtime = document.createElement("span");
    runtime.textContent = !computer.lifecycle?.managed
      ? "Managed browser not configured"
      : isKnownStopped(computer)
        ? "Browser runtime stopped"
        : computer.lifecycle?.instantiated === true
          ? "Browser runtime active"
          : "Browser runtime ready";
    details.append(control, activity, context, runtime);
    card.append(details);

    const actions = document.createElement("div");
    actions.className = "computer-actions-row";
    if (!computer.lifecycle?.managed) {
      const setup = makeButton("Set up browser");
      setup.addEventListener("click", () => switchView("settings"));
      actions.append(setup);
    } else if (isKnownStopped(computer)) {
      const start = makeButton("Start computer", "computer-action primary");
      start.addEventListener("click", () => runAction(start, () => window.sovereignbot.computer.lifecycle({ agentId: binding.agentId, action: "start" }), refresh));
      actions.append(start);
    } else if (computer.control?.mode === "human") {
      const release = makeButton("Hand back", "computer-action primary");
      release.addEventListener("click", () => runAction(release, () => window.sovereignbot.computer.control({ agentId: binding.agentId, action: "release" }), refresh));
      actions.append(release);
    } else {
      const take = makeButton(computer.control?.mode === "requested" ? "Take over now" : "Take control", "computer-action primary");
      take.addEventListener("click", () => runAction(take, () => { window.sovereignbotStopVoice?.(); return window.sovereignbot.computer.control({ agentId: binding.agentId, action: "take" }); }, refresh));
      actions.append(take);
      const stop = makeButton("Stop");
      stop.addEventListener("click", () => runAction(stop, () => window.sovereignbot.computer.lifecycle({ agentId: binding.agentId, action: "stop" }), refresh));
      actions.append(stop);
    }
    card.append(actions);

    const error = document.createElement("p");
    error.className = "computer-error hidden";
    card.append(error);
    renderSecretRequest(card, computer, refresh);
    return card;
  }

  async function renderComputers(conversation) {
    ensureComputerSection();
    const root = document.getElementById("details-computers");
    if (!root) return;
    const seq = ++refreshSeq;
    root.textContent = "";
    const loading = document.createElement("span");
    loading.className = "computer-loading";
    loading.textContent = "Checking computer…";
    root.append(loading);

    try {
      const overview = await window.sovereignbot.operator.getOverview({});
      if (seq !== refreshSeq || state?.selectedConversationId !== conversation.id) return;
      root.textContent = "";
      const coworkers = participantCoworkers(conversation);
      const computers = overview?.computers ?? [];
      const team = typeof teamForConversation === "function" ? teamForConversation(conversation.id) : undefined;
      const refresh = () => renderComputers(conversation);
      for (const coworker of coworkers) {
        const binding = bindingFor(coworker.id);
        const computer = computers.find((entry) => entry.agentId === binding?.agentId);
        root.append(renderComputerCard({ coworker, binding, computer, team, refresh }));
      }
      if (!coworkers.length) {
        const empty = document.createElement("span");
        empty.className = "computer-loading";
        empty.textContent = "No coworker computer in this conversation.";
        root.append(empty);
      }
    } catch (error) {
      root.textContent = "";
      const failed = document.createElement("span");
      failed.className = "computer-error";
      failed.textContent = "Computer status unavailable.";
      root.append(failed);
    }
  }

  renderDetails = function renderDetailsWithComputer(conversation) {
    baseRenderDetails(conversation);
    renderComputers(conversation);
  };

  ensureComputerSection();
})();
