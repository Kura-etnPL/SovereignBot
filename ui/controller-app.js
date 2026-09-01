(() => {
  "use strict";

  const STORAGE_KEY = "sovereignbot.remote-controller.public.v1";
  const NAV = [
    ["team", "Team"], ["activity", "Activity"], ["attention", "Attention"],
    ["artifacts", "Artifacts"], ["routines", "Routines"], ["computer", "Computer"],
  ];
  const bridge = window.sovereignbotRemoteBridge;
  let view = "team";
  let state = { connection: "offline", teams: [], channels: [], attention: [], routines: [], artifacts: [], computerTargets: [] };

  const $ = (id) => document.getElementById(id);
  const text = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1000);
  const safeCall = async (name, input) => {
    if (!bridge || typeof bridge[name] !== "function") throw new Error("Trusted controller host is unavailable");
    return bridge[name](input);
  };
  const card = (title, body, actions = []) => {
    const root = document.createElement("article"); root.className = "card";
    const heading = document.createElement("h2"); heading.textContent = title; root.append(heading);
    if (body) { const paragraph = document.createElement("p"); paragraph.textContent = body; root.append(paragraph); }
    if (actions.length) { const row = document.createElement("div"); row.className = "row"; actions.forEach((action) => row.append(action)); root.append(row); }
    return root;
  };
  const button = (label, handler, className = "secondary") => { const node = document.createElement("button"); node.type = "button"; node.className = className; node.textContent = label; node.addEventListener("click", () => void handler(node)); return node; };
  const empty = (message) => card("Nothing here yet", message);

  function persist() {
    if (!window.localStorage || !bridge?.controllerIdentity) return;
    const identity = bridge.controllerIdentity();
    if (!identity || typeof identity !== "object") return;
    // Deliberately persist public identifiers and UI preference only. The host owns keys and leases.
    const safe = { schema: "sovereignbot.remote-controller.persistence.v1", controllerId: text(identity.controllerId), deviceId: text(identity.deviceId), displayName: text(identity.displayName), transport: text(state.connection), preferredView: view, ...(state.teams[0]?.id ? { lastTeamId: text(state.teams[0].id) } : {}) };
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safe)); } catch {}
  }

  function renderNav() {
    const nav = $("controller-nav"); nav.textContent = "";
    NAV.forEach(([id, label]) => nav.append(button(label, async () => { view = id; persist(); await render(); }, id === view ? "primary" : "secondary")));
    [...nav.querySelectorAll("button")].forEach((node, index) => node.setAttribute("aria-current", NAV[index][0] === view ? "page" : "false"));
  }

  function renderTeam() {
    const root = $("controller-content");
    if (!state.teams.length) return root.append(empty(state.connection === "offline" ? "Desktop must be online to read Teams." : "No Teams are currently shared with this controller."));
    const list = document.createElement("div"); list.className = "card-list";
    state.teams.forEach((team) => {
      const actions = [];
      const channel = (state.channels ?? []).find((entry) => entry.teamId === team.id);
      if (channel) actions.push(button("Open activity", async () => { view = "activity"; state.selectedChannel = channel; await render(); }, "primary"));
      list.append(card(text(team.name || "Team"), `${text(team.flow?.status || "ready")} · ${team.coworkerIds?.length ?? 0} coworkers`, actions));
    }); root.append(list);
  }

  function renderActivity() {
    const root = $("controller-content");
    if (!state.channels.length) return root.append(empty("No shared Channels are available."));
    const list = document.createElement("div"); list.className = "card-list";
    state.channels.slice(0, 12).forEach((channel) => {
      const messages = state.conversations?.[channel.id]?.messages ?? [];
      const summary = messages.at(-1)?.text || "No messages yet.";
      const actions = [button("Refresh", () => loadChannel(channel), "secondary")];
      if (typeof bridge?.sendMessage === "function") {
        const composer = document.createElement("textarea"); composer.rows = 2; composer.maxLength = 12000; composer.placeholder = "Send a bounded Team message…"; composer.setAttribute("aria-label", `Message ${text(channel.name)}`);
        actions.push(composer, button("Send", async (node) => { node.disabled = true; const message = composer.value.trim(); if (!message) { node.disabled = false; return; } await action("sendMessage", { teamId: channel.teamId, channelId: channel.id, text: message }); composer.value = ""; }, "primary"));
      }
      list.append(card(text(channel.name || "Channel"), `${text(summary)} · ${messages.length} messages`, actions));
    }); root.append(list);
  }

  function renderAttention() {
    const root = $("controller-content");
    if (!state.attention.length) return root.append(empty("No Attention items require a decision."));
    const list = document.createElement("div"); list.className = "card-list";
    state.attention.forEach((item) => {
      const actions = String(item.id).startsWith("outcome_")
        ? [button("Request takeover", async (node) => { node.disabled = true; await action("requestTakeover", { outcomeId: item.id, reason: "Remote controller requested human attention." }); }, "primary")]
        : [button("Approve", async (node) => { node.disabled = true; await action("approveAttention", { jobId: item.id }); }, "primary"), button("Deny", async (node) => { node.disabled = true; await action("denyAttention", { jobId: item.id }); })];
      list.append(card(text(item.title || item.id), `${text(item.status)} · ${text(item.reason || "Human decision requested")}`, actions));
    }); root.append(list);
  }

  function renderArtifacts() {
    const root = $("controller-content");
    if (!state.artifacts.length) return root.append(empty("Artifacts appear here after a governed outcome is selected."));
    const list = document.createElement("div"); list.className = "card-list";
    state.artifacts.forEach((artifact) => list.append(card(text(artifact.title || artifact.fileName || artifact.id), `${text(artifact.mimeType)} · ${text(artifact.size)} bytes`, [])));
    root.append(list);
  }

  function renderRoutines() {
    const root = $("controller-content");
    if (!state.routines.length) return root.append(empty("No enabled Routines are shared with this controller."));
    const list = document.createElement("div"); list.className = "card-list";
    state.routines.forEach((routine) => {
      const actions = [button("Run now", async (node) => { node.disabled = true; await action("runRoutineNow", { routineId: routine.id }); }, "primary")];
      list.append(card(text(routine.name || routine.id), `${routine.enabled ? "Enabled" : "Disabled"} · ${text(routine.lastStatus || "not run")}`, actions));
    });
    root.append(list);
  }

  function renderComputer() {
    const root = $("controller-content");
    if (!state.computerTargets.length) return root.append(empty("Computer view is read-only and appears only for shared Project targets."));
    const list = document.createElement("div"); list.className = "card-list";
    state.computerTargets.forEach((target) => {
      const actions = [button("View snapshot", async (node) => { node.disabled = true; await action("computerView", { projectId: target.projectId, coworkerId: target.coworkerId }); })];
      if (target.canHandBack) actions.push(button("Release takeover", async (node) => { node.disabled = true; await action("releaseTakeover", { projectId: target.projectId, coworkerId: target.coworkerId }); }));
      list.append(card(text(target.label || target.coworkerId), `${text(target.status || "offline")} · read-only by default`, actions));
    }); root.append(list);
  }

  async function action(name, input) {
    try { const result = await safeCall(name, input); state.lastAction = `${name} completed`; if (result?.computer) state.computerResult = result; await load(); }
    catch (error) { state.lastAction = text(error?.message ?? error); await render(); }
  }

  async function loadChannel(channel) {
    try {
      const conversation = await safeCall("getConversation", { teamId: channel.teamId, channelId: channel.id });
      state.conversations = { ...(state.conversations ?? {}), [channel.id]: conversation };
      const artifactIds = [...new Set((conversation?.messages ?? []).flatMap((message) => message.artifactIds ?? []))].slice(0, 12);
      if (typeof bridge?.getArtifacts === "function") for (const outcomeId of artifactIds) { try { state.artifacts.push(...((await safeCall("getArtifacts", { outcomeId }))?.artifacts ?? [])); } catch {} }
      await render();
    }
    catch (error) { state.lastAction = text(error?.message ?? error); await render(); }
  }

  async function load() {
    if (!bridge) { state.connection = "offline"; return render(); }
    try {
      const [teams, coworkers, routines, attention] = await Promise.all([safeCall("listTeams"), safeCall("listCoworkers"), safeCall("listRoutines"), safeCall("getAttention")]);
      state = { ...state, connection: "trusted", teams: teams?.teams ?? [], coworkers: coworkers?.coworkers ?? [], routines: routines?.routines ?? [], attention: attention?.jobs ?? [], channels: [], artifacts: [] };
      for (const team of state.teams.slice(0, 24)) { const listed = await safeCall("listChannels", { teamId: team.id }); state.channels.push(...(listed?.channels ?? [])); }
      if (typeof bridge.getComputerTargets === "function") state.computerTargets = (await bridge.getComputerTargets()) ?? [];
      const artifactIds = [...new Set(state.channels.flatMap((channel) => (state.conversations?.[channel.id]?.messages ?? []).flatMap((message) => message.artifactIds ?? [])))].slice(0, 12);
      if (typeof bridge.getArtifacts === "function") for (const outcomeId of artifactIds) { try { state.artifacts.push(...((await safeCall("getArtifacts", { outcomeId }))?.artifacts ?? [])); } catch {} }
    } catch (error) { state.connection = "reconnecting"; state.lastAction = text(error?.message ?? error); }
    await render();
  }

  async function render() {
    $("connection-status").textContent = state.connection === "trusted" ? "Connected through paired secure control." : state.connection === "reconnecting" ? "Reconnecting; actions are paused." : "Desktop connection is offline.";
    renderNav(); const root = $("controller-content"); root.textContent = "";
    if (state.lastAction) root.append(card("Controller status", state.lastAction));
    if (view === "team") renderTeam(); else if (view === "activity") renderActivity(); else if (view === "attention") renderAttention(); else if (view === "artifacts") renderArtifacts(); else if (view === "routines") renderRoutines(); else renderComputer();
    const banner = $("attention-banner"); banner.classList.toggle("hidden", !state.attention.length); banner.textContent = state.attention.length ? `${state.attention.length} Attention item${state.attention.length === 1 ? "" : "s"} needs a governed decision.` : "";
  }

  $("reconnect")?.addEventListener("click", () => void (typeof bridge?.reconnect === "function" ? bridge.reconnect().then(load) : load()));
  $("logout")?.addEventListener("click", async () => { try { await bridge?.clearLease?.(); await bridge?.logout?.(); } catch {} try { window.localStorage?.removeItem(STORAGE_KEY); } catch {} state = { connection: "offline", teams: [], channels: [], attention: [], routines: [], artifacts: [], computerTargets: [] }; await render(); });
  if (typeof bridge?.registerServiceWorker === "function") void bridge.registerServiceWorker();
  else if (window.isSecureContext && navigator.serviceWorker) void navigator.serviceWorker.register("./controller-sw.js").catch(() => {});
  void load();
})();
