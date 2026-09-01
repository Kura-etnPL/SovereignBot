"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  let nodes = [];
  let controllers = [];
  let pollTimer;

  function zh() { return document.documentElement.lang === "zh-CN"; }
  function label(en, cn) { return zh() ? cn : en; }
  function text(value) { return String(value ?? ""); }

  function render() {
    const root = $("worker-node-list");
    if (!root) return;
    root.textContent = "";
    if (!nodes.length) {
      const empty = document.createElement("p"); empty.className = "setting-feedback";
      empty.textContent = label("No paired Worker Nodes yet.", "尚未配对工作节点。"); root.append(empty); return;
    }
    for (const node of nodes) {
      const card = document.createElement("article"); card.className = "worker-node-card";
      const head = document.createElement("div"); head.className = "worker-node-card-head";
      const title = document.createElement("strong"); title.textContent = `${node.name} · ${node.nodeId}`;
      const status = document.createElement("span"); status.className = `worker-node-status ${node.status}`; status.textContent = node.status;
      head.append(title, status);
      const meta = document.createElement("div"); meta.className = "worker-node-meta";
      for (const value of [
        `${label("Protocol", "协议")}: ${node.protocol}`,
        `${label("OS", "系统")}: ${node.platform}/${node.arch}`,
        `${label("Registry", "注册表")}: ${label("Advanced worker registry", "高级工作节点注册表")}`,
        `${label("Last seen", "最后在线")}: ${node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : "—"}`,
        `${label("Enabled", "已启用")}: ${node.enabled ? label("yes", "是") : label("no", "否")}`,
      ]) { const span = document.createElement("span"); span.textContent = value; meta.append(span); }
     const caps = document.createElement("div"); caps.className = "worker-node-meta"; caps.textContent = `${label("Capabilities", "能力")}: ${(node.capabilities ?? []).join(", ") || "—"}`;
      const computer = document.createElement("div"); computer.className = "worker-node-meta"; const target = node.computer ?? {}; computer.textContent = `${label("Computer", "工作电脑")}: ${target.name ?? "—"} · ${target.state ?? "offline"} · ${target.currentLoad ?? 0}/${target.capacity ?? 0} · ${(target.capabilities ?? []).join(", ") || "—"}`;
      const trust = node.trust ?? { status: "unpaired", transport: "loopback" };
      const trustMeta = document.createElement("div"); trustMeta.className = "worker-node-meta"; trustMeta.textContent = `${label("Trust", "信任")}: ${trust.status} · ${trust.transport}${trust.keyEpoch ? ` · epoch ${trust.keyEpoch}` : ""}${trust.expiresAt ? ` · ${new Date(trust.expiresAt).toLocaleString()}` : ""}`;
      const list = document.createElement("ul"); list.className = "worker-node-workspaces";
      for (const workspace of node.workspaces ?? []) { const item = document.createElement("li"); item.textContent = `${workspace.name} (${workspace.id})`; list.append(item); }
      const actions = document.createElement("div"); actions.className = "worker-node-actions";
      const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "quiet-action"; refresh.textContent = label("Refresh", "刷新"); refresh.addEventListener("click", async () => { refresh.disabled = true; try { await window.sovereignbot.workerNodes.refresh({ nodeId: node.nodeId }); await load(); } finally { refresh.disabled = false; } });
      const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "quiet-action"; toggle.textContent = node.enabled ? label("Disable", "停用") : label("Enable", "启用"); toggle.addEventListener("click", async () => { toggle.disabled = true; try { await window.sovereignbot.workerNodes.setEnabled({ nodeId: node.nodeId, enabled: !node.enabled }); await load(); } finally { toggle.disabled = false; } });
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "quiet-action"; remove.textContent = label("Remove", "移除"); remove.addEventListener("click", async () => { remove.disabled = true; try { await window.sovereignbot.workerNodes.remove({ nodeId: node.nodeId }); await load(); } finally { remove.disabled = false; } });
      const pair = document.createElement("button"); pair.type = "button"; pair.className = "quiet-action"; pair.textContent = label("Secure pair", "安全配对"); pair.addEventListener("click", async () => { pair.disabled = true; try { const outcome = await window.sovereignbot.workerNodes.trustBegin({ nodeId: node.nodeId, transport: "lan" }); const result = $("worker-node-result"); if (result) result.textContent = label(`One-time pairing code: ${outcome?.offer?.code ?? "—"}`, `一次性配对码：${outcome?.offer?.code ?? "—"}`); await load(); } catch (error) { const result = $("worker-node-result"); if (result) result.textContent = text(error?.message ?? error).slice(0, 400); } finally { pair.disabled = false; } });
      const complete = document.createElement("button"); complete.type = "button"; complete.className = "quiet-action"; complete.textContent = label("Complete pair", "完成配对"); complete.disabled = trust.status !== "pending"; complete.addEventListener("click", async () => { complete.disabled = true; try { const outcome = await window.sovereignbot.workerNodes.trustCompleteViaDialog({ nodeId: node.nodeId }); const result = $("worker-node-result"); if (result) result.textContent = outcome?.paired ? label("Secure Worker paired.", "安全工作节点已配对。") : label("Pairing cancelled.", "已取消配对。"); await load(); } catch (error) { const result = $("worker-node-result"); if (result) result.textContent = text(error?.message ?? error).slice(0, 400); } finally { complete.disabled = false; } });
      const revoke = document.createElement("button"); revoke.type = "button"; revoke.className = "quiet-action"; revoke.textContent = label("Revoke trust", "撤销信任"); revoke.disabled = !["trusted", "rotating"].includes(trust.status); revoke.addEventListener("click", async () => { revoke.disabled = true; try { await window.sovereignbot.workerNodes.trustRevoke({ nodeId: node.nodeId }); await load(); } finally { revoke.disabled = false; } });
      const rotate = document.createElement("button"); rotate.type = "button"; rotate.className = "quiet-action"; rotate.textContent = label("Rotate key", "轮换密钥"); rotate.disabled = !["trusted", "rotating"].includes(trust.status); rotate.addEventListener("click", async () => { rotate.disabled = true; try { await window.sovereignbot.workerNodes.trustRotate({ nodeId: node.nodeId }); await load(); } finally { rotate.disabled = false; } });
      actions.append(refresh, toggle, pair, complete, revoke, rotate, remove);
      card.append(head, meta, caps, computer, trustMeta, list, actions);
      if (node.lastError) { const error = document.createElement("p"); error.className = "inline-error"; error.textContent = node.lastError; card.append(error); }
      root.append(card);
    }
  }

  function renderControllers() {
    const root = $("external-controller-list");
    if (!root) return;
    root.textContent = "";
    if (!controllers.length) {
      const empty = document.createElement("p"); empty.className = "setting-feedback";
      empty.textContent = label("No paired external controllers yet.", "尚未配对外部控制器。"); root.append(empty); return;
    }
    for (const controller of controllers) {
      const card = document.createElement("article"); card.className = "workspace-card";
      const title = document.createElement("h3"); title.textContent = `${text(controller.name)} · ${text(controller.deviceId)}`;
      const meta = document.createElement("p"); meta.textContent = `${label("Status", "状态")}: ${text(controller.status)} · ${label("Health", "健康")}: ${text(controller.health)} · ${label("Transport", "传输")}: ${text(controller.transport)} · ${label("Last seen", "最后在线")}: ${controller.lastSeenAt ? new Date(controller.lastSeenAt).toLocaleString() : "—"}`;
      const scopes = document.createElement("p"); scopes.textContent = `${label("Scopes", "范围")}: ${(controller.scopes ?? []).join(", ") || "—"}`;
      const bindings = document.createElement("p"); bindings.textContent = `${label("Teams", "团队")}: ${(controller.teamIds ?? []).join(", ") || "—"} · ${label("Projects", "项目")}: ${(controller.projectIds ?? []).join(", ") || "—"}`;
      const actions = document.createElement("div"); actions.className = "worker-node-actions";
      const revoke = document.createElement("button"); revoke.type = "button"; revoke.className = "quiet-action"; revoke.textContent = label("Revoke", "撤销"); revoke.disabled = !["active", "rotating"].includes(controller.status); revoke.addEventListener("click", async () => { revoke.disabled = true; try { await window.sovereignbot.externalControllers.revoke({ deviceId: controller.deviceId }); await load(); } finally { revoke.disabled = false; } });
      const rotate = document.createElement("button"); rotate.type = "button"; rotate.className = "quiet-action"; rotate.textContent = label("Rotate", "轮换"); rotate.disabled = !["active"].includes(controller.status); rotate.addEventListener("click", async () => { rotate.disabled = true; try { await window.sovereignbot.externalControllers.rotate({ deviceId: controller.deviceId }); await load(); } finally { rotate.disabled = false; } });
      actions.append(revoke, rotate); card.append(title, meta, scopes, bindings, actions); root.append(card);
    }
  }

  async function load() {
    try {
      const [nodeResult, controllerResult] = await Promise.all([window.sovereignbot.workerNodes.list({}), window.sovereignbot.externalControllers.list({})]);
      nodes = nodeResult.nodes ?? []; controllers = controllerResult.controllers ?? []; render(); renderControllers();
    } catch (error) { const root = $("worker-node-list"); if (root) root.textContent = text(error?.message ?? error).slice(0, 400); }
  }

  function show() {
    for (const view of document.querySelectorAll(".main-view")) view.classList.add("hidden");
    $("view-worker-nodes")?.classList.remove("hidden");
    $("view-external-controllers")?.classList.remove("hidden");
    for (const id of ["nav-work", "nav-attention", "nav-routines", "nav-triggers", "nav-settings", "nav-worker-nodes"]) $(id)?.classList.remove("active");
    $("nav-worker-nodes")?.classList.add("active");
    clearTimeout(pollTimer);
    const poll = () => load().finally(() => { if (!$("view-worker-nodes")?.classList.contains("hidden")) pollTimer = setTimeout(poll, 10_000); });
    void load(); pollTimer = setTimeout(poll, 10_000);
  }

  function bind() {
    $("nav-worker-nodes")?.addEventListener("click", show);
    $("worker-node-refresh")?.addEventListener("click", () => { void window.sovereignbot.workerNodes.refresh({}).then(load); });
    $("external-controller-refresh")?.addEventListener("click", () => { void load(); });
    $("worker-node-pair")?.addEventListener("click", async () => {
      const result = $("worker-node-result"); if (result) result.textContent = label("Choose a pairing bundle…", "请选择配对文件…");
      try { const outcome = await window.sovereignbot.workerNodes.pairViaDialog({}); if (result) result.textContent = outcome?.paired ? label("Worker Node paired.", "工作节点已配对。") : label("Pairing cancelled.", "已取消配对。"); await load(); }
      catch (error) { if (result) result.textContent = text(error?.message ?? error).slice(0, 400); }
    });
    new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  }

  globalThis.SovereignWorkerNodesUI = { load, render, show };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind); else bind();
})();
