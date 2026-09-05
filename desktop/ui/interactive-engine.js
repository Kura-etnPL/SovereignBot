"use strict";

/**
 * SovereignBot Advanced Interactive Engine (Grok / Manus AI / OpenBot tier)
 * Features:
 * 1. Slash Command System (`/` in composer):
 *    - /code, /computer, /chief, /team, /research, /routine, /skills, /artifacts, /shortcuts, /clear
 * 2. Welcome Matrix & Active Conversation Quick Action Chips
 * 3. Drag & Drop File Upload Overlay onto Conversation
 * 4. Message Actions: ✏️ Edit & Reprompt, ↻ Regenerate / Resend, 📋 Copy Markdown, 💬 Quote Reply
 * 5. Split-Screen Dual Pane Toggle (Manus AI split screen between Chat & Computer/Details)
 * 6. Keyboard Shortcuts Cheat Sheet HUD Modal (Triggered via '?' or Cmd+/ or /shortcuts)
 */

(function (global) {
  const isZh = () => {
    if (globalThis.SovereignI18n && typeof globalThis.SovereignI18n.currentLocale === "function") {
      return globalThis.SovereignI18n.currentLocale().startsWith("zh");
    }
    const lang = localStorage.getItem("sovereign_lang") || navigator.language || "zh";
    return lang.toLowerCase().startsWith("zh");
  };

  const t = (k, p) => globalThis.SovereignI18n?.t(k, p) || k;
  const chime = () => globalThis.motionFx?.playChime?.();
  const bubble = () => globalThis.motionFx?.playBubblePop?.();
  const toast = (msg, type) => globalThis.motionFx?.toast?.(msg, type);

  // Slash commands provider (dynamic localization)
  function getSlashCommands() {
    return [
      {
        id: "code",
        trigger: "/code",
        icon: "🚀",
        title: "/code",
        desc: t("slash.code.desc"),
        tag: isZh() ? "动作" : "Action",
        execute: () => insertPrompt(t("slash.code.prompt"))
      },
      {
        id: "computer",
        trigger: "/computer",
        icon: "🖥️",
        title: "/computer",
        desc: t("slash.computer.desc"),
        tag: isZh() ? "视图" : "View",
        execute: () => toggleSplitScreen()
      },
      {
        id: "chief",
        trigger: "/chief",
        icon: "👔",
        title: "/chief",
        desc: t("slash.chief.desc"),
        tag: isZh() ? "智能体" : "Agent",
        execute: () => {
          const chiefBtn = document.getElementById("welcome-open-chief");
          if (chiefBtn) chiefBtn.click();
          else {
            const firstCoworker = document.querySelector(".sidebar-item.coworker-item, .nav-item");
            if (firstCoworker) firstCoworker.click();
          }
          toast(t("feedback.switchedChief"), "success");
        }
      },
      {
        id: "team",
        trigger: "/team",
        icon: "👥",
        title: "/team",
        desc: t("slash.team.desc"),
        tag: isZh() ? "团队" : "Team",
        execute: () => {
          const teamBtn = document.getElementById("welcome-install-software-team");
          if (teamBtn) teamBtn.click();
          else {
            const teamNav = document.querySelector('[data-view="view-team-packs"], [data-view="team-packs"]');
            if (teamNav) teamNav.click();
          }
        }
      },
      {
        id: "research",
        trigger: "/research",
        icon: "🔍",
        title: "/research",
        desc: t("slash.research.desc"),
        tag: isZh() ? "调研" : "Research",
        execute: () => insertPrompt(t("slash.research.prompt"))
      },
      {
        id: "routine",
        trigger: "/routine",
        icon: "⚡",
        title: "/routine",
        desc: t("slash.routine.desc"),
        tag: isZh() ? "流水线" : "Workflow",
        execute: () => {
          const dialog = document.getElementById("routine-run-dialog");
          if (dialog?.showModal) dialog.showModal();
          else toast(isZh() ? "例行任务选择器" : "Routine Selector", "normal");
        }
      },
      {
        id: "skills",
        trigger: "/skills",
        icon: "🧠",
        title: "/skills",
        desc: t("slash.skills.desc"),
        tag: isZh() ? "技能库" : "Library",
        execute: () => {
          const skillBtn = document.querySelector('[data-view="view-skills"], [data-view="skills"]');
          if (skillBtn) skillBtn.click();
        }
      },
      {
        id: "artifacts",
        trigger: "/artifacts",
        icon: "📁",
        title: "/artifacts",
        desc: t("slash.artifacts.desc"),
        tag: isZh() ? "产物" : "Files",
        execute: () => {
          const artifactBtn = document.querySelector('[data-view="view-artifacts"], [data-view="artifacts"]');
          if (artifactBtn) artifactBtn.click();
        }
      },
      {
        id: "theme",
        trigger: "/theme",
        icon: "🎨",
        title: "/theme",
        desc: t("slash.theme.desc"),
        tag: isZh() ? "外观" : "Appearance",
        execute: () => {
          globalThis.SovereignPalette?.openModal?.();
        }
      },
      {
        id: "shortcuts",
        trigger: "/shortcuts",
        icon: "⌨️",
        title: "/shortcuts",
        desc: t("slash.shortcuts.desc"),
        tag: isZh() ? "帮助" : "Help",
        execute: () => openKeyboardHud()
      },
      {
        id: "clear",
        trigger: "/clear",
        icon: "✕",
        title: "/clear",
        desc: t("slash.clear.desc"),
        tag: isZh() ? "输入" : "Input",
        execute: () => {
          const area = document.getElementById("composer-input");
          if (area) {
            area.value = "";
            area.dispatchEvent(new Event("input", { bubbles: true }));
            toast(t("feedback.composerCleared"), "normal");
          }
        }
      }
    ];
  }

  // Helper: insert prompt into composer and focus
  function insertPrompt(text, shouldSubmit = false) {
    const area = document.getElementById("composer-input");
    if (!area) return;
    area.value = text;
    area.dispatchEvent(new Event("input", { bubbles: true }));
    area.focus();
    if (shouldSubmit) {
      setTimeout(() => {
        const sendBtn = document.getElementById("composer-send");
        if (sendBtn && !sendBtn.disabled) sendBtn.click();
      }, 100);
    }
  }

  // 1. Setup Slash Command Menu
  let slashMenuEl = null;
  let selectedIndex = 0;
  let matchingCommands = [];

  function ensureSlashMenu() {
    if (slashMenuEl) return slashMenuEl;
    const composerBox = document.querySelector(".composer-box");
    if (!composerBox) return null;

    slashMenuEl = document.createElement("div");
    slashMenuEl.id = "slash-command-menu";
    slashMenuEl.className = "slash-command-menu hidden";
    composerBox.parentElement.insertBefore(slashMenuEl, composerBox);
    return slashMenuEl;
  }

  function renderSlashMenu(filterQuery = "") {
    const menu = ensureSlashMenu();
    if (!menu) return;

    const commands = getSlashCommands();
    const query = filterQuery.toLowerCase().trim();
    matchingCommands = commands.filter((cmd) => {
      if (!query) return true;
      return cmd.trigger.toLowerCase().includes(query) || cmd.id.toLowerCase().includes(query) || cmd.desc.toLowerCase().includes(query);
    });

    if (matchingCommands.length === 0) {
      menu.classList.add("hidden");
      return;
    }

    menu.textContent = "";
    selectedIndex = Math.min(selectedIndex, matchingCommands.length - 1);
    if (selectedIndex < 0) selectedIndex = 0;

    matchingCommands.forEach((cmd, idx) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `slash-item ${idx === selectedIndex ? "selected" : ""}`;
      item.innerHTML = `
        <span class="slash-item-icon">${cmd.icon}</span>
        <div class="slash-item-content">
          <span class="slash-item-title">${cmd.title}</span>
          <span class="slash-item-desc">${cmd.desc}</span>
        </div>
        <span class="slash-item-tag">${cmd.tag}</span>
      `;

      item.addEventListener("click", () => {
        executeSlashCommand(cmd);
      });

      menu.appendChild(item);
    });

    menu.classList.remove("hidden");
  }

  function executeSlashCommand(cmd) {
    chime();
    const menu = ensureSlashMenu();
    if (menu) menu.classList.add("hidden");

    const area = document.getElementById("composer-input");
    if (area) {
      // Clear slash query
      area.value = "";
      area.dispatchEvent(new Event("input", { bubbles: true }));
    }

    cmd.execute();
  }

  function initSlashCommands() {
    const area = document.getElementById("composer-input");
    if (!area) return;

    area.addEventListener("input", () => {
      const val = area.value;
      if (val.startsWith("/")) {
        renderSlashMenu(val.slice(1));
      } else {
        const menu = ensureSlashMenu();
        if (menu) menu.classList.add("hidden");
      }
    });

    area.addEventListener("keydown", (e) => {
      const menu = ensureSlashMenu();
      if (!menu || menu.classList.contains("hidden") || matchingCommands.length === 0) {
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        selectedIndex = (selectedIndex + 1) % matchingCommands.length;
        renderSlashMenu(area.value.slice(1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selectedIndex = (selectedIndex - 1 + matchingCommands.length) % matchingCommands.length;
        renderSlashMenu(area.value.slice(1));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (matchingCommands[selectedIndex]) {
          executeSlashCommand(matchingCommands[selectedIndex]);
        }
      } else if (e.key === "Escape") {
        menu.classList.add("hidden");
      }
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".composer-shell")) {
        const menu = ensureSlashMenu();
        if (menu) menu.classList.add("hidden");
      }
    });
  }

  // 2. Quick Prompts Bar above Composer
  function getQuickPrompts() {
    return [
      { label: t("quickPrompts.conclude"), prompt: t("quickPrompts.concludePrompt") },
      { label: t("quickPrompts.code"), prompt: t("quickPrompts.codePrompt") },
      { label: t("quickPrompts.review"), prompt: t("quickPrompts.reviewPrompt") },
      { label: t("quickPrompts.breakdown"), prompt: t("quickPrompts.breakdownPrompt") },
      { label: t("quickPrompts.export"), prompt: t("quickPrompts.exportPrompt") }
    ];
  }

  function initQuickPromptsBar() {
    const composerForm = document.getElementById("composer-form");
    if (!composerForm) return;

    let bar = document.getElementById("quick-prompts-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "quick-prompts-bar";
      bar.className = "quick-prompts-bar";
      composerForm.prepend(bar);
    }

    bar.textContent = "";
    getQuickPrompts().forEach((item) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "quick-prompt-chip";
      chip.textContent = item.label;
      chip.addEventListener("click", () => {
        bubble();
        insertPrompt(item.prompt, false);
      });
      bar.appendChild(chip);
    });
  }

  // 3. Welcome Screen Interactive Prompt Matrix (Grok / Manus Style)
  function getWelcomePromptCards() {
    return [
      {
        icon: "🚀",
        title: t("welcomePrompts.fullstack.title"),
        desc: t("welcomePrompts.fullstack.desc"),
        prompt: t("welcomePrompts.fullstack.prompt")
      },
      {
        icon: "🔍",
        title: t("welcomePrompts.research.title"),
        desc: t("welcomePrompts.research.desc"),
        prompt: t("welcomePrompts.research.prompt")
      },
      {
        icon: "🖥️",
        title: t("welcomePrompts.computer.title"),
        desc: t("welcomePrompts.computer.desc"),
        action: () => toggleSplitScreen()
      },
      {
        icon: "👥",
        title: t("welcomePrompts.team.title"),
        desc: t("welcomePrompts.team.desc"),
        action: () => {
          const btn = document.getElementById("welcome-install-software-team");
          if (btn) btn.click();
        }
      }
    ];
  }

  function renderWelcomePromptsMatrix() {
    const welcomeCard = document.querySelector(".welcome-card");
    if (!welcomeCard) return;

    let matrix = document.getElementById("welcome-prompts-matrix");
    if (!matrix) {
      matrix = document.createElement("div");
      matrix.id = "welcome-prompts-matrix";
      matrix.className = "welcome-prompts-matrix";
      const actions = welcomeCard.querySelector(".welcome-actions");
      if (actions) {
        welcomeCard.insertBefore(matrix, actions);
      } else {
        welcomeCard.appendChild(matrix);
      }
    }

    matrix.textContent = "";
    getWelcomePromptCards().forEach((card) => {
      const cardEl = document.createElement("div");
      cardEl.className = "welcome-prompt-card";
      cardEl.innerHTML = `
        <div class="welcome-prompt-header">
          <span class="welcome-prompt-icon">${card.icon}</span>
          <span>${card.title}</span>
        </div>
        <div class="welcome-prompt-desc">${card.desc}</div>
      `;

      cardEl.addEventListener("click", () => {
        chime();
        if (card.action) {
          card.action();
        } else if (card.prompt) {
          // Switch to chief or conversation first
          const chiefBtn = document.getElementById("welcome-open-chief");
          if (chiefBtn) {
            chiefBtn.click();
            setTimeout(() => insertPrompt(card.prompt, true), 300);
          } else {
            insertPrompt(card.prompt, false);
          }
        }
      });

      matrix.appendChild(cardEl);
    });
  }

  function initWelcomePromptsMatrix() {
    renderWelcomePromptsMatrix();
    const orb = document.getElementById("welcome-orb");
    if (orb && window.SovereignBotRobotEngine) {
      window.SovereignBotRobotEngine.renderRobotHead(orb, {
        name: "Chief of Staff",
        role: "AI Workspace Commander",
        id: "chief_commander"
      }, { size: "xl" });
    }
  }

  // 4. Drag & Drop File Upload Overlay
  function initDragAndDrop() {
    let overlay = document.getElementById("drag-drop-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "drag-drop-overlay";
      overlay.className = "drag-drop-overlay hidden";
      overlay.innerHTML = `
        <div class="drag-drop-modal">
          <div class="drag-drop-icon">✦</div>
          <h3>${isZh() ? "释放文件以添加为工作区附件" : "Drop files to attach to workspace"}</h3>
          <p>${isZh() ? "支持将代码、文档、图片安全链接至当前智能体上下文" : "Securely attach code, documents, and images to agent context"}</p>
        </div>
      `;
      document.body.appendChild(overlay);
    }

    let dragCounter = 0;

    window.addEventListener("dragenter", (e) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        dragCounter++;
        overlay.classList.remove("hidden");
      }
    });

    window.addEventListener("dragleave", () => {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        overlay.classList.add("hidden");
      }
    });

    window.addEventListener("dragover", (e) => {
      e.preventDefault();
    });

    window.addEventListener("drop", (e) => {
      e.preventDefault();
      dragCounter = 0;
      overlay.classList.add("hidden");

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        chime();
        toast(isZh() ? `已捕获 ${files.length} 个文件，正在安全加入上下文…` : `Captured ${files.length} file(s), safely adding to context…`, "success");
        // Trigger composer-add or attach via API
        const addBtn = document.getElementById("composer-add");
        if (addBtn) addBtn.click();
      }
    });
  }

  // 5. Dual Pane Mode (Split Screen)
  function syncSplitScreenState() {
    const splitBtn = document.getElementById("toggle-split-screen");
    const detailsPanel = document.getElementById("details-panel");
    if (!splitBtn || !detailsPanel) return;
    const isVisible = !detailsPanel.classList.contains("hidden");
    splitBtn.classList.toggle("active", isVisible);
  }

  function toggleSplitScreen() {
    const splitBtn = document.getElementById("toggle-split-screen");
    const detailsPanel = document.getElementById("details-panel");
    if (!detailsPanel) return;

    const isVisible = !detailsPanel.classList.contains("hidden");

    if (isVisible) {
      detailsPanel.classList.add("hidden");
      splitBtn?.classList.remove("active");
      toast(isZh() ? "已关闭双栏工作台" : "Dual-pane workspace closed", "normal");
    } else {
      detailsPanel.classList.remove("hidden");
      splitBtn?.classList.add("active");
      chime();
      if (window.sovereignbotUi?.state?.selectedConversation && typeof window.sovereignbotUi?.renderDetails === "function") {
        window.sovereignbotUi.renderDetails(window.sovereignbotUi.state.selectedConversation, true);
      }
      toast(isZh() ? "已开启双栏实时工作台" : "Dual-pane workspace enabled", "success");
    }
  }

  function updateSplitScreenButton() {
    const btn = document.getElementById("toggle-split-screen");
    if (!btn) return;
    btn.title = t("nav.split.title");
    btn.setAttribute("aria-label", t("nav.split.title"));
    const label = btn.querySelector(".split-label");
    if (label) label.textContent = t("nav.split");
    syncSplitScreenState();
  }

  function initSplitScreenButton() {
    const actions = document.querySelector(".conversation-actions");
    if (!actions || document.getElementById("toggle-split-screen")) return;

    const btn = document.createElement("button");
    btn.id = "toggle-split-screen";
    btn.className = "quiet-action split-screen-btn";
    btn.type = "button";
    btn.title = t("nav.split.title");
    btn.setAttribute("aria-label", t("nav.split.title"));
    btn.innerHTML = `<span class="split-icon">◫</span> <span class="split-label">${t("nav.split")}</span>`;

    btn.addEventListener("click", () => {
      toggleSplitScreen();
    });

    const detailsBtn = document.getElementById("open-details");
    if (detailsBtn) {
      actions.insertBefore(btn, detailsBtn);
      detailsBtn.addEventListener("click", () => {
        setTimeout(syncSplitScreenState, 50);
      });
    } else {
      actions.appendChild(btn);
    }

    const closeDetailsBtn = document.getElementById("close-details");
    if (closeDetailsBtn) {
      closeDetailsBtn.addEventListener("click", () => {
        setTimeout(syncSplitScreenState, 50);
      });
    }

    syncSplitScreenState();
  }

  // 6. Keyboard Shortcuts Cheat Sheet HUD Modal
  function renderKeyboardHudContent(dialog) {
    if (!dialog) return;
    const card = dialog.querySelector(".modal-card");
    if (!card) return;

    const rows = [
      { label: t("hud.newChat"), keys: "<kbd>⌘</kbd><kbd>N</kbd> / <kbd>Ctrl</kbd><kbd>N</kbd>" },
      { label: t("hud.search"), keys: "<kbd>⌘</kbd><kbd>K</kbd> / <kbd>Ctrl</kbd><kbd>K</kbd>" },
      { label: t("hud.slash"), keys: "<kbd>/</kbd>" },
      { label: t("hud.mention"), keys: "<kbd>@</kbd>" },
      { label: t("hud.send"), keys: "<kbd>Enter</kbd>" },
      { label: t("hud.newline"), keys: "<kbd>Shift</kbd><kbd>Enter</kbd>" },
      { label: t("hud.split"), keys: "<kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>C</kbd>" },
      { label: t("hud.sidebar"), keys: "<kbd>⌘</kbd><kbd>B</kbd> / <kbd>Ctrl</kbd><kbd>B</kbd>" },
      { label: t("hud.settings"), keys: "<kbd>⌘</kbd><kbd>,</kbd> / <kbd>Ctrl</kbd><kbd>,</kbd>" },
      { label: t("hud.esc"), keys: "<kbd>Esc</kbd>" },
      { label: t("hud.hud"), keys: "<kbd>?</kbd> / <kbd>Ctrl</kbd><kbd>/</kbd>" }
    ];

    const gridHtml = rows.map((r) => `
      <div class="keyboard-hud-row">
        <span>${r.label}</span>
        <span class="keyboard-hud-keys">${r.keys}</span>
      </div>
    `).join("");

    card.innerHTML = `
      <div class="modal-heading">
        <div>
          <span class="eyebrow">${t("hud.eyebrow")}</span>
          <h2>${t("hud.title")}</h2>
          <p class="modal-subtitle" style="font-size:12px;color:var(--text-3);margin-top:2px;">${t("hud.subtitle")}</p>
        </div>
        <button class="modal-x" type="button">×</button>
      </div>
      <div class="keyboard-hud-grid">
        ${gridHtml}
      </div>
      <div class="modal-actions">
        <button class="hero-action modal-close-btn" type="button">${t("hud.done")}</button>
      </div>
    `;

    const closeBtn = card.querySelector(".modal-x");
    const heroBtn = card.querySelector(".modal-close-btn");
    const close = () => dialog.close();
    closeBtn?.addEventListener("click", close);
    heroBtn?.addEventListener("click", close);
  }

  function ensureKeyboardHud() {
    let dialog = document.getElementById("keyboard-hud-dialog");
    if (dialog) return dialog;

    dialog = document.createElement("dialog");
    dialog.id = "keyboard-hud-dialog";
    dialog.className = "modal keyboard-hud-modal";
    const card = document.createElement("div");
    card.className = "modal-card";
    dialog.appendChild(card);
    document.body.appendChild(dialog);

    renderKeyboardHudContent(dialog);

    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });

    return dialog;
  }

  function openKeyboardHud() {
    const dialog = ensureKeyboardHud();
    if (dialog?.showModal) {
      chime();
      dialog.showModal();
    }
  }

  function updateMessageActionLabels() {
    document.querySelectorAll(".message-action-edit").forEach((btn) => {
      btn.textContent = t("msgAction.edit");
      btn.title = t("msgAction.editTitle");
    });
    document.querySelectorAll(".message-action-regenerate").forEach((btn) => {
      btn.textContent = t("msgAction.regenerate");
      btn.title = t("msgAction.regenerateTitle");
    });
  }

  // 7. Message Interaction Superpowers (Edit, Regenerate, Quote)
  function enhanceMessageRow(row) {
    if (!row || row.dataset.interactiveEnhanced === "true") return;
    row.dataset.interactiveEnhanced = "true";

    const actions = row.querySelector(".message-actions");
    if (!actions) return;

    const isUser = row.classList.contains("user");

    if (isUser) {
      // Add "Edit & Reprompt" button
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "message-action message-action-edit";
      editBtn.textContent = t("msgAction.edit");
      editBtn.title = t("msgAction.editTitle");
      editBtn.addEventListener("click", () => {
        bubble();
        const text = row.querySelector(".chat-text")?.textContent || "";
        const area = document.getElementById("composer-input");
        if (area) {
          area.value = text;
          area.dispatchEvent(new Event("input", { bubbles: true }));
          area.focus();
          row.classList.add("editing-pulse");
          setTimeout(() => row.classList.remove("editing-pulse"), 2400);
          toast(t("msgAction.editLoadedToast"), "normal");
        }
      });
      actions.prepend(editBtn);
    } else if (!actions.querySelector(".message-action-regenerate")) {
      // Reuse the base renderer's action when available.
      const regenBtn = document.createElement("button");
      regenBtn.type = "button";
      regenBtn.className = "message-action message-action-regenerate";
      regenBtn.textContent = t("msgAction.regenerate");
      regenBtn.title = t("msgAction.regenerateTitle");
      regenBtn.addEventListener("click", () => {
        chime();
        toast(isZh() ? "正在请求重新生成…" : "Requesting regeneration…", "normal");
        const redirectBtn = document.getElementById("conversation-redirect");
        if (redirectBtn && !redirectBtn.classList.contains("hidden")) {
          redirectBtn.click();
        } else {
          // Send a subtle follow-up asking to refine
          const regenPrompt = isZh() ? "请重新梳理并完善上一次的回复，注意更深入细致。" : "Please re-evaluate and refine the previous response with greater detail and depth.";
          insertPrompt(regenPrompt, true);
        }
      });
      actions.insertBefore(regenBtn, actions.firstChild);
    }
  }

  // Observe conversation message list to inject interactive action buttons seamlessly
  function initMessageObserver() {
    const list = document.getElementById("conversation-messages");
    if (!list) return;

    // Initial pass
    list.querySelectorAll(".chat-row").forEach(enhanceMessageRow);

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList?.contains("chat-row")) {
              enhanceMessageRow(node);
            } else {
              node.querySelectorAll?.(".chat-row").forEach(enhanceMessageRow);
            }
          }
        }
      }
    });

    observer.observe(list, { childList: true, subtree: true });
  }

  // Global Keyboard Shortcuts Dispatcher
  function initGlobalKeybindings() {
    document.addEventListener("keydown", (e) => {
      const isInput = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);

      // 1. Ctrl+N / Cmd+N -> New Conversation
      if ((e.ctrlKey || e.metaKey) && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        const newBtn = document.getElementById("new-conversation-button");
        if (newBtn) {
          newBtn.click();
          chime();
          setTimeout(() => {
            const composer = document.getElementById("composer-input");
            if (composer) composer.focus();
          }, 80);
        }
        return;
      }

      // 2. Ctrl+, / Cmd+, -> Settings
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        const settingsBtn = document.getElementById("nav-settings");
        if (settingsBtn) {
          settingsBtn.click();
          chime();
        }
        return;
      }

      // 3. Ctrl+B / Cmd+B -> Toggle Sidebar Collapse
      if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        const sidebar = document.querySelector(".sidebar");
        if (sidebar) {
          sidebar.classList.toggle("collapsed");
          bubble();
        }
        return;
      }

      // 4. Esc -> Close open dialogs or HUD
      if (e.key === "Escape") {
        const hud = document.getElementById("shortcuts-hud-dialog");
        if (hud?.open) {
          hud.close();
          return;
        }
        const paletteModal = document.getElementById("palette-picker-dialog");
        if (paletteModal?.open) {
          paletteModal.close();
          return;
        }
      }

      // 5. Open Keyboard HUD on '?' or Ctrl+/ when not typing in inputs
      if (
        e.key === "?" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !isInput
      ) {
        e.preventDefault();
        openKeyboardHud();
      } else if (
        (e.ctrlKey || e.metaKey) &&
        e.key === "/" &&
        !isInput
      ) {
        e.preventDefault();
        openKeyboardHud();
      }
    });
  }

  // 8. Flagship Sidebar Buttons & Roster Interactive Upgrade
  function initSidebarInteractions() {
    // 8.1. New Conversation Button
    const newChatBtn = document.getElementById("new-conversation-button");
    if (newChatBtn) {
      const kbd = newChatBtn.querySelector(".new-conversation-kbd");
      if (kbd) {
        const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
        kbd.textContent = isMac ? "⌘N" : "Ctrl+N";
      }
      newChatBtn.addEventListener("click", () => {
        chime();
      });
    }

    // 8.2. Section Header Actions
    const refreshBtn = document.getElementById("refresh-coworkers");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        chime();
        refreshBtn.classList.remove("spinning");
        void refreshBtn.offsetWidth; // trigger reflow
        refreshBtn.classList.add("spinning");
        setTimeout(() => refreshBtn.classList.remove("spinning"), 650);
        toast(isZh() ? "已刷新全部常驻同事与协作通道" : "Refreshed all coworkers and collaboration channels", "normal");
      });
    }

    const newCoworkerBtn = document.getElementById("new-coworker");
    if (newCoworkerBtn) {
      newCoworkerBtn.addEventListener("click", () => bubble());
    }

    const newTeamBtn = document.getElementById("new-team");
    if (newTeamBtn) {
      newTeamBtn.addEventListener("click", () => bubble());
    }

    const newProjectBtn = document.getElementById("new-project");
    if (newProjectBtn) {
      newProjectBtn.addEventListener("click", () => bubble());
    }

    // 8.3. Sound feedback on all nav-items in coworker, team, project, recent lists
    const navLists = document.querySelectorAll("#coworker-list, #team-list, #sidebar-project-list, #conversation-list");
    navLists.forEach((list) => {
      list.addEventListener("click", (e) => {
        const item = e.target.closest(".nav-item");
        if (item) {
          bubble();
        }
      });
    });

    // 8.4. Bottom Utility Navigation buttons
    const utilityBtns = document.querySelectorAll(".sidebar-bottom .utility-nav");
    utilityBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        bubble();
        if (btn.id !== "open-palette-picker") {
          utilityBtns.forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
        }
      });
    });

    // Clear bottom active highlight when a conversation is opened
    document.addEventListener("click", (e) => {
      if (e.target.closest(".nav-item") || e.target.closest("#new-conversation-button")) {
        utilityBtns.forEach((b) => b.classList.remove("active"));
      }
    });

    // 8.5. Coworker Search bar
    const searchInput = document.getElementById("coworker-search");
    if (searchInput) {
      searchInput.addEventListener("focus", () => bubble());
    }
  }

  // 9. Flagship Button Physics & Modal Feedback
  function initModalAndButtonInteractions() {
    // 9.1. Dialogs entrance & exit sound & backdrop dismiss
    document.querySelectorAll("dialog").forEach((dlg) => {
      dlg.addEventListener("cancel", () => bubble());
      dlg.addEventListener("close", () => bubble());
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg && typeof dlg.close === "function") {
          dlg.close();
          bubble();
        }
      });
    });

    // 9.2. Form submit buttons chime & loading pulse
    document.querySelectorAll("form").forEach((form) => {
      form.addEventListener("submit", () => {
        const submitBtn = form.querySelector('button[type="submit"], .hero-action');
        if (submitBtn && !submitBtn.disabled) {
          chime();
          submitBtn.classList.add("btn-loading");
          setTimeout(() => submitBtn.classList.remove("btn-loading"), 800);
        }
      });
    });

    // 9.3. Composer send button interaction
    const sendBtn = document.getElementById("composer-send");
    if (sendBtn) {
      sendBtn.addEventListener("click", () => {
        const input = document.getElementById("composer-input");
        if (input && input.value.trim()) {
          chime();
          sendBtn.classList.add("sending-pulse");
          setTimeout(() => sendBtn.classList.remove("sending-pulse"), 400);
        }
      });
    }

    // 9.4. Quiet action & Ghost buttons click feedback
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".quiet-action, .modal-x, .composer-tool, .ghost-icon");
      if (btn) {
        bubble();
      }
    });
  }

  // Engine Lifecycle Bootstrap
  function init() {
    initSlashCommands();
    initQuickPromptsBar();
    initWelcomePromptsMatrix();
    // Desktop attachments are selected through the governed file picker.
    initSplitScreenButton();
    initMessageObserver();
    initGlobalKeybindings();
    initSidebarInteractions();
    initModalAndButtonInteractions();

    document.addEventListener("sovereignbot:locale-changed", () => {
      initQuickPromptsBar();
      renderWelcomePromptsMatrix();
      updateSplitScreenButton();
      const hudDialog = document.getElementById("keyboard-hud-dialog");
      if (hudDialog) renderKeyboardHudContent(hudDialog);
      updateMessageActionLabels();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    setTimeout(init, 60);
  }

  global.interactiveEngine = {
    openKeyboardHud,
    toggleSplitScreen,
    insertPrompt,
    getSlashCommands,
    get SLASH_COMMANDS() {
      return getSlashCommands();
    }
  };
})(window);
