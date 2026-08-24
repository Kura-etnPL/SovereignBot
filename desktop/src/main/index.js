import { join } from "node:path";
import { app } from "electron";
import { desktopVersion } from "./lib/desktop-version.js";
import { installAppProtocolHandler, registerAppSchemePrivileged } from "./protocol.js";
import { createMainWindow, appOrigin } from "./window.js";
import { bindIpcChannels } from "./ipc.js";
import { startRuntimeHost } from "./runtime-host.js";

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
    app.whenReady().then(main);
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
    const start = async () => {
        win = createMainWindow();
        bindIpcChannels({
            win,
            handlers: {
                "app:handshake": async () => ({
                    ok: true,
                    version: desktopVersion(),
                    platform: process.platform,
                    locale: app.getLocale(),
                }),
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
