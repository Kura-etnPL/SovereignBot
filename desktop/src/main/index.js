import { join } from "node:path";
import { app, dialog, Notification } from "electron";
import { desktopVersion } from "./lib/desktop-version.js";
import { installAppProtocolHandler, registerAppSchemePrivileged } from "./protocol.js";
import { createMainWindow, appOrigin } from "./window.js";
import { bindIpcChannels } from "./ipc.js";
import { createOperatorBridge } from "./operator-bridge.js";
import { startRuntimeHost } from "./runtime-host.js";
import { createDesktopServices } from "./services.js";
import { createFirstRunService } from "./first-run.js";
import { createGoalController } from "./goal-controller.js";
import { openProviderLogin } from "./provider-login.js";
import { validateRoleAssignment } from "./provider-roster.js";
import { attachWindowLifecycle } from "./lifecycle.js";
import { createTrayController } from "./tray.js";

// Squirrel.Windows launches the executable with --squirrel-* events during
// install/update/uninstall; none of them should boot a runtime or open a window.
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

if (!app.requestSingleInstanceLock()) {
    // A second launcher must never start a second runtime against the same dataDir.
    app.quit();
}
else if (argvHasSquirrelFlag(process.argv)) {
    app.quit();
}
else {
    // Privileged scheme registration must happen before app.ready.
    registerAppSchemePrivileged();
    app.enableSandbox();
    app.setAppUserModelId("com.sovereignbot.desktop");
    app.whenReady().then(() => {
        main().catch((error) => {
            const message = String(error?.stack ?? error);
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
    if (process.argv.includes("--desktop-smoke")) {
        const { runSmokeMode } = await import("./smoke.js");
        await runSmokeMode({ app });
        return;
    }

    const dataDir = defaultDataDir();
    const services = createDesktopServices({ dataDir, dialog });

    let host;
    try {
        host = await startRuntimeHost({
            dataDir,
            getSettings: () => services.getSettings(),
        });
    }
    catch (error) {
        // Fail visibly instead of silently degrading: no roster, no runtime, no Echo.
        const { dialog } = await import("electron");
        dialog.showErrorBox("SovereignBot failed to start", String(error?.stack ?? error));
        app.exit(1);
        return;
    }

    const uninstallProtocol = installAppProtocolHandler();

    let win;
    let bridge;
    let goals;
    let quitting = false;
    let shutdownStarted = false;

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Central graceful shutdown: refuse new goals, cancel active ones, wait for the
    // pump within a bound, close the runtime (which closes governed bridges and the
    // managed driver factory), then tear down protocol and tray. No provider child
    // survives: task cancellation aborts its harness controller.
    async function requestQuit(reason) {
        if (shutdownStarted)
            return;
        shutdownStarted = true;
        quitting = true;
        try {
            if (goals) {
                for (const goal of goals.listGoals().goals) {
                    if (!["completed", "failed", "cancelled"].includes(goal.status)) {
                        try {
                            await goals.cancel(goal.id);
                        }
                        catch {
                        }
                    }
                }
                await Promise.race([goals.flush(), delay(15_000)]);
            }
            await Promise.race([host?.close(), delay(15_000)]);
        }
        finally {
            try {
                uninstallProtocol();
            }
            catch {
            }
            try {
                tray?.destroy();
            }
            catch {
            }
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
        return roster.ready
            ? { allowed: true }
            : { allowed: false, reason: "Connect at least one AI provider to run goals." };
    }

    const GOAL_TERMINAL = new Set(["completed", "failed", "cancelled"]);
    const goalsBusy = () => goals
        ? goals.listGoals().goals.some((goal) => !GOAL_TERMINAL.has(goal.status))
        : false;

    function rebuildRuntimeBoundServices() {
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

    function bindHandlers() {
        bindIpcChannels({
            win,
            handlers: {
                "app:handshake": async () => ({
                    ok: true,
                    version: desktopVersion(),
                    platform: process.platform,
                    locale: app.getLocale(),
                }),
                ...bridge.handlers,
                "firstrun:getStatus": () => firstRun.getStatus(),
                "computer:browserStatus": async () => (await firstRun.getStatus()).browsers,
                "computer:provisionDriver": async () => {
                    const result = await firstRun.provisionManagedBrowserDriver();
                    // A newly provisioned driver must reach the runtime: refresh applies
                    // the new computer config + worker browser capability when idle.
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
                "goal:submit": ({ text, workspaceId }) => goals.submitGoal({ text, workspaceId }),
                "goal:list": () => goals.listGoals(),
                "goal:getStatus": ({ goalId }) => goals.getGoal(goalId),
                "goal:getConversation": ({ goalId }) => goals.getConversation(goalId),
                "goal:cancel": async ({ goalId }) => await goals.cancel(goalId),
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

    app.on("second-instance", () => {
        if (!win)
            return;
        if (win.isMinimized())
            win.restore();
        win.focus();
    });

    app.on("window-all-closed", () => {
        void requestQuit("window-closed");
    });
}
