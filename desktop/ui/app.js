"use strict";

// Renderer entry point. The renderer is fully sandboxed: no Node, no fs, no child_process.
// The only privileged surface is window.sovereignbot exposed by the preload through
// contextBridge, and every call goes to an enumerated IPC channel. All dynamic content
// reaches the DOM through textContent — never innerHTML — because agent output is data.

const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];
const ROLE_LABELS = { planner: "Planner", worker: "Worker", reviewer: "Reviewer", synthesizer: "Synthesizer" };
const state = {
    handshake: undefined,
    workspaces: { workspaces: [], defaultWorkspaceId: undefined },
    goals: [],
    selectedGoalId: undefined,
    conversationCache: new Map(),
    pollTimer: undefined,
    roster: undefined,
};

function $(id) {
    return document.getElementById(id);
}

function show(el) {
    el.classList.remove("hidden");
}

function hide(el) {
    el.classList.add("hidden");
}

function setChip(el, text, kind) {
    el.textContent = text;
    el.className = `chip chip-${kind}`;
}

function statusChipKind(status) {
    if (status === "completed")
        return "ok";
    if (status === "failed" || status === "cancelled")
        return "error";
    return "pending";
}

function switchView(name) {
    for (const view of document.querySelectorAll(".view"))
        hide(view);
    show($(`view-${name}`));
    for (const button of document.querySelectorAll(".nav-btn"))
        button.classList.remove("active");
    if (name === "home" || name === "conversation") {
        $("nav-home").classList.add("active");
    }
    else {
        $("nav-control").classList.add("active");
    }
}

/* ---------------- Home ---------------- */

function renderWorkspaces() {
    const select = $("workspace-select");
    select.textContent = "";
    const list = state.workspaces.workspaces ?? [];
    if (!list.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "no workspace registered — add one in Control Center";
        select.append(option);
        return;
    }
    for (const workspace of list) {
        const option = document.createElement("option");
        option.value = workspace.id;
        option.textContent = `${workspace.path}${workspace.id === state.workspaces.defaultWorkspaceId ? "  (default)" : ""}`;
        if (workspace.id === state.workspaces.defaultWorkspaceId)
            option.selected = true;
        select.append(option);
    }
}

function renderGoals() {
    const list = $("goals-list");
    list.textContent = "";
    const goals = [...state.goals].reverse();
    hide($("goals-empty"));
    if (!goals.length)
        show($("goals-empty"));
    for (const goal of goals) {
        const item = document.createElement("li");
        item.className = "goal-item";
        const chip = document.createElement("span");
        setChip(chip, goal.status, statusChipKind(goal.status));
        const title = document.createElement("button");
        title.type = "button";
        title.className = "goal-link";
        title.textContent = goal.textPreview || "(empty)";
        title.addEventListener("click", () => openConversation(goal.id));
        const when = document.createElement("time");
        when.className = "goal-when";
        when.textContent = String(goal.updatedAt ?? "").replace("T", " ").slice(0, 19);
        item.append(chip, title, when);
        list.append(item);
    }
}

async function refreshGoals() {
    try {
        const result = await window.sovereignbot.goals.list();
        state.goals = result?.goals ?? [];
        renderGoals();
    }
    catch {
        // Transient IPC hiccups must not blank the UI; next tick retries.
    }
}

async function submitGoal(event) {
    event.preventDefault();
    const errorEl = $("goal-error");
    hide(errorEl);
    const text = $("goal-input").value.trim();
    if (!text) {
        errorEl.textContent = "Describe what you want done first.";
        show(errorEl);
        return;
    }
    const workspaceId = $("workspace-select").value || undefined;
    try {
        $("goal-submit").disabled = true;
        const goal = await window.sovereignbot.goals.submit({ text, workspaceId });
        $("goal-input").value = "";
        await refreshGoals();
        openConversation(goal.id);
    }
    catch (error) {
        errorEl.textContent = String(error?.message ?? error).replace(/^.*Error: /, "");
        show(errorEl);
    }
    finally {
        $("goal-submit").disabled = false;
    }
}

/* ---------------- Providers / roster ---------------- */

function renderRoster(roster) {
    state.roster = roster;
    const rolesEl = $("roster-roles");
    rolesEl.textContent = "";
    for (const [role, label] of Object.entries(ROLE_LABELS)) {
        const item = document.createElement("li");
        const name = document.createElement("strong");
        name.textContent = label;
        const detail = document.createElement("span");
        const agent = (roster.agents ?? []).find((candidate) => candidate.id === roster.roles?.[role]);
        if (agent) {
            detail.textContent = ` ${agent.name} (${agent.capabilities.join(", ")})`;
            item.className = "provider provider-ok";
        }
        else {
            detail.textContent = " not assigned";
            item.className = "provider provider-missing";
        }
        item.append(name, detail);
        rolesEl.append(item);
    }

    const ready = Boolean(roster.ready);
    $("demo-banner").classList.toggle("hidden", roster.mode !== "demo");
    $("goal-gate-hint").classList.toggle("hidden", ready || roster.mode === "demo");
    $("goal-submit").disabled = !ready && roster.mode !== "demo";
}

async function refreshProviders() {
    try {
        renderRoster(await window.sovereignbot.providers.getRoster());
    }
    catch {
        // Smoke mode or channel hiccup: leave the last known roster on screen.
    }
}

function providerActionFeedback(text, isError = false) {
    const el = $("provider-action-result");
    el.textContent = text;
    el.classList.toggle("form-error", isError);
}

/* ---------------- Conversation ---------------- */

async function openConversation(goalId) {
    state.selectedGoalId = goalId;
    switchView("conversation");
    await refreshConversation();
}

function renderMessage(message) {
    const item = document.createElement("li");
    item.className = `message message-${message.role} message-${message.kind}`;
    if (message.kind === "status")
        item.classList.add("muted");
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = `${message.role} · ${message.kind} · ${String(message.at).replace("T", " ").slice(0, 19)}`;
    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = message.text;
    item.append(meta, body);
    return item;
}

async function refreshConversation() {
    const goalId = state.selectedGoalId;
    if (!goalId)
        return;
    let goal;
    let conversation;
    try {
        [goal, conversation] = await Promise.all([
            window.sovereignbot.goals.getStatus({ goalId }),
            window.sovereignbot.goals.getConversation({ goalId }),
        ]);
    }
    catch {
        return;
    }
    if (state.selectedGoalId !== goalId)
        return;

    setChip($("conversation-status"), goal.status, statusChipKind(goal.status));
    $("conversation-demo-badge").classList.toggle("hidden", goal.mode !== "demo");
    $("conversation-workspace").textContent = goal.workspacePath ?? "";
    const terminal = TERMINAL_STATUSES.includes(goal.status);
    if (terminal)
        hide($("cancel-goal"));
    else
        show($("cancel-goal"));

    const messagesEl = $("conversation-messages");
    const signature = JSON.stringify(conversation.messages);
    if (state.conversationCache.get(goalId) !== signature) {
        state.conversationCache.set(goalId, signature);
        messagesEl.textContent = "";
        for (const message of conversation.messages)
            messagesEl.append(renderMessage(message));
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    clearTimeout(state.pollTimer);
    if (!terminal && !$("view-conversation").classList.contains("hidden")) {
        state.pollTimer = setTimeout(refreshConversation, 1000);
    }
}

async function cancelSelectedGoal() {
    if (!state.selectedGoalId)
        return;
    $("cancel-goal").disabled = true;
    try {
        await window.sovereignbot.goals.cancel({ goalId: state.selectedGoalId });
    }
    finally {
        $("cancel-goal").disabled = false;
        await refreshConversation();
        await refreshGoals();
    }
}

/* ---------------- Control Center ---------------- */

function renderSettings(settings) {
    $("setting-theme").value = settings.theme ?? "system";
    document.body.dataset.theme = settings.theme ?? "system";
    $("setting-close").value = settings.closeBehavior ?? "ask";
    $("setting-notifications").checked = settings.notifications !== false;
    $("setting-demo-mode").checked = settings.demoMode === true;
    $("provider-codex-enabled").checked = settings.providers?.codex?.enabled !== false;
    $("provider-claude-enabled").checked = settings.providers?.claude?.enabled !== false;
}

function renderRoleOptions(roster) {
    const agentIds = (roster.agents ?? []).map((agent) => ({ id: agent.id, name: agent.name }));
    for (const role of Object.keys(ROLE_LABELS)) {
        const select = $(`role-${role}`);
        select.textContent = "";
        const auto = document.createElement("option");
        auto.value = "";
        auto.textContent = "Automatic";
        select.append(auto);
        for (const agent of agentIds) {
            const option = document.createElement("option");
            option.value = agent.id;
            option.textContent = agent.name;
            select.append(option);
        }
        select.value = roster.roles?.[role] ?? "";
        if (select.value && !agentIds.some((agent) => agent.id === select.value))
            select.value = "";
    }
}

function renderProviderList(el, providers) {
    el.textContent = "";
    for (const [key, provider] of Object.entries(providers ?? {})) {
        const item = document.createElement("li");
        const name = document.createElement("strong");
        name.textContent = key;
        const detail = document.createElement("span");
        if (provider.found) {
            detail.textContent = ` found · ${provider.version ?? "version unknown"} · auth: ${provider.auth?.state ?? "unknown"}`;
            item.className = "provider provider-ok";
        }
        else {
            detail.textContent = ` not found${provider.reason ? ` (${provider.reason})` : ""}`;
            item.className = "provider provider-missing";
        }
        item.append(name, detail);
        el.append(item);
    }
    if (!el.children.length) {
        const empty = document.createElement("li");
        empty.className = "note";
        empty.textContent = "Nothing detected yet.";
        el.append(empty);
    }
}

async function refreshControlCenter() {
    try {
        const [settings, workspaces, firstRun] = await Promise.all([
            window.sovereignbot.settings.get(),
            window.sovereignbot.workspaces.list(),
            window.sovereignbot.firstRun.getStatus().catch(() => undefined),
        ]);
        renderSettings(settings);
        state.workspaces = workspaces;
        renderWorkspaces();
    }
    catch {
        // Channel not bound (e.g. smoke mode): leave defaults on screen.
        return;
    }

    const manager = $("workspace-manager-list");
    manager.textContent = "";
    for (const workspace of workspaces.workspaces ?? []) {
        const item = document.createElement("li");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "default-workspace";
        radio.checked = workspace.id === workspaces.defaultWorkspaceId;
        radio.title = "Make default workspace";
        radio.addEventListener("change", async () => {
            await window.sovereignbot.workspaces.setDefault({ id: workspace.id });
            await refreshControlCenter();
        });
        const path = document.createElement("code");
        path.textContent = workspace.path;
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "danger-btn small";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", async () => {
            await window.sovereignbot.workspaces.remove({ id: workspace.id });
            await refreshControlCenter();
        });
        item.append(radio, path, removeBtn);
        manager.append(item);
    }
    if (!(workspaces.workspaces ?? []).length) {
        const empty = document.createElement("li");
        empty.className = "note";
        empty.textContent = "No workspaces registered. Add a folder to enable goal runs.";
        manager.append(empty);
    }

    if (firstRun) {
        renderProviderList($("providers-list"), firstRun.providers);
        if (firstRun.roster)
            renderRoleOptions(firstRun.roster);

        const browsersEl = $("browsers-list");
        browsersEl.textContent = "";
        for (const browser of firstRun.browsers ?? []) {
            const item = document.createElement("li");
            item.className = "provider provider-ok";
            const name = document.createElement("strong");
            name.textContent = browser.browser;
            const detail = document.createElement("span");
            detail.textContent = ` ${browser.version}`;
            item.append(name, detail);
            browsersEl.append(item);
        }
        if (!$("browsers-list").children.length) {
            const empty = document.createElement("li");
            empty.className = "note";
            empty.textContent = "No Chrome-family browser detected on this machine.";
            browsersEl.append(empty);
        }
    }
}

async function provisionDriver() {
    const resultEl = $("driver-result");
    resultEl.textContent = "Downloading…";
    try {
        const result = await window.sovereignbot.computer.provisionDriver({});
        resultEl.textContent = `Installed chromedriver ${result.driverVersion}${result.digestVerified ? " (vendor digest verified)" : " (digest unavailable — recorded unverified)"}`;
    }
    catch (error) {
        resultEl.textContent = `Failed: ${String(error?.message ?? error).replace(/^.*Error: /, "")}`;
    }
}

/* ---------------- Activity drawer ---------------- */

async function refreshActivity() {
    try {
        const overview = await window.sovereignbot.operator.getOverview();
        const agents = (overview.agents ?? []).map((agent) =>
            `${agent.id} [${agent.role}] ${agent.status ?? ""} caps:${(agent.capabilities ?? []).join(",")}`);
        const computers = (overview.computers ?? []).map((computer) => `${computer.agentId}: ${computer.status ?? ""}`);
        const tasks = overview.tasks ?? [];
        const counts = {};
        for (const task of tasks)
            counts[task.status] = (counts[task.status] ?? 0) + 1;
        $("overview-block").textContent =
            `agents:\n${agents.join("\n") || "-"}\n\ncomputers:\n${computers.join("\n") || "-"}\n\ntasks (${tasks.length}): ${JSON.stringify(counts)}`;

        const audit = await window.sovereignbot.operator.getAudit({ limit: 12 });
        $("audit-block").textContent = (audit.entries ?? [])
            .map((entry) => `${entry.at ?? ""} ${entry.type} ${entry.subject ?? ""}`)
            .reverse()
            .join("\n") || "(no audit entries)";
    }
    catch {
        $("overview-block").textContent = "overview unavailable";
        $("audit-block").textContent = "";
    }
}

/* ---------------- Bootstrap ---------------- */

function bindStaticEvents() {
    $("nav-home").addEventListener("click", () => {
        switchView("home");
        refreshGoals();
    });
    $("nav-control").addEventListener("click", () => {
        switchView("control");
        refreshControlCenter();
    });
    $("toggle-drawer").addEventListener("click", () => {
        const drawer = $("activity-drawer");
        drawer.classList.toggle("hidden");
        if (!drawer.classList.contains("hidden"))
            refreshActivity();
    });
    $("close-drawer").addEventListener("click", () => hide($("activity-drawer")));
    $("goal-form").addEventListener("submit", submitGoal);
    $("back-to-home").addEventListener("click", () => {
        clearTimeout(state.pollTimer);
        switchView("home");
        refreshGoals();
    });
    $("cancel-goal").addEventListener("click", cancelSelectedGoal);
    $("setting-theme").addEventListener("change", saveSetting("theme", (value) => value));
    $("setting-close").addEventListener("change", saveSetting("closeBehavior", (value) => value));
    $("setting-notifications").addEventListener("change", saveSetting("notifications", (_, el) => el.checked));
    $("setting-demo-mode").addEventListener("change", async (event) => {
        try {
            const updated = await window.sovereignbot.settings.update({ demoMode: event.target.checked });
            renderSettings(updated);
            await applyProviderRefresh(await window.sovereignbot.providers.refresh());
        }
        catch (error) {
            console.error("demo mode rejected:", error);
        }
    });
    for (const provider of ["codex", "claude"]) {
        $(`provider-${provider}-enabled`).addEventListener("change", async (event) => {
            try {
                const updated = await window.sovereignbot.settings.update({
                    providers: { [provider]: { enabled: event.target.checked } },
                });
                renderSettings(updated);
                await applyProviderRefresh(await window.sovereignbot.providers.refresh());
            }
            catch (error) {
                console.error("provider toggle rejected:", error);
            }
        });
    }
    for (const role of Object.keys(ROLE_LABELS)) {
        $(`role-${role}`).addEventListener("change", async (event) => {
            const agentId = event.target.value;
            try {
                if (!agentId) {
                    await window.sovereignbot.settings.update({ roles: { [role]: null } });
                }
                else {
                    await window.sovereignbot.providers.setRoleAssignment({ role, agentId });
                }
                await applyProviderRefresh(await window.sovereignbot.providers.refresh());
            }
            catch (error) {
                providerActionFeedback(String(error?.message ?? error).replace(/^.*Error: /, ""), true);
            }
        });
    }
    $("refresh-providers").addEventListener("click", async () => {
        providerActionFeedback("Refreshing…");
        try {
            const result = await window.sovereignbot.providers.refresh();
            await applyProviderRefresh(result);
            providerActionFeedback(result.applied
                ? "Provider roster updated."
                : result.reason === "active-work"
                    ? "Changes apply after current work finishes."
                    : "No roster change detected.");
        }
        catch (error) {
            providerActionFeedback(String(error?.message ?? error).replace(/^.*Error: /, ""), true);
        }
    });
    for (const [buttonId, provider] of [["open-login-codex", "codex"], ["open-login-claude", "claude"]]) {
        $(buttonId).addEventListener("click", async () => {
            providerActionFeedback(`Opening ${provider} sign-in window…`);
            try {
                const result = await window.sovereignbot.providers.openLogin({ provider });
                if (!result.login?.launched)
                    providerActionFeedback(result.login?.reason ?? "Sign-in could not be started.", true);
                else
                    providerActionFeedback("Complete the sign-in in the opened window; the roster refreshes automatically.");
                await applyProviderRefresh(result.refresh ?? {});
            }
            catch (error) {
                providerActionFeedback(String(error?.message ?? error).replace(/^.*Error: /, ""), true);
            }
        });
    }
    $("add-workspace").addEventListener("click", async () => {
        await window.sovereignbot.workspaces.addViaDialog({});
        await refreshControlCenter();
    });
    $("provision-driver").addEventListener("click", provisionDriver);
}

function saveSetting(key, pick) {
    return async (event) => {
        try {
            const updated = await window.sovereignbot.settings.update({ [key]: pick(event.target.value, event.target) });
            renderSettings(updated);
        }
        catch (error) {
            console.error("setting rejected:", error);
        }
    };
}

async function applyProviderRefresh(result) {
    if (result?.roster)
        renderRoster(result.roster);
    else
        await refreshProviders();
}

async function main() {
    bindStaticEvents();

    let handshake;
    try {
        handshake = await window.sovereignbot.handshake();
    }
    catch {
        setChip($("chip-version"), "desktop unavailable", "error");
        return;
    }
    if (!handshake?.ok) {
        setChip($("chip-version"), "runtime error", "error");
        return;
    }
    state.handshake = handshake;
    setChip($("chip-version"), `${handshake.version} · ${handshake.platform}`, "ok");

    await Promise.all([refreshGoals(), refreshControlCenter(), refreshProviders()]);
}

main();
