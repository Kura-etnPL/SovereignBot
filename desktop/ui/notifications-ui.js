(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const t = (key, fallback) => globalThis.SovereignI18n?.t(key) ?? fallback ?? key;
  let currentVisibleIds = [];
  let pollTimer;
  let refreshGeneration = 0;

  const CATEGORY_LABELS = Object.freeze({
    "attention": "Attention / 需关注",
    "routine-completed": "Routine completed / 例行完成",
    "trigger-fired": "Trigger fired / 触发器执行",
    "coworker-finished": "Coworker finished / 同事完成",
    "channel-unread": "Channel unread / 频道未读",
  });

  const CATEGORY_ICONS = Object.freeze({
    "attention": "⚠",
    "routine-completed": "✓",
    "trigger-fired": "⚡",
    "coworker-finished": "✦",
    "channel-unread": "💬",
  });

  const NAV_TARGET_LABELS = Object.freeze({
    "attention": "View Attention / 查看需关注",
    "routines": "View Routines / 查看例行",
    "triggers": "View Triggers / 查看触发器",
    "work": "View Work / 查看工作",
    "artifacts": "View Files & Artifacts / 查看文件成果",
    "conversation": "Open Conversation / 打开会话",
  });

  function formatRelativeTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return '';
    const now = Date.now();
    const diffSec = Math.max(0, Math.floor((now - date.getTime()) / 1000));
    if (diffSec < 60) return "Just now / 刚刚";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return diffMin + "m ago / " + diffMin + "分钟前";
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return diffHours + "h ago / " + diffHours + "小时前";
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return diffDays + "d ago / " + diffDays + "天前";
    return date.toLocaleDateString();
  }

  function setStatus(text) {
    const el = $("notifications-status");
    if (el) el.textContent = text ? String(text).slice(0, 300) : "";
  }

  function setError(message) {
    const el = $("notifications-error");
    if (!el) return;
    el.textContent = message ? String(message).slice(0, 400) : "";
    el.classList.toggle("hidden", !message);
  }

  function updateBadge(unreadCount) {
    const badge = $("notifications-badge");
    if (!badge) return;
    if (typeof unreadCount === "number" && unreadCount > 0) {
      badge.textContent = String(unreadCount);
      badge.classList.remove("hidden");
    } else {
      badge.textContent = "0";
      badge.classList.add("hidden");
    }
  }

  async function refreshBadgeOnly() {
    if (!window.sovereignbot?.notifications?.list) return;
    try {
      const res = await window.sovereignbot.notifications.list({ limit: 1 });
      if (res && typeof res.unreadCount === "number") {
        updateBadge(res.unreadCount);
      }
    } catch {
      // Background badge refresh failure is benign
    }
  }

  function navigateToSource(source) {
    if (!source || typeof source !== "object") return;
    const target = source.target;
    if (target === "attention") {
      $("nav-attention")?.click();
    } else if (target === "routines") {
      const navRoutines = $("nav-routines");
      if (navRoutines) {
        navRoutines.click();
      } else {
        document.dispatchEvent(new CustomEvent("sovereignbot:navigate-routines"));
      }
    } else if (target === "work") {
      $("nav-work")?.click();
    } else if (target === "triggers") {
      $("nav-triggers")?.click();
    } else if (target === "artifacts") {
      $("nav-artifacts")?.click();
    } else if (target === "conversation" && source.conversationId) {
      const convId = String(source.conversationId).trim();
      if (convId) {
        document.dispatchEvent(new CustomEvent("sovereignbot:navigate-conversation", {
          detail: { conversationId: convId }
        }));
      }
    }
  }

  function renderNotificationCard(item) {
    const card = document.createElement("article");
    card.className = "settings-card notification-card" + (item.read ? " read" : " unread");
    card.setAttribute("role", "article");
    card.dataset.id = item.id;

    // Header
    const header = document.createElement("div");
    header.className = "notification-card-header";

    const badgeSpan = document.createElement("span");
    const catClass = "category-" + (item.category || "attention");
    badgeSpan.className = "notification-category-badge " + catClass;
    const iconSpan = document.createElement("span");
    iconSpan.textContent = CATEGORY_ICONS[item.category] || "•";
    badgeSpan.append(iconSpan);
    const labelSpan = document.createElement("span");
    labelSpan.textContent = CATEGORY_LABELS[item.category] || item.category;
    badgeSpan.append(labelSpan);
    header.append(badgeSpan);

    const metaRight = document.createElement("div");
    metaRight.className = "notification-meta-right";

    const readPill = document.createElement("span");
    readPill.className = "notification-read-pill " + (item.read ? "read" : "unread");
    readPill.textContent = item.read ? "Read / 已读" : "Unread / 未读";
    metaRight.append(readPill);

    const timeSpan = document.createElement("time");
    timeSpan.className = "notification-time";
    timeSpan.textContent = formatRelativeTime(item.createdAt);
    if (item.createdAt) timeSpan.title = String(item.createdAt);
    metaRight.append(timeSpan);

    header.append(metaRight);
    card.append(header);

    // Title (strict textContent, no innerHTML)
    const titleEl = document.createElement("h3");
    titleEl.className = "notification-card-title";
    titleEl.textContent = item.title || "";
    card.append(titleEl);

    // Body (strict textContent, no innerHTML)
    if (item.body) {
      const bodyEl = document.createElement("p");
      bodyEl.className = "notification-card-body";
      bodyEl.textContent = item.body;
      card.append(bodyEl);
    }

    // Actions
    const actionsRow = document.createElement("div");
    actionsRow.className = "notification-card-actions detail-actions";

    // Read/Unread toggle button
    const toggleReadBtn = document.createElement("button");
    toggleReadBtn.type = "button";
    toggleReadBtn.className = "quiet-action";
    toggleReadBtn.textContent = item.read ? "Mark unread / 标为未读" : "Mark read / 标为已读";
    toggleReadBtn.addEventListener("click", async () => {
      try {
        await window.sovereignbot.notifications.markRead({ id: item.id, read: !item.read });
        await refresh();
      } catch (err) {
        setError(err.message || String(err));
      }
    });
    actionsRow.append(toggleReadBtn);

    // Dismiss / clear button
    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "quiet-action";
    dismissBtn.textContent = "Dismiss / 清除";
    dismissBtn.addEventListener("click", async () => {
      try {
        await window.sovereignbot.notifications.clear({ id: item.id });
        await refresh();
      } catch (err) {
        setError(err.message || String(err));
      }
    });
    actionsRow.append(dismissBtn);

    // Safe Source Navigation Button
    if (item.source && item.source.target && NAV_TARGET_LABELS[item.source.target]) {
      let valid = true;
      if (item.source.target === "conversation" && !item.source.conversationId) valid = false;
      if (item.source.target === "routines" && !item.source.routineId) valid = false;
      if (item.source.target === "triggers" && !item.source.triggerId) valid = false;
      if (item.source.target === "work" && !item.source.jobId) valid = false;
      if (item.source.target === "artifacts" && !item.source.artifactId) valid = false;
      if (valid) {
        const navBtn = document.createElement("button");
        navBtn.type = "button";
        navBtn.className = "hero-action";
        navBtn.textContent = NAV_TARGET_LABELS[item.source.target];
        navBtn.addEventListener("click", () => navigateToSource(item.source));
        actionsRow.append(navBtn);
      }
    }

    card.append(actionsRow);
    return card;
  }

  async function refresh() {
    if (!window.sovereignbot?.notifications?.list) return;
    const generation = ++refreshGeneration;
    setError("");
    const listEl = $("notifications-list");
    const catSelect = $("notifications-category-filter");
    const readSelect = $("notifications-read-filter");
    const countSummary = $("notifications-count-summary");

    const category = catSelect?.value || "all";
    const readVal = readSelect?.value || "all";
    const params = { limit: 100 };
    if (category !== "all") params.category = category;
    if (readVal === "unread") params.read = false;
    else if (readVal === "read") params.read = true;

    try {
      setStatus("Loading notifications… / 正在加载通知…");
      const res = await window.sovereignbot.notifications.list(params);
      if (generation !== refreshGeneration) {
        return;
      }
      setStatus("");
      if (!res) return;

      updateBadge(res.unreadCount);

      if (countSummary) {
        countSummary.textContent = "Total: " + (res.totalCount ?? 0) + " · Unread: " + (res.unreadCount ?? 0) + " / 总计: " + (res.totalCount ?? 0) + " · 未读: " + (res.unreadCount ?? 0);
      }

      if (listEl) {
        listEl.textContent = "";
        const items = res.notifications || [];
        currentVisibleIds = items.map((item) => item.id);

        if (items.length === 0) {
          const emptyCard = document.createElement("div");
          emptyCard.className = "settings-card";
          const p = document.createElement("p");
          p.className = "detail-help";
          p.textContent = (category !== "all" || readVal !== "all")
            ? "No notifications match this filter / 没有符合条件的通知"
            : "No notifications yet / 暂无通知";
          emptyCard.append(p);
          listEl.append(emptyCard);
        } else {
          for (const item of items) {
            listEl.append(renderNotificationCard(item));
          }
        }
      }
    } catch (err) {
      if (generation !== refreshGeneration) return;
      setStatus("");
      setError(err.message || String(err));
    }
  }

  function showNotificationsView() {
    for (const view of document.querySelectorAll(".main-view")) {
      view.classList.add("hidden");
    }
    const target = $("view-notifications");
    if (target) target.classList.remove("hidden");

    for (const btn of document.querySelectorAll(".utility-nav, .nav-item")) {
      btn.classList.remove("active");
    }
    $("nav-notifications")?.classList.add("active");

    void refresh();
  }

  function bindEvents() {
    $("nav-notifications")?.addEventListener("click", showNotificationsView);
    $("notifications-refresh")?.addEventListener("click", () => void refresh());

    $("notifications-category-filter")?.addEventListener("change", () => void refresh());
    $("notifications-read-filter")?.addEventListener("change", () => void refresh());

    $("notifications-mark-all-read")?.addEventListener("click", async () => {
      if (currentVisibleIds.length === 0) return;
      try {
        await window.sovereignbot.notifications.markAllRead({ ids: currentVisibleIds });
        await refresh();
      } catch (err) {
        setError(err.message || String(err));
      }
    });

    $("notifications-clear-all")?.addEventListener("click", async () => {
      if (currentVisibleIds.length === 0) return;
      try {
        await window.sovereignbot.notifications.clearAll({ ids: currentVisibleIds });
        await refresh();
      } catch (err) {
        setError(err.message || String(err));
      }
    });

    window.sovereignbot?.onNavigate?.((target) => {
      if (target === "notifications") {
        showNotificationsView();
      }
    });

    // Start badge polling
    void refreshBadgeOnly();
    pollTimer = setInterval(refreshBadgeOnly, 10000);
    window.addEventListener("focus", refreshBadgeOnly);
    document.addEventListener("sovereignbot:refresh-notifications-badge", refreshBadgeOnly);
  }

  window.addEventListener("DOMContentLoaded", bindEvents);
})();
