import { basename, dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { app, dialog, Notification, shell } from "electron";
import { desktopVersion } from "./lib/desktop-version.js";
import { installAppProtocolHandler, registerAppSchemePrivileged } from "./protocol.js";
import { createMainWindow, appOrigin } from "./window.js";
import { bindIpcChannels } from "./ipc.js";
import { exportTeamPackViaDialog, importTeamPackViaDialog } from "./team-pack-file-io.js";
import { exportPlaybookViaDialog, importPlaybookViaDialog } from "./playbook-file-io.js";
import { exportSkillViaDialog, importSkillViaDialog } from "./skill-file-io.js";
import { createOperatorBridge } from "./operator-bridge.js";
import { startRuntimeHost } from "./runtime-host.js";
import { createDesktopServices } from "./services.js";
import { createFirstRunService } from "./first-run.js";
import { createGoalController } from "./goal-controller.js";
import { createJobController } from "./job-controller.js";
import { createChiefLoop } from "./chief-loop.js";
import { createRoutineController } from "./routine-controller.js";
import { createEventTriggerController } from "./event-trigger-controller.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createArtifactStore } from "./artifact-store.js";
import { createAttachmentAwareConversationStore, pickArtifactRevision, pickConversationAttachments } from "./attachment-integration.js";
import { exportArtifactViaDialog } from "./artifact-file-io.js";
import { exportProjectViaDialog } from "./project-file-io.js";
import { createSkillStore } from "./skill-store.js";
import { createSkillAwareConversationStore, createSkillHandlers } from "./skill-integration.js";
import { createTeachOnceController } from "./teach-once-controller.js";
import { createTeachOnceRuntime } from "./teach-once-runtime.js";
import { createCoworkerDispatcher } from "./coworker-dispatcher.js";
import { openProviderLogin } from "./provider-login.js";
import { coworkerAgentId, validateRoleAssignment } from "./provider-roster.js";
import { antigravityAccountNamespace } from "./antigravity-provider.js";
import { attachWindowLifecycle } from "./lifecycle.js";
import { createTrayController } from "./tray.js";
import { createWorkerNodeStore } from "./worker-node-store.js";
import { createExternalControllerStore } from "./external-controller-store.js";
import { createTeamService } from "./team-service.js";
import { createConnectedAppsService } from "./connected-apps.js";
import { createExternalTeamControlServer } from "./external-team-control.js";
import { createProductSurfaceService } from "./product-surface-service.js";
import { createMemoryService } from "./memory-service.js";
import { createProjectService } from "./project-service.js";
import { createSearchService } from "./search-service.js";
import { createCommandPaletteService } from "./command-palette-service.js";
import { createThisPcService } from "./this-pc-service.js";
import { createComputerTargetController } from "./computer-target-controller.js";
import { createLocalIsolatedComputer } from "./local-isolated-computer.js";
import { createDesktopDataLifecycle } from "./data-lifecycle.js";
import { createSquirrelUpdateExecutor, createUpdateService } from "./update-service.js";
import { createNotificationService } from "./notification-service.js";
import { createChannelUnreadProducer } from "./channel-unread-producer.js";

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
// Set the product name before Electron resolves userData/single-instance paths.
// Packaged builds otherwise inherit the generic "Electron" profile, which can
// collide with the host application's lock and corrupt smoke/installer isolation.
app.setName("SovereignBot");

// Packaged smoke/dogfood must isolate Electron's own profile as well as the
// product data directory.  Otherwise the default per-user profile owns the
// single-instance lock and can leave a hidden child alive without ever entering
// the requested smoke branch.
if ((process.argv.includes("--desktop-smoke") || process.argv.includes("--desktop-dogfood"))
    && process.env.SOVEREIGNBOT_DESKTOP_SMOKE_DATA_DIR) {
    try {
        const smokeDataDir = process.env.SOVEREIGNBOT_DESKTOP_SMOKE_DATA_DIR;
        const isolatedUserData = join(dirname(smokeDataDir), `${basename(smokeDataDir)}-electron-userdata`);
        mkdirSync(isolatedUserData, { recursive: true });
        app.setPath("userData", isolatedUserData);
    }
    catch {
    }
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
    if (process.argv.includes("--desktop-dogfood")) {
        const { runSmokeMode } = await import("./smoke.js");
        await runSmokeMode({ app, mode: "dogfood" });
        return;
    }
    if (process.argv.includes("--desktop-migration-check")) {
        const { createDesktopDataLifecycle } = await import("./data-lifecycle.js");
        const lifecycle = createDesktopDataLifecycle({
            dataDir: defaultDataDir(),
            migrationHook: async () => { if (process.env.SOVEREIGNBOT_INJECT_MIGRATION_FAILURE === "1") throw new Error("injected migration failure"); },
        });
        try {
            const result = await lifecycle.recover();
            process.stdout.write(`${JSON.stringify({ migration: "ok", result })}\n`);
            app.exit(0);
        }
        catch (error) {
            process.stdout.write(`${JSON.stringify({ migration: "failed", error: String(error?.message ?? error) })}\n`);
            app.exit(1);
        }
        return;
    }

    const dataDir = defaultDataDir();
    let jobs;
    let routines;
    let eventTriggers;
    let computerTargetController;
    let localIsolatedComputer;
    const dataLifecycle = createDesktopDataLifecycle({
        dataDir,
        stopRuntime: async () => { try { eventTriggers?.stop(); } catch {} try { routines?.stop(); } catch {} },
        releaseLeases: async () => { try { await computerTargetController?.releaseAllLeases?.({ jobs: jobs?.listJobs?.().jobs ?? [] }); } catch {} },
        clearControllerCache: async () => { try { computerTargetController?.clearCache?.(); } catch {} },
    });
    await dataLifecycle.recover();
    const services = createDesktopServices({ dataDir, dialog });
    const notifications = createNotificationService({ dataDir, getSettings: () => services.getSettings(), NotificationClass: Notification });
    const updateFeedRoot = process.env.SOVEREIGNBOT_UPDATE_FEED_DIR;
    const updates = createUpdateService({
        dataDir,
        currentVersion: desktopVersion(),
        getChannel: () => services.getSettings().updateChannel,
        setChannel: (channel) => services.updateSettings({ updateChannel: channel }),
        dataLifecycle,
        feedRoot: updateFeedRoot,
        updateExecutor: updateFeedRoot && process.platform === "win32"
            ? createSquirrelUpdateExecutor({ updateExe: join(dirname(app.getPath("exe")), "..", "Update.exe"), feedRoot: updateFeedRoot })
            : undefined,
    });
    const coworkerStore = createCoworkerStore({ persistPath: join(dataDir, "desktop-state", "coworkers.json") });
    coworkerStore.ensureDefaults();
    const conversationStore = createConversationStore({
        persistPath: join(dataDir, "desktop-state", "conversations.json"),
        coworkerStore,
    });
    const artifactStore = createArtifactStore({ dataDir });
    conversationStore.setArtifactReferenceValidator(({ conversationId, artifactIds }) => {
        for (const artifactId of artifactIds)
            artifactStore.validateReference(artifactId, conversationId);
    });
    const attachmentAwareConversationStore = createAttachmentAwareConversationStore(conversationStore, artifactStore);
    const skillStore = createSkillStore({ persistPath: join(dataDir, "desktop-state", "skills.json") });
    const workerNodeStore = createWorkerNodeStore({ dataDir });
    const externalControllerStore = createExternalControllerStore({ dataDir, trustStore: workerNodeStore.secureTrustStore() });
    const teamService = createTeamService({
        dataDir,
        coworkerStore,
        conversationStore,
        services,
    });
    const channelUnreadProducer = createChannelUnreadProducer({
        notifications,
        teamService,
        coworkerStore,
        conversationStore,
    });
    skillStore.setTargetResolver({
        hasCoworker: (id) => coworkerStore.list().coworkers.some((entry) => entry.id === id),
        hasTeam: (id) => teamService.list().teams.some((entry) => entry.id === id),
        teamIdsForCoworker: (id) => teamService.list().teams.filter((team) => team.coworkerIds.includes(id)).map((team) => team.id),
    });
    conversationStore.setTeamRouteResolver((conversation) => teamService.currentOwnerForConversation(conversation.id));
    let projectService;
    const connectedApps = createConnectedAppsService({
        dataDir,
        teamService,
        coworkerStore,
        getProjectScope: (id) => projectService?.resolveScope(id),
        healthProbe: async ({ appId }) => {
            if (appId === "sovereignbot-computer") {
                if (!host?.runtime?.computer?.listComputers) return { health: "unavailable" };
                const computers = await host.runtime.computer.listComputers();
                return { health: Array.isArray(computers) && computers.length ? "ready" : "unavailable" };
            }
            if (appId === "sovereignbot-workspace") return { health: services.listWorkspacesInternal?.().workspaces?.length ? "ready" : "unavailable" };
            return { health: "unavailable" };
        },
    });
    teamService.setCoworkerAppAccessResolver((coworkerId) => connectedApps.assignedToolsForCoworker(coworkerId));
    let host;
    projectService = createProjectService({
        dataDir,
        services,
        teamService,
        coworkerStore,
        artifactStore,
        skillStore,
        connectedApps,
        getRoutines: () => routines?.list(),
        getEventTriggers: () => eventTriggers?.list(),
        getPlaybooks: () => productSurfaces?.listPlaybooks(),
        getJobs: () => jobs,
        getComputers: async () => {
            if (!host?.runtime?.computer?.listComputers) throw new Error("Computer lease state is unavailable");
            return host.runtime.computer.listComputers();
        },
        onChanged: () => search?.invalidate(),
    });
    connectedApps.setProjectScopeResolver((id) => projectService.resolveScope(id));

    try {
        host = await startRuntimeHost({
            dataDir,
            getSettings: () => services.getSettings(),
            getCoworkers: () => (coworkerStore.listInternal?.() ?? coworkerStore.list()).coworkers,
            getCoworkerAppAccess: (coworkerId) => connectedApps.assignedToolsForCoworker(coworkerId),
            workerNodeClientResolver: (nodeId) => workerNodeStore.client(nodeId),
            economyConfig: services.getEconomyConfig(),
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
    let chiefLoop;
    let coworkerDispatcher;
    let teachOnce;
    let palette;
    let search;
    let externalTeamControl;
    const memoryService = createMemoryService({
        runtime: host.runtime,
        getRuntime: () => host.runtime,
        services,
        coworkerStore,
        teamService,
        conversationStore,
        artifactStore,
        getJobs: () => jobs,
        projectResolver: (projectId) => projectService.resolveProject(projectId),
        onChanged: () => search?.invalidate(),
    });
    projectService.setMemoryService(memoryService);
    const productSurfaces = createProductSurfaceService({ dataDir, teamService, coworkerStore, artifactStore, runtime: host.runtime, getRuntime: () => host.runtime });
    const thisPc = createThisPcService({
        projectService,
        coworkerStore,
        artifactStore,
        runtime: host.runtime,
        getRuntime: () => host.runtime,
        getBinding: (coworkerId) => host.rosterSummary()?.coworkerBindings?.[coworkerId],
    });
    search = createSearchService({
        teamService,
        conversationStore,
        coworkerStore,
        projectService,
        artifactStore,
        skillStore,
        productSurfaces,
        getRoutines: () => routines?.list(),
        memoryService,
        getJobs: () => jobs,
        getHistory: (payload) => productSurfaces.computerHistory(payload),
    });
    conversationStore.onMessage(() => search?.invalidate());
    teamService.setRuntimeHandoffPreflight(({ conversationId, targetCoworkerId, workspaceId }) => {
        const binding = host.rosterSummary()?.coworkerBindings?.[targetCoworkerId];
        if (!binding?.ready || binding.agentId !== coworkerAgentId(targetCoworkerId)) throw new Error("target coworker provider binding is not ready");
        const trustedWorkspaceId = teamService.workspaceIdForConversation(conversationId);
        if (!workspaceId || trustedWorkspaceId !== workspaceId || !services.workspacePath(workspaceId)) throw new Error("target team workspace is unavailable");
        return { targetCoworkerId, agentId: binding.agentId, workspaceId };
    });
    const blockedConversations = new Set();
    let quitting = false;
    let shutdownStarted = false;
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function requestQuit(reason) {
        if (shutdownStarted)
            return;
        shutdownStarted = true;
        quitting = true;
        try { eventTriggers?.stop(); } catch {}
        try { routines?.stop(); } catch {}
        try { chiefLoop?.stop(); } catch {}
        try { await localIsolatedComputer?.close?.(); } catch {}
        try { await Promise.race([externalTeamControl?.close?.() ?? Promise.resolve(), delay(5_000)]); } catch {}
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
            if (eventTriggers) await Promise.race([eventTriggers.flush(), delay(5_000)]);
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
        try { eventTriggers?.stop(); } catch {}
        try { routines?.stop(); } catch {}
        try { chiefLoop?.stop(); } catch {}
        bridge = createOperatorBridge(host.runtime);
        localIsolatedComputer?.close?.().catch?.(() => {});
        localIsolatedComputer = createLocalIsolatedComputer({ services, audit: host.runtime.audit });
        const thisPcComputer = {
            resolve: async () => ({
                computer: { state: "online", capacity: 1, currentLoad: 0, capabilities: ["snapshot", "takeover", "release"] },
                execute: async (envelope) => {
                    if (!envelope.projectId) throw new Error("This PC Computer target requires a Project scope");
                    if (envelope.operation !== "snapshot") throw new Error(`This PC Computer does not support ${envelope.operation} through Job execution`);
                    return thisPc.snapshot(envelope.projectId, envelope.ownerCoworkerId);
                },
                lease: async (envelope) => {
                    if (!envelope.projectId) throw new Error("This PC Computer target requires a Project scope");
                    if (envelope.operation === "takeover") return thisPc.takeOver(envelope.projectId, envelope.ownerCoworkerId, { actor: envelope.input.actorId });
                    return thisPc.handBack(envelope.projectId, envelope.ownerCoworkerId, { actor: envelope.input.actorId });
                },
            }),
        };
        computerTargetController = createComputerTargetController({ workerNodeStore, localIsolatedComputer, thisPcComputer, audit: host.runtime.audit });
        goals = createGoalController({
            runtime: host.runtime,
            services,
            supervisorAgentId: host.plannerAgentId,
            readiness: goalReadiness,
            roster: () => host.rosterSummary(),
            persistPath: join(dataDir, "desktop-state", "goals.json"),
            onTerminal: (goal) => notifications.notify({
                category: goal.status === "completed" ? "coworker-finished" : "attention",
                key: `goal:${goal.id}:${goal.status}`,
                title: goal.status === "completed" ? "Coworker finished" : "Attention needed",
                body: goal.status === "completed" ? goal.textPreview : `${goal.textPreview} — ${goal.error ?? "did not complete"}`,
                source: goal.status === "completed"
                    ? (goal.conversationId ? { target: "conversation", conversationId: goal.conversationId } : null)
                    : { target: "attention" },
            }),
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
            workerNodeStore,
            computerTargetController,
            projectService,
            teamService,
            onStatus: (job, transition) => {
                if (transition.status === "needs_attention") {
                    notifications.notify({
                        category: "attention",
                        key: `job:${job.id}:attention`,
                        title: "Attention needed",
                        body: job.title,
                        source: { target: "attention", jobId: job.id },
                    });
                }
                else if (transition.status === "completed") {
                    const isTrigger = Boolean(job.eventMetadata);
                    const isRoutine = Boolean(job.routineId);
                    notifications.notify({
                        category: isTrigger ? "trigger-fired" : isRoutine ? "routine-completed" : "coworker-finished",
                        key: `job:${job.id}:completed`,
                        title: isTrigger ? "Trigger fired" : isRoutine ? "Routine completed" : "Coworker finished",
                        body: job.title,
                        source: isTrigger ? { target: "triggers", triggerId: job.eventMetadata?.triggerId }
                            : isRoutine ? { target: "routines", routineId: job.routineId }
                            : job.conversationId ? { target: "conversation", conversationId: job.conversationId }
                            : { target: "work", jobId: job.id },
                    });
                }
            },
        });
        routines = createRoutineController({ dataDir, jobController: jobs, coworkerStore, skillStore, services, projectService, teamService, computerTargetController });
        skillStore.setRetestRunner((skill) => {
            const directOwner = (skill.assignedCoworkerIds ?? []).find((id) => coworkerStore.get(id).state === "active");
            const teamOwner = directOwner ? undefined : (skill.assignedTeamIds ?? []).map((id) => teamService.get(id)).flatMap((team) => team.coworkerIds ?? []).find((id) => coworkerStore.get(id).state === "active");
            const ownerCoworkerId = directOwner ?? teamOwner;
            if (!ownerCoworkerId) throw new Error("assign the Skill to an active Coworker or Team before retesting");
            const owner = coworkerStore.get(ownerCoworkerId);
            const workspaceId = (owner.workspaceIds ?? []).find((id) => services.workspacePath(id));
            return jobs.submitJob({
                title: `Retest Skill · ${skill.name}`,
                objective: `Run the bounded Skill “${skill.name}” and report its expected output.`,
                ownerCoworkerId,
                internalContext: { skillId: skill.id, ...(workspaceId ? { workspaceId } : {}) },
            });
        });
        eventTriggers = createEventTriggerController({ dataDir, routineController: routines, services });
        chiefLoop = createChiefLoop({ jobController: jobs, goalController: goals, roster: () => host.rosterSummary() });
        routines.start();
        eventTriggers.start();
        chiefLoop.start();
        coworkerDispatcher = createCoworkerDispatcher({
            dataDir,
            runtime: host.runtime,
            roster: () => host.rosterSummary(),
            coworkerStore,
            conversationStore: createSkillAwareConversationStore(attachmentAwareConversationStore, skillStore),
            artifactStore,
            services,
            jobController: jobs,
            teamFlow: teamService,
            isConversationBlocked: (conversationId) => blockedConversations.has(conversationId),
        });
    }

    const firstRun = createFirstRunService({ host, services });
    rebuildRuntimeBoundServices();
    const teachOnceRuntime = createTeachOnceRuntime({
        dataDir,
        getRuntime: () => host.runtime,
        roster: () => host.rosterSummary(),
        coworkerStore,
        services,
    });
    const dynamicRawComputer = Object.fromEntries(["snapshot", "navigate", "click", "type", "key", "scroll"].map((method) => [
        method,
        (...args) => host.runtime.rawComputer[method](...args),
    ]));
    teachOnce = createTeachOnceController({
        dataDir,
        coworkerStore,
        skillStore,
        rawComputer: dynamicRawComputer,
        getAgentId: (coworkerId) => host.rosterSummary()?.coworkerBindings?.[coworkerId]?.agentId,
        generateDraft: teachOnceRuntime.generateDraft,
        testExecutor: teachOnceRuntime.testExecutor,
    });
    palette = createCommandPaletteService({
        createCoworker: async ({ name, role, instructions }) => ({
            coworker: coworkerStore.create({ name, role, instructions }),
            refresh: await refreshCoworkerRuntime(),
        }),
        createTeam: ({ title, coworkerIds, leadCoworkerId }) => teamService.createTeam({ title, coworkerIds, leadCoworkerId }),
        createChannel: ({ teamId, name }) => teamService.createChannel({ teamId, name }),
        runRoutine: (routineId) => routines.runNow(routineId),
        teachSkill: (payload) => teachOnce.start(payload),
        openComputer: ({ coworkerId }) => {
            const coworker = coworkerStore.get(coworkerId);
            if (coworker.state === "archived") throw new Error("archived coworker has no Computer lane");
            return { action: "open-computer", coworkerId: coworker.id };
        },
    });

    const configuredExternalPort = process.env.SOVEREIGNBOT_EXTERNAL_TEAM_CONTROL_PORT;
    const externalPort = configuredExternalPort === undefined ? 0 : Number(configuredExternalPort);
    if (!Number.isInteger(externalPort) || externalPort < 0 || externalPort > 65_535)
        throw new Error("SOVEREIGNBOT_EXTERNAL_TEAM_CONTROL_PORT must be an integer from 0 to 65535");
    externalTeamControl = createExternalTeamControlServer({
        host: "127.0.0.1",
        port: externalPort,
        authenticate: (token) => host.runtime.operatorSessions.authenticate(token),
        dataDir,
        teamService,
        coworkerStore,
        conversationStore,
        artifactStore,
        skillStore,
        routineController: routines,
        jobs,
        dispatchMessage: (conversationId, messageId) => coworkerDispatcher.dispatchMessage(conversationId, messageId),
        blockConversation: (conversationId) => blockedConversations.add(conversationId),
        isConversationBlocked: (conversationId) => blockedConversations.has(conversationId),
        cancelConversation: (conversationId, reason) => coworkerDispatcher.cancelConversation(conversationId, reason),
        getAudit: () => host.runtime.audit,
        getRoutineController: () => routines,
        getJobs: () => jobs,
        controllerRegistry: externalControllerStore,
        projectService,
        computerService: thisPc,
    });
    try {
        await externalTeamControl.start();
    }
    catch (error) {
        logStartupError("external team control unavailable", error);
    }

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
        const handlers = {
                "app:handshake": async () => ({ ok: true, version: desktopVersion(), platform: process.platform, locale: app.getLocale(), language: services.getSettings().language, externalTeamControl: externalTeamControl?.status?.() }),
                ...bridge.handlers,
                "firstrun:getStatus": () => firstRun.getStatus(),
                "computer:browserStatus": async () => (await firstRun.getStatus()).browsers,
                "computer:provisionDriver": async () => {
                    const result = await firstRun.provisionManagedBrowserDriver();
                    const refresh = await host.refreshProviders({ isBusy: goalsBusy });
                    await applyProviderRefresh(refresh);
                    return { ...result, refresh };
                },
                "workspace:addViaDialog": async () => {
                    const result = await services.addWorkspaceViaDialog(win);
                    eventTriggers?.reconcile();
                    return result;
                },
                "workspace:list": () => services.listWorkspaces(),
                "workspace:setDefault": ({ id }) => ({ ok: services.setDefaultWorkspace(id) }),
                "workspace:remove": ({ id }) => {
                    const removed = services.removeWorkspace(id);
                    eventTriggers?.reconcile();
                    return { removed };
                },
                "project:list": (payload) => projectService.list(payload),
                "project:get": ({ projectId }) => projectService.get(projectId),
                "project:create": ({ name }) => projectService.create({ name }),
                "project:open": ({ projectId }) => projectService.open(projectId),
                "project:archive": ({ projectId }) => projectService.archive(projectId),
                "project:restore": ({ projectId }) => projectService.restore(projectId),
                "project:export": ({ projectId }) => projectService.export(projectId),
                "project:exportViaDialog": ({ projectId }) => exportProjectViaDialog({ parentWindow: win, dialog, targetName: projectId, resolveProject: () => projectService.export(projectId) }),
                "project:backup": ({ projectId }) => projectService.backup(projectId),
                "search:query": (payload) => search.query(payload),
                "palette:list": () => palette.list(),
                "palette:execute": ({ paletteId, args }) => palette.execute({ commandId: paletteId, args }),
                "settings:get": () => services.getSettings(),
                "settings:update": (patch) => services.updateSettings(patch),
                "update:status": () => updates.status(),
                "update:check": () => updates.check(),
                "update:stage": () => updates.stage(),
                "update:apply": () => updates.apply(),
                "update:setChannel": ({ channel }) => updates.setChannel(channel),
                "data:status": () => dataLifecycle.status(),
                "data:listBackups": () => dataLifecycle.listBackups(),
                "data:backup": () => dataLifecycle.backup(),
                "data:restore": ({ id }) => dataLifecycle.restoreBackup({ id }),
                "data:export": () => dataLifecycle.exportData(),
                "data:prepareReset": () => dataLifecycle.prepareReset(),
                "data:reset": ({ confirmation, backupId }) => dataLifecycle.cleanReset({ confirmation, backupId }),
                "provider:getRoster": () => host.rosterSummary(),
                "provider:refresh": async () => applyProviderRefresh(await host.refreshProviders({ isBusy: goalsBusy })),
                "provider:openLogin": async ({ provider }) => {
                    if (provider === "chatgpt-web") {
                        const login = await host.openChatGPTWebLogin();
                        return { login, refresh: { applied: false, reason: "manual-sign-in", roster: host.rosterSummary() } };
                    }
                    if (provider === "antigravity") {
                        const login = await host.openAntigravityLogin(antigravityAccountNamespace("A"));
                        return { login, refresh: { applied: false, reason: "manual-sign-in", roster: host.rosterSummary() } };
                    }
                    if (provider === "economy")
                        throw new Error("Economy providers are configured by trusted main-process configuration; no renderer login is permitted");
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
                "team:list": () => {
                    const listed = teamService.list();
                    const recipes = productSurfaces.recipeList();
                    const recipeById = new Map(recipes.map((pack) => [pack.id, pack]));
                    const packs = listed.packs.map((pack) => recipeById.has(pack.id) ? { ...pack, ...recipeById.get(pack.id) } : pack);
                    const known = new Set(packs.map((pack) => pack.id));
                    return { ...listed, packs: [...packs, ...recipes.filter((pack) => !known.has(pack.id))] };
                },
                "team:get": ({ teamId }) => teamService.get(teamId),
                "team:computerTask": (payload) => coworkerDispatcher.dispatchComputerTask(payload),
                "team:activity": (payload) => teamService.activity(payload),
                "team:requestCollaboration": (payload) => {
                    const result = teamService.requestCollaboration(payload);
                    const deliveries = coworkerDispatcher.dispatchMessage(payload.conversationId, result.message.id);
                    return { ...result, scheduledRecipients: deliveries.length };
                },
                "team:requestParallel": (payload) => {
                    const result = teamService.requestParallelCollaboration(payload);
                    const deliveries = coworkerDispatcher.dispatchMessage(payload.conversationId, result.message.id);
                    return { ...result, scheduledRecipients: deliveries.length };
                },
                "team:installPack": async ({ packId }) => {
                    const result = productSurfaces.recipeList().some((pack) => pack.id === packId)
                        ? teamService.importPack(productSurfaces.getPackRecipe(packId))
                        : teamService.installPack(packId);
                    const refresh = await refreshCoworkerRuntime();
                    return { ...result, refresh };
                },
                "team:exportPack": ({ teamId }) => teamService.exportPack(teamId),
                "team:importPack": async ({ pack }) => {
                    const result = teamService.importPack(pack);
                    const refresh = await refreshCoworkerRuntime();
                    return { ...result, refresh };
                },
                "team:importPackViaDialog": async () => {
                    const result = await importTeamPackViaDialog({ parentWindow: win, dialog, importPack: (pack) => teamService.importPack(pack) });
                    if (result.canceled) return result;
                    return { ...result, refresh: await refreshCoworkerRuntime() };
                },
                "team:exportPackViaDialog": ({ teamId, packId }) => exportTeamPackViaDialog({
                    parentWindow: win,
                    dialog,
                    targetName: packId ?? teamId,
                    resolvePack: () => teamId ? teamService.exportPack(teamId) : productSurfaces.exportPack(packId),
                }),
                "team:duplicatePack": ({ packId }) => productSurfaces.duplicatePack(packId),
                "team:exportPackRecipe": ({ packId }) => productSurfaces.exportPack(packId),
                "team:editPack": ({ packId, patch }) => productSurfaces.editPack(packId, patch),
                "team:exportPlaybook": ({ teamId, playbookId }) => teamService.exportPlaybook(teamId, playbookId),
                "team:importPlaybook": ({ teamId, playbook }) => teamService.importPlaybook(teamId, playbook),
                "playbook:list": ({ includeArchived }) => productSurfaces.listPlaybooks({ includeArchived }),
                "playbook:create": ({ playbook }) => productSurfaces.createPlaybook(playbook),
                "playbook:update": ({ playbookId, patch }) => productSurfaces.updatePlaybook(playbookId, patch),
                "playbook:archive": ({ playbookId }) => productSurfaces.archivePlaybook(playbookId),
                "playbook:restore": ({ playbookId }) => productSurfaces.restorePlaybook(playbookId),
                "playbook:duplicate": ({ playbookId }) => productSurfaces.duplicatePlaybook(playbookId),
                "playbook:export": ({ playbookId }) => productSurfaces.exportPlaybook(playbookId),
                "playbook:import": ({ playbook }) => productSurfaces.importPlaybook(playbook),
                "playbook:importViaDialog": async () => {
                    return importPlaybookViaDialog({ parentWindow: win, dialog, importPlaybook: (playbook) => productSurfaces.importPlaybook(playbook) });
                },
                "playbook:exportViaDialog": ({ playbookId }) => exportPlaybookViaDialog({
                    parentWindow: win,
                    dialog,
                    targetName: playbookId,
                    resolvePlaybook: () => productSurfaces.exportPlaybook(playbookId),
                }),
                "playbook:assign": ({ playbookId, teamId, channelId }) => productSurfaces.assignPlaybook(playbookId, { teamId, channelId }),
                "team:createChannelFromTemplate": ({ teamId, templateId }) => teamService.createChannelFromTemplate(teamId, templateId),
                "channel:list": ({ teamId, includeArchived }) => teamService.listChannels({ teamId, includeArchived }),
                "channel:get": ({ channelId }) => teamService.getChannel(channelId),
                "channel:create": (payload) => teamService.createChannel(payload),
                "channel:update": ({ channelId, patch }) => teamService.updateChannel(channelId, patch),
                "channel:archive": ({ channelId }) => teamService.archiveChannel(channelId),
                "channel:restore": ({ channelId }) => teamService.restoreChannel(channelId),
                "connectedApps:list": (payload) => connectedApps.list(payload),
                "connectedApps:search": (payload) => connectedApps.search(payload),
                "connectedApps:assign": async (payload) => {
                    const app = connectedApps.setAssignment(payload);
                    const refresh = await refreshCoworkerRuntime();
                    return { ...app, refresh };
                },
                "connectedApps:connect": async (payload) => {
                    const app = await connectedApps.connect(payload);
                    const refresh = await refreshCoworkerRuntime();
                    return { ...app, refresh };
                },
                "connectedApps:disconnect": async (payload) => {
                    const app = await connectedApps.disconnect(payload);
                    const refresh = await refreshCoworkerRuntime();
                    return { ...app, refresh };
                },
                "connectedApps:review": (payload) => connectedApps.review(payload),
                "connectedApps:disable": async (payload) => {
                    const app = await connectedApps.disable(payload);
                    const refresh = await refreshCoworkerRuntime();
                    return { ...app, refresh };
                },
                "connectedApps:health": (payload) => connectedApps.health(payload),
                "thisPc:list": (payload) => thisPc.list(payload),
                "thisPc:frame": (payload) => thisPc.frame(payload.projectId, payload.coworkerId),
                "thisPc:snapshot": (payload) => thisPc.snapshot(payload.projectId, payload.coworkerId),
                "thisPc:takeOver": (payload) => thisPc.takeOver(payload.projectId, payload.coworkerId),
                "thisPc:handBack": (payload) => thisPc.handBack(payload.projectId, payload.coworkerId),
                "thisPc:health": (payload) => thisPc.health(payload.projectId, payload.coworkerId),
                ...createSkillHandlers({
                    skillStore,
                    conversationStore,
                    dispatchMessage: (conversationId, messageId) => coworkerDispatcher.dispatchMessage(conversationId, messageId),
                    isConversationArchived: (conversationId) => teamService.isArchivedConversation(conversationId),
                }),
                "skill:exportViaDialog": ({ skillId }) => exportSkillViaDialog({ parentWindow: win, dialog, targetName: skillId, resolveSkill: () => skillStore.exportSkill(skillId) }),
                "skill:importViaDialog": () => importSkillViaDialog({ parentWindow: win, dialog, importSkill: (skill) => skillStore.importSkill(skill) }),
                "teach:list": () => teachOnce.list(),
                "teach:start": (payload) => teachOnce.start(payload),
                "teach:get": ({ sessionId }) => teachOnce.get(sessionId),
                "teach:snapshot": ({ sessionId }) => teachOnce.snapshot(sessionId),
                "teach:recordAction": ({ sessionId, action }) => teachOnce.recordAction(sessionId, action),
                "teach:finish": ({ sessionId }) => teachOnce.finish(sessionId),
                "teach:test": ({ sessionId }) => teachOnce.test(sessionId),
                "teach:confirm": ({ sessionId }) => teachOnce.confirm(sessionId),
                "teach:save": ({ sessionId }) => teachOnce.save(sessionId),
                "teach:cancel": ({ sessionId }) => teachOnce.cancel(sessionId),
                "conversation:list": () => conversationStore.list(),
                "conversation:get": ({ conversationId, limit, beforeMessageId, aroundMessageId }) => conversationStore.getPage(conversationId, { limit, beforeMessageId, aroundMessageId }),
                "conversation:acknowledge": ({ conversationId }) => notifications.resolveChannelUnread(conversationId),
                "conversation:createDirect": ({ coworkerId }) => conversationStore.createDirect(coworkerId),
                "conversation:createTeam": ({ title, coworkerIds, leadCoworkerId }) => teamService.createTeam({ title, coworkerIds, leadCoworkerId }).conversation,
                "conversation:stop": async ({ conversationId }) => coworkerDispatcher.stopConversation(conversationId),
                "conversation:redirect": async ({ conversationId, text, mentions, replyTo, clientMessageId }) => {
                    if (teamService.isArchivedConversation(conversationId)) throw new Error("archived channel is read-only");
                    const redirectContext = teamService.collaborationContextForConversation(conversationId);
                    const stopped = await coworkerDispatcher.stopConversation(conversationId, "conversation redirected by the user", "desktop-operator", redirectContext);
                    const afterStop = teamService.collaborationContextForConversation(conversationId);
                    if (redirectContext && afterStop?.runId === redirectContext.runId) {
                        teamService.recordCollaborationEvent({ conversationId, type: "run.redirected", status: "redirected", actorId: "user", reason: "Work was redirected by the user.", runId: redirectContext.runId, requestId: afterStop.requestId, operationId: afterStop.operationId, operationToken: afterStop.operationToken, expectedVersion: afterStop.version, idempotencyKey: `run.redirected:${redirectContext.runId}:${afterStop.version}` });
                    }
                    const message = conversationStore.postUserMessage(conversationId, { text, mentions, replyTo, clientMessageId });
                    const deliveries = coworkerDispatcher.dispatchMessage(conversationId, message.id);
                    return { stopped, message, scheduledRecipients: deliveries.length };
                },
                "artifact:list": ({ conversationId, coworkerId, limit }) => artifactStore.list({ conversationId, coworkerId, limit }),
                "artifact:get": ({ artifactId }) => artifactStore.get(artifactId),
                "artifact:preview": ({ artifactId }) => artifactStore.previewText(artifactId),
                "artifact:history": ({ artifactId }) => productSurfaces.artifactHistory({ artifactId }),
                "artifact:archive": ({ artifactId }) => artifactStore.archive(artifactId),
                "artifact:restore": ({ artifactId }) => artifactStore.restore(artifactId),
                "artifact:restoreAsNewVersion": ({ artifactId }) => artifactStore.restoreAsNewVersion(artifactId),
                "artifact:reviseViaDialog": ({ artifactId }) => pickArtifactRevision({ win, dialog, artifactStore, artifactId }),
                "artifact:exportViaDialog": ({ artifactId }) => exportArtifactViaDialog({ parentWindow: win, dialog, artifactStore, artifactId }),
                "artifact:open": async ({ artifactId }) => {
                    const managedPath = artifactStore.managedPath(artifactId);
                    if (process.env.SOVEREIGNBOT_VERIFY_SOFTWARE_TEAM === "1") return { ok: true, verified: "managed-artifact", action: "open", artifactId };
                    const error = await shell.openPath(managedPath);
                    if (error) throw new Error(String(error).slice(0, 240));
                    return { ok: true };
                },
                "provider:setCoworkerAccount": async ({ coworkerId, accountSlot }) => {
                    if (await host.hasActiveWork()) throw new Error("Cannot switch an Antigravity account while work is active");
                    const current = coworkerStore.getInternal(coworkerId);
                    const binding = current.modelBinding ?? { profile: "automatic" };
                    const updated = coworkerStore.update(coworkerId, {
                        modelBinding: {
                            ...binding,
                            provider: "antigravity",
                            providerAccountId: `account-${accountSlot.toLowerCase()}`,
                        },
                    });
                    return { coworker: updated, refresh: await refreshCoworkerRuntime() };
                },
                "memory:list": (payload) => memoryService.list(payload),
                "memory:putFact": (payload) => memoryService.putFact(payload),
                "memory:get": (payload) => memoryService.get(payload),
                "memory:update": (payload) => memoryService.update(payload),
                "memory:forget": (payload) => memoryService.forget(payload),
                "memory:delete": (payload) => memoryService.delete(payload),
                "memory:pin": (payload) => memoryService.pin(payload),
                "memory:sourceTrace": (payload) => memoryService.sourceTrace(payload),
                "memory:listSuggestions": () => memoryService.listSuggestions(),
                "memory:approveSuggestion": ({ suggestionId }) => memoryService.approveSuggestion(suggestionId),
                "memory:rejectSuggestion": ({ suggestionId }) => memoryService.rejectSuggestion(suggestionId),
                "artifact:attachViaDialog": ({ conversationId }) => pickConversationAttachments({ win, dialog, artifactStore, conversationId }),
                "artifact:reveal": ({ artifactId }) => {
                    const managedPath = artifactStore.managedPath(artifactId);
                    if (process.env.SOVEREIGNBOT_VERIFY_SOFTWARE_TEAM === "1") return { ok: true, verified: "managed-artifact", action: "reveal", artifactId };
                    shell.showItemInFolder(managedPath);
                    return { ok: true };
                },
                "artifact:hub": (payload) => productSurfaces.artifactHub(payload),
                "computer:history": (payload) => productSurfaces.computerHistory(payload),
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
                "job:snooze": async ({ jobId, minutes }) => await jobs.snooze(jobId, minutes),
                "job:dismiss": async ({ jobId }) => await jobs.dismiss(jobId),
                "job:attention": (payload) => jobs.attentionJobs(payload),
                "notification:list": (payload) => notifications.list(payload),
                "notification:markRead": (payload) => notifications.markRead(payload),
                "notification:markAllRead": (payload) => notifications.markAllRead(payload),
                "notification:clear": (payload) => notifications.clear(payload),
                "notification:clearAll": (payload) => notifications.clearAll(payload),
                "routine:create": (payload) => routines.create(payload),
                "routine:list": (payload) => routines.list(payload),
                "routine:get": ({ routineId }) => routines.get(routineId),
                "routine:history": ({ routineId }) => routines.history(routineId),
                "routine:runNow": ({ routineId }) => routines.runNow(routineId),
                "routine:archive": ({ routineId }) => {
                    const result = routines.archive(routineId);
                    eventTriggers?.reconcile();
                    return result;
                },
                "routine:restore": ({ routineId }) => {
                    const result = routines.restore(routineId);
                    eventTriggers?.reconcile();
                    return result;
                },
                "routine:retry": ({ routineId, runId }) => routines.retry(routineId, runId),
                "routine:setEnabled": ({ routineId, enabled }) => {
                    const result = routines.setEnabled(routineId, enabled);
                    eventTriggers?.reconcile();
                    return result;
                },
                "routine:remove": ({ routineId }) => {
                    const result = routines.remove(routineId);
                    eventTriggers?.reconcile();
                    return result;
                },
                "eventTrigger:create": (payload) => eventTriggers.create(payload),
                "eventTrigger:list": () => eventTriggers.list(),
                "eventTrigger:get": ({ triggerId }) => eventTriggers.get(triggerId),
                "eventTrigger:setEnabled": ({ triggerId, enabled }) => eventTriggers.setEnabled(triggerId, enabled),
                "eventTrigger:remove": ({ triggerId }) => eventTriggers.remove(triggerId),
                "workerNode:pairViaDialog": () => workerNodeStore.pairViaDialog(win, dialog),
                "computerTarget:list": () => computerTargetController?.listTargets?.() ?? { targets: [] },
                "workerNode:list": () => workerNodeStore.list(),
                "workerNode:get": ({ nodeId }) => workerNodeStore.get(nodeId),
                "workerNode:refresh": ({ nodeId }) => workerNodeStore.refresh(nodeId),
                "workerNode:setEnabled": ({ nodeId, enabled }) => workerNodeStore.setEnabled(nodeId, enabled),
                "workerNode:remove": ({ nodeId }) => workerNodeStore.remove(nodeId),
                "workerNode:trustBegin": ({ nodeId, transport, ttlMs }) => workerNodeStore.trust.beginPairing(nodeId, { transport, ...(ttlMs === undefined ? {} : { ttlMs }) }),
                "workerNode:trustComplete": ({ nodeId, offer, response }) => workerNodeStore.trust.completePairing(nodeId, offer, response),
                "workerNode:trustCompleteViaDialog": ({ nodeId }) => workerNodeStore.trustCompleteViaDialog(win, dialog, nodeId),
                "workerNode:trustRevoke": ({ nodeId }) => workerNodeStore.trust.revoke(nodeId),
                "workerNode:trustRotate": ({ nodeId }) => workerNodeStore.trust.rotate(nodeId),
                "externalController:list": () => externalControllerStore.list(),
                "externalController:get": ({ deviceId }) => externalControllerStore.get(deviceId),
                "externalController:pairingBegin": ({ transport, ttlMs, trustTtlMs } = {}) => externalControllerStore.beginPairing({ transport, ...(ttlMs === undefined ? {} : { ttlMs }), ...(trustTtlMs === undefined ? {} : { trustTtlMs }) }),
                "externalController:pairingComplete": ({ offer, response, scopes, teamIds, projectIds, expiresAt } = {}) => externalControllerStore.completePairing(offer, response, { scopes, teamIds, projectIds, ...(expiresAt === undefined ? {} : { expiresAt }) }),
                "externalController:revoke": ({ deviceId }) => externalControllerStore.revoke(deviceId),
                "externalController:rotate": ({ deviceId }) => externalControllerStore.rotate(deviceId),
        };
        const searchMutationChannels = new Set([
            "conversation:createDirect", "conversation:createTeam", "conversation:send", "conversation:redirect",
            "artifact:attachViaDialog", "artifact:archive", "artifact:restore", "artifact:restoreAsNewVersion", "artifact:reviseViaDialog", "coworker:create", "coworker:update", "coworker:archive", "coworker:restore",
            "team:requestCollaboration", "team:requestParallel", "team:installPack", "team:importPack", "team:importPlaybook", "team:createChannelFromTemplate",
            "playbook:create", "playbook:update", "playbook:archive", "playbook:restore", "playbook:duplicate", "playbook:import", "playbook:assign",
            "channel:create", "channel:update", "channel:archive", "channel:restore",
            "skill:create", "skill:update", "skill:archive", "skill:restore", "skill:assign", "skill:import",
            "routine:create", "routine:archive", "routine:restore", "routine:setEnabled", "routine:remove", "routine:runNow", "routine:retry",
            "eventTrigger:create", "eventTrigger:setEnabled", "eventTrigger:remove",
            "goal:submit", "goal:cancel", "team:computerTask", "job:submit", "job:cancel", "job:pause", "job:resume", "job:approve", "job:dismiss",
        ]);
        for (const channel of searchMutationChannels) {
            const handler = handlers[channel];
            if (!handler) continue;
            handlers[channel] = async (...args) => { const result = await handler(...args); search?.invalidate(); return result; };
        }
        bindIpcChannels({ win, handlers });
    }

    const start = async () => {
        win = createMainWindow({ smoke: process.argv.includes("--verify-software-team") });
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

    if (process.argv.includes("--verify-software-team")) {
        const { runVerifySoftwareTeam } = await import("./verify-software-team.js");
        const result = await runVerifySoftwareTeam({
            win,
            dataDir,
            getHost: () => host,
            getServices: () => services,
            getCoworkerStore: () => coworkerStore,
            getConversationStore: () => conversationStore,
            getTeamService: () => teamService,
            evidenceDir: process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        await requestQuit("verify-software-team");
        return;
    }

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
