"use strict";

(() => {
  if (!window.sovereignbot?.computer || !window.sovereignbot?.operator || typeof renderDetails !== "function") return;

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

  function renderComputerCard({ coworker, binding, computer, refresh }) {
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
    agent.textContent = binding?.provider ? `${humanProvider(binding.provider)} computer` : "Computer";
    copy.append(name, agent);
    identity.append(icon, copy);
    const stateEl = document.createElement("span");
    stateEl.className = `computer-state ${statusClass(computer)}`;
    stateEl.textContent = statusLabel(computer);
    head.append(identity, stateEl);
    card.append(head);

    if (!binding?.agentId) {
      const note = document.createElement("p");
      note.className = "computer-note";
      note.textContent = "This coworker has no provider lane yet.";
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
    const runtime = document.createElement("span");
    runtime.textContent = !computer.lifecycle?.managed
      ? "Managed browser not configured"
      : isKnownStopped(computer)
        ? "Browser runtime stopped"
        : computer.lifecycle?.instantiated === true
          ? "Browser runtime active"
          : "Browser runtime ready";
    details.append(control, runtime);
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
      take.addEventListener("click", () => runAction(take, () => window.sovereignbot.computer.control({ agentId: binding.agentId, action: "take" }), refresh));
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
      const refresh = () => renderComputers(conversation);
      for (const coworker of coworkers) {
        const binding = bindingFor(coworker.id);
        const computer = computers.find((entry) => entry.agentId === binding?.agentId);
        root.append(renderComputerCard({ coworker, binding, computer, refresh }));
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
