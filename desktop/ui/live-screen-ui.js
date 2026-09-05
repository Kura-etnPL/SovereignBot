"use strict";

(() => {
  if (!window.sovereignbot?.computer?.frame || typeof renderDetails !== "function") return;

  const baseRenderDetails = renderDetails;
  let generation = 0;
  let selectedAgentId;
  let currentConversationId = null;

  function ensureSection() {
    const container = document.getElementById("details-body") || document.getElementById("details-panel");
    if (!container) return undefined;
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
    img.style.display = "none";
    img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
    img.onerror = function () {
      this.style.display = "none";
      this.classList.add("hidden");
    };

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
    const computer = document.getElementById("details-computer-section");
    const future = container.querySelector(".future-section");
    const refNode = (computer && computer.parentElement === container) ? computer : ((future && future.parentElement === container) ? future : null);
    if (refNode) {
      container.insertBefore(section, refNode);
    } else {
      container.appendChild(section);
    }
    refresh.addEventListener("click", () => pullFrame(++generation, true));
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
      img.style.display = "none";
      img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
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
      if (img && frame?.data) {
        img.src = `data:${frame.mimeType || "image/png"};base64,${frame.data}`;
        img.classList.remove("hidden");
        img.style.display = "block";
        empty?.classList.add("hidden");
        if (url) url.textContent = frame.url || "Active browser page";
        if (stateEl) stateEl.textContent = "Live";
        // Only loop pullFrame if the frame retrieval genuinely succeeded and session is alive
        if (myGeneration === generation && !panel.classList.contains("hidden")) {
          setTimeout(() => pullFrame(myGeneration), 2500);
        }
      } else {
        setEmpty("No active display output", "Idle");
      }
    } catch (error) {
      if (myGeneration !== generation) return;
      const message = String(error?.message || error);
      if (/not running|session is not running|unavailable|offline/i.test(message)) {
        setEmpty("Start this coworker's computer to see its live screen.", "Offline");
      } else {
        setEmpty("Live screen is temporarily unavailable.", "Unavailable");
      }
    }
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
    setEmpty("Start this coworker's computer to see its live screen.", "Offline");
    pullFrame(current, false);
  }

  renderDetails = function renderDetailsWithLiveScreen(conversation) {
    baseRenderDetails(conversation);
    if (currentConversationId !== conversation?.id) {
      currentConversationId = conversation?.id;
      startLiveScreen(conversation);
    }
  };

  ensureSection();
})();
