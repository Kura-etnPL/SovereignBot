"use strict";

/**
 * SovereignBot Motion & Micro-Interactions Engine
 * Provides Grok / Manus AI grade ambient canvas, 3D gyroscopic tilt,
 * synthesized Web Audio chimes, code copy handlers, and reactive composer motion.
 */
(function (global) {
  // Web Audio Context for zero-latency micro-sounds
  let audioCtx = null;

  function getAudioContext() {
    if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
      try {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioCtor();
      } catch {}
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playBubblePop() {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(380, now);
      osc.frequency.exponentialRampToValueAtTime(740, now + 0.08);

      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.09);
    } catch {}
  }

  function playChime() {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(1046.5, now); // C6
      osc.frequency.exponentialRampToValueAtTime(1318.5, now + 0.12); // E6

      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.22);
    } catch {}
  }

  // Toast Notification System
  function toast(message, type = "normal", duration = 2400) {
    let container = document.getElementById("motion-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "motion-toast-container";
      container.className = "motion-toast-container";
      document.body.appendChild(container);
    }

    const toastEl = document.createElement("div");
    toastEl.className = `motion-toast ${type === "success" ? "toast-success" : ""}`;
    const icon = type === "success" ? "✓" : "✦";
    const iconEl = document.createElement("span");
    iconEl.className = "toast-icon";
    iconEl.textContent = icon;
    const messageEl = document.createElement("span");
    messageEl.className = "toast-text";
    messageEl.textContent = message;
    toastEl.append(iconEl, messageEl);
    container.appendChild(toastEl);

    setTimeout(() => {
      toastEl.style.animation = "toast-out 0.22s ease forwards";
      setTimeout(() => toastEl.remove(), 220);
    }, duration);
  }

  // Interactive Ambient Particle Canvas (Grok/Manus Ethereal Starfield)
  function initAmbientCanvas() {
    const canvas = document.getElementById("ambient-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let particles = [];
    const PARTICLE_COUNT = 72;
    let mouse = { x: -1000, y: -1000, active: false };
    let shockwaves = [];

    function resize() {
      const parent = canvas.parentElement;
      if (!parent) return;
      width = canvas.width = parent.clientWidth || window.innerWidth;
      height = canvas.height = parent.clientHeight || window.innerHeight;
      createParticles();
    }

    function createParticles() {
      particles = [];
      const isLight = document.body.dataset.theme === "light";
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        let pColor;
        if (isLight) {
          const rand = Math.random();
          pColor = rand > 0.6 ? "37, 99, 235" : (rand > 0.3 ? "124, 58, 237" : (rand > 0.15 ? "217, 119, 6" : "5, 150, 105"));
        } else {
          const rand = Math.random();
          pColor = rand > 0.5 ? "10, 132, 255" : (rand > 0.25 ? "168, 85, 247" : "6, 182, 212");
        }
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.55,
          vy: (Math.random() - 0.5) * 0.55,
          baseRadius: Math.random() * 2.2 + 1.2,
          radius: Math.random() * 2.2 + 1.2,
          alpha: isLight ? Math.random() * 0.4 + 0.45 : Math.random() * 0.45 + 0.45,
          color: pColor,
          pulseSpeed: Math.random() * 0.04 + 0.02,
          pulseOffset: Math.random() * Math.PI * 2,
        });
      }
    }

    function draw(time) {
      if (!canvas.offsetParent) {
        requestAnimationFrame(draw);
        return;
      }

      ctx.clearRect(0, 0, width, height);
      const isLight = document.body.dataset.theme === "light";

      // 1. Draw luminous mouse cursor spotlight aura
      if (mouse.active) {
        const radGrad = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, 170);
        radGrad.addColorStop(0, isLight ? "rgba(37, 99, 235, 0.18)" : "rgba(10, 132, 255, 0.24)");
        radGrad.addColorStop(0.55, isLight ? "rgba(139, 92, 246, 0.08)" : "rgba(168, 85, 247, 0.12)");
        radGrad.addColorStop(1, "transparent");
        ctx.fillStyle = radGrad;
        ctx.beginPath();
        ctx.arc(mouse.x, mouse.y, 170, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2. Expand and render click shockwaves
      for (let s = shockwaves.length - 1; s >= 0; s--) {
        const sw = shockwaves[s];
        sw.r += 6;
        sw.alpha *= 0.94;
        if (sw.alpha < 0.02 || sw.r > sw.maxR) {
          shockwaves.splice(s, 1);
          continue;
        }
        ctx.save();
        ctx.beginPath();
        ctx.arc(sw.x, sw.y, sw.r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${sw.color}, ${sw.alpha})`;
        ctx.lineWidth = 2.5;
        ctx.shadowBlur = 14;
        ctx.shadowColor = `rgba(${sw.color}, 0.8)`;
        ctx.stroke();
        ctx.restore();
      }

      // 3. Move & render particles
      const now = (time || performance.now()) * 0.001;
      for (let i = 0; i < particles.length; i++) {
        const p1 = particles[i];

        // Move
        p1.x += p1.vx;
        p1.y += p1.vy;

        // Bounce
        if (p1.x < 0 || p1.x > width) p1.vx *= -1;
        if (p1.y < 0 || p1.y > height) p1.vy *= -1;

        // Shockwave deflection
        for (let s = 0; s < shockwaves.length; s++) {
          const sw = shockwaves[s];
          const dx = p1.x - sw.x;
          const dy = p1.y - sw.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (Math.abs(d - sw.r) < 24) {
            const push = (24 - Math.abs(d - sw.r)) * 0.12;
            p1.x += (dx / (d || 1)) * push;
            p1.y += (dy / (d || 1)) * push;
          }
        }

        // Mouse gravity & interaction
        let alphaBoost = 0;
        let radiusBoost = 0;
        if (mouse.active) {
          const dx = mouse.x - p1.x;
          const dy = mouse.y - p1.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 160) {
            const factor = (1 - dist / 160);
            p1.x += dx * 0.015 * factor;
            p1.y += dy * 0.015 * factor;
            alphaBoost = 0.35 * factor;
            radiusBoost = 1.2 * factor;

            // Connect filament to mouse cursor
            if (dist < 130) {
              const cursorLineAlpha = (1 - dist / 130) * 0.45;
              ctx.beginPath();
              ctx.moveTo(p1.x, p1.y);
              ctx.lineTo(mouse.x, mouse.y);
              ctx.strokeStyle = `rgba(${p1.color}, ${cursorLineAlpha})`;
              ctx.lineWidth = 1.2;
              ctx.stroke();
            }
          }
        }

        // Gentle breathing size
        const currentRadius = p1.baseRadius + radiusBoost + Math.sin(now * 2 + p1.pulseOffset) * 0.4;
        const currentAlpha = Math.min(1, p1.alpha + alphaBoost);

        // Draw particle dot with luminous halo
        ctx.save();
        ctx.shadowBlur = 10;
        ctx.shadowColor = `rgba(${p1.color}, 0.75)`;
        ctx.beginPath();
        ctx.arc(p1.x, p1.y, Math.max(0.6, currentRadius), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p1.color}, ${currentAlpha})`;
        ctx.fill();
        ctx.restore();

        // Connect constellation lines between nearby particles
        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
          if (dist < 135) {
            const lineAlpha = (1 - dist / 135) * (isLight ? 0.34 : 0.4);
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = `rgba(${p1.color}, ${lineAlpha})`;
            ctx.lineWidth = 0.95;
            ctx.stroke();
          }
        }
      }

      requestAnimationFrame(draw);
    }

    window.addEventListener("resize", resize);
    const parent = canvas.parentElement;
    if (parent) {
      parent.addEventListener("mousemove", (e) => {
        const rect = canvas.getBoundingClientRect();
        mouse.x = e.clientX - rect.left;
        mouse.y = e.clientY - rect.top;
        mouse.active = true;
      });
      parent.addEventListener("mouseleave", () => {
        mouse.active = false;
      });
      parent.addEventListener("click", (e) => {
        const rect = canvas.getBoundingClientRect();
        const isLight = document.body.dataset.theme === "light";
        shockwaves.push({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          r: 0,
          maxR: 220,
          alpha: 0.85,
          color: isLight ? "37, 99, 235" : "10, 132, 255"
        });
      });
    }

    resize();
    requestAnimationFrame(draw);
  }

  // 3D Gyroscopic Orb Tilt & Interactive Levitation
  function initOrbTilt() {
    const orb = document.getElementById("welcome-orb");
    if (!orb) return;
    const hero = orb.closest(".welcome-hero") || orb.parentElement;
    if (!hero) return;

    hero.addEventListener("mousemove", (e) => {
      const rect = orb.getBoundingClientRect();
      const orbCenterX = rect.left + rect.width / 2;
      const orbCenterY = rect.top + rect.height / 2;

      const deltaX = (e.clientX - orbCenterX) / 16;
      const deltaY = (e.clientY - orbCenterY) / 16;

      const clampX = Math.max(-20, Math.min(20, deltaX));
      const clampY = Math.max(-20, Math.min(20, -deltaY));

      orb.style.setProperty("--tilt-x", `${clampX}deg`);
      orb.style.setProperty("--tilt-y", `${clampY}deg`);
      orb.style.setProperty("--orb-scale", "1.12");
    });

    hero.addEventListener("mouseleave", () => {
      orb.style.setProperty("--tilt-x", "0deg");
      orb.style.setProperty("--tilt-y", "0deg");
      orb.style.setProperty("--orb-scale", "1");
    });

    orb.addEventListener("click", () => {
      playChime();
      sparkleBurst(orb);
      orb.classList.remove("orb-clicked");
      void orb.offsetWidth; // trigger reflow
      orb.classList.add("orb-clicked");
      setTimeout(() => orb.classList.remove("orb-clicked"), 800);
    });
  }

  // Global Code Copy & Message Actions Event Delegation
  function initGlobalClickHandlers() {
    document.addEventListener("click", (e) => {
      // 1. Code block copy button
      const copyBtn = e.target.closest(".code-copy-btn");
      if (copyBtn) {
        e.preventDefault();
        e.stopPropagation();
        const code = copyBtn.dataset.code || copyBtn.closest(".code-block")?.querySelector("code")?.textContent || "";
        if (code) {
          navigator.clipboard.writeText(code).then(() => {
            playChime();
            sparkleBurst(copyBtn);
            copyBtn.classList.add("copied");
            const label = copyBtn.querySelector(".copy-label");
            const oldText = label ? label.textContent : "";
            if (label) label.textContent = (globalThis.SovereignI18n?.currentLocale?.() === "zh-CN" ? "已复制 ✓" : "Copied ✓");
            toast(globalThis.SovereignI18n?.currentLocale?.() === "zh-CN" ? "代码已复制到剪贴板" : "Code copied to clipboard", "success");

            setTimeout(() => {
              copyBtn.classList.remove("copied");
              if (label) label.textContent = oldText || (globalThis.SovereignI18n?.currentLocale?.() === "zh-CN" ? "复制" : "Copy");
            }, 2000);
          }).catch(() => {
            toast(globalThis.SovereignI18n?.currentLocale?.() === "zh-CN" ? "复制失败" : "Could not copy code", "error");
          });
        }
        return;
      }

      // 2. Message action copy button
      const msgCopyBtn = e.target.closest(".message-action-copy");
      if (msgCopyBtn) {
        e.preventDefault();
        const row = msgCopyBtn.closest(".chat-row");
        const text = row?.querySelector(".chat-text")?.textContent || "";
        if (text) {
          navigator.clipboard.writeText(text).then(() => {
            playChime();
            sparkleBurst(msgCopyBtn);
            const oldText = msgCopyBtn.textContent;
            msgCopyBtn.textContent = (globalThis.SovereignI18n?.currentLocale?.() === "zh-CN" ? "已复制 ✓" : "Copied ✓");
            toast(globalThis.SovereignI18n?.currentLocale?.() === "zh-CN" ? "消息已复制" : "Message copied", "success");
            setTimeout(() => {
              msgCopyBtn.textContent = oldText;
            }, 2000);
          });
        }
        return;
      }

      // 3. Quick prompt chip click sparkle
      const chip = e.target.closest(".quick-prompt-chip");
      if (chip) {
        sparkleBurst(chip);
      }
    });
  }

  // Interactive Ambient Particle Canvas for Conversation View (Ethereal Cosmic Mesh)
  function initConversationAmbientCanvas() {
    const canvas = document.getElementById("conversation-ambient-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let particles = [];
    const PARTICLE_COUNT = 58;
    let mouse = { x: -1000, y: -1000, active: false };
    let shockwaves = [];

    function resize() {
      const parent = canvas.parentElement;
      if (!parent) return;
      width = canvas.width = parent.clientWidth || window.innerWidth;
      height = canvas.height = parent.clientHeight || window.innerHeight;
      createParticles();
    }

    function createParticles() {
      particles = [];
      const isLight = document.body.dataset.theme === "light";
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        let pColor;
        if (isLight) {
          const rand = Math.random();
          pColor = rand > 0.6 ? "37, 99, 235" : (rand > 0.3 ? "124, 58, 237" : (rand > 0.15 ? "217, 119, 6" : "5, 150, 105"));
        } else {
          const rand = Math.random();
          pColor = rand > 0.5 ? "10, 132, 255" : (rand > 0.25 ? "168, 85, 247" : "6, 182, 212");
        }
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.45,
          vy: (Math.random() - 0.5) * 0.45,
          baseRadius: Math.random() * 2.2 + 1.1,
          radius: Math.random() * 2.2 + 1.1,
          alpha: isLight ? Math.random() * 0.35 + 0.42 : Math.random() * 0.45 + 0.4,
          color: pColor,
          pulseOffset: Math.random() * Math.PI * 2,
        });
      }
    }

    function draw(time) {
      const view = document.getElementById("view-conversation");
      if (!view || view.classList.contains("hidden")) {
        requestAnimationFrame(draw);
        return;
      }

      ctx.clearRect(0, 0, width, height);
      const isLight = document.body.dataset.theme === "light";

      // 1. Mouse cursor glow aura in chat view
      if (mouse.active) {
        const radGrad = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, 160);
        radGrad.addColorStop(0, isLight ? "rgba(37, 99, 235, 0.15)" : "rgba(10, 132, 255, 0.2)");
        radGrad.addColorStop(0.6, isLight ? "rgba(139, 92, 246, 0.06)" : "rgba(168, 85, 247, 0.10)");
        radGrad.addColorStop(1, "transparent");
        ctx.fillStyle = radGrad;
        ctx.beginPath();
        ctx.arc(mouse.x, mouse.y, 160, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2. Shockwaves
      for (let s = shockwaves.length - 1; s >= 0; s--) {
        const sw = shockwaves[s];
        sw.r += 5;
        sw.alpha *= 0.94;
        if (sw.alpha < 0.02 || sw.r > sw.maxR) {
          shockwaves.splice(s, 1);
          continue;
        }
        ctx.save();
        ctx.beginPath();
        ctx.arc(sw.x, sw.y, sw.r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${sw.color}, ${sw.alpha})`;
        ctx.lineWidth = 2;
        ctx.shadowBlur = 12;
        ctx.shadowColor = `rgba(${sw.color}, 0.8)`;
        ctx.stroke();
        ctx.restore();
      }

      // 3. Move & render particles
      const now = (time || performance.now()) * 0.001;
      for (let i = 0; i < particles.length; i++) {
        const p1 = particles[i];

        // Move
        p1.x += p1.vx;
        p1.y += p1.vy;

        // Soft bounce boundaries
        if (p1.x < 0 || p1.x > width) p1.vx *= -1;
        if (p1.y < 0 || p1.y > height) p1.vy *= -1;

        // Interactive mouse drift
        let alphaBoost = 0;
        let radiusBoost = 0;
        if (mouse.active) {
          const dx = mouse.x - p1.x;
          const dy = mouse.y - p1.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 150) {
            const factor = (1 - dist / 150);
            p1.x += dx * 0.012 * factor;
            p1.y += dy * 0.012 * factor;
            alphaBoost = 0.35 * factor;
            radiusBoost = 1.0 * factor;

            if (dist < 120) {
              const cursorLineAlpha = (1 - dist / 120) * 0.4;
              ctx.beginPath();
              ctx.moveTo(p1.x, p1.y);
              ctx.lineTo(mouse.x, mouse.y);
              ctx.strokeStyle = `rgba(${p1.color}, ${cursorLineAlpha})`;
              ctx.lineWidth = 1;
              ctx.stroke();
            }
          }
        }

        const currentRadius = p1.baseRadius + radiusBoost + Math.sin(now * 2 + p1.pulseOffset) * 0.35;
        const currentAlpha = Math.min(1, p1.alpha + alphaBoost);

        // Draw particle dot with soft radiant glow
        ctx.save();
        ctx.shadowBlur = 9;
        ctx.shadowColor = `rgba(${p1.color}, 0.7)`;
        ctx.beginPath();
        ctx.arc(p1.x, p1.y, Math.max(0.6, currentRadius), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p1.color}, ${currentAlpha})`;
        ctx.fill();
        ctx.restore();

        // Connect lines
        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
          if (dist < 130) {
            const lineAlpha = (1 - dist / 130) * (isLight ? 0.3 : 0.36);
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = `rgba(${p1.color}, ${lineAlpha})`;
            ctx.lineWidth = 0.85;
            ctx.stroke();
          }
        }
      }

      requestAnimationFrame(draw);
    }

    window.addEventListener("resize", resize);
    const parent = canvas.parentElement;
    if (parent) {
      parent.addEventListener("mousemove", (e) => {
        const rect = canvas.getBoundingClientRect();
        mouse.x = e.clientX - rect.left;
        mouse.y = e.clientY - rect.top;
        mouse.active = true;
      });
      parent.addEventListener("mouseleave", () => {
        mouse.active = false;
      });
      parent.addEventListener("click", (e) => {
        const rect = canvas.getBoundingClientRect();
        const isLight = document.body.dataset.theme === "light";
        shockwaves.push({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          r: 0,
          maxR: 200,
          alpha: 0.8,
          color: isLight ? "37, 99, 235" : "10, 132, 255"
        });
      });
    }

    resize();
    requestAnimationFrame(draw);
  }

  // Micro Sparkle Burst Confetti for clicks & interactions
  function sparkleBurst(anchorEl) {
    if (!anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const container = document.createElement("div");
    container.className = "sparkle-burst-container";
    container.style.left = `${rect.left + rect.width / 2}px`;
    container.style.top = `${rect.top + rect.height / 2}px`;

    const colors = ["#007aff", "#8b5cf6", "#06b6d4", "#30d158", "#ff9f0a", "#ec4899"];
    const count = 10;

    for (let i = 0; i < count; i++) {
      const p = document.createElement("span");
      p.className = "sparkle-particle";
      const angle = (Math.PI * 2 / count) * i + (Math.random() - 0.5) * 0.5;
      const distance = Math.random() * 26 + 18;
      const tx = Math.cos(angle) * distance;
      const ty = Math.sin(angle) * distance;
      p.style.setProperty("--tx", `${tx}px`);
      p.style.setProperty("--ty", `${ty}px`);
      p.style.background = colors[i % colors.length];
      p.style.boxShadow = `0 0 6px ${colors[i % colors.length]}`;
      container.appendChild(p);
    }

    document.body.appendChild(container);
    setTimeout(() => container.remove(), 650);
  }

  // Reasoning Holographic Engine & Real-time Stopwatch
  function initReasoningEngine() {
    const typingRow = document.getElementById("typing-row");
    const timerEl = document.getElementById("typing-timer");
    const stepsContainer = document.getElementById("typing-steps");
    if (!typingRow) return;

    let timerInterval = null;
    let secondsElapsed = 0;
    let wasActive = false;

    function formatTime(s) {
      const mins = Math.floor(s / 60).toString().padStart(2, "0");
      const secs = (s % 60).toString().padStart(2, "0");
      return `${mins}:${secs}`;
    }

    function updateSteps(elapsed) {
      if (!stepsContainer) return;
      const steps = stepsContainer.querySelectorAll(".typing-step");
      if (!steps.length) return;

      let activeIndex = 0;
      if (elapsed < 3) {
        activeIndex = 0;
      } else if (elapsed < 7) {
        activeIndex = 1;
      } else {
        activeIndex = 2;
      }

      steps.forEach((step, idx) => {
        step.classList.toggle("active", idx === activeIndex);
      });
    }

    const observer = new MutationObserver(() => {
      const isVisible = !typingRow.classList.contains("hidden");
      if (isVisible && !wasActive) {
        wasActive = true;
        secondsElapsed = 0;
        if (timerEl) timerEl.textContent = "00:00";
        updateSteps(0);
        playBubblePop();

        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(() => {
          secondsElapsed++;
          if (timerEl) timerEl.textContent = formatTime(secondsElapsed);
          updateSteps(secondsElapsed);
        }, 1000);
      } else if (!isVisible && wasActive) {
        wasActive = false;
        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }
        if (secondsElapsed >= 1) {
          playChime();
        }
      }
    });

    observer.observe(typingRow, { attributes: true, attributeFilter: ["class"] });
  }

  // Reactive Composer Controls & Keybindings
  function initComposerEnhancements() {
    const input = document.getElementById("composer-input");
    const sendBtn = document.getElementById("composer-send");
    if (!input) return;

    function updateComposerState() {
      const hasText = Boolean(input.value.trim());
      if (sendBtn) {
        sendBtn.classList.toggle("active-ready", hasText);
      }

      // Auto-grow height smoothly
      input.style.height = "auto";
      const newHeight = Math.min(Math.max(input.scrollHeight, 28), 160);
      input.style.height = `${newHeight}px`;
    }

    input.addEventListener("input", updateComposerState);
    input.addEventListener("change", updateComposerState);

    // Audio cue on submit
    const form = document.getElementById("composer-form");
    if (form) {
      form.addEventListener("submit", () => {
        if (input.value.trim()) {
          playBubblePop();
        }
      });
    }

    updateComposerState();
  }

  // Initialization when DOM ready
  function init() {
    initAmbientCanvas();
    initConversationAmbientCanvas();
    initOrbTilt();
    initComposerEnhancements();
    initReasoningEngine();
    initGlobalClickHandlers();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    setTimeout(init, 50);
  }

  global.motionFx = {
    toast,
    playBubblePop,
    playChime,
    sparkleBurst,
    initAmbientCanvas,
    initConversationAmbientCanvas
  };
})(window);
