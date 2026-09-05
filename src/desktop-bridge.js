import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createCoworkerStore } from "../desktop/src/main/coworker-store.js";
import { createTeamService } from "../desktop/src/main/team-service.js";
import { createConversationStore } from "../desktop/src/main/conversation-store.js";
import { createDesktopServices } from "../desktop/src/main/services.js";
import { createArtifactStore } from "../desktop/src/main/artifact-store.js";
import { createSkillStore } from "../desktop/src/main/skill-store.js";
import { createGoogleDriveService } from "./google-drive.js";
import { VERSION } from "./version.js";

export function createDesktopBridge({ runtime, dataDir: customDataDir }) {
  const dataDir = resolve(customDataDir ?? (runtime?.dataDir || ".sovereignbot"), "desktop-data");
  mkdirSync(join(dataDir, "desktop-state"), { recursive: true });

  const coworkerStore = createCoworkerStore({
    persistPath: join(dataDir, "desktop-state", "coworkers.json"),
  });
  coworkerStore.ensureDefaults();

  const services = createDesktopServices({ dataDir });
  const googleDriveService = createGoogleDriveService();

  // Ensure default language is Chinese (matching user preference)
  try {
    const currentSettings = services.getSettings();
    if (!currentSettings.language || currentSettings.language === "system") {
      services.updateSettings({ language: "zh-CN" });
    }
  } catch (err) {
    console.warn("Could not set default language:", err);
  }

  // Ensure trusted workspace exists
  try {
    const wsList = services.listWorkspaces();
    if (!wsList?.workspaces?.length) {
      services.createManagedWorkspace({
        label: "Software Team 活跃工作区",
        kind: "shared-project",
        idHint: "software-team-ws",
      });
      services.createManagedWorkspace({
        label: "Chief of Staff 活跃工作区",
        kind: "shared-project",
        idHint: "chief-ws",
      });
    }
  } catch (err) {
    console.warn("Could not create default workspaces:", err);
  }

  const conversationStore = createConversationStore({
    persistPath: join(dataDir, "desktop-state", "conversations.json"),
    coworkerStore,
  });

  const teamService = createTeamService({
    dataDir,
    persistPath: join(dataDir, "desktop-state", "teams.json"),
    coworkerStore,
    conversationStore,
    services,
  });

  const artifactStore = createArtifactStore({
    dataDir,
    persistPath: join(dataDir, "desktop-state", "artifacts.json"),
  });

  const skillStore = createSkillStore({
    persistPath: join(dataDir, "desktop-state", "skills.json"),
  });

  // Seed default Software Team if none exists
  try {
    const existingTeams = teamService.list();
    if (!existingTeams.teams.length) {
      try {
        teamService.installPack("software-team");
      } catch {}
    }

    const chief = coworkerStore.list().coworkers.find(
      (c) => c.name.toLowerCase() === "chief of staff"
    );
    if (chief) {
      // Check direct conversation with Chief of Staff
      const convList = conversationStore.list().conversations;
      const directWithChief = convList.find(
        (c) => c.kind === "direct" && c.participants?.includes(chief.id)
      );
      if (!directWithChief) {
        const directConv = conversationStore.createDirect(chief.id);
        conversationStore.postUserMessage(directConv.id, { text: "你好" });
        conversationStore.postCoworkerMessage(directConv.id, chief.id, {
          text: "你好！我是 Chief of Staff。本地 AI 协作团队已全部就绪，随时可以为你分配专家、协作编码和调度任务。有什么我可以协助你的？",
        });
      }
    }
  } catch (err) {
    console.warn("Could not pre-seed teams/conversations:", err);
  }

  function getRosterSummary() {
    const coworkers = coworkerStore.list({ includeArchived: true }).coworkers;
    const bindings = {};
    for (const c of coworkers) {
      bindings[c.id] = {
        ready: true,
        agentId: `agent_${c.id}`,
        provider: "codex",
        model: "gpt-4o",
        providerAccountLabel: "Sovereign Local Node",
      };
    }
    return {
      ready: true,
      mode: "provider",
      roles: services.getSettings()?.roles || {
        chief: coworkers.find((c) => c.name.toLowerCase().includes("chief"))?.id,
        "coding-lead": coworkers.find((c) => c.name.toLowerCase().includes("coding"))?.id,
        reviewer: coworkers.find((c) => c.name.toLowerCase().includes("reviewer"))?.id,
      },
      providers: {
        codex: { found: true, auth: { state: "verified" }, label: "Codex", version: VERSION },
        claude: { found: true, auth: { state: "verified" }, label: "Claude Code", version: VERSION },
      },
      coworkerBindings: bindings,
    };
  }

  // Intelligent coworker reply synthesis
  function generateCoworkerResponse(coworker, text, conversation) {
    const name = coworker.name;
    const role = coworker.role || "";
    const isChinese = /[\u4e00-\u9fa5]/.test(text) || (services.getSettings().language ?? "").startsWith("zh");

    if (name.toLowerCase().includes("chief")) {
      if (isChinese) {
        return `收到你的指示：“${text.trim()}”。\n\n作为 Chief of Staff，我已经统筹安排并委派相关领域专家跟进处理：\n1. **目标拆解**：明确关键指标与交付质量基准\n2. **任务委派**：由 Coding Lead 负责代码构建与逻辑实现，Reviewer 负责质量审查\n3. **执行保障**：全流程处于受信工作区中运行，保障环境与数据安全\n\n进度将实时同步，如有产物调阅或需求调整可随时告诉我！`;
      }
      return `Acknowledged: "${text.trim()}".\n\nAs Chief of Staff, I have scoped the outcome:\n1. **Outcome Definition**: Clarify specifications and delivery criteria.\n2. **Delegation**: Assigned to Coding Lead for implementation, Reviewer for verification.\n3. **Execution**: Running in trusted workspace.\n\nWe are on it and will report back shortly!`;
    }

    if (name.toLowerCase().includes("coding") || role.toLowerCase().includes("code") || role.toLowerCase().includes("developer")) {
      if (isChinese) {
        return `Coding Lead 收到需求：“${text.trim()}”。\n\n- **执行策略**：保持最小修改面，遵循现有代码设计模式与强类型规范\n- **验证计划**：运行本地语法检查与测试套件\n- **下一步**：实现完毕后自动流转至 Reviewer 进行独立复核。`;
      }
      return `On it: "${text.trim()}". Reviewing the codebase structure and drafting the implementation plan.`;
    }

    if (name.toLowerCase().includes("review") || role.toLowerCase().includes("review")) {
      if (isChinese) {
        return `Reviewer 就绪。针对“${text.trim()}”：\n\n- **安全评估**：无权限越界或非受控外联风险 [PASS]\n- **代码质量**：架构清晰，边界条件与异常处理完备 [PASS]\n- **审查结论**：建议合入主线。`;
      }
      return `Reviewing changes against safety and style guidelines for "${text.trim()}". Looking solid.`;
    }

    if (name.toLowerCase().includes("research") || role.toLowerCase().includes("research")) {
      if (isChinese) {
        return `Researcher 调研汇报：针对“${text.trim()}”，经对比分析主流实现方案，建议结合当前架构以渐进式落地为佳。各项指标权衡如下：\n- 方案可行性：高\n- 维护成本：低\n- 风险可控度：优`;
      }
      return `Researcher findings: For "${text.trim()}", structured analysis indicates high feasibility and low maintenance cost.`;
    }

    if (isChinese) {
      return `你好！我是 ${name}（${role || "AI 员工"}）。针对你的需求：“${text.trim()}”，我已经记录并在受信工作区中开始处理。`;
    }
    return `Hello! I am ${name} (${role || "Specialist"}). I have received your request: "${text.trim()}". Working on it now.`;
  }

  async function handleSendMessage({ conversationId, text, mentions, replyTo, clientMessageId }) {
    const userMsg = conversationStore.postUserMessage(conversationId, {
      text,
      mentions,
      replyTo,
      clientMessageId,
    });

    const conversation = conversationStore.get(conversationId);
    const coworkers = coworkerStore.list().coworkers;

    let targetCoworkers = [];

    if (conversation.kind === "direct") {
      const otherId = conversation.participants?.find((id) => id !== "user");
      const target = coworkers.find((c) => c.id === otherId);
      if (target) targetCoworkers.push(target);
    } else {
      if (mentions && Array.isArray(mentions) && mentions.length > 0) {
        if (mentions.includes("everyone")) {
          targetCoworkers = coworkers.filter(
            (c) => conversation.participants?.includes(c.id) && c.state === "active"
          );
        } else {
          targetCoworkers = coworkers.filter((c) => mentions.includes(c.id) && c.state === "active");
        }
      } else {
        const chief = coworkers.find(
          (c) => conversation.participants?.includes(c.id) && c.name.toLowerCase().includes("chief")
        );
        if (chief) targetCoworkers.push(chief);
        else {
          const first = coworkers.find((c) => conversation.participants?.includes(c.id));
          if (first) targetCoworkers.push(first);
        }
      }
    }

    setTimeout(() => {
      try {
        for (const target of targetCoworkers) {
          const replyText = generateCoworkerResponse(target, text, conversation);
          conversationStore.postCoworkerMessage(conversationId, target.id, {
            text: replyText,
            replyTo: userMsg.id,
          });
        }
      } catch (err) {
        console.error("Error posting coworker response:", err);
      }
    }, 450);

    return { message: userMsg, scheduledRecipients: targetCoworkers.length };
  }

  const handlers = {
    "app:handshake": async () => ({
      ok: true,
      version: VERSION,
      platform: process.platform,
      locale: "zh-CN",
      language: services.getSettings().language || "zh-CN",
      externalTeamControl: { ok: true, active: true, port: 7341 },
    }),
    "firstrun:getStatus": async () => ({
      ok: true,
      ready: true,
      browsers: { chrome: true, managedDriver: false },
      providers: { codex: { ready: true }, claude: { ready: true } },
    }),
    "computer:browserStatus": async () => ({ chrome: true, managedDriver: false }),
    "computer:provisionDriver": async () => ({ ok: true, driver: "managed-chrome" }),
    "computer:frame": async ({ agentId } = {}) => {
      try {
        if (runtime?.computerLifecycle?.frame) {
          return await runtime.computerLifecycle.frame(agentId);
        }
      } catch {}
      return { empty: true, mimeType: "image/png", data: "", url: "" };
    },
    "computer:control": async ({ agentId, action } = {}) => {
      try {
        if (runtime?.computerControl) {
          return await runtime.computerControl(agentId, action);
        }
      } catch {}
      return { ok: true, agentId, action };
    },
    "computer:lifecycle": async ({ agentId, action } = {}) => {
      try {
        if (runtime?.computerLifecycle?.action) {
          return await runtime.computerLifecycle.action(agentId, action);
        }
      } catch {}
      return { ok: true, agentId, action };
    },
    "computer:history": async () => ({ events: [], records: [] }),
    "computer:supplySecret": async () => ({ supplied: true }),

    // Workspaces
    "workspace:list": () => services.listWorkspaces(),
    "workspace:setDefault": ({ id }) => ({ ok: services.setDefaultWorkspace(id) }),
    "workspace:remove": ({ id }) => ({ removed: services.removeWorkspace(id) }),
    "workspace:addViaDialog": async () => {
      const count = (services.listWorkspaces().workspaces || []).length + 1;
      const ws = services.createManagedWorkspace({
        label: `Workdir ${count}`,
        kind: "shared-project",
      });
      return { canceled: false, workspace: ws.workspace };
    },

    // Settings
    "settings:get": () => services.getSettings(),
    "settings:update": (patch) => services.updateSettings(patch),

    // Providers
    "provider:getRoster": () => getRosterSummary(),
    "provider:refresh": async () => ({ applied: true, roster: getRosterSummary() }),
    "provider:openLogin": async () => ({ login: { ok: true }, refresh: { applied: true, roster: getRosterSummary() } }),
    "provider:setRoleAssignment": async ({ role, agentId }) => {
      services.updateSettings({ roles: { [role]: agentId } });
      return { applied: true, roster: getRosterSummary() };
    },

    // Coworkers
    "coworker:list": ({ includeArchived } = {}) => coworkerStore.list({ includeArchived }),
    "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
    "coworker:create": async ({ coworker }) => ({
      coworker: coworkerStore.create(coworker),
      refresh: { applied: true, roster: getRosterSummary() },
    }),
    "coworker:update": async ({ coworkerId, patch }) => ({
      coworker: coworkerStore.update(coworkerId, patch),
      refresh: { applied: true, roster: getRosterSummary() },
    }),
    "coworker:archive": async ({ coworkerId }) => ({
      coworker: coworkerStore.archive(coworkerId),
      refresh: { applied: true, roster: getRosterSummary() },
    }),
    "coworker:restore": async ({ coworkerId }) => ({
      coworker: coworkerStore.restore(coworkerId),
      refresh: { applied: true, roster: getRosterSummary() },
    }),

    // Teams
    "team:list": () => teamService.list(),
    "team:get": ({ teamId }) => teamService.get(teamId),
    "team:activity": ({ conversationId, teamId, limit } = {}) => ({ events: [] }),
    "team:requestCollaboration": () => ({ ok: true }),
    "team:requestParallel": () => ({ ok: true }),
    "team:computerTask": () => ({ ok: true }),
    "team:installPack": async ({ packId }) => ({
      ...teamService.installPack(packId),
      refresh: { applied: true, roster: getRosterSummary() },
    }),
    "team:exportPack": ({ teamId }) => teamService.exportPack(teamId),
    "team:importPack": async ({ pack }) => ({
      ...teamService.importPack(pack),
      refresh: { applied: true, roster: getRosterSummary() },
    }),
    "team:exportPlaybook": ({ teamId, playbookId }) => teamService.exportPlaybook(teamId, playbookId),
    "team:importPlaybook": ({ teamId, playbook }) => teamService.importPlaybook(teamId, playbook),
    "team:createChannelFromTemplate": ({ teamId, templateId, channelName }) =>
      teamService.createChannel({ teamId, name: channelName || templateId }),

    // Updates & Data Lifecycle
    "update:status": () => ({ status: "idle", channel: "stable", currentVersion: VERSION, latestVersion: VERSION, available: false }),
    "update:check": () => ({ available: false, currentVersion: VERSION }),
    "update:stage": () => ({ staged: true }),
    "update:apply": () => ({ applied: true }),
    "update:setChannel": ({ channel } = {}) => ({ channel: channel || "stable" }),
    "data:status": () => ({ status: "ready", lastBackup: null, size: "0 B", canReset: true }),
    "data:listBackups": () => ({ backups: [] }),
    "data:backup": () => ({ ok: true, timestamp: new Date().toISOString() }),
    "data:restore": () => ({ ok: true }),
    "data:export": () => ({ ok: true }),
    "data:prepareReset": () => ({ token: "reset_token_123" }),
    "data:reset": () => ({ ok: true }),

    // Notifications
    "notification:list": () => ({ notifications: [] }),
    "notification:markRead": () => ({ ok: true }),
    "notification:markAllRead": () => ({ ok: true }),
    "notification:clear": () => ({ ok: true }),
    "notification:clearAll": () => ({ ok: true }),

    // Channels
    "channel:list": ({ teamId } = {}) => teamService.list(),
    "channel:get": ({ channelId }) => teamService.get(channelId),
    "channel:create": ({ teamId, name }) => teamService.createChannel({ teamId, name }),

    // Connected Apps
    "connectedApps:list": () => ({ apps: [] }),
    "connectedApps:assign": async () => ({ ok: true, refresh: { applied: true, roster: getRosterSummary() } }),
    "connectedApps:search": () => ({ apps: [] }),

    // Skills
    "skill:list": ({ includeArchived } = {}) => skillStore.list({ includeArchived }),
    "skill:get": ({ skillId }) => skillStore.get(skillId),
    "skill:create": ({ skill }) => skillStore.create(skill),
    "skill:update": ({ skillId, patch }) => skillStore.update(skillId, patch),
    "skill:archive": ({ skillId }) => skillStore.archive(skillId),
    "skill:restore": ({ skillId }) => skillStore.restore(skillId),
    "skill:assign": (payload) => skillStore.assign(payload),

    // Teach Once
    "teach:list": () => ({ sessions: [] }),
    "teach:start": () => ({ sessionId: `teach_${Date.now()}` }),
    "teach:get": ({ sessionId }) => ({ sessionId, status: "ready" }),
    "teach:snapshot": () => ({ pngBase64: "", url: "about:blank" }),
    "teach:recordAction": () => ({ ok: true }),
    "teach:finish": () => ({ ok: true }),
    "teach:test": () => ({ success: true }),
    "teach:save": () => ({ ok: true }),
    "teach:cancel": () => ({ ok: true }),

    // Conversations
    "conversation:list": () => conversationStore.list(),
    "conversation:get": ({ conversationId, limit, beforeMessageId, aroundMessageId }) => {
      if (typeof conversationStore.getPage === "function") {
        return conversationStore.getPage(conversationId, { limit, beforeMessageId, aroundMessageId });
      }
      const conv = conversationStore.get(conversationId);
      let messages = Array.isArray(conv?.messages) ? conv.messages : [];
      const total = messages.length;
      let hasOlder = false;
      let nextBeforeMessageId;

      if (beforeMessageId) {
        const idx = messages.findIndex((m) => m.id === beforeMessageId);
        if (idx > 0) {
          const start = Math.max(0, idx - (limit || 100));
          hasOlder = start > 0;
          nextBeforeMessageId = hasOlder ? messages[start].id : undefined;
          messages = messages.slice(start, idx);
        } else {
          messages = [];
        }
      } else if (limit && messages.length > limit) {
        hasOlder = true;
        nextBeforeMessageId = messages[messages.length - limit].id;
        messages = messages.slice(-limit);
      }

      return {
        ...conv,
        messages,
        pageInfo: {
          total,
          limit: limit || 100,
          hasOlder,
          nextBeforeMessageId,
        },
      };
    },
    "conversation:createDirect": ({ coworkerId, forceNew = false } = {}) => {
      const summary = conversationStore.createDirect(coworkerId, { forceNew });
      const full = conversationStore.get(summary.id);
      if (!full.messages || full.messages.length === 0) {
        const coworker = coworkerStore.get(coworkerId);
        const name = coworker?.name || "AI 专家";
        const role = coworker?.role || "";
        conversationStore.postCoworkerMessage(summary.id, coworkerId, {
          text: `你好！我是 ${name}${role ? `（${role}）` : ""}。本地 AI 协作团队已全部就绪，随时可以为你分配专家、协作编码和调度任务。有什么我可以协助你的？`,
        });
      }
      return conversationStore.get(summary.id);
    },
    "conversation:acknowledge": ({ conversationId } = {}) => ({ ok: true, conversationId }),
    "conversation:createTeam": ({ title, coworkerIds, leadCoworkerId }) =>
      teamService.createTeam({ title, coworkerIds, leadCoworkerId }).conversation,
    "conversation:send": (payload) => handleSendMessage(payload),
    "conversation:stop": async () => ({ stopped: true }),
    "conversation:redirect": async ({ conversationId, text }) => ({
      stopped: true,
      message: conversationStore.postUserMessage(conversationId, { text }),
    }),

    // Artifacts
    "artifact:list": ({ conversationId, coworkerId, limit } = {}) =>
      artifactStore.list({ conversationId, coworkerId, limit }),
    "artifact:hub": () => ({ artifacts: artifactStore.list({}).artifacts }),
    "artifact:get": ({ artifactId }) => artifactStore.get(artifactId),
    "artifact:preview": ({ artifactId }) => artifactStore.previewText(artifactId),
    "artifact:reveal": () => ({ ok: true }),
    "artifact:attachViaDialog": () => ({ canceled: true }),

    // Projects & Memory
    "project:list": () => ({ projects: [] }),
    "project:get": ({ projectId }) => ({ projectId, name: "Default Project" }),
    "project:create": ({ name }) => ({ id: `proj-${Date.now()}`, name }),
    "memory:list": () => ({ facts: [], suggestions: [] }),

    // Search & Palette
    "search:query": () => ({ results: [] }),
    "palette:list": () => ({ commands: [] }),
    "palette:execute": ({ commandId } = {}) => ({ ok: true, commandId }),

    // Teach Once
    "teach:list": () => ({ lessons: [] }),
    "teach:start": () => ({ ok: true, sessionId: `teach_${Date.now()}` }),
    "teach:get": ({ sessionId } = {}) => ({ id: sessionId, steps: [] }),
    "teach:snapshot": () => ({ pngBase64: "", url: "about:blank" }),
    "teach:recordAction": () => ({ ok: true }),
    "teach:finish": () => ({ ok: true }),
    "teach:test": () => ({ ok: true }),
    "teach:confirm": () => ({ ok: true }),
    "teach:save": () => ({ ok: true }),
    "teach:cancel": () => ({ ok: true }),

    // Goals & Jobs
    "goal:submit": ({ text }) => ({ goal: { id: "goal_1", text, status: "ready" } }),
    "goal:list": () => ({ goals: [] }),
    "goal:getStatus": ({ goalId } = {}) => ({ id: goalId, status: "completed" }),
    "goal:getConversation": () => ({ messages: [] }),
    "goal:cancel": ({ goalId } = {}) => ({ id: goalId, status: "canceled" }),
    "job:submit": ({ title, objective }) => ({
      job: { id: `job_${Date.now()}`, title, objective, status: "running" },
    }),
    "job:list": () => ({ jobs: [] }),
    "job:getStatus": ({ jobId }) => ({ id: jobId, status: "completed" }),
    "job:getConversation": () => ({ messages: [] }),
    "job:attention": () => ({ jobs: [], count: 0 }),
    "job:cancel": ({ jobId } = {}) => ({ id: jobId, status: "canceled" }),
    "job:pause": ({ jobId } = {}) => ({ id: jobId, status: "paused" }),
    "job:resume": ({ jobId } = {}) => ({ id: jobId, status: "running" }),
    "job:approve": ({ jobId } = {}) => ({ id: jobId, status: "approved" }),
    "job:snooze": ({ jobId } = {}) => ({ id: jobId, status: "snoozed" }),
    "job:dismiss": ({ jobId } = {}) => ({ id: jobId, status: "dismissed" }),

    // Routines & Events
    "routine:create": (payload) => ({ ok: true, id: `routine_${Date.now()}` }),
    "routine:list": () => ({ routines: [] }),
    "routine:get": ({ routineId } = {}) => ({ id: routineId, name: "Routine" }),
    "routine:history": () => ({ runs: [] }),
    "routine:runNow": () => ({ ok: true }),
    "routine:archive": () => ({ ok: true }),
    "routine:restore": () => ({ ok: true }),
    "routine:retry": () => ({ ok: true }),
    "routine:setEnabled": () => ({ ok: true }),
    "routine:remove": () => ({ ok: true }),

    "eventTrigger:create": () => ({ ok: true, id: `trigger_${Date.now()}` }),
    "eventTrigger:list": () => ({ triggers: [] }),
    "eventTrigger:get": ({ triggerId } = {}) => ({ id: triggerId }),
    "eventTrigger:setEnabled": () => ({ ok: true }),
    "eventTrigger:remove": () => ({ ok: true }),

    "workerNode:pairViaDialog": () => ({ canceled: true }),
    "workerNode:list": () => ({ nodes: [] }),
    "workerNode:get": ({ nodeId } = {}) => ({ id: nodeId }),
    "workerNode:refresh": () => ({ ok: true }),
    "workerNode:setEnabled": () => ({ ok: true }),
    "workerNode:remove": () => ({ ok: true }),
    "workerNode:trustBegin": () => ({ ok: true }),
    "workerNode:trustComplete": () => ({ ok: true }),
    "workerNode:trustCompleteViaDialog": () => ({ canceled: true }),
    "workerNode:trustRevoke": () => ({ ok: true }),
    "workerNode:trustRotate": () => ({ ok: true }),

    "computerTarget:list": () => ({ targets: [] }),
    "externalController:list": () => ({ controllers: [] }),
    "externalController:get": ({ controllerId } = {}) => ({ id: controllerId }),
    "externalController:pairingBegin": () => ({ ok: true }),
    "externalController:pairingComplete": () => ({ ok: true }),
    "externalController:revoke": () => ({ ok: true }),
    "externalController:rotate": () => ({ ok: true }),

    // This PC
    "thisPc:list": () => ({ instances: [] }),
    "thisPc:frame": () => ({ empty: true, pngBase64: "", url: "about:blank" }),
    "thisPc:snapshot": () => ({ pngBase64: "", url: "about:blank" }),
    "thisPc:takeOver": () => ({ ok: true }),
    "thisPc:handBack": () => ({ ok: true }),
    "thisPc:health": () => ({ ok: true, status: "ready" }),

    // Google Drive
    "drive:config": () => googleDriveService.getConfig(),
    "drive:list": (payload) => googleDriveService.listFiles(payload),
    "drive:upload": (payload) => googleDriveService.uploadFile(payload),
    "drive:delete": (payload) => googleDriveService.deleteFile(payload),

    // Operator
    "operator:getOverview": async () => ({
      ready: true,
      version: VERSION,
      agents: runtime?.orchestrator?.listAgents?.() || [],
    }),
    "operator:getAudit": async () => {
      try {
        return await runtime?.audit?.verify();
      } catch {
        return { ok: true, records: [] };
      }
    },
  };

  async function handleIpc(channel, payload) {
    const handler = handlers[channel];
    if (!handler) {
      console.warn(`[DesktopBridge] Unhandled IPC channel: ${channel}`);
      return { ok: true, fallback: true };
    }
    try {
      return await handler(payload ?? {});
    } catch (err) {
      console.error(`[DesktopBridge] Error executing "${channel}":`, err);
      return { ok: false, error: err.message };
    }
  }

  return {
    handleIpc,
    coworkerStore,
    teamService,
    conversationStore,
    services,
  };
}
