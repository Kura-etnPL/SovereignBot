"use strict";

(() => {
  // Live screen is rendered by This PC with a Project/Coworker scope. The
  // legacy agent-scoped decorator must not expose internal runtime IDs.
  if (window.sovereignbot?.thisPc || !window.sovereignbot?.computer?.frame || typeof renderDetails !== "function") return;

  const baseRenderDetails = renderDetails;
  let generation = 0;
  let selectedAgentId;

  function ensureSection() {
    const panel = document.getElementById("details-panel");
    if (!panel) return undefined;
    let section = document.getElementById("details-live-screen-section");
    if (section) return section;

    section = document.createElement("section");
    section.id = "details-live-screen-section";
    section.className = "detail-section live-screen-section";

    const head = document.createElement("div");
    head.className = "live-screen-heading";
    const label = document.createElement("span");
    label.className = "detail-label";
    label.textContent = "Live screen";
    const state = document.createElement("span");
    state.id = "live-screen-state";
    state.className = "live-screen-state";
    state.textContent = "Idle";
    head.append(label, state);

    const tabs = document.createElement("div");
    tabs.id = "live-screen-tabs";
    tabs.className = "live-screen-tabs";

    const viewport = document.createElement("div");
    viewport.className = "live-screen-viewport";
    const img = document.createElement("img");
    img.id = "live-screen-image";
    img.alt = "Live coworker computer screen";
    img.className = "live-screen-image hidden";
    const empty = document.createElement("div");
    empty.id = "live-screen-empty";
    empty.className = "live-screen-empty";
    empty.textContent = "Start this coworker's computer to see its screen.";
    viewport.append(img, empty);

    const footer = document.createElement("div");
    footer.className = "live-screen-footer";
    const url = document.createElement("span");
    url.id = "live-screen-url";
    url.textContent = "No active page";
    const refresh = document.createElement("button");
    refresh.id = "live-screen-refresh";
    refresh.className = "live-screen-refresh";
    refresh.type = "button";
    refresh.textContent = "Refresh";
    footer.append(url, refresh);

    section.append(head, tabs, viewport, footer);
    const targetContainer = document.getElementById("details-body") || panel;
    const computer = document.getElementById("details-computer-section");
    const future = targetContainer.querySelector(".future-section");
    const refNode = (computer && computer.parentNode === targetContainer) ? computer : ((future && future.parentNode === targetContainer) ? future : null);
    targetContainer.insertBefore(section, refNode);
    refresh.addEventListener("click", () => pullFrame(generation, true));
    return section;
  }

  function bindingsForConversation(conversation) {
    const rows = [];
    for (const coworker of participantCoworkers(conversation)) {
      const binding = bindingFor(coworker.id);
      if (!binding?.agentId) continue;
      rows.push({ coworker, binding });
    }
    return rows;
  }

  function renderTabs(conversation) {
    const tabs = document.getElementById("live-screen-tabs");
    if (!tabs) return [];
    const rows = bindingsForConversation(conversation);
    tabs.textContent = "";
    if (!rows.some((row) => row.binding.agentId === selectedAgentId))
      selectedAgentId = rows[0]?.binding.agentId;

    for (const row of rows) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `live-screen-tab${row.binding.agentId === selectedAgentId ? " active" : ""}`;
      button.textContent = row.coworker.name;
      button.addEventListener("click", () => {
        selectedAgentId = row.binding.agentId;
        renderTabs(conversation);
        pullFrame(++generation, true);
      });
      tabs.append(button);
    }
    return rows;
  }

  function setEmpty(message, status = "Idle") {
    const img = document.getElementById("live-screen-image");
    const empty = document.getElementById("live-screen-empty");
    const stateEl = document.getElementById("live-screen-state");
    if (img) {
      img.classList.add("hidden");
      img.removeAttribute("src");
    }
    if (empty) {
      empty.textContent = message;
      empty.classList.remove("hidden");
    }
    if (stateEl) stateEl.textContent = status;
  }

  async function pullFrame(myGeneration, force = false) {
    const panel = document.getElementById("details-panel");
    if (!selectedAgentId || !panel || panel.classList.contains("hidden")) return;
    const stateEl = document.getElementById("live-screen-state");
    if (stateEl && force) stateEl.textContent = "Refreshing…";
    try {
      const frame = await window.sovereignbot.computer.frame({ agentId: selectedAgentId });
      if (myGeneration !== generation || panel.classList.contains("hidden")) return;
      const img = document.getElementById("live-screen-image");
      const empty = document.getElementById("live-screen-empty");
      const url = document.getElementById("live-screen-url");
      if (img) {
        img.src = `data:${frame.mimeType};base64,${frame.data}`;
        img.classList.remove("hidden");
      }
      empty?.classList.add("hidden");
      if (url) url.textContent = frame.url || "Active browser page";
      if (stateEl) stateEl.textContent = "Live";
    } catch (error) {
      if (myGeneration !== generation) return;
      const message = String(error?.message || error);
      if (/not running|session is not running|unavailable/i.test(message))
        setEmpty("Start this coworker's computer to see its live screen.", "Offline");
      else
        setEmpty("Live screen is temporarily unavailable.", "Unavailable");
    }
    if (myGeneration === generation && !panel.classList.contains("hidden"))
      setTimeout(() => pullFrame(myGeneration), 1400);
  }

  function startLiveScreen(conversation) {
    ensureSection();
    const rows = renderTabs(conversation);
    const url = document.getElementById("live-screen-url");
    if (url) url.textContent = "No active page";
    const current = ++generation;
    if (!rows.length) {
      selectedAgentId = undefined;
      setEmpty("No coworker computer is bound to this conversation.", "Unavailable");
      return;
    }
    setEmpty("Connecting to coworker computer…", "Connecting…");
    pullFrame(current, true);
  }

  renderDetails = function renderDetailsWithLiveScreen(conversation) {
    baseRenderDetails(conversation);
    startLiveScreen(conversation);
  };

  ensureSection();
})();
