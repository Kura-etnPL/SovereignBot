// Hidden Electron acceptance for the P14 controlled parallel-specialist flow.
// The renderer/preload/validated IPC path and the production dispatcher are used
// end to end. Provider execution is replaced only at the runtime boundary by a
// phase-gated local stub; no provider process, network, or account is contacted.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { desktopVersion } from "./lib/desktop-version.js";
import { createDesktopServices } from "./services.js";
import { createArtifactStore } from "./artifact-store.js";
import { createCoworkerDispatcher } from "./coworker-dispatcher.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createTeamService } from "./team-service.js";
import { buildProviderRoster, coworkerAgentId } from "./provider-roster.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = join(WORKTREE_ROOT, "_evidence_v53_2026-09-02");
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function localRoster() {
    return { ready: false, mode: "local-gate", roles: {}, agents: [], providers: {}, coworkerBindings: {} };
}

function controlledRuntime(roster) {
    const tasks = [];
    const waiters = new Map();
    let sequence = 0;
    let phase = "children";
    const released = new Set();

    function waitForPhase(expected) {
        if (released.has(expected)) return Promise.resolve();
        return new Promise((resolvePromise) => {
            const list = waiters.get(expected) ?? [];
            list.push(resolvePromise);
            waiters.set(expected, list);
        });
    }

    function release(expected) {
        if (phase !== expected) throw new Error(`controlled runtime expected ${expected}, observed ${phase}`);
        const next = expected === "children" ? "review" : expected === "review" ? "join" : "done";
        released.add(expected);
        phase = next;
        for (const resolvePromise of waiters.get(expected) ?? []) resolvePromise();
        waiters.delete(expected);
    }

    function resultFor(task) {
        if (task.input?.fanoutMode === "child") {
            const key = String(task.input.fanoutChildKey ?? "specialist");
            const title = `${key} isolated report`;
            mkdirSync(task.executionContext.cwd, { recursive: true });
            writeFileSync(join(task.executionContext.cwd, `${key}.md`), `Controlled report for ${key}.\n`, "utf8");
            return `Completed ${key} bounded work.\nSOVEREIGN_ARTIFACTS: [{"path":"${key}.md","title":"${title}"}]`;
        }
        if (task.input?.fanoutMode === "review") return "Independent reviewer approved the bounded specialist results.\nSOVEREIGN_REVIEW: \"approved\"";
        if (task.input?.fanoutMode === "join") return "Original owner joined the approved specialist results.";
        return "Controlled chief result.";
    }

    async function runUntilIdle() {
        if (phase === "done") return;
        const queuedModes = new Set(tasks.filter((entry) => entry.status === "queued").map((entry) => entry.input?.fanoutMode));
        const expected = queuedModes.has("child") ? "children" : phase;
        await waitForPhase(expected);
        const mode = expected === "children" ? "child" : expected;
        for (const task of tasks.filter((entry) => entry.status === "queued" && entry.input?.fanoutMode === mode)) {
            const agent = roster().agents.find((entry) => entry.id === task.preferredAgentId);
            if (!agent) throw new Error(`controlled runtime missing ${task.preferredAgentId}`);
            if (!task.requiredCapabilities.every((capability) => agent.capabilities.includes(capability)))
                throw new Error(`controlled runtime capability mismatch for ${task.id}`);
            task.assignedAgentId = agent.id;
            task.status = "completed";
            task.result = { text: resultFor(task) };
        }
        if (mode === "review") phase = "join";
    }

    const runtime = {
        orchestrator: {
            async createPlan(spec) { return { id: `plan_${++sequence}`, ...spec }; },
            async delegateTrusted(planId, spec, executionContext) {
                const task = { id: `task_${++sequence}`, parentTaskId: planId, status: "queued", ...structuredClone(spec), executionContext: structuredClone(executionContext) };
                tasks.push(task);
                return structuredClone(task);
            },
            async preflightTrustedTask(taskId) {
                const task = tasks.find((entry) => entry.id === taskId);
                if (!task) throw new Error(`controlled runtime missing task ${taskId}`);
                return { allowed: true, agentId: task.preferredAgentId, task: structuredClone(task) };
            },
            requireAgent(agentId) {
                const agent = roster().agents.find((entry) => entry.id === agentId);
                if (!agent) throw new Error(`controlled runtime missing agent ${agentId}`);
                return agent;
            },
            runUntilIdle,
            async listTasks() { return structuredClone(tasks); },
            async cancel(taskId) {
                const task = tasks.find((entry) => entry.id === taskId);
                if (task) task.status = "cancelled";
                return structuredClone(task);
            },
        },
        audit: { async append() {} },
        tasks,
        release,
        phase: () => phase,
    };
    return runtime;
}

function makeFixture(dataDir) {
    const stateDir = join(dataDir, "desktop-state");
    mkdirSync(stateDir, { recursive: true });
    const services = createDesktopServices({ dataDir, dialog: {} });
    const coworkerStore = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
    const conversationStore = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore });
    const teamService = createTeamService({ dataDir, coworkerStore, conversationStore, services });
    teamService.setRuntimeHandoffPreflight(({ conversationId, targetCoworkerId, workspaceId }) => ({
        targetCoworkerId,
        agentId: coworkerAgentId(targetCoworkerId),
        workspaceId: workspaceId ?? teamService.workspaceIdForConversation(conversationId),
    }));
    conversationStore.setTeamRouteResolver((conversation) => teamService.currentOwnerForConversation(conversation.id));
    const artifactStore = createArtifactStore({ dataDir });
    return { services, coworkerStore, conversationStore, teamService, artifactStore };
}

function handlers(fixture, dispatcher, requestStats) {
    const { services, coworkerStore, conversationStore, teamService, artifactStore } = fixture;
    return {
        "app:handshake": () => ({ ok: true, version: desktopVersion(), platform: process.platform, locale: "en-US", language: services.getSettings().language }),
        "firstrun:getStatus": () => ({ browsers: [] }),
        "workspace:list": () => services.listWorkspaces(),
        "settings:get": () => services.getSettings(),
        "settings:update": (patch) => services.updateSettings(patch),
        "provider:getRoster": () => localRoster(),
        "provider:refresh": () => ({ applied: false, roster: localRoster() }),
        "coworker:list": ({ includeArchived }) => coworkerStore.list({ includeArchived }),
        "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
        "conversation:list": () => conversationStore.list(),
        "conversation:get": ({ conversationId }) => conversationStore.get(conversationId),
        "team:list": () => teamService.list(),
        "team:get": ({ teamId }) => teamService.get(teamId),
        "team:activity": (payload) => teamService.activity(payload),
        "team:requestParallel": (payload) => {
            requestStats.total += 1;
            requestStats.targets.push({ reviewerCoworkerId: payload.reviewerCoworkerId, childCount: payload.children.length });
            const result = teamService.requestParallelCollaboration(payload);
            const recipients = Object.entries(result.message.delivery ?? {})
                .filter(([, delivery]) => delivery?.status === "pending")
                .map(([coworkerId]) => coworkerId);
            const scheduled = dispatcher.dispatchMessage(payload.conversationId, result.message.id);
            return { ...result, scheduledRecipients: scheduled.length, pendingRecipients: recipients };
        },
        "team:requestCollaboration": (payload) => teamService.requestCollaboration(payload),
        "channel:list": (payload) => teamService.listChannels(payload),
        "project:list": () => ({ projects: [] }),
        "skill:list": () => ({ skills: [] }),
        "artifact:list": (payload) => artifactStore.list(payload),
        "artifact:get": ({ artifactId }) => artifactStore.get(artifactId),
        "artifact:preview": ({ artifactId }) => artifactStore.previewText(artifactId),
        "memory:list": () => ({ memories: [] }),
        "memory:listSuggestions": () => ({ suggestions: [] }),
        "connectedApps:list": () => ({ apps: [] }),
        "eventTrigger:list": () => ({ triggers: [] }),
        "data:status": () => ({ backups: [] }),
        "data:listBackups": () => ({ backups: [] }),
        "update:status": () => ({ channel: "stable", currentVersion: desktopVersion(), available: false }),
        "job:list": () => ({ jobs: [] }),
        "job:attention": () => ({ jobs: [] }),
        "routine:list": () => ({ routines: [] }),
    };
}

async function loadWindow(win) {
    await win.loadURL(appOrigin());
    await win.webContents.executeJavaScript("(async()=>document.readyState==='complete'?true:await new Promise(r=>window.addEventListener('load',()=>r(true),{once:true})))()");
    await sleep(900);
}

async function invoke(win, expression) { return win.webContents.executeJavaScript(`(${expression})()`); }

async function publicSnapshot(win, teamId, conversationId) {
    return invoke(win, `async()=>({team:await window.sovereignbot.teams.get({teamId:${JSON.stringify(teamId)}}),conversation:await window.sovereignbot.conversations.get({conversationId:${JSON.stringify(conversationId)}}),activity:await window.sovereignbot.teams.activity({conversationId:${JSON.stringify(conversationId)},limit:64}),artifacts:await window.sovereignbot.artifacts.list({conversationId:${JSON.stringify(conversationId)},limit:50})})`);
}

function parallelPayload(conversationId, research, builder, quality, extra = {}) {
    return {
        conversationId,
        children: [
            { targetCoworkerId: research.id, boundedTask: "Research the bounded change and return an isolated report.", requiresComputer: true },
            { targetCoworkerId: builder.id, boundedTask: "Implement the bounded change in the private specialist root." },
        ],
        reviewerCoworkerId: quality.id,
        reason: "Two independent Specialists should complete the bounded work before required review.",
        ...extra,
    };
}

async function rejectThroughRenderer(win, payload) {
    return invoke(win, `async()=>{try { await window.sovereignbot.teams.requestParallel(${JSON.stringify(payload)}); return { rejected: false }; } catch (error) { return { rejected: true, message: String(error?.message ?? error) }; }}`);
}

function durableFingerprint(value) {
    return JSON.stringify({
        flow: value.team?.flow,
        messages: value.conversation?.messages?.map((message) => ({ id: message.id, senderId: message.senderId, text: message.text, mentions: message.mentions, delivery: message.delivery })),
        activity: value.activity?.events,
        artifacts: value.artifacts,
    });
}

function safePublic(value) {
    if (Array.isArray(value)) return value.every(safePublic);
    if (!value || typeof value !== "object") return true;
    const forbiddenKey = /^(?:fanoutid|workspacekey|taskid|cwd|workspacepath|sessionid|provideraccountid|capability|token)$/i;
    return Object.entries(value).every(([key, child]) => !forbiddenKey.test(key.replaceAll(/[-_]/g, "")) && safePublic(child));
}

function pathsAreIsolated(tasks, dataDir, fanoutId) {
    const parent = resolve(join(dataDir, "desktop-state", "coworker-workspaces", "fanout", fanoutId));
    const children = tasks.filter((task) => task.input?.fanoutMode === "child");
    const roots = children.map((task) => resolve(task.executionContext.cwd));
    return children.length === 2
        && new Set(roots).size === roots.length
        && roots.every((root) => {
            const rel = relative(parent, root);
            return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && existsSync(join(root, `${taskKeyForRoot(root)}.md`));
        });
}

function taskKeyForRoot(root) {
    const entries = readdirSync(root);
    const report = entries.find((entry) => entry.endsWith(".md"));
    return report ? report.slice(0, -3) : "missing";
}

async function waitFor(label, fn, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await fn()) return;
        await sleep(80);
    }
    throw new Error(`timed out waiting for ${label}`);
}

export async function runVerifyP14TeamFanout({ app }) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const checks = {};
    const log = [];
    const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
    const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };
    const tempRoot = process.env.SOVEREIGNBOT_V53_TEMP_ROOT;
    if (!tempRoot) throw new Error("V53 temp root is missing; refusing to use the default user profile");
    const dataDir = join(tempRoot, "data");
    let fixture; let runtime; let dispatcher; let win; let unbind; let uninstallProtocol; let fatal;
    let team; let channel; let chief; let research; let builder; let quality; let outsider; let snapshot;
    const requestStats = { total: 0, targets: [] };
    try {
        fixture = makeFixture(dataDir);
        chief = fixture.coworkerStore.create({ name: "P14 Chief", role: "Coordinate" });
        research = fixture.coworkerStore.create({ name: "P14 Research Specialist", role: "Research" });
        builder = fixture.coworkerStore.create({ name: "P14 Build Specialist", role: "Build" });
        quality = fixture.coworkerStore.create({ name: "P14 Quality Reviewer", role: "Review" });
        outsider = fixture.coworkerStore.create({ name: "P14 Outside Specialist", role: "External" });
        const created = fixture.teamService.createTeam({ title: "P14 Parallel Team", coworkerIds: [chief.id, research.id, builder.id, quality.id], leadCoworkerId: chief.id });
        team = created.team;
        channel = team.channels[0];
        const first = fixture.conversationStore.postUserMessage(channel.conversationId, { text: "Start the bounded parallel Team task." });
        fixture.teamService.onMessageQueued({ conversation: fixture.conversationStore.get(channel.conversationId), message: first });
        fixture.conversationStore.markDelivery(channel.conversationId, first.id, chief.id, "delivered");

        const roster = buildProviderRoster({
            discovery: { codex: { found: true, auth: { state: "signed-in" } }, claude: { found: true, auth: { state: "signed-in" } } },
            settings: {},
            coworkers: fixture.coworkerStore.list().coworkers,
            getCoworkerAppAccess: (coworkerId) => coworkerId === research.id ? { tools: ["computer"] } : { tools: [] },
        });
        runtime = controlledRuntime(() => roster);
        // The app-assignment resolver is the authority for optional computer work.
        fixture.teamService.setCoworkerAppAccessResolver((coworkerId) => coworkerId === research.id ? { tools: ["computer"] } : { tools: [] });
        dispatcher = createCoworkerDispatcher({ dataDir, runtime, roster: () => roster, coworkerStore: fixture.coworkerStore, conversationStore: fixture.conversationStore, artifactStore: fixture.artifactStore, services: fixture.services, teamFlow: fixture.teamService });

        uninstallProtocol = installAppProtocolHandler();
        win = createMainWindow({ smoke: true });
        unbind = bindIpcChannels({ win, handlers: handlers(fixture, dispatcher, requestStats) });
        check("hidden Electron window stays hidden", win.isVisible() === false);
        await loadWindow(win);
        const surface = await invoke(win, "async()=>({request:typeof window.sovereignbot?.teams?.requestParallel,channel:!!document.getElementById('conversation-messages'),details:!!document.getElementById('details-collaboration')})");
        check("preload exposes parallel Team action and normal Team Channel surface", surface.request === "function" && surface.channel && surface.details, JSON.stringify(surface));
        await waitFor("Team sidebar entry", async () => await invoke(win, "async()=>!!document.querySelector('#team-list button')"));
        await invoke(win, "async()=>{document.querySelector('#team-list button')?.click(); return true}");
        await waitFor("Team Channel", async () => await invoke(win, "async()=>document.getElementById('conversation-title')?.textContent==='Project Channel'"));
        await invoke(win, "async()=>{document.getElementById('open-details')?.click(); return true}");
        await waitFor("parallel controls", async () => await invoke(win, "async()=>!!document.getElementById('details-parallel-collaboration')"));
        const initialControls = await invoke(win, "async()=>({rows:document.querySelectorAll('#parallel-specialist-list .parallel-specialist-row').length,reviewer:!!document.getElementById('parallel-reviewer'),form:!!document.getElementById('parallel-collaboration-form'),internals:document.getElementById('details-parallel-collaboration')?.innerText||''})");
        check("Team Channel renders two bounded Specialist rows and an independent reviewer selector", initialControls.rows === 2 && initialControls.reviewer && initialControls.form && !/(fanout|workspaceKey|taskId|sessionId|token|cwd)/i.test(initialControls.internals), JSON.stringify(initialControls));
        const validPayload = parallelPayload(channel.conversationId, research, builder, quality);

        const semanticCases = [
            ["duplicate Specialist target", { children: [validPayload.children[0], validPayload.children[0]] }],
            ["reviewer conflict", { reviewerCoworkerId: research.id }],
            ["non-roster Specialist", { children: [{ ...validPayload.children[0], targetCoworkerId: outsider.id }, validPayload.children[1]] }],
        ];
        for (const [label, patch] of semanticCases) {
            const before = await publicSnapshot(win, team.id, channel.conversationId);
            const result = await rejectThroughRenderer(win, { ...validPayload, ...patch });
            const after = await publicSnapshot(win, team.id, channel.conversationId);
            check(`${label} is rejected by the normal-user parallel flow`, result.rejected === true && durableFingerprint(after) === durableFingerprint(before), JSON.stringify(result));
        }
        fixture.coworkerStore.update(research.id, { state: "paused" });
        const inactiveBefore = await publicSnapshot(win, team.id, channel.conversationId);
        const inactiveResult = await rejectThroughRenderer(win, validPayload);
        const inactiveAfter = await publicSnapshot(win, team.id, channel.conversationId);
        check("inactive Specialist is rejected without durable mutation", inactiveResult.rejected === true && durableFingerprint(inactiveAfter) === durableFingerprint(inactiveBefore), JSON.stringify(inactiveResult));
        fixture.coworkerStore.update(research.id, { state: "active" });

        for (const [field, value] of [["ownerId", chief.id], ["providerAccountId", "forged-account"], ["capability", "computer"], ["token", "forged-token"], ["workspacePath", "C:\\forged"], ["sessionId", "forged-session"]]) {
            const before = await publicSnapshot(win, team.id, channel.conversationId);
            const callsBefore = requestStats.total;
            const result = await rejectThroughRenderer(win, { ...validPayload, [field]: value });
            const after = await publicSnapshot(win, team.id, channel.conversationId);
            check(`forged ${field} is rejected before the parallel handler`, result.rejected === true && requestStats.total === callsBefore && durableFingerprint(after) === durableFingerprint(before), JSON.stringify(result));
        }

        const validCallsBefore = requestStats.total;
        const submitted = await invoke(win, `async()=>{const rows=[...document.querySelectorAll('#parallel-specialist-list .parallel-specialist-row')]; rows[0].querySelector('.parallel-target').value=${JSON.stringify(research.id)}; rows[0].querySelector('.parallel-task').value=${JSON.stringify(validPayload.children[0].boundedTask)}; rows[0].querySelector('.parallel-computer').checked=true; rows[1].querySelector('.parallel-target').value=${JSON.stringify(builder.id)}; rows[1].querySelector('.parallel-task').value=${JSON.stringify(validPayload.children[1].boundedTask)}; document.getElementById('parallel-reviewer').value=${JSON.stringify(quality.id)}; document.getElementById('parallel-reason').value=${JSON.stringify(validPayload.reason)}; document.getElementById('parallel-submit').click(); return true}`);
        check("renderer submits only conversationId, bounded children, reviewer, and reason", submitted === true, JSON.stringify(submitted));
        await waitFor("parallel fanout requested", async () => (await publicSnapshot(win, team.id, channel.conversationId)).team.flow.activeFanout?.state === "running");
        snapshot = await publicSnapshot(win, team.id, channel.conversationId);
        const ownerMessage = snapshot.conversation.messages.at(-1);
        check("controlled parallel request has two active children and no active legacy handoff", snapshot.team.flow.activeFanout?.children?.length === 2 && !snapshot.team.flow.activeProtocol && requestStats.total === validCallsBefore + 1, JSON.stringify(snapshot.team.flow.activeFanout));
        check("only the two selected Specialists are woken", Object.keys(ownerMessage.delivery ?? {}).length === 2 && Object.keys(ownerMessage.delivery).every((id) => [research.id, builder.id].includes(id)) && ownerMessage.mentions?.length === 2, JSON.stringify(ownerMessage.delivery));
        const progress = await invoke(win, "async()=>({text:document.getElementById('parallel-collaboration-progress')?.innerText||'',formHidden:document.getElementById('parallel-collaboration-form')?.classList.contains('hidden'),handoffDisabled:document.getElementById('collaboration-submit')?.disabled})");
        check("active fanout shows progress and disables new handoff/fanout actions", /0\/2|Parallel work/i.test(progress.text) && progress.formHidden === true && progress.handoffDisabled === true, JSON.stringify(progress));
        check("active public projection exposes bounded work without execution authority", safePublic(snapshot.team) && safePublic(snapshot.conversation) && safePublic(snapshot.activity) && safePublic(snapshot.artifacts), "safe projection");

        const duplicateBefore = await publicSnapshot(win, team.id, channel.conversationId);
        const duplicateCalls = requestStats.total;
        const duplicateResult = await rejectThroughRenderer(win, { ...validPayload, reason: "A second fanout must fail closed." });
        const duplicateAfter = await publicSnapshot(win, team.id, channel.conversationId);
        check("duplicate active fanout is rejected and leaves one protocol", duplicateResult.rejected === true && requestStats.total === duplicateCalls + 1 && durableFingerprint(duplicateAfter) === durableFingerprint(duplicateBefore), JSON.stringify(duplicateResult));

        const fanoutId = fixture.teamService.fanoutContextForConversation(channel.conversationId).activeFanout.fanoutId;
        runtime.release("children");
        await waitFor("required independent review", async () => ["review_requested", "reviewing"].includes((await publicSnapshot(win, team.id, channel.conversationId)).team.flow.activeFanout?.state));
        snapshot = await publicSnapshot(win, team.id, channel.conversationId);
        const reviewMessage = snapshot.conversation.messages.at(-1);
        const childTasks = runtime.tasks.filter((task) => task.input?.fanoutMode === "child");
        check("each Specialist completes through the existing dispatcher and isolated private root", childTasks.length === 2 && childTasks.every((task) => task.status === "completed") && pathsAreIsolated(childTasks, dataDir, fanoutId), JSON.stringify(childTasks.map((task) => ({ status: task.status, root: task.executionContext.cwd }))));
        check("review is delivered only to the designated independent reviewer", Object.keys(reviewMessage.delivery ?? {}).length === 1 && reviewMessage.delivery[quality.id]?.status === "pending" && reviewMessage.mentions?.length === 1 && reviewMessage.mentions[0] === quality.id, JSON.stringify(reviewMessage.delivery));
        await waitFor("review progress UI", async () => /2\/2|Reviewing/i.test(await invoke(win, "async()=>document.getElementById('parallel-collaboration-progress')?.innerText||''")));
        const reviewProgressText = await invoke(win, "async()=>document.getElementById('parallel-collaboration-progress')?.innerText||''");
        check("review progress exposes completed child count without internals", safePublic(snapshot.team) && /2\/2|Reviewing/i.test(reviewProgressText), JSON.stringify({ text: reviewProgressText, safe: safePublic(snapshot.team) }));

        await waitFor("reviewer accepted but paused before decision", async () => (await publicSnapshot(win, team.id, channel.conversationId)).team.flow.activeFanout?.state === "reviewing");
        snapshot = await publicSnapshot(win, team.id, channel.conversationId);
        const reviewOnlyMessage = snapshot.conversation.messages.find((message) => message.text?.includes("required independent review"));
        check("review-only wake remains restricted to the designated reviewer", reviewOnlyMessage?.mentions?.length === 1 && reviewOnlyMessage.mentions[0] === quality.id && Object.keys(reviewOnlyMessage.delivery ?? {}).length === 1 && reviewOnlyMessage.delivery[quality.id]?.status === "pending", JSON.stringify(reviewOnlyMessage?.delivery));
        runtime.release("review");
        await waitFor("original owner join", async () => ["join_requested", "joining"].includes((await publicSnapshot(win, team.id, channel.conversationId)).team.flow.activeFanout?.state));
        snapshot = await publicSnapshot(win, team.id, channel.conversationId);
        const joinMessage = snapshot.conversation.messages.at(-1);
        check("approved review creates exactly one original-owner join", snapshot.team.flow.activeFanout?.review === "approved" && Object.keys(joinMessage.delivery ?? {}).length === 1 && joinMessage.delivery[chief.id]?.status === "pending" && joinMessage.mentions?.[0] === chief.id, JSON.stringify(joinMessage.delivery));
        check("reviewer is not promoted to final owner", snapshot.team.flow.currentOwnerId === chief.id && snapshot.team.flow.activeFanout?.owner === "P14 Chief", JSON.stringify(snapshot.team.flow));

        runtime.release("join");
        await waitFor("parallel fanout completion", async () => !(await publicSnapshot(win, team.id, channel.conversationId)).team.flow.activeFanout);
        snapshot = await publicSnapshot(win, team.id, channel.conversationId);
        const finalMessage = snapshot.conversation.messages.at(-1);
        check("final completion returns to the original owner and clears active fanout", snapshot.team.flow.status === "available" && !snapshot.team.flow.activeFanout && finalMessage.senderId === chief.id && snapshot.activity.events[0]?.label === "Completed", JSON.stringify({ flow: snapshot.team.flow, finalSenderId: finalMessage.senderId }));
        check("child artifacts are published only at final join and project safely", snapshot.artifacts.artifacts.length === 2 && finalMessage.artifactIds?.length === 2 && safePublic(snapshot.artifacts) && snapshot.artifacts.artifacts.every((entry) => !Object.hasOwn(entry, "path") && !Object.hasOwn(entry, "storageRelativePath")), JSON.stringify(snapshot.artifacts));
        check("all four dispatcher tasks complete with no provider execution", runtime.tasks.length === 4 && runtime.tasks.every((task) => task.status === "completed") && runtime.tasks.filter((task) => task.input?.fanoutMode === "review").length === 1 && runtime.tasks.filter((task) => task.input?.fanoutMode === "join").length === 1, JSON.stringify(runtime.tasks.map((task) => ({ mode: task.input?.fanoutMode, status: task.status }))));
        check("final public summary is safe and bounded", safePublic(snapshot) && !/(C:\\|\\\\|desktop-state|fanout\.)/i.test(JSON.stringify(snapshot)), "safe final summary");

        unbind(); unbind = undefined;
        const restartedFixture = makeFixture(dataDir);
        const restartedRoster = buildProviderRoster({ discovery: { codex: { found: true, auth: { state: "signed-in" } }, claude: { found: true, auth: { state: "signed-in" } } }, settings: {}, coworkers: restartedFixture.coworkerStore.list().coworkers, getCoworkerAppAccess: (coworkerId) => coworkerId === research.id ? { tools: ["computer"] } : { tools: [] } });
        restartedFixture.teamService.setCoworkerAppAccessResolver((coworkerId) => coworkerId === research.id ? { tools: ["computer"] } : { tools: [] });
        const restartedRuntime = controlledRuntime(() => restartedRoster);
        const restartedDispatcher = createCoworkerDispatcher({ dataDir, runtime: restartedRuntime, roster: () => restartedRoster, coworkerStore: restartedFixture.coworkerStore, conversationStore: restartedFixture.conversationStore, artifactStore: restartedFixture.artifactStore, services: restartedFixture.services, teamFlow: restartedFixture.teamService });
        unbind = bindIpcChannels({ win, handlers: handlers(restartedFixture, restartedDispatcher, { total: 0, targets: [] }) });
        await loadWindow(win);
        const restarted = await publicSnapshot(win, team.id, channel.conversationId);
        check("restart preserves completed original-owner result, artifacts, and no active fanout", restarted.team.flow.status === "available" && !restarted.team.flow.activeFanout && restarted.conversation.messages.at(-1)?.senderId === chief.id && restarted.artifacts.artifacts.length === 2, JSON.stringify(restarted.team.flow));
        check("restart renderer projection remains authority-free", safePublic(restarted), "safe restart projection");
    }
    catch (error) {
        fatal = error;
        note(`[fatal] ${String(error?.stack ?? error)}`);
        note(`[runtime] phase=${runtime?.phase?.() ?? "none"} tasks=${JSON.stringify(runtime?.tasks?.map((task) => ({ id: task.id, mode: task.input?.fanoutMode, status: task.status })) ?? [])}`);
        try { note(`[flow] ${JSON.stringify(fixture?.teamService?.collaborationContextForConversation?.(channel?.conversationId))}`); } catch {}
        check("P14 Electron parallel-specialist gate runner completed", false, String(error?.message ?? error));
    }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
    const summary = { at: new Date().toISOString(), checks, teamId: team?.id, channelId: channel?.id, ownerCoworkerId: chief?.id, reviewerCoworkerId: quality?.id, childCoworkerIds: [research?.id, builder?.id].filter(Boolean), requestStats, snapshot, fatal: fatal ? String(fatal?.message ?? fatal) : undefined };
    writeFileSync(join(EVIDENCE_DIR, "verify-p14-team-fanout.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    writeFileSync(join(EVIDENCE_DIR, "verify-p14-team-fanout.log"), `${log.join("\n")}\n`, "utf8");
    try { unbind?.(); } catch {} try { uninstallProtocol?.(); } catch {} try { win?.destroy(); } catch {} try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    if (fatal || failed.length) throw new Error(`P14 parallel-specialist gate failed: ${failed.join(", ") || String(fatal?.message ?? fatal)}`);
    app.exit(0);
}
