import { join } from "node:path";
import { app, dialog } from "electron";
import { desktopVersion } from "./lib/desktop-version.js";
import { installAppProtocolHandler, registerAppSchemePrivileged } from "./protocol.js";
import { createMainWindow, appOrigin } from "./window.js";
import { bindIpcChannels } from "./ipc.js";
import { createOperatorBridge } from "./operator-bridge.js";
import { startRuntimeHost } from "./runtime-host.js";
import { createDesktopServices } from "./services.js";
import { createFirstRunService } from "./first-run.js";

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

    let host;
    try {
        host = await startRuntimeHost({ dataDir: defaultDataDir() });
    }
    catch (error) {
        // Foundation scope: fail visibly instead of silently degrading. First-run UX with
        // repair/inspect flows arrives with the full Desktop onboarding work.
        const { dialog } = await import("electron");
        dialog.showErrorBox("SovereignBot failed to start", String(error?.stack ?? error));
        app.exit(1);
        return;
    }

    const uninstallProtocol = installAppProtocolHandler();

    let win;
    let bridge;
    const dataDir = defaultDataDir();
    const services = createDesktopServices({ dataDir, dialog });
    const firstRun = createFirstRunService({ host, services });

    const start = async () => {
        win = createMainWindow();
        bridge = createOperatorBridge(host.runtime);
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
                "computer:provisionDriver": () => firstRun.provisionManagedBrowserDriver(),
                "workspace:addViaDialog": () => services.addWorkspaceViaDialog(win),
                "workspace:list": () => services.listWorkspaces(),
                "workspace:setDefault": ({ id }) => ({ ok: services.setDefaultWorkspace(id) }),
                "workspace:remove": ({ id }) => ({ removed: services.removeWorkspace(id) }),
                "settings:get": () => services.getSettings(),
                "settings:update": (patch) => services.updateSettings(patch),
            },
        });
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

    app.on("window-all-closed", async () => {
        uninstallProtocol();
        try {
            await host?.close();
        }
        finally {
            app.exit(0);
        }
    });
}
