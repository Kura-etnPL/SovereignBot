"use strict";

/**
 * SovereignBot Flagship Color Palette & Theme Engine
 * Provides 8 bespoke designer color tones:
 * 1. Midnight OLED (深空极客黑)
 * 2. Manus Emerald (矩阵翠绿 / 自主智能体)
 * 3. Cyberpunk Neon (赛博极光 / 霓虹紫)
 * 4. Solar Amber (暖阳琥珀 / 曜金日落)
 * 5. Nordic Arctic (冰极冷雾 / 极地蓝)
 * 6. Sakura Rose (暮色绛粉 / 玫瑰薄雾)
 * 7. Warm Titanium (原色钛金 / 极简暖灰)
 * 8. Paper Studio (雅致白纸 / 日光浅色)
 */

(function (global) {
  const PALETTES = [
    {
      id: "midnight",
      nameZh: "深空极客黑",
      nameEn: "Midnight OLED",
      descZh: "Grok / Linear 纯黑极客沉浸风格，纯粹极致暗场与发光蓝",
      descEn: "Pure black OLED aesthetic with electric sapphire glow",
      brand: "#0a84ff",
      bg: "#000000",
      panel: "#111114",
      glow: "rgba(10, 132, 255, 0.4)"
    },
    {
      id: "emerald",
      nameZh: "矩阵翠绿",
      nameEn: "Manus Emerald",
      descZh: "Manus AI / 自主智能体风格，黑客松荧光翡翠绿与深曜石",
      descEn: "Agentic matrix obsidian with vibrant emerald glow",
      brand: "#10b981",
      bg: "#050a07",
      panel: "#0c1610",
      glow: "rgba(16, 185, 129, 0.4)"
    },
    {
      id: "cyberpunk",
      nameZh: "赛博极光",
      nameEn: "Cyberpunk Neon",
      descZh: "未来主义深紫星空与幻彩霓虹，张扬个性科技浪漫",
      descEn: "Cosmic deep violet with electric neon purple glow",
      brand: "#a855f7",
      bg: "#080612",
      panel: "#130d24",
      glow: "rgba(168, 85, 247, 0.42)"
    },
    {
      id: "amber",
      nameZh: "暖阳琥珀",
      nameEn: "Solar Amber",
      descZh: "曜金日落光辉与深玄岩石，奢华温润沉静",
      descEn: "Deep warm basalt with radiant solar amber luster",
      brand: "#f59e0b",
      bg: "#0c0906",
      panel: "#18130d",
      glow: "rgba(245, 158, 11, 0.4)"
    },
    {
      id: "arctic",
      nameZh: "冰极冷雾",
      nameEn: "Nordic Arctic",
      descZh: "北欧冰川蓝与冷雾灰度，冷静专注的极致理智",
      descEn: "Glacial cyan & cool slate for absolute focus",
      brand: "#0ea5e9",
      bg: "#060e17",
      panel: "#0d1929",
      glow: "rgba(14, 165, 233, 0.4)"
    },
    {
      id: "rose",
      nameZh: "暮色玫瑰",
      nameEn: "Sakura Rose",
      descZh: "暮色烟紫灰与电光绛粉，柔美而锐利的个性视觉",
      descEn: "Dusk smoke violet with electric magenta-rose glow",
      brand: "#f43f5e",
      bg: "#0e070c",
      panel: "#1a0f17",
      glow: "rgba(244, 63, 94, 0.4)"
    },
    {
      id: "titanium",
      nameZh: "原色钛金",
      nameEn: "Warm Titanium",
      descZh: "钛金属精密原色与暖调自然矿物黑，低调内敛工匠风",
      descEn: "Apple natural titanium with warm basalt mineral tone",
      brand: "#e2c99a",
      bg: "#111111",
      panel: "#1c1b19",
      glow: "rgba(226, 201, 154, 0.38)"
    },
    {
      id: "champagne",
      mode: "light",
      nameZh: "香槟珍珠",
      nameEn: "Champagne Pearl",
      descZh: "暖玉香槟金与象牙珍珠白，温润高级、告别冰冷素白",
      descEn: "Warm champagne alabaster & ivory pearl luster, cozy luxury",
      brand: "#d97706",
      bg: "#faf7f2",
      panel: "#ffffff",
      glow: "rgba(217, 119, 6, 0.35)"
    },
    {
      id: "aurora_light",
      mode: "light",
      nameZh: "极光云海",
      nameEn: "Lilac Aurora",
      descZh: "macOS 梦幻晨雾与幻彩薰衣草浅紫，空灵通透、科技浪漫",
      descEn: "Ethereal morning cloud & lilac lavender glow, airy tech aesthetic",
      brand: "#7c3aed",
      bg: "#f8f6fd",
      panel: "#ffffff",
      glow: "rgba(124, 58, 237, 0.32)"
    },
    {
      id: "mint_light",
      mode: "light",
      nameZh: "薄荷晨曦",
      nameEn: "Mint Dawn",
      descZh: "阿尔卑斯初露与翡翠青白，生机盎然、醒目护眼不寡淡",
      descEn: "Alpine morning dew with fresh jade emerald, revitalizing and clean",
      brand: "#059669",
      bg: "#f2f8f5",
      panel: "#ffffff",
      glow: "rgba(5, 150, 105, 0.32)"
    },
    {
      id: "paper",
      mode: "light",
      nameZh: "包豪斯群青",
      nameEn: "Bauhaus Studio",
      descZh: "克莱因宝蓝与高对比特种纸微光，雕塑质感与通透层次",
      descEn: "Sculptural Bauhaus studio with royal Klein sapphire, crisp & vivid",
      brand: "#2563eb",
      bg: "#f4f6fb",
      panel: "#ffffff",
      glow: "rgba(37, 99, 235, 0.35)"
    }
  ];

  const STORAGE_KEY = "sovereign_color_palette";
  let activePaletteId = localStorage.getItem(STORAGE_KEY) || "midnight";
  let modalDialog = null;
  let activeFilterTab = "all"; // "all" | "light" | "dark"

  const isZh = () => {
    if (globalThis.SovereignI18n && typeof globalThis.SovereignI18n.currentLocale === "function") {
      return globalThis.SovereignI18n.currentLocale().startsWith("zh");
    }
    const lang = localStorage.getItem("sovereign_lang") || navigator.language || "zh";
    return lang.toLowerCase().startsWith("zh");
  };

  const getPalette = (id) => PALETTES.find((p) => p.id === id) || PALETTES[0];

  function applyPalette(id, notify = false, persist = true) {
    const p = getPalette(id);
    activePaletteId = p.id;
    if (persist) localStorage.setItem(STORAGE_KEY, activePaletteId);
    document.body.dataset.palette = activePaletteId;

    if (p.mode === "light" || p.id === "paper" || p.id === "champagne" || p.id === "aurora_light" || p.id === "mint_light") {
      document.body.dataset.theme = "light";
    } else {
      document.body.dataset.theme = "dark";
    }

    const themeSelect = document.getElementById("setting-theme");
    if (themeSelect) {
      themeSelect.value = document.body.dataset.theme;
    }

    updateSidebarBadge();
    updateModalCards();
    updateSettingsChips();

    if (notify) {
      global.sovereignbot?.settings?.update({ theme: document.body.dataset.theme }).catch(error => {
        global.motionFx?.toast?.(String(error?.message ?? "Theme could not be saved"), "error");
      });
      global.motionFx?.playChime?.();
      const name = isZh() ? p.nameZh : p.nameEn;
      const msg = isZh() ? `已切换至【${name}】色调` : `Switched to [${name}] color palette`;
      global.motionFx?.toast?.(msg, "success");
    }
  }

  function syncTheme(theme = "system") {
    const mode = theme === "system" ? (global.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : theme;
    const preferred = getPalette(localStorage.getItem(STORAGE_KEY) || "midnight");
    const preferredMode = preferred.mode === "light" ? "light" : "dark";
    applyPalette(preferredMode === mode ? preferred.id : mode === "light" ? "paper" : "midnight", false, false);
    document.body.dataset.theme = theme;
    const select = document.getElementById("setting-theme");
    if (select) select.value = theme;
  }

  function updateSidebarBadge() {
    const p = getPalette(activePaletteId);
    const btn = document.getElementById("open-palette-picker");
    if (btn) {
      const labelSpan = btn.querySelector("span:not(.utility-icon):not(.palette-badge-pill):not(.palette-badge-name):not(.palette-swatch-dot)");
      if (labelSpan) labelSpan.textContent = isZh() ? "色调" : "Theme";
      btn.title = isZh() ? "选择系统色调与主题 (Color Themes)" : "Choose System Color Theme & Palette";
    }
    const pill = document.getElementById("sidebar-palette-pill");
    if (pill) {
      const nameEl = pill.querySelector(".palette-badge-name");
      const dot = pill.querySelector(".palette-swatch-dot");
      if (nameEl) nameEl.textContent = isZh() ? p.nameZh : p.nameEn;
      if (dot) dot.style.background = p.brand;
    }
  }

  function updateModalCards() {
    if (!modalDialog) return;
    const cards = modalDialog.querySelectorAll(".palette-card");
    cards.forEach((card) => {
      const id = card.dataset.paletteId;
      const p = getPalette(id);
      const isAct = id === activePaletteId;
      card.classList.toggle("active", isAct);
      const badge = card.querySelector(".palette-check-badge");
      if (badge) {
        badge.style.display = isAct ? "inline-flex" : "none";
        badge.textContent = isZh() ? "✓ 当前使用" : "✓ Active";
      }
      const titleEl = card.querySelector(".palette-card-title strong");
      if (titleEl) titleEl.textContent = isZh() ? p.nameZh : p.nameEn;
      const descEl = card.querySelector(".palette-card-desc");
      if (descEl) descEl.textContent = isZh() ? p.descZh : p.descEn;
    });

    const eyebrow = modalDialog.querySelector(".modal-title-group .eyebrow");
    if (eyebrow) eyebrow.textContent = isZh() ? "视觉与主题调色板" : "PALETTE & AESTHETICS";
    const h2 = modalDialog.querySelector(".modal-title-group h2");
    if (h2) h2.textContent = isZh() ? "选择工作区色调风格" : "Workspace Color Tone";
    const subtitle = modalDialog.querySelector(".modal-title-group .modal-subtitle");
    if (subtitle) subtitle.textContent = isZh() ? "内置 11 款旗舰级设计师微光色系，包含 4 款明亮雅致与 7 款深空沉浸风格" : "11 designer-crafted luminous color palettes for deep focus";
    const footerTip = modalDialog.querySelector(".modal-actions span");
    if (footerTip) footerTip.textContent = isZh() ? "💡 提示：输入 /theme 或按 Ctrl+K 即可随时快速调色" : "💡 Tip: Type /theme or press Ctrl+K to switch palettes anytime";
    const okBtn = modalDialog.querySelector("#palette-modal-ok");
    if (okBtn) okBtn.textContent = isZh() ? "完成" : "Done";

    // Update filter tabs
    const tabAll = modalDialog.querySelector(`.palette-filter-tab[data-filter="all"]`);
    if (tabAll) tabAll.textContent = isZh() ? "全部 (11)" : "All (11)";
    const tabLight = modalDialog.querySelector(`.palette-filter-tab[data-filter="light"]`);
    if (tabLight) tabLight.textContent = isZh() ? "🌓 浅色雅致 (4款 · 告别素白)" : "🌓 Light (4)";
    const tabDark = modalDialog.querySelector(`.palette-filter-tab[data-filter="dark"]`);
    if (tabDark) tabDark.textContent = isZh() ? "🌙 深空沉浸 (7款)" : "🌙 Dark (7)";
  }

  function applyFilter(filter) {
    activeFilterTab = filter;
    if (!modalDialog) return;
    const tabs = modalDialog.querySelectorAll(".palette-filter-tab");
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.filter === filter));

    const cards = modalDialog.querySelectorAll(".palette-card");
    cards.forEach((card) => {
      const p = getPalette(card.dataset.paletteId);
      const isMatch = filter === "all" || p.mode === filter;
      card.style.display = isMatch ? "flex" : "none";
    });
  }

  function updateSettingsChips() {
    const container = document.getElementById("settings-palette-chips");
    if (!container) return;
    const chips = container.querySelectorAll(".settings-palette-chip");
    chips.forEach((chip) => {
      const id = chip.dataset.paletteId;
      const p = getPalette(id);
      chip.classList.toggle("active", id === activePaletteId);
      const textSpan = chip.querySelector("span:not(.settings-palette-chip-dot)");
      if (textSpan) textSpan.textContent = isZh() ? p.nameZh : p.nameEn;
    });

    const titleWrap = document.querySelector(".settings-palette-title");
    if (titleWrap) {
      const titleSpan = titleWrap.querySelector("span");
      if (titleSpan) titleSpan.textContent = isZh() ? "色调预设" : "Color Palette Presets";
      const browseBtn = titleWrap.querySelector("#settings-open-palette-modal");
      if (browseBtn) browseBtn.textContent = isZh() ? "浏览全部 11 款 ↗" : "Browse all 11 ↗";
    }
  }

  // Create Palette Modal
  function ensurePaletteModal() {
    if (modalDialog) return modalDialog;

    modalDialog = document.createElement("dialog");
    modalDialog.id = "palette-picker-dialog";
    modalDialog.className = "modal palette-dialog";

    const card = document.createElement("div");
    card.className = "modal-card";

    const header = document.createElement("div");
    header.className = "modal-header";
    header.innerHTML = `
      <div class="modal-title-group">
        <span class="eyebrow">${isZh() ? "视觉与主题调色板" : "PALETTE & AESTHETICS"}</span>
        <h2>${isZh() ? "选择工作区色调风格" : "Workspace Color Tone"}</h2>
        <p class="modal-subtitle">${isZh() ? "内置 11 款旗舰级设计师微光色系，包含 4 款明亮雅致与 7 款深空沉浸风格" : "11 designer tuned tones tailored for deep focus"}</p>
      </div>
      <button type="button" class="modal-close" id="palette-modal-close" aria-label="Close">✕</button>
    `;

    const filterBar = document.createElement("div");
    filterBar.className = "palette-filter-bar";
    filterBar.innerHTML = `
      <button type="button" class="palette-filter-tab ${activeFilterTab === "all" ? "active" : ""}" data-filter="all">${isZh() ? "全部 (11)" : "All (11)"}</button>
      <button type="button" class="palette-filter-tab ${activeFilterTab === "light" ? "active" : ""}" data-filter="light">${isZh() ? "🌓 浅色雅致 (4款 · 告别素白)" : "🌓 Light (4)"}</button>
      <button type="button" class="palette-filter-tab ${activeFilterTab === "dark" ? "active" : ""}" data-filter="dark">${isZh() ? "🌙 深空沉浸 (7款)" : "🌙 Dark (7)"}</button>
    `;
    filterBar.addEventListener("click", (e) => {
      const tab = e.target.closest(".palette-filter-tab");
      if (tab) {
        applyFilter(tab.dataset.filter);
      }
    });

    const grid = document.createElement("div");
    grid.className = "palette-grid";

    PALETTES.forEach((p) => {
      const cardEl = document.createElement("div");
      cardEl.className = "palette-card";
      cardEl.dataset.paletteId = p.id;
      cardEl.dataset.mode = p.mode;
      cardEl.style.setProperty("--card-brand", p.brand);
      cardEl.style.setProperty("--card-glow", p.glow);

      const title = isZh() ? p.nameZh : p.nameEn;
      const desc = isZh() ? p.descZh : p.descEn;
      const modeTag = p.mode === "light" ? (isZh() ? "明亮浅色" : "Light") : (isZh() ? "深空暗场" : "Dark");

      cardEl.innerHTML = `
        <div class="palette-card-header">
          <div class="palette-card-title">
            <span style="width:10px;height:10px;border-radius:50%;background:${p.brand};box-shadow:0 0 8px ${p.brand};"></span>
            <strong>${title}</strong>
            <span class="palette-mode-badge ${p.mode}">${modeTag}</span>
          </div>
          <span class="palette-check-badge" style="display:${p.id === activePaletteId ? "inline-flex" : "none"};">
            ✓ ${isZh() ? "当前使用" : "Active"}
          </span>
        </div>
        <p class="palette-card-desc">${desc}</p>
        <div class="palette-swatches">
          <span class="palette-swatch" style="background:${p.bg};" title="背景底色"></span>
          <span class="palette-swatch" style="background:${p.panel};" title="卡片面板"></span>
          <span class="palette-swatch" style="background:${p.brand};" title="高光重音"></span>
          <span class="palette-swatch" style="background:${p.glow};border:1px dashed ${p.brand};" title="发光光晕"></span>
        </div>
      `;

      cardEl.addEventListener("click", () => {
        applyPalette(p.id, true);
        setTimeout(() => {
          modalDialog.close();
        }, 160);
      });

      grid.appendChild(cardEl);
    });

    const footer = document.createElement("div");
    footer.className = "modal-actions";
    footer.innerHTML = `
      <span style="font-size:12px;color:var(--text-3);margin-right:auto;">${isZh() ? "💡 提示：输入 /theme 或按 Ctrl+K 即可随时快速调色" : "Tip: Type /theme or press Ctrl+K to change palette"}</span>
      <button type="button" class="quiet-action" id="palette-modal-ok">${isZh() ? "完成" : "Done"}</button>
    `;

    card.appendChild(header);
    card.appendChild(filterBar);
    card.appendChild(grid);
    card.appendChild(footer);
    modalDialog.appendChild(card);
    document.body.appendChild(modalDialog);

    // Event handlers
    const closeBtn = card.querySelector("#palette-modal-close");
    const okBtn = card.querySelector("#palette-modal-ok");
    const close = () => modalDialog.close();
    closeBtn?.addEventListener("click", close);
    okBtn?.addEventListener("click", close);
    modalDialog.addEventListener("click", (e) => {
      if (e.target === modalDialog) close();
    });

    return modalDialog;
  }

  function openPaletteModal() {
    const dialog = ensurePaletteModal();
    updateModalCards();
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }

  // Inject or bind color button in sidebar-bottom
  function injectSidebarButton() {
    const existingBtn = document.getElementById("open-palette-picker");
    if (existingBtn) {
      existingBtn.addEventListener("click", () => {
        global.motionFx?.playBubblePop?.();
        openPaletteModal();
      });
      updateSidebarBadge();
      return;
    }

    const sidebarBottom = document.querySelector(".sidebar-bottom");
    if (!sidebarBottom) return;

    const p = getPalette(activePaletteId);
    const btn = document.createElement("button");
    btn.id = "open-palette-picker";
    btn.className = "utility-nav";
    btn.type = "button";
    btn.title = "选择系统色调与主题 (Color Themes)";
    btn.innerHTML = `
      <span class="utility-icon">🎨</span>
      <span>${isZh() ? "色调" : "Theme"}</span>
      <span id="sidebar-palette-pill" class="palette-badge-pill">
        <span class="palette-swatch-dot" style="background:${p.brand};"></span>
        <span class="palette-badge-name">${isZh() ? p.nameZh : p.nameEn}</span>
      </span>
    `;

    btn.addEventListener("click", () => {
      global.motionFx?.playBubblePop?.();
      openPaletteModal();
    });

    // Insert before Settings button
    const settingsBtn = document.getElementById("nav-settings");
    if (settingsBtn) {
      sidebarBottom.insertBefore(btn, settingsBtn);
    } else {
      sidebarBottom.appendChild(btn);
    }
  }

  // Inject palette chips into Settings view
  function injectSettingsPaletteView() {
    const settingsCard = document.querySelector("#view-settings .settings-card:has(#setting-theme)");
    if (!settingsCard || document.getElementById("settings-palette-chips")) return;

    const container = document.createElement("div");
    container.className = "settings-palette-container";
    container.innerHTML = `
      <div class="settings-palette-title">
        <span>${isZh() ? "色调预设" : "Color Palette Presets"}</span>
        <button type="button" class="quiet-action" id="settings-open-palette-modal" style="font-size:11.5px;padding:2px 8px;">${isZh() ? "浏览全部 11 款 ↗" : "Browse all 11 ↗"}</button>
      </div>
      <div id="settings-palette-chips" class="settings-palette-chips"></div>
    `;

    const chipsWrap = container.querySelector("#settings-palette-chips");
    PALETTES.forEach((p) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `settings-palette-chip ${p.id === activePaletteId ? "active" : ""}`;
      chip.dataset.paletteId = p.id;
      chip.style.setProperty("--chip-brand", p.brand);
      chip.style.setProperty("--chip-glow", p.glow);
      chip.innerHTML = `
        <span class="settings-palette-chip-dot"></span>
        <span>${isZh() ? p.nameZh : p.nameEn}</span>
      `;
      chip.addEventListener("click", () => {
        applyPalette(p.id, true);
      });
      chipsWrap.appendChild(chip);
    });

    container.querySelector("#settings-open-palette-modal")?.addEventListener("click", () => {
      openPaletteModal();
    });

    settingsCard.appendChild(container);
  }

  // Initialize
  function init() {
    applyPalette(activePaletteId, false);
    global.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (document.body.dataset.theme === "system") syncTheme("system");
    });
    injectSidebarButton();
    injectSettingsPaletteView();

    // Re-render UI labels and badges whenever user changes language
    document.addEventListener("sovereignbot:locale-changed", () => {
      updateSidebarBadge();
      updateModalCards();
      updateSettingsChips();
    });

    // Recheck occasionally or on view change
    const navSettings = document.getElementById("nav-settings");
    navSettings?.addEventListener("click", () => {
      setTimeout(injectSettingsPaletteView, 50);
    });
  }

  // Export API
  global.SovereignPalette = {
    PALETTES,
    get: () => getPalette(activePaletteId),
    getAll: () => PALETTES,
    syncTheme,
    set: (id, notify = true) => applyPalette(id, notify),
    openModal: openPaletteModal
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(typeof window !== "undefined" ? window : globalThis);
