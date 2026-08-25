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
        operatorBridge: false,
        firstRunStatus: false,
        rosterShape: false,
        goalGateHonest: false,
        fakePipeline: false,
        trustedCwd: false,
        resumeContinuity: false,
        noEchoNormalMode: false,
        noSessionLeak: false,
        cleanQuit: false,
    };
    let dataDir;
    let host;
    let win;
    let services;

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
        const { createDesktopServices } = await import("./services.js");
        const { dialog } = await import("electron");
        services = createDesktopServices({ dataDir, dialog });
        host = await startRuntimeHost({
            dataDir,
            getSettings: () => services.getSettings(),
        });
        checks.runtimeHost = true;

        const { createOperatorBridge } = await import("./operator-bridge.js");
        const bridge = createOperatorBridge(host.runtime);
        const overview = await bridge.handlers["operator:getOverview"]({});
        checks.operatorBridge = Array.isArray(overview?.tasks)
            && Array.isArray(overview?.agents)
            && Array.isArray(overview?.computers);

        const { createFirstRunService } = await import("./first-run.js");
        const firstRun = createFirstRunService({ host, services });
        const status = await firstRun.getStatus();
        checks.firstRunStatus = Boolean(
            status.providers?.codex
            && status.providers?.claude
            && status.roster
            && Array.isArray(status.browsers)
            && status.workspaces?.schema === "sovereignbot.desktop.workspaces.v1"
            && status.settings?.schema === "sovereignbot.desktop.settings.v1",
        );

        // Roster shape (BLOCKER A): provider mode never contains echo agents; Demo Mode
        // is the only place they may exist. An empty roster means not-ready, not Echo.
        const roster = host.rosterSummary();
        const echoAgents = roster.agents.filter((agent) => agent.harnessKind === "echo");
        checks.rosterShape = Boolean(
            ["provider", "demo"].includes(roster.mode)
            && (
                (roster.mode === "provider" && echoAgents.length === 0
                    && (roster.ready ? roster.agents.length >= 4 : roster.agents.length === 0))
                || (roster.mode === "demo" && echoAgents.length > 0)
            ),
        );

        // Goal gate honesty: without a ready provider roster the submission is refused
        // with an actionable error instead of degrading to an Echo demo run. When this
        // machine does have providers (developer workstation), the gate opens and the
        // full pipeline is covered by the fake-provider E2E instead of live calls here.
        const { createGoalController } = await import("./goal-controller.js");
        if (!roster.ready) {
            const goals = createGoalController({
                runtime: host.runtime,
                services,
                supervisorAgentId: "unavailable-without-providers",
                roster: () => host.rosterSummary(),
                readiness: () => ({ allowed: false, reason: "Connect at least one AI provider to run goals." }),
                persistPath: join(dataDir, "desktop-state", "goals.json"),
            });
            services.addWorkspacePath(await mkdtemp(join(tmpdir(), "sovereign-smoke-ws-")));
            let refused = false;
            try {
                await goals.submitGoal({ text: "this must be refused without providers" });
            }
            catch (error) {
                refused = /Connect at least one AI provider/.test(String(error?.message ?? error));
            }
            checks.goalGateHonest = refused;
        }
        else {
            // Providers are present; never burn real quota from smoke. Demo-mode roster
            // (explicit) may exercise the echo pipeline as a wiring check only.
            if (roster.mode === "demo") {
                const goals = createGoalController({
                    runtime: host.runtime,
                    services,
                    supervisorAgentId: host.plannerAgentId,
                    readiness: () => ({ allowed: true }),
                    roster: () => host.rosterSummary(),
                    persistPath: join(dataDir, "desktop-state", "goals.json"),
                });
                services.addWorkspacePath(await mkdtemp(join(tmpdir(), "sovereign-smoke-ws-")));
                const submitted = await goals.submitGoal({ text: "demo mode wiring check" });
                const deadline = Date.now() + 30_000;
                let final = await goals.getGoal(submitted.id);
                while (!["completed", "failed", "cancelled"].includes(final.status) && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                    final = await goals.getGoal(submitted.id);
                }
                checks.goalGateHonest = final.status === "completed";
            }
            else {
                // Provider mode with a ready roster inside the PACKAGED app is only
                // reachable through the fake-provider E2E contract (real CLIs are never
                // invoked by smoke, so no quota is ever burned). Run the full goal
                // pipeline: planner -> workers -> independent review with one
                // changes_requested cycle -> synthesizer, then verify the canary.
                const { readFile } = await import("node:fs/promises");
                const transcriptPath = process.env.FAKE_PROVIDER_TRANSCRIPT
                    ?? join(dataDir, "fake-provider-transcript.jsonl");
                const goals = createGoalController({
                    runtime: host.runtime,
                    services,
                    supervisorAgentId: host.plannerAgentId,
                    readiness: () => ({ allowed: true }),
                    roster: () => host.rosterSummary(),
                    persistPath: join(dataDir, "desktop-state", "goals.json"),
                });
                const wsDir = await mkdtemp(join(tmpdir(), "sovereign-fake-ws-"));
                const workspace = services.addWorkspacePath(wsDir).workspace;
                const submitted = await goals.submitGoal({
                    text: "fix the login validation bug end to end",
                    workspaceId: workspace.id,
                });
                const deadline = Date.now() + 120_000;
                let final = await goals.getGoal(submitted.id);
                while (!["completed", "failed", "cancelled"].includes(final.status) && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    final = await goals.getGoal(submitted.id);
                }

                let entries = [];
                try {
                    entries = (await readFile(transcriptPath, "utf8"))
                        .split(/\r?\n/)
                        .filter(Boolean)
                        .map((line) => JSON.parse(line));
                }
                catch {
                }
                const phases = new Set(entries.map((entry) => entry.phase));
                const conversation = JSON.stringify(goals.getConversation(submitted.id).messages);
                const overviewJson = JSON.stringify(await bridge.handlers["operator:getOverview"]({}));
                const sessionIds = [...new Set(entries.map((entry) => entry.sessionId).filter(Boolean))];

                checks.goalGateHonest = final.status === "completed";
                checks.fakePipeline =
                    phases.has("planning") && phases.has("work") && phases.has("review") && phases.has("synthesis")
                    && typeof final.finalAnswer === "string"
                    && final.finalAnswer.startsWith("SYNTHESIS(fake)");
                // Every provider child ran inside the trusted workspace cwd.
                checks.trustedCwd = entries.length > 0
                    && entries.every((entry) => entry.cwd && entry.cwd.toLowerCase() === wsDir.toLowerCase());
                // The review retry resumed an existing provider session at least once.
                checks.resumeContinuity = entries.some((entry) => entry.resumed === true);
                // No echo agent existed anywhere in a provider-mode roster.
                checks.noEchoNormalMode = roster.agents.every((agent) => agent.harnessKind !== "echo");
                // Raw provider session ids stay internal: never in public surfaces.
                checks.noSessionLeak = sessionIds.length > 0
                    && sessionIds.every((sessionId) => !conversation.includes(sessionId))
                    && sessionIds.every((sessionId) => !overviewJson.includes(sessionId));
            }
        }

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
