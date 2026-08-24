// Smoke mode. Only reachable through the explicit `--desktop-smoke` argv flag; production
// builds never import or expose these hooks. The flow:
//   temp dataDir -> hidden window over sovereignbot://app -> renderer handshake IPC ->
//   in-process Core RuntimeHost (vendored, integrity-verified) -> assertions ->
//   machine-readable JSON on stdout -> exit 0/1.
export async function runSmokeMode({ app }) {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createMainWindow, appOrigin } = await import("./window.js");
    const { installAppProtocolHandler } = await import("./protocol.js");
    const { bindIpcChannels } = await import("./ipc.js");
    const { startRuntimeHost } = await import("./runtime-host.js");
    const { VERSION: DESKTOP_VERSION } = await import("./lib/desktop-version.js");

    const checks = {
        windowCreated: false,
        protocolLoaded: false,
        cspPresent: false,
        handshake: false,
        runtimeHost: false,
        cleanQuit: false,
    };
    let dataDir;
    let host;
    let win;

    const fail = async (error) => {
        process.stdout.write(`${JSON.stringify({ smoke: "failed", checks, error: String(error?.message ?? error) })}\n`);
        try {
            await host?.close();
        }
        catch {
        }
        app.exit(1);
    };

    try {
        dataDir = process.env.SOVEREIGNBOT_DESKTOP_SMOKE_DATA_DIR
            ?? await mkdtemp(join(tmpdir(), "sovereign-desktop-smoke-"));
        host = await startRuntimeHost({ dataDir });
        checks.runtimeHost = true;

        const uninstallProtocol = installAppProtocolHandler();
        win = createMainWindow({ smoke: true });
        checks.windowCreated = true;

        let handshakeResolve;
        const handshakePromise = new Promise((resolve) => (handshakeResolve = resolve));
        bindIpcChannels({
            win,
            handlers: {
                "app:handshake": async () => {
                    handshakeResolve(true);
                    return {
                        ok: true,
                        version: DESKTOP_VERSION,
                        platform: process.platform,
                        locale: app.getLocale(),
                    };
                },
            },
        });

        await win.loadURL(appOrigin());
        await win.webContents.executeJavaScript("document.readyState === 'complete' ? Promise.resolve() : new Promise((r) => window.addEventListener('load', () => r()))");

        const locationProtocol = await win.webContents.executeJavaScript("location.protocol");
        checks.protocolLoaded = locationProtocol === "sovereignbot:";
        const csp = await win.webContents.executeJavaScript(
            "document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content ?? null",
        );
        checks.cspPresent = typeof csp === "string" && csp.includes("default-src 'none'") && csp.includes("script-src 'self'");

        const handshakeResult = await Promise.race([
            handshakePromise,
            new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
        ]);
        checks.handshake = handshakeResult === true;

        if (!win.isDestroyed()) {
            const image = await win.webContents.capturePage();
            const png = image.toPNG();
            if (png.length > 10_000)
                await writeFile(join(dataDir, "smoke-home.png"), png);
        }

        uninstallProtocol();

        await host.close();
        host = undefined;
        checks.cleanQuit = true;

        const ok = Object.values(checks).every(Boolean);
        process.stdout.write(`${JSON.stringify({ smoke: ok ? "ok" : "failed", checks })}\n`);
        app.exit(ok ? 0 : 1);
    }
    catch (error) {
        await fail(error);
    }
}
