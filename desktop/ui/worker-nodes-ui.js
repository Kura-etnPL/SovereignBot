"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  let nodes = [];
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
        `${label("Endpoint", "端点")}: ${node.endpoint}`,
        `${label("Last seen", "最后在线")}: ${node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : "—"}`,
        `${label("Enabled", "已启用")}: ${node.enabled ? label("yes", "是") : label("no", "否")}`,
      ]) { const span = document.createElement("span"); span.textContent = value; meta.append(span); }
      const caps = document.createElement("div"); caps.className = "worker-node-meta"; caps.textContent = `${label("Capabilities", "能力")}: ${(node.capabilities ?? []).join(", ") || "—"}`;
      const list = document.createElement("ul"); list.className = "worker-node-workspaces";
      for (const workspace of node.workspaces ?? []) { const item = document.createElement("li"); item.textContent = `${workspace.name} (${workspace.id})`; list.append(item); }
      const actions = document.createElement("div"); actions.className = "worker-node-actions";
      const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "quiet-action"; refresh.textContent = label("Refresh", "刷新"); refresh.addEventListener("click", async () => { refresh.disabled = true; try { await window.sovereignbot.workerNodes.refresh({ nodeId: node.nodeId }); await load(); } finally { refresh.disabled = false; } });
      const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "quiet-action"; toggle.textContent = node.enabled ? label("Disable", "停用") : label("Enable", "启用"); toggle.addEventListener("click", async () => { toggle.disabled = true; try { await window.sovereignbot.workerNodes.setEnabled({ nodeId: node.nodeId, enabled: !node.enabled }); await load(); } finally { toggle.disabled = false; } });
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "quiet-action"; remove.textContent = label("Remove", "移除"); remove.addEventListener("click", async () => { remove.disabled = true; try { await window.sovereignbot.workerNodes.remove({ nodeId: node.nodeId }); await load(); } finally { remove.disabled = false; } });
      actions.append(refresh, toggle, remove);
      card.append(head, meta, caps, list, actions);
      if (node.lastError) { const error = document.createElement("p"); error.className = "inline-error"; error.textContent = node.lastError; card.append(error); }
      root.append(card);
    }
  }

  async function load() {
    try { nodes = (await window.sovereignbot.workerNodes.list({})).nodes ?? []; render(); } catch (error) { const root = $("worker-node-list"); if (root) root.textContent = text(error?.message ?? error).slice(0, 400); }
  }

  function show() {
    for (const view of document.querySelectorAll(".main-view")) view.classList.add("hidden");
    $("view-worker-nodes")?.classList.remove("hidden");
    for (const id of ["nav-work", "nav-attention", "nav-routines", "nav-triggers", "nav-settings", "nav-worker-nodes"]) $(id)?.classList.remove("active");
    $("nav-worker-nodes")?.classList.add("active");
    clearTimeout(pollTimer);
    const poll = () => load().finally(() => { if (!$("view-worker-nodes")?.classList.contains("hidden")) pollTimer = setTimeout(poll, 10_000); });
    void load(); pollTimer = setTimeout(poll, 10_000);
  }

  function bind() {
    $("nav-worker-nodes")?.addEventListener("click", show);
    $("worker-node-refresh")?.addEventListener("click", () => { void window.sovereignbot.workerNodes.refresh({}).then(load); });
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
