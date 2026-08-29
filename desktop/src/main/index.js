import { join } from "node:path";
import { app, dialog, Notification, shell } from "electron";
import { desktopVersion } from "./lib/desktop-version.js";
import { installAppProtocolHandler, registerAppSchemePrivileged } from "./protocol.js";
import { createMainWindow, appOrigin } from "./window.js";
import { bindIpcChannels } from "./ipc.js";
import { createOperatorBridge } from "./operator-bridge.js";
import { startRuntimeHost } from "./runtime-host.js";
import { createDesktopServices } from "./services.js";
import { createFirstRunService } from "./first-run.js";
import { createGoalController } from "./goal-controller.js";
import { createJobController } from "./job-controller.js";
import { createChiefLoop } from "./chief-loop.js";
import { createRoutineController } from "./routine-controller.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createArtifactStore } from "./artifact-store.js";
import { createAttachmentAwareConversationStore, pickConversationAttachments } from "./attachment-integration.js";
import { createSkillStore } from "./skill-store.js";
import { createSkillAwareConversationStore, createSkillHandlers } from "./skill-integration.js";
import { createCoworkerDispatcher } from "./coworker-dispatcher.js";
import { openProviderLogin } from "./provider-login.js";
import { validateRoleAssignment } from "./provider-roster.js";
import { attachWindowLifecycle } from "./lifecycle.js";
import { createTrayController } from "./tray.js";

const SQUIRREL_FLAGS = new Set([
    "--squirrel-install",
    "--squirrel-updated",
    "--squirrel-uninstall",
    "--squirrel-obsolete",
    "--squirrel-firstrun",
]);

function argvHasSquirrelFlag(argv) {
    return argv.slice(1).some((arg) => SQUIRREL_FLAGS.has(arg));
}

function logStartupError(scope, error) {
    const message = String(error?.stack ?? error);
    try {
        process.stderr.write(`[sovereignbot] ${scope}: ${message}\n`);
    }
    catch {}
    return message;
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
}
else if (argvHasSquirrelFlag(process.argv)) {
    app.quit();
}
else {
    registerAppSchemePrivileged();
    app.enableSandbox();
    app.setAppUserModelId("com.sovereignbot.desktop");
    app.whenReady().then(() => {
        main().catch((error) => {
            const message = logStartupError("failed to start", error);
            if (process.argv.includes("--desktop-smoke")) {
                process.stdout.write(`${JSON.stringify({ smoke: "failed", checks: {}, error: message })}\n`);
                app.exit(1);
                return;
            }
            import("electron").then(({ dialog }) => {
                dialog.showErrorBox("SovereignBot failed to start", message);
                app.exit(1);
            });
        });
    });
}

function defaultDataDir() {
    return process.env.SOVEREIGNBOT_DESKTOP_DATA_DIR ?? join(app.getPath("userData"), "data");
}

async function main() {
    if (process.argv.includes("--verify-gate")) {
        const { runVerifyGate } = await import("./verify-gate.js");
        await runVerifyGate({ app });
        return;
    }
    if (process.argv.includes("--desktop-smoke")) {
        const { runSmokeMode } = await import("./smoke.js");
        await runSmokeMode({ app });
        return;
    }

    const dataDir = defaultDataDir();
    const services = createDesktopServices({ dataDir, dialog });
    const coworkerStore = createCoworkerStore({ persistPath: join(dataDir, "desktop-state", "coworkers.json") });
    coworkerStore.ensureDefaults();
    const conversationStore = createConversationStore({
        persistPath: join(dataDir, "desktop-state", "conversations.json"),
        coworkerStore,
    });
    const artifactStore = createArtifactStore({ dataDir });
    const attachmentAwareConversationStore = createAttachmentAwareConversationStore(conversationStore, artifactStore);
    const skillStore = createSkillStore({ persistPath: join(dataDir, "desktop-state", "skills.json") });

    let host;
    try {
        host = await startRuntimeHost({
            dataDir,
            getSettings: () => services.getSettings(),
            getCoworkers: () => coworkerStore.list().coworkers,
        });
    }
    catch (error) {
        const message = logStartupError("runtime host failed", error);
        const { dialog } = await import("electron");
        dialog.showErrorBox("SovereignBot failed to start", message);
        app.exit(1);
        return;
    }

    const uninstallProtocol = installAppProtocolHandler();
    let win;
    let bridge;
    let goals;
    let jobs;
    let routines;
    let chiefLoop;
    let coworkerDispatcher;
    let quitting = false;
    let shutdownStarted = false;
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function requestQuit(reason) {
        if (shutdownStarted)
            return;
        shutdownStarted = true;
        quitting = true;
        try { routines?.stop(); } catch {}
        try { chiefLoop?.stop(); } catch {}
        try {
            await Promise.race([coworkerDispatcher?.flush?.() ?? Promise.resolve(), delay(15_000)]);
            if (goals) {
                for (const goal of goals.listGoals().goals) {
                    if (!["completed", "failed", "cancelled"].includes(goal.status)) {
                        try { await goals.cancel(goal.id); } catch {}
                    }
                }
                await Promise.race([goals.flush(), delay(15_000)]);
            }
            if (routines) await Promise.race([routines.flush(), delay(5_000)]);
            if (jobs) await Promise.race([jobs.flush(), delay(15_000)]);
            await Promise.race([host?.close(), delay(15_000)]);
        }
        finally {
            try { uninstallProtocol(); } catch {}
            try { tray?.destroy(); } catch {}
            app.exit(0);
        }
    }

    const tray = createTrayController({
        getWindow: () => win,
        onQuit: () => void requestQuit("tray-quit"),
    });

    function goalReadiness() {
        if (!host)
            return { allowed: false, reason: "runtime is starting" };
        if (quitting)
            return { allowed: false, reason: "SovereignBot is shutting down; new goals are not accepted." };
        if (host.mode === "demo")
            return { allowed: true };
        const roster = host.rosterSummary();
        return roster.ready ? { allowed: true } : { allowed: false, reason: "Connect at least one AI provider to run goals." };
    }

    const GOAL_TERMINAL = new Set(["completed", "failed", "cancelled"]);
    const goalsBusy = () => goals
        ? goals.listGoals().goals.some((goal) => !GOAL_TERMINAL.has(goal.status))
        : false;

    function rebuildRuntimeBoundServices() {
        try { routines?.stop(); } catch {}
        try { chiefLoop?.stop(); } catch {}
        bridge = createOperatorBridge(host.runtime);
        goals = createGoalController({
            runtime: host.runtime,
            services,
            supervisorAgentId: host.plannerAgentId,
            readiness: goalReadiness,
            roster: () => host.rosterSummary(),
            persistPath: join(dataDir, "desktop-state", "goals.json"),
            onTerminal: (goal) => {
                if (!services.getSettings().notifications || Notification.isSupported() === false)
                    return;
                new Notification({
                    title: `SovereignBot goal ${goal.status}`,
                    body: goal.status === "completed" ? goal.textPreview : `${goal.textPreview} — ${goal.error ?? "did not complete"}`,
                    silent: true,
                }).show();
            },
        });
        jobs = createJobController({
            dataDir,
            runtime: host.runtime,
            roster: () => host.rosterSummary(),
            coworkerStore,
            services,
            skillStore,
            supervisorAgentId: host.plannerAgentId,
            readiness: goalReadiness,
        });
        routines = createRoutineController({ dataDir, jobController: jobs, coworkerStore, skillStore, services });
        chiefLoop = createChiefLoop({ jobController: jobs, goalController: goals, roster: () => host.rosterSummary() });
        routines.start();
        chiefLoop.start();
        coworkerDispatcher = createCoworkerDispatcher({
            dataDir,
            runtime: host.runtime,
            roster: () => host.rosterSummary(),
            coworkerStore,
            conversationStore: createSkillAwareConversationStore(attachmentAwareConversationStore, skillStore),
            artifactStore,
            services,
        });
    }

    const firstRun = createFirstRunService({ host, services });
    rebuildRuntimeBoundServices();

    async function applyProviderRefresh(refresh) {
        if (refresh.applied) {
            rebuildRuntimeBoundServices();
            bindHandlers();
        }
        return { ...refresh, roster: host.rosterSummary() };
    }

    async function refreshCoworkerRuntime() {
        return applyProviderRefresh(await host.refreshProviders({ isBusy: goalsBusy }));
    }

    function bindHandlers() {
        bindIpcChannels({
            win,
            handlers: {
                "app:handshake": async () => ({ ok: true, version: desktopVersion(), platform: process.platform, locale: app.getLocale(), language: services.getSettings().language }),
                ...bridge.handlers,
                "firstrun:getStatus": () => firstRun.getStatus(),
                "computer:browserStatus": async () => (await firstRun.getStatus()).browsers,
                "computer:provisionDriver": async () => {
                    const result = await firstRun.provisionManagedBrowserDriver();
                    const refresh = await host.refreshProviders({ isBusy: goalsBusy });
                    await applyProviderRefresh(refresh);
                    return { ...result, refresh };
                },
                "workspace:addViaDialog": () => services.addWorkspaceViaDialog(win),
                "workspace:list": () => services.listWorkspaces(),
                "workspace:setDefault": ({ id }) => ({ ok: services.setDefaultWorkspace(id) }),
                "workspace:remove": ({ id }) => ({ removed: services.removeWorkspace(id) }),
                "settings:get": () => services.getSettings(),
                "settings:update": (patch) => services.updateSettings(patch),
                "provider:getRoster": () => host.rosterSummary(),
                "provider:refresh": async () => applyProviderRefresh(await host.refreshProviders({ isBusy: goalsBusy })),
                "provider:openLogin": async ({ provider }) => {
                    const resolver = provider === "codex"
                        ? () => host.coreModules.resolveCodexLaunch({})
                        : () => host.coreModules.resolveClaudeCodeLaunch({});
                    const login = await openProviderLogin({ resolver, label: provider });
                    const refresh = applyProviderRefresh(await host.refreshProviders({ isBusy: goalsBusy }));
                    return { login, refresh: await refresh };
                },
                "provider:setRoleAssignment": async ({ role, agentId }) => {
                    validateRoleAssignment(host.rosterSummary(), { role, agentId });
                    services.updateSettings({ roles: { [role]: agentId } });
                    return applyProviderRefresh(await host.refreshProviders({ isBusy: goalsBusy }));
                },
                "coworker:list": ({ includeArchived }) => coworkerStore.list({ includeArchived }),
                "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
                "coworker:create": async ({ coworker }) => {
                    const created = coworkerStore.create(coworker);
                    return { coworker: created, refresh: await refreshCoworkerRuntime() };
                },
                "coworker:update": async ({ coworkerId, patch }) => {
                    const updated = coworkerStore.update(coworkerId, patch);
                    return { coworker: updated, refresh: await refreshCoworkerRuntime() };
                },
                "coworker:archive": async ({ coworkerId }) => {
                    const updated = coworkerStore.archive(coworkerId);
                    return { coworker: updated, refresh: await refreshCoworkerRuntime() };
                },
                "coworker:restore": async ({ coworkerId }) => {
                    const updated = coworkerStore.restore(coworkerId);
                    return { coworker: updated, refresh: await refreshCoworkerRuntime() };
                },
                ...createSkillHandlers({
                    skillStore,
                    conversationStore,
                    dispatchMessage: (conversationId, messageId) => coworkerDispatcher.dispatchMessage(conversationId, messageId),
                }),
                "conversation:list": () => conversationStore.list(),
                "conversation:get": ({ conversationId }) => conversationStore.get(conversationId),
                "conversation:createDirect": ({ coworkerId }) => conversationStore.createDirect(coworkerId),
                "conversation:createTeam": ({ title, coworkerIds }) => conversationStore.createTeam({ title, coworkerIds }),
                "artifact:list": ({ conversationId, coworkerId, limit }) => artifactStore.list({ conversationId, coworkerId, limit }),
                "artifact:get": ({ artifactId }) => artifactStore.get(artifactId),
                "artifact:preview": ({ artifactId }) => artifactStore.previewText(artifactId),
                "artifact:attachViaDialog": ({ conversationId }) => pickConversationAttachments({ win, dialog, artifactStore, conversationId }),
                "artifact:reveal": ({ artifactId }) => {
                    shell.showItemInFolder(artifactStore.managedPath(artifactId));
                    return { ok: true };
                },
                "goal:submit": ({ text, workspaceId }) => goals.submitGoal({ text, workspaceId }),
                "goal:list": () => goals.listGoals(),
                "goal:getStatus": ({ goalId }) => goals.getGoal(goalId),
                "goal:getConversation": ({ goalId }) => goals.getConversation(goalId),
                "goal:cancel": async ({ goalId }) => await goals.cancel(goalId),
                "job:submit": (payload) => jobs.submitJob(payload),
                "job:list": () => jobs.listJobs(),
                "job:getStatus": ({ jobId }) => jobs.getJob(jobId),
                "job:getConversation": ({ jobId }) => jobs.getConversation(jobId),
                "job:cancel": async ({ jobId }) => await jobs.cancel(jobId),
                "job:pause": async ({ jobId }) => await jobs.pause(jobId),
                "job:resume": async ({ jobId }) => await jobs.resume(jobId),
                "job:approve": async ({ jobId }) => await jobs.approve(jobId),
                "job:dismiss": async ({ jobId }) => await jobs.dismiss(jobId),
                "job:attention": () => jobs.attentionJobs(),
                "routine:create": (payload) => routines.create(payload),
                "routine:list": () => routines.list(),
                "routine:get": ({ routineId }) => routines.get(routineId),
                "routine:history": ({ routineId }) => routines.history(routineId),
                "routine:setEnabled": ({ routineId, enabled }) => routines.setEnabled(routineId, enabled),
                "routine:remove": ({ routineId }) => routines.remove(routineId),
            },
        });
    }

    const start = async () => {
        win = createMainWindow();
        attachWindowLifecycle({
            win,
            getCloseBehavior: () => services.getSettings().closeBehavior,
            rememberCloseBehavior: (value) => services.updateSettings({ closeBehavior: value }),
            tray,
            isQuitting: () => quitting,
        });
        bindHandlers();
        await win.loadURL(appOrigin());
        win.on("closed", () => (win = undefined));
    };
    await start();

    if (host.mode !== "demo") {
        void host.refreshProviders({ isBusy: goalsBusy })
            .then((refresh) => applyProviderRefresh(refresh))
            .catch((error) => logStartupError("background provider refresh failed", error));
    }

    app.on("second-instance", () => {
        if (!win)
            return;
        if (win.isMinimized())
            win.restore();
        win.focus();
    });

    app.on("window-all-closed", () => { void requestQuit("window-closed"); });
}
