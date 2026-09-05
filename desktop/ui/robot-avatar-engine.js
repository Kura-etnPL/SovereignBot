/**
 * SovereignBot Diverse Ultra-Minimalist Thinking Robot Avatar Engine
 * Pure 2D flat papercraft aesthetic with multiple distinctive head shapes & expressive Grok-inspired thinking motions:
 * - 7 Distinct Geometric Head Silhouettes: Circle (Orb), Squircle (Cube), Oval (Capsule), Hexagon (Shield), TV (Wide Screen), Arch (Vault Dome), Octagon (Prism)
 * - Alive, curious, and organic thinking loops (歪头思考、视线顾盼、双重眨眼)
 * - Deep reasoning & high-frequency execution states for active AI tasks
 * - Interactive cursor gaze tracking for welcome orb and active bots
 * - Distinctive flat color palettes for Sovereign Mascot, Teams, Channels, Projects & Coworkers
 */

(function () {
  "use strict";

  const HEAD_SHAPES = ["circle", "squircle", "oval", "hexagon", "tv", "arch", "octagon"];

  const BRIGHT_BOT_THEMES = {
    chief: {
      key: "chief",
      name: "Chief of Staff",
      shape: "circle",
      chassisFill: "#FFFFFF",
      chassisStroke: "#334155",
      eyeColor: "#0284C7", // Vibrant Ocean Cyan
      accentColor: "#0EA5E9",
      crestColor: "#F59E0B"  // Gold Crown
    },
    code: {
      key: "code",
      name: "Coding Lead",
      shape: "squircle",
      chassisFill: "#FFFFFF",
      chassisStroke: "#334155",
      eyeColor: "#3B82F6", // Electric Neon Blue
      accentColor: "#2563EB",
      crestColor: "#38BDF8"
    },
    research: {
      key: "research",
      name: "Researcher",
      shape: "oval",
      chassisFill: "#FFFFFF",
      chassisStroke: "#334155",
      eyeColor: "#10B981", // Emerald Mint
      accentColor: "#059669",
      crestColor: "#34D399"
    },
    review: {
      key: "review",
      name: "Reviewer",
      shape: "hexagon",
      chassisFill: "#FFFFFF",
      chassisStroke: "#334155",
      eyeColor: "#8B5CF6", // Royal Purple
      accentColor: "#7C3AED",
      crestColor: "#A78BFA"
    },
    creative: {
      key: "creative",
      name: "Creative Lead",
      shape: "tv",
      chassisFill: "#FFFFFF",
      chassisStroke: "#334155",
      eyeColor: "#F43F5E", // Vibrant Rose
      accentColor: "#E11D48",
      crestColor: "#FB7185"
    },
    devops: {
      key: "devops",
      name: "DevOps & Infra",
      shape: "arch",
      chassisFill: "#FFFFFF",
      chassisStroke: "#334155",
      eyeColor: "#06B6D4", // Electric Cyan
      accentColor: "#0891B2",
      crestColor: "#22D3EE"
    },
    data: {
      key: "data",
      name: "Data & ML",
      shape: "octagon",
      chassisFill: "#FFFFFF",
      chassisStroke: "#334155",
      eyeColor: "#6366F1", // Indigo Cyber
      accentColor: "#4F46E5",
      crestColor: "#818CF8"
    },
    default: {
      key: "default",
      name: "AI Agent",
      shape: "circle",
      chassisFill: "#FFFFFF",
      chassisStroke: "#334155",
      eyeColor: "#6366F1",
      accentColor: "#4F46E5",
      crestColor: "#818CF8"
    }
  };

  const BRIGHT_PALETTES = [
    { key: "amber", shape: "squircle", eyeColor: "#F59E0B", accentColor: "#D97706" },
    { key: "cyan", shape: "tv", eyeColor: "#06B6D4", accentColor: "#0891B2" },
    { key: "rose", shape: "oval", eyeColor: "#F43F5E", accentColor: "#E11D48" },
    { key: "emerald", shape: "hexagon", eyeColor: "#10B981", accentColor: "#059669" },
    { key: "violet", shape: "arch", eyeColor: "#8B5CF6", accentColor: "#7C3AED" },
    { key: "blue", shape: "circle", eyeColor: "#2563EB", accentColor: "#1D4ED8" },
    { key: "indigo", shape: "octagon", eyeColor: "#6366F1", accentColor: "#4F46E5" },
    { key: "teal", shape: "squircle", eyeColor: "#0D9488", accentColor: "#0F766E" },
    { key: "orange", shape: "tv", eyeColor: "#EA580C", accentColor: "#C2410C" }
  ];

  function getCoworkerTheme(coworker) {
    if (!coworker) return BRIGHT_BOT_THEMES.default;
    const name = (coworker.name || "").toLowerCase();
    const role = (coworker.role || "").toLowerCase();
    const id = (coworker.id || "").toLowerCase();
    const combined = `${name} ${role} ${id}`;

    if (/chief|staff|统筹|主管|助理|leader|head/i.test(combined)) {
      return BRIGHT_BOT_THEMES.chief;
    }
    if (/code|coding|dev|engineer|架构|开发|代码|程序|frontend|backend/i.test(combined)) {
      return BRIGHT_BOT_THEMES.code;
    }
    if (/research|search|investigat|分析|调研|情报|研究|analyst/i.test(combined)) {
      return BRIGHT_BOT_THEMES.research;
    }
    if (/review|qa|test|audit|审查|审核|质量|质检|security|安全/i.test(combined)) {
      return BRIGHT_BOT_THEMES.review;
    }
    if (/design|creative|art|ui|ux|产品|设计|创意|文案|media/i.test(combined)) {
      return BRIGHT_BOT_THEMES.creative;
    }
    if (/infra|devops|ops|运维|系统|deploy|cloud|k8s/i.test(combined)) {
      return BRIGHT_BOT_THEMES.devops;
    }
    if (/data|ml|ai|algo|数据|算法|模型|database/i.test(combined)) {
      return BRIGHT_BOT_THEMES.data;
    }

    let hash = 0;
    const str = `${coworker.id || ""}${coworker.name || ""}`;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % BRIGHT_PALETTES.length;
    const p = BRIGHT_PALETTES[idx];
    const shapeIdx = Math.abs(hash >> 3) % HEAD_SHAPES.length;
    const shape = p.shape || HEAD_SHAPES[shapeIdx];

    return {
      key: `custom-${idx}`,
      name: coworker.name || "AI Agent",
      shape,
      chassisFill: "#FFFFFF",
      chassisStroke: "#334155",
      eyeColor: p.eyeColor,
      accentColor: p.accentColor,
      crestColor: p.eyeColor
    };
  }

  /**
   * Renders Head Chassis SVG element according to shape
   */
  function renderHeadChassis(shape, theme) {
    switch (shape) {
      case "squircle":
        // Smooth rounded cube / squircle
        return `<rect x="6" y="6" width="36" height="36" rx="10" class="bot-flat-head" fill="${theme.chassisFill}" stroke="${theme.chassisStroke}" stroke-width="2.2"/>`;
      case "oval":
        // Vertical elegant capsule
        return `<ellipse cx="24" cy="24" rx="16" ry="18.5" class="bot-flat-head" fill="${theme.chassisFill}" stroke="${theme.chassisStroke}" stroke-width="2.2"/>`;
      case "hexagon":
        // Cyber bevel shield / hexagon
        return `<polygon points="24,5.5 39.5,14.5 39.5,33.5 24,42.5 8.5,33.5 8.5,14.5" class="bot-flat-head" fill="${theme.chassisFill}" stroke="${theme.chassisStroke}" stroke-width="2.2" stroke-linejoin="round"/>`;
      case "tv":
        // Horizontal rounded wide screen
        return `<rect x="5" y="8.5" width="38" height="31" rx="13" class="bot-flat-head" fill="${theme.chassisFill}" stroke="${theme.chassisStroke}" stroke-width="2.2"/>`;
      case "arch":
        // Arch dome vault
        return `<path d="M7 40 V22 C7 12.6 14.6 5.5 24 5.5 C33.4 5.5 41 12.6 41 22 V40 C41 41.5 39.5 42.5 38 42.5 H10 C8.5 42.5 7 41.5 7 40 Z" class="bot-flat-head" fill="${theme.chassisFill}" stroke="${theme.chassisStroke}" stroke-width="2.2" stroke-linejoin="round"/>`;
      case "octagon":
        // Beveled precision octagon
        return `<polygon points="13,6 35,6 42,13 42,35 35,42 13,42 6,35 6,13" class="bot-flat-head" fill="${theme.chassisFill}" stroke="${theme.chassisStroke}" stroke-width="2.2" stroke-linejoin="round"/>`;
      case "circle":
      default:
        // Pure iconic round head
        return `<circle cx="24" cy="24" r="18.5" class="bot-flat-head" fill="${theme.chassisFill}" stroke="${theme.chassisStroke}" stroke-width="2.2"/>`;
    }
  }

  /**
   * Renders Top Floating Crest / Antenna
   */
  function renderHeadCrest(shape, theme, isChief) {
    if (isChief) {
      return `
        <path d="M17.5 5.5L20.5 8.5L24 2.5L27.5 8.5L30.5 5.5V10H17.5V5.5Z" fill="#F59E0B" stroke="#D97706" stroke-width="0.9" stroke-linejoin="round"/>
        <circle cx="24" cy="2.5" r="1.3" fill="#FEF08A"/>
      `;
    }

    switch (shape) {
      case "squircle":
        return `
          <circle cx="24" cy="3.5" r="2.2" fill="${theme.crestColor}"/>
          <circle cx="17.5" cy="4" r="1.3" fill="${theme.accentColor}"/>
          <circle cx="30.5" cy="4" r="1.3" fill="${theme.accentColor}"/>
        `;
      case "oval":
        return `
          <ellipse cx="24" cy="3.5" rx="2.8" ry="1.8" fill="${theme.crestColor}"/>
          <circle cx="24" cy="3.5" r="0.8" fill="#FFFFFF"/>
        `;
      case "hexagon":
        return `
          <polygon points="24,1.8 26.5,4.3 24,6.8 21.5,4.3" fill="${theme.crestColor}"/>
        `;
      case "tv":
        return `
          <path d="M20 4.5 Q24 2 28 4.5" stroke="${theme.crestColor}" stroke-width="1.8" stroke-linecap="round" fill="none"/>
          <circle cx="24" cy="3.2" r="1.4" fill="${theme.accentColor}"/>
        `;
      case "arch":
        return `
          <circle cx="24" cy="3.5" r="2.2" fill="${theme.crestColor}"/>
          <line x1="24" y1="5.7" x2="24" y2="7.5" stroke="${theme.accentColor}" stroke-width="1.5" stroke-linecap="round"/>
        `;
      case "octagon":
        return `
          <rect x="22" y="2.2" width="4" height="4" rx="1.2" transform="rotate(45 24 4.2)" fill="${theme.crestColor}"/>
        `;
      case "circle":
      default:
        return `<circle cx="24" cy="4" r="2.2" fill="${theme.crestColor}"/>`;
    }
  }

  /**
   * Renders Expressive Eyes tailored for the head shape
   */
  function renderHeadEyes(shape, theme) {
    if (shape === "tv") {
      return `
        <g class="bot-gaze-group">
          <rect x="14" y="19" width="5.2" height="10.5" rx="2.6" transform="rotate(-10 16.6 24.25)" fill="${theme.eyeColor}" class="bot-eye-unit bot-eye-left"/>
          <circle cx="17.5" cy="21.5" r="0.8" fill="#FFFFFF"/>

          <rect x="28.8" y="19" width="5.2" height="10.5" rx="2.6" transform="rotate(-10 31.4 24.25)" fill="${theme.eyeColor}" class="bot-eye-unit bot-eye-right"/>
          <circle cx="32.3" cy="21.5" r="0.8" fill="#FFFFFF"/>
        </g>
      `;
    }

    if (shape === "hexagon") {
      return `
        <g class="bot-gaze-group">
          <rect x="15" y="18.5" width="5" height="11.5" rx="2.5" transform="rotate(-8 17.5 24.25)" fill="${theme.eyeColor}" class="bot-eye-unit bot-eye-left"/>
          <circle cx="18.2" cy="21" r="0.8" fill="#FFFFFF"/>

          <rect x="28" y="18.5" width="5" height="11.5" rx="2.5" transform="rotate(-8 30.5 24.25)" fill="${theme.eyeColor}" class="bot-eye-unit bot-eye-right"/>
          <circle cx="31.2" cy="21" r="0.8" fill="#FFFFFF"/>
        </g>
      `;
    }

    return `
      <g class="bot-gaze-group">
        <!-- Left Slanted Eye -->
        <rect x="15" y="18.5" width="5.2" height="11.5" rx="2.6" transform="rotate(-10 17.6 24.25)" fill="${theme.eyeColor}" class="bot-eye-unit bot-eye-left"/>
        <circle cx="18.5" cy="21" r="0.8" fill="#FFFFFF"/>

        <!-- Right Slanted Eye -->
        <rect x="27.8" y="18.5" width="5.2" height="11.5" rx="2.6" transform="rotate(-10 30.4 24.25)" fill="${theme.eyeColor}" class="bot-eye-unit bot-eye-right"/>
        <circle cx="31.3" cy="21" r="0.8" fill="#FFFFFF"/>
      </g>
    `;
  }

  /**
   * Generates Sovereign AI Robot Mascot Brand Logo SVG
   * Iconic minimalist geometric circle with slanted expressive eyes & floating gold crown
   */
  function createBrandLogoSvg({ size = "md" } = {}) {
    return `
      <svg class="sovereign-brand-icon size-${size}" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <!-- Minimalist Floating Sovereign Crown -->
        <path d="M15 7L17.5 9.5L20 4.5L22.5 9.5L25 7V10H15V7Z" fill="#F59E0B" stroke="#D97706" stroke-width="0.8" stroke-linejoin="round"/>
        <circle cx="20" cy="4.5" r="1.1" fill="#FEF08A"/>

        <!-- Iconic Pure Round Head (干净纯白极简圆头) -->
        <circle cx="20" cy="21" r="14.5" class="bot-flat-head" fill="#FFFFFF" stroke="#334155" stroke-width="1.8"/>

        <!-- Expressive Slanted Thinking Eyes (Grok-inspired iconic geometry) -->
        <g class="bot-brand-eyes">
          <!-- Left Slanted Eye -->
          <rect x="13.2" y="16.5" width="4.4" height="9.5" rx="2.2" transform="rotate(-10 15.4 21.25)" fill="#0284C7"/>
          <circle cx="16.2" cy="18.5" r="0.7" fill="#FFFFFF"/>

          <!-- Right Slanted Eye -->
          <rect x="22.4" y="16.5" width="4.4" height="9.5" rx="2.2" transform="rotate(-10 24.6 21.25)" fill="#0284C7"/>
          <circle cx="25.4" cy="18.5" r="0.7" fill="#FFFFFF"/>
        </g>
      </svg>
    `;
  }

  /**
   * Generates Team Squad Command Robot Head (Iconic Multi-Agent Command Shield)
   */
  function createTeamSquadSvg(team, { size = "md", state = "ready", phase = 0 } = {}) {
    const animDelay = (phase * 0.85) % 8.6;
    return `
      <svg class="robot-head-svg size-${size} bot-role-team ${state === "working" ? "is-working" : state === "paused" ? "is-paused" : ""}"
           viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"
           style="--bot-eye: #0284C7; --bot-accent: #2563EB; --bot-delay: -${animDelay.toFixed(2)}s;"
           aria-hidden="true">
        <g class="robot-head-anchor">
          <!-- Floating Multi-Agent Signal Pip Array -->
          <circle cx="24" cy="3.5" r="2.2" fill="#3B82F6"/>
          <circle cx="17.5" cy="4" r="1.3" fill="#0EA5E9"/>
          <circle cx="30.5" cy="4" r="1.3" fill="#0EA5E9"/>

          <!-- Command Squircle Shield Chassis (多智能体指挥方盾) -->
          <rect x="5.5" y="6.5" width="37" height="37" rx="11" class="bot-flat-head" fill="#FFFFFF" stroke="#334155" stroke-width="2.2"/>

          <!-- 3-Node Squad Agent Optics (Expressive Tri-Core Matrix) -->
          <g class="bot-gaze-group">
            <rect x="13" y="19.5" width="4.8" height="9.5" rx="2.4" fill="#3B82F6" class="bot-eye-unit bot-eye-left"/>
            <circle cx="16.2" cy="22" r="0.75" fill="#FFFFFF"/>

            <rect x="21.6" y="20.5" width="4.8" height="7.5" rx="2.4" fill="#0EA5E9" class="bot-eye-unit"/>
            <circle cx="24.8" cy="22.5" r="0.75" fill="#FFFFFF"/>

            <rect x="30.2" y="19.5" width="4.8" height="9.5" rx="2.4" fill="#3B82F6" class="bot-eye-unit bot-eye-right"/>
            <circle cx="33.4" cy="22" r="0.75" fill="#FFFFFF"/>
          </g>
        </g>
      </svg>
    `;
  }

  /**
   * Generates Quantum Channel Matrix Robot Head (Cyber Hexagon Hub)
   */
  function createChannelHubSvg(channel, { size = "md", state = "ready", phase = 0 } = {}) {
    const animDelay = (phase * 0.75) % 8.6;
    return `
      <svg class="robot-head-svg size-${size} bot-role-channel ${state === "working" ? "is-working" : state === "paused" ? "is-paused" : ""}"
           viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"
           style="--bot-eye: #0D9488; --bot-accent: #0F766E; --bot-delay: -${animDelay.toFixed(2)}s;"
           aria-hidden="true">
        <g class="robot-head-anchor">
          <!-- Floating Signal Nodes -->
          <polygon points="24,1.8 26.5,4.3 24,6.8 21.5,4.3" fill="#0D9488"/>

          <!-- Hexagonal Matrix Head (科技六边形枢纽) -->
          <polygon points="24,5.5 39.5,14.5 39.5,33.5 24,42.5 8.5,33.5 8.5,14.5" class="bot-flat-head" fill="#FFFFFF" stroke="#334155" stroke-width="2.2" stroke-linejoin="round"/>

          <!-- Channel Hashtag Grid Optics -->
          <g class="bot-gaze-group">
            <line x1="21.5" y1="18.5" x2="21.5" y2="29.5" stroke="#0D9488" stroke-width="2.2" stroke-linecap="round"/>
            <line x1="26.5" y1="18.5" x2="26.5" y2="29.5" stroke="#0D9488" stroke-width="2.2" stroke-linecap="round"/>
            <line x1="17.5" y1="21.5" x2="30.5" y2="21.5" stroke="#0D9488" stroke-width="2.2" stroke-linecap="round"/>
            <line x1="17.5" y1="26.5" x2="30.5" y2="26.5" stroke="#0D9488" stroke-width="2.2" stroke-linecap="round"/>
            <circle cx="21.5" cy="21.5" r="1" fill="#FFFFFF"/>
            <circle cx="26.5" cy="26.5" r="1" fill="#FFFFFF"/>
          </g>
        </g>
      </svg>
    `;
  }

  /**
   * Generates Project Workspace Hub Robot Head (Architectural Rounded Squircle with Folder Crest)
   */
  function createProjectHubSvg(project, { size = "md", state = "ready", phase = 0 } = {}) {
    const animDelay = (phase * 0.8) % 8.6;
    return `
      <svg class="robot-head-svg size-${size} bot-role-project ${state === "working" ? "is-working" : state === "paused" ? "is-paused" : ""}"
           viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"
           style="--bot-eye: #F59E0B; --bot-accent: #D97706; --bot-delay: -${animDelay.toFixed(2)}s;"
           aria-hidden="true">
        <g class="robot-head-anchor">
          <!-- Floating Folder Crest -->
          <path d="M19 4.5 C19 3.5 19.5 3 20.5 3 H23.5 L25 4.5 H28.5 C29.5 4.5 30 5 30 6 V7 H19 V4.5 Z" fill="#F59E0B"/>

          <!-- Panoramic TV Lozenge Head (项目工作区宽屏头) -->
          <rect x="5.5" y="8" width="37" height="33" rx="12" class="bot-flat-head" fill="#FFFFFF" stroke="#334155" stroke-width="2.2"/>

          <!-- Project Optics -->
          <g class="bot-gaze-group">
            <rect x="14" y="19" width="5.2" height="10.5" rx="2.6" transform="rotate(-10 16.6 24.25)" fill="#F59E0B" class="bot-eye-unit bot-eye-left"/>
            <circle cx="17.5" cy="21.5" r="0.8" fill="#FFFFFF"/>

            <rect x="28.8" y="19" width="5.2" height="10.5" rx="2.6" transform="rotate(-10 31.4 24.25)" fill="#F59E0B" class="bot-eye-unit bot-eye-right"/>
            <circle cx="32.3" cy="21.5" r="0.8" fill="#FFFFFF"/>
          </g>
        </g>
      </svg>
    `;
  }

  /**
   * Generates Cyber Coworker Robot Head SVG - Diverse Geometric Head Silhouettes with Grok Thinking Motions
   */
  function createRobotHeadSvg(coworker, { size = "md", state = "ready", phase = 0 } = {}) {
    const theme = getCoworkerTheme(coworker);
    const isWorking = state === "working" || state === "executing";
    const isAttention = state === "attention";
    const isPaused = state === "paused" || state === "offline";
    const isChief = theme.key === "chief";
    const shape = theme.shape || "circle";

    const animDelay = (phase * 0.92) % 8.6;

    return `
      <svg class="robot-head-svg size-${size} bot-role-${theme.key} bot-shape-${shape}${isWorking ? " is-working" : ""}${isAttention ? " is-attention" : ""}${isPaused ? " is-paused" : ""}"
           viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"
           style="--bot-eye: ${theme.eyeColor}; --bot-accent: ${theme.accentColor}; --bot-delay: -${animDelay.toFixed(2)}s;"
           aria-hidden="true">
        <g class="robot-head-anchor">
          <!-- Floating Crest / Antenna Tailored to Shape & Role -->
          ${renderHeadCrest(shape, theme, isChief)}

          <!-- Diverse Pure White Geometric Chassis (Circle, Squircle, Oval, Hexagon, TV, Arch, Octagon) -->
          ${renderHeadChassis(shape, theme)}

          <!-- Expressive Slanted Capsule Eyes Tailored to Shape -->
          ${renderHeadEyes(shape, theme)}
        </g>
      </svg>
    `;
  }

  function renderRobotHead(container, entity, options = {}) {
    if (!container) return;
    container.classList.add("avatar-is-robot");
    container.classList.remove("avatar-is-team");

    // Compute unique organic phase for each entity so avatars don't animate in robotic sync
    let phase = options.phase || 0;
    if (!options.phase) {
      const idStr = typeof entity === "object" ? `${entity?.id || ""}${entity?.name || ""}` : String(entity || "");
      let hash = 0;
      for (let i = 0; i < idStr.length; i++) {
        hash = (hash << 5) - hash + idStr.charCodeAt(i);
        hash |= 0;
      }
      phase = (Math.abs(hash) % 86) / 10;
    }
    const finalOpts = { ...options, phase };

    // Check entity type
    if (entity?.kind === "team" || entity === "team" || entity === "👥") {
      container.innerHTML = createTeamSquadSvg(entity, finalOpts);
      return;
    }

    if (entity?.kind === "channel" || entity === "#" || (typeof entity === "string" && (entity.startsWith("#") || entity === "project-channel"))) {
      container.innerHTML = createChannelHubSvg(entity, finalOpts);
      return;
    }

    if (entity?.kind === "project" || entity === "📁" || entity === "project") {
      container.innerHTML = createProjectHubSvg(entity, finalOpts);
      return;
    }

    // Default coworker robot
    const coworker = typeof entity === "object" ? entity : { id: String(entity || "default"), name: String(entity || "Coworker") };
    container.innerHTML = createRobotHeadSvg(coworker, finalOpts);
  }

  // Interactive Cursor Gaze Follower for Welcome Orb & Focused Avatars
  let gazeListenerInitialized = false;
  function initInteractiveGazeFollower() {
    if (gazeListenerInitialized) return;
    gazeListenerInitialized = true;

    let rafId = null;
    let targetX = 0;
    let targetY = 0;

    window.addEventListener("mousemove", (e) => {
      targetX = e.clientX;
      targetY = e.clientY;

      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const orb = document.getElementById("welcome-orb");
        if (!orb) return;

        const rect = orb.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const dx = targetX - centerX;
        const dy = targetY - centerY;
        const dist = Math.hypot(dx, dy);

        // Only track when cursor is within reasonable proximity (e.g. 500px)
        if (dist < 500 && dist > 10) {
          const angle = Math.atan2(dy, dx);
          const maxTilt = 7.5; // degrees
          const tilt = Math.max(-maxTilt, Math.min(maxTilt, (dx / 300) * maxTilt));
          const eyeOffsetMax = 2.4; // px
          const eyeX = (dx / dist) * Math.min(eyeOffsetMax, dist / 100 * eyeOffsetMax);
          const eyeY = (dy / dist) * Math.min(eyeOffsetMax, dist / 100 * eyeOffsetMax);

          const anchor = orb.querySelector(".robot-head-anchor");
          const gaze = orb.querySelector(".bot-gaze-group");
          if (anchor && gaze) {
            anchor.style.transform = `translate3d(${eyeX * 0.4}px, ${eyeY * 0.4}px, 0) rotate(${tilt}deg)`;
            gaze.style.transform = `translate3d(${eyeX}px, ${eyeY}px, 0)`;
            anchor.style.animationPlayState = "paused";
            gaze.style.animationPlayState = "paused";

            clearTimeout(orb._gazeResetTimer);
            orb._gazeResetTimer = setTimeout(() => {
              anchor.style.transform = "";
              gaze.style.transform = "";
              anchor.style.animationPlayState = "running";
              gaze.style.animationPlayState = "running";
            }, 1200);
          }
        }
      });
    }, { passive: true });
  }

  // Auto-init interactive tracker when DOM is ready
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initInteractiveGazeFollower);
    } else {
      setTimeout(initInteractiveGazeFollower, 100);
    }
  }

  // Export to window
  window.SovereignBotRobotEngine = {
    getCoworkerTheme,
    createBrandLogoSvg,
    createTeamSquadSvg,
    createChannelHubSvg,
    createProjectHubSvg,
    createRobotHeadSvg,
    renderRobotHead,
    initInteractiveGazeFollower,
    BRIGHT_BOT_THEMES
  };
  window.SovereignRobotAvatar = window.SovereignBotRobotEngine;
})();
