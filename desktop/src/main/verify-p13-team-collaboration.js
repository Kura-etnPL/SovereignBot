// Hidden Electron correction acceptance for the directed Team collaboration slice.
// It drives the renderer/preload/validated IPC boundary for invalid requests and
// the full handoff -> review -> handback path. The wake callback is intentionally
// controlled: this gate verifies target selection and delivery fan-in without
// claiming a provider execution.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { desktopVersion } from "./lib/desktop-version.js";
import { createDesktopServices } from "./services.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createConversationStore } from "./conversation-store.js";
import { createTeamService } from "./team-service.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = join(WORKTREE_ROOT, "_evidence_v52_2026-09-02");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function roster() { return { ready: false, mode: "local-gate", roles: {}, agents: [], providers: {}, coworkerBindings: {} }; }

function makeFixture(dataDir) {
    const stateDir = join(dataDir, "desktop-state");
    mkdirSync(stateDir, { recursive: true });
    const services = createDesktopServices({ dataDir, dialog: {} });
    const coworkerStore = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
    const conversationStore = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore });
    const teamService = createTeamService({ dataDir, coworkerStore, conversationStore, services });
    teamService.setRuntimeHandoffPreflight(({ conversationId, targetCoworkerId, workspaceId }) => ({
        targetCoworkerId,
        agentId: `controlled-${targetCoworkerId}`,
        workspaceId: workspaceId ?? teamService.workspaceIdForConversation(conversationId),
    }));
    return { services, coworkerStore, conversationStore, teamService };
}

function handlers(fixture, wakeLog, requestStats = { total: 0, targets: [] }) {
    const { services, coworkerStore, conversationStore, teamService } = fixture;
    return {
        "app:handshake": () => ({ ok: true, version: desktopVersion(), platform: process.platform, locale: "en-US", language: services.getSettings().language }),
        "firstrun:getStatus": () => ({ browsers: [] }),
        "workspace:list": () => services.listWorkspaces(),
        "settings:get": () => services.getSettings(),
        "settings:update": (patch) => services.updateSettings(patch),
        "provider:getRoster": () => roster(),
        "provider:refresh": () => ({ applied: false, roster: roster() }),
        "coworker:list": ({ includeArchived }) => coworkerStore.list({ includeArchived }),
        "coworker:get": ({ coworkerId }) => coworkerStore.get(coworkerId),
        "conversation:list": () => conversationStore.list(),
        "conversation:get": ({ conversationId }) => conversationStore.get(conversationId),
        "team:list": () => teamService.list(),
        "team:get": ({ teamId }) => teamService.get(teamId),
        "team:activity": (payload) => teamService.activity(payload),
        "team:requestCollaboration": (payload) => {
            requestStats.total += 1;
            requestStats.targets.push({ targetCoworkerId: payload.targetCoworkerId, handoffType: payload.handoffType });
            const result = teamService.requestCollaboration(payload);
            const recipients = Object.entries(result.message.delivery ?? {})
                .filter(([, delivery]) => delivery?.status === "pending")
                .map(([coworkerId]) => coworkerId);
            wakeLog.push(...recipients);
            return { ...result, scheduledRecipients: recipients.length };
        },
        "channel:list": (payload) => teamService.listChannels(payload),
        "project:list": () => ({ projects: [] }),
        "skill:list": () => ({ skills: [] }),
        "artifact:list": () => ({ artifacts: [] }),
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
    return invoke(win, `async()=>({team:await window.sovereignbot.teams.get({teamId:${JSON.stringify(teamId)}}),conversation:await window.sovereignbot.conversations.get({conversationId:${JSON.stringify(conversationId)}}),activity:await window.sovereignbot.teams.activity({conversationId:${JSON.stringify(conversationId)},limit:32})})`);
}

function collaborationPayload(conversationId, targetCoworkerId, handoffType, boundedTask, reason, extra = {}) {
    return { conversationId, targetCoworkerId, handoffType, boundedTask, reason, ...extra };
}

async function requestThroughRenderer(win, payload) {
    return invoke(win, `async()=>window.sovereignbot.teams.requestCollaboration(${JSON.stringify(payload)})`);
}

async function rejectThroughRenderer(win, payload) {
    return invoke(win, `async()=>{try { await window.sovereignbot.teams.requestCollaboration(${JSON.stringify(payload)}); return { rejected: false }; } catch (error) { return { rejected: true, message: String(error?.message ?? error) }; }}`);
}

function durableFingerprint(value) {
    return JSON.stringify({
        flow: value.team?.flow,
        messages: value.conversation?.messages?.map((message) => ({
            id: message.id,
            senderId: message.senderId,
            text: message.text,
            mentions: message.mentions,
            delivery: message.delivery,
        })),
        activity: value.activity?.events,
    });
}

function singleOwner(value, coworker) {
    const flow = value.team?.flow;
    return flow?.currentOwnerId === coworker.id && flow.currentOwner === coworker.name;
}

function onlyPendingRecipient(value, coworkerId) {
    const message = value.conversation?.messages?.at(-1);
    const delivery = message?.delivery ?? {};
    return Object.keys(delivery).length === 1 && delivery[coworkerId]?.status === "pending";
}

function completeTrustedProtocol(fixture, conversationId, targetCoworkerId, messageId, { review = false } = {}) {
    const { teamService, conversationStore } = fixture;
    let context = teamService.collaborationContextForConversation(conversationId);
    const proof = teamService.pendingProtocolProof(conversationId);
    if (!proof) throw new Error(`missing trusted protocol proof for ${targetCoworkerId}`);
    teamService.acceptProtocol({ conversationId, targetCoworkerId, proofId: proof.proofId, messageId, ...context, expectedVersion: context.version });
    context = teamService.collaborationContextForConversation(conversationId);
    teamService.claimStage({ conversationId, ownerId: targetCoworkerId, messageId, ...context, expectedVersion: context.version });
    context = teamService.collaborationContextForConversation(conversationId);
    teamService.submitProtocolResult({ conversationId, coworkerId: targetCoworkerId, messageId, ...context, expectedVersion: context.version });
    if (review) {
        context = teamService.collaborationContextForConversation(conversationId);
        teamService.recordReviewDecision({ conversationId, coworkerId: targetCoworkerId, messageId, decision: "approved", ...context, expectedVersion: context.version });
    }
    conversationStore.markDelivery(conversationId, messageId, targetCoworkerId, "delivered");
}

async function waitFor(label, fn, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await fn()) return; await sleep(80); }
    throw new Error(`timed out waiting for ${label}`);
}

function hasForbiddenPublicKey(value) {
    if (Array.isArray(value)) return value.some(hasForbiddenPublicKey);
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]) => /^(?:session|lease|path|routing|policy|capability|token|agent|workspacepath|provideraccount)/i.test(key.replaceAll(/[-_]/g, "")) || hasForbiddenPublicKey(child));
}

export async function runVerifyP13TeamCollaboration({ app }) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const checks = {}; const log = []; const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
    const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };
    const tempRoot = process.env.SOVEREIGNBOT_V52_TEMP_ROOT;
    if (!tempRoot) throw new Error("V52 temp root is missing; refusing to use the default user profile");
    const dataDir = join(tempRoot, "data");
    let fixture; let win; let unbind; let uninstallProtocol; let restartFixture; let restartWin; let restartUnbind; let fatal;
    let team; let channel; let builder; let research; let quality; let outsider; let snapshot; const wakeLog = [];
    const requestStats = { total: 0, targets: [] };
    try {
        fixture = makeFixture(dataDir);
        const chief = fixture.coworkerStore.create({ name: "P13 Chief", role: "Coordinate" });
        research = fixture.coworkerStore.create({ name: "P13 Research", role: "Research" });
        builder = fixture.coworkerStore.create({ name: "P13 Build Specialist", role: "Build" });
        quality = fixture.coworkerStore.create({ name: "P13 Quality Specialist", role: "Review" });
        outsider = fixture.coworkerStore.create({ name: "P13 Outside Specialist", role: "External" });
        const created = fixture.teamService.createTeam({ title: "P13 Directed Team", coworkerIds: [chief.id, research.id, builder.id, quality.id], leadCoworkerId: chief.id });
        team = created.team;
        channel = team.channels[0];
        const first = fixture.conversationStore.postUserMessage(channel.conversationId, { text: "Start a bounded Team delivery." });
        fixture.teamService.onMessageQueued({ conversation: fixture.conversationStore.get(channel.conversationId), message: first });
        fixture.conversationStore.markDelivery(channel.conversationId, first.id, chief.id, "delivered");

        uninstallProtocol = installAppProtocolHandler();
        win = createMainWindow({ smoke: true });
        unbind = bindIpcChannels({ win, handlers: handlers(fixture, wakeLog, requestStats) });
        check("hidden Electron window stays hidden", win.isVisible() === false);
        await loadWindow(win);
        const surface = await invoke(win, "async()=>({request:typeof window.sovereignbot?.teams?.requestCollaboration, channel:!!document.getElementById('conversation-messages'), control:!!document.getElementById('details-collaboration')})");
        check("preload exposes the bounded collaboration action and Team Channel surface", surface.request === "function" && surface.channel && surface.control, JSON.stringify(surface));
        await waitFor("Team sidebar entry", async () => await invoke(win, "async()=>!!document.querySelector('#team-list button')"));
        await invoke(win, "async()=>{document.querySelector('#team-list button')?.click(); return true}");
        await waitFor("Team Channel", async () => await invoke(win, `async()=>document.getElementById('conversation-title')?.textContent==='Project Channel'`));
        await invoke(win, "async()=>{document.getElementById('open-details')?.click(); return true}");
        await waitFor("collaboration controls", async () => await invoke(win, "async()=>!document.getElementById('details-collaboration')?.classList.contains('hidden')"));
        const controls = await invoke(win, "async()=>({hidden:document.getElementById('details-collaboration')?.classList.contains('hidden'), options:[...document.querySelectorAll('#collaboration-target option')].map((entry)=>entry.textContent), owner:document.getElementById('details-current-work')?.textContent, internals:document.getElementById('details-collaboration')?.innerText})");
        check("Team Channel shows available teammate targets without runtime internals", !controls.hidden && controls.options.length === 3 && controls.options.includes("P13 Build Specialist") && !/(session|lease|path|routing|policy)/i.test(controls.internals), JSON.stringify(controls));

        fixture.coworkerStore.update(quality.id, { state: "paused" });
        const inactiveBefore = await publicSnapshot(win, team.id, channel.conversationId);
        const inactiveResult = await rejectThroughRenderer(win, collaborationPayload(channel.conversationId, quality.id, "review", "Review the bounded change.", "The inactive specialist must not receive work."));
        const inactiveAfter = await publicSnapshot(win, team.id, channel.conversationId);
        check("inactive target is rejected through renderer/preload/IPC", inactiveResult.rejected === true, JSON.stringify(inactiveResult));
        check("inactive target cannot change owner, ledger, or delivery", durableFingerprint(inactiveAfter) === durableFingerprint(inactiveBefore), "durable state unchanged");
        fixture.coworkerStore.update(quality.id, { state: "active" });

        const selfBefore = await publicSnapshot(win, team.id, channel.conversationId);
        const selfResult = await rejectThroughRenderer(win, collaborationPayload(channel.conversationId, chief.id, "handoff", "Hand the work to the current owner.", "Self-targeted collaboration is invalid."));
        const selfAfter = await publicSnapshot(win, team.id, channel.conversationId);
        check("self target is rejected through renderer/preload/IPC", selfResult.rejected === true, JSON.stringify(selfResult));
        check("self target cannot change owner, ledger, or delivery", durableFingerprint(selfAfter) === durableFingerprint(selfBefore), "durable state unchanged");

        const rosterBefore = await publicSnapshot(win, team.id, channel.conversationId);
        const rosterResult = await rejectThroughRenderer(win, collaborationPayload(channel.conversationId, outsider.id, "handoff", "Send work outside the Team roster.", "Non-roster targets are invalid."));
        const rosterAfter = await publicSnapshot(win, team.id, channel.conversationId);
        check("non-roster target is rejected through renderer/preload/IPC", rosterResult.rejected === true, JSON.stringify(rosterResult));
        check("non-roster target cannot change owner, ledger, or delivery", durableFingerprint(rosterAfter) === durableFingerprint(rosterBefore), "durable state unchanged");

        const authorityFields = [
            ["ownerId", chief.id],
            ["providerAccountId", "provider-forged"],
            ["capability", "execute"],
            ["token", "token_forged"],
            ["workspacePath", "C:\\forged-workspace"],
            ["sessionId", "session_forged"],
        ];
        for (const [field, value] of authorityFields) {
            const before = await publicSnapshot(win, team.id, channel.conversationId);
            const callsBefore = requestStats.total;
            const result = await rejectThroughRenderer(win, collaborationPayload(channel.conversationId, builder.id, "handoff", "A bounded task with a forged field.", "The forged authority field must be rejected.", { [field]: value }));
            const after = await publicSnapshot(win, team.id, channel.conversationId);
            check(`forged ${field} is rejected before the collaboration handler`, result.rejected === true && requestStats.total === callsBefore, JSON.stringify(result));
            check(`forged ${field} cannot change owner, ledger, or delivery`, durableFingerprint(after) === durableFingerprint(before), "durable state unchanged");
        }

        const submitted = await invoke(win, `async()=>{document.getElementById('collaboration-target').value=${JSON.stringify(builder.id)}; document.getElementById('collaboration-type').value='handoff'; document.getElementById('collaboration-task').value='Inspect the bounded change and report the smallest safe result.'; document.getElementById('collaboration-reason').value='The build specialist owns this slice.'; document.getElementById('collaboration-submit').click(); return true}`);
        check("renderer submits only the bounded public collaboration fields", submitted === true, JSON.stringify(submitted));
        await waitFor("directed handoff durable state", async () => await invoke(win, `async()=>{const value=await window.sovereignbot.teams.get({teamId:${JSON.stringify(team.id)}}); return value.flow?.currentOwnerId===${JSON.stringify(builder.id)} && value.flow?.activeProtocol?.targetCoworkerId===${JSON.stringify(builder.id)}}`));
        snapshot = await publicSnapshot(win, team.id, channel.conversationId);
        const lastMessage = snapshot.conversation.messages.at(-1);
        check("non-hardcoded specialist becomes the single current owner", singleOwner(snapshot, builder) && snapshot.team.flow.activeProtocol?.kind === "handoff" && snapshot.team.flow.activeProtocol?.boundedTask?.startsWith("Inspect the bounded change"), JSON.stringify(snapshot.team.flow));
        check("only the selected teammate is woken", wakeLog.length === 1 && wakeLog[0] === builder.id && Object.keys(lastMessage.delivery ?? {}).length === 1 && lastMessage.delivery[builder.id]?.status === "pending", JSON.stringify({ wakeLog, delivery: lastMessage.delivery }));
        check("bot-to-bot projection is visible as safe handoff activity", snapshot.activity.events[0]?.label === "Handoff requested" && snapshot.activity.events[0]?.targetCoworker === "P13 Build Specialist" && !hasForbiddenPublicKey(snapshot.activity), JSON.stringify(snapshot.activity.events[0]));
        check("public Team and Channel state carries no execution authority", !hasForbiddenPublicKey({ team: snapshot.team, conversation: snapshot.conversation }), "authority keys absent");

        const duplicateBefore = await publicSnapshot(win, team.id, channel.conversationId);
        const duplicateCallsBefore = requestStats.total;
        const duplicateResult = await rejectThroughRenderer(win, collaborationPayload(channel.conversationId, quality.id, "review", "A duplicate request must not fan out.", "The existing handoff is still active."));
        const duplicateAfter = await publicSnapshot(win, team.id, channel.conversationId);
        check("duplicate active request is rejected through renderer/preload/IPC", duplicateResult.rejected === true, JSON.stringify(duplicateResult));
        check("duplicate active request cannot overreach the owner or ledger", duplicateCallsBefore + 1 === requestStats.total && durableFingerprint(duplicateAfter) === durableFingerprint(duplicateBefore), "single active protocol retained");

        completeTrustedProtocol(fixture, channel.conversationId, builder.id, lastMessage.id);
        snapshot = await publicSnapshot(win, team.id, channel.conversationId);
        check("trusted protocol completes and submits the bounded handoff", singleOwner(snapshot, builder) && snapshot.team.flow.activeProtocol?.kind === "handoff" && snapshot.team.flow.activeProtocol?.state === "submitted" && !snapshot.team.flow.pendingCoworkerIds?.length, JSON.stringify(snapshot.team.flow));

        const review = await requestThroughRenderer(win, collaborationPayload(channel.conversationId, quality.id, "review", "Review the bounded implementation and approve only the smallest safe result.", "A separate active Specialist must validate the implementation."));
        snapshot = await publicSnapshot(win, team.id, channel.conversationId);
        check("same renderer/preload/IPC requests review to another active Specialist", review.scheduledRecipients === 1 && review.message?.senderId === builder.id && singleOwner(snapshot, quality) && snapshot.team.flow.activeProtocol?.kind === "review" && snapshot.team.flow.activeProtocol?.state === "review_requested", JSON.stringify({ flow: snapshot.team.flow, scheduledRecipients: review.scheduledRecipients }));
        const reviewMessage = snapshot.conversation.messages.at(-1);
        check("review delivery is only to the selected active Specialist", wakeLog.length === 2 && wakeLog[1] === quality.id && onlyPendingRecipient(snapshot, quality.id), JSON.stringify({ wakeLog, delivery: reviewMessage.delivery }));
        completeTrustedProtocol(fixture, channel.conversationId, quality.id, reviewMessage.id, { review: true });
        snapshot = await publicSnapshot(win, team.id, channel.conversationId);
        check("trusted review acceptance, submission, and approval leave one reviewer owner", singleOwner(snapshot, quality) && snapshot.team.flow.activeProtocol?.kind === "review" && snapshot.team.flow.activeProtocol?.state === "approved" && !snapshot.team.flow.pendingCoworkerIds?.length, JSON.stringify(snapshot.team.flow));

        const returned = await requestThroughRenderer(win, collaborationPayload(channel.conversationId, builder.id, "handoff", "Continue from the approved review and finish the bounded change.", "Return ownership to the original implementation Specialist."));
        snapshot = await publicSnapshot(win, team.id, channel.conversationId);
        check("same renderer/preload/IPC hands back to the original implementation Specialist", returned.scheduledRecipients === 1 && returned.message?.senderId === quality.id && singleOwner(snapshot, builder) && snapshot.team.flow.activeProtocol?.kind === "handoff" && snapshot.team.flow.activeProtocol?.state === "requested", JSON.stringify({ flow: snapshot.team.flow, scheduledRecipients: returned.scheduledRecipients }));
        check("handback delivery is only to the original implementation Specialist", wakeLog.length === 3 && wakeLog[2] === builder.id && onlyPendingRecipient(snapshot, builder.id), JSON.stringify({ wakeLog, delivery: snapshot.conversation.messages.at(-1).delivery }));

        unbind?.(); unbind = undefined;
        restartFixture = makeFixture(dataDir);
        restartWin = win;
        restartUnbind = bindIpcChannels({ win: restartWin, handlers: handlers(restartFixture, [], { total: 0, targets: [] }) });
        await loadWindow(restartWin);
        const restarted = await publicSnapshot(restartWin, team.id, channel.conversationId);
        check("restart preserves the handback owner, bounded task, and pending target delivery", restarted.team.flow.currentOwnerId === builder.id && restarted.team.flow.activeProtocol?.targetCoworkerId === builder.id && restarted.team.flow.activeProtocol?.boundedTask?.startsWith("Continue from the approved review") && restarted.conversation.messages.at(-1).delivery[builder.id]?.status === "pending", JSON.stringify(restarted.team.flow));
        check("restart safe projection remains authority-free", !hasForbiddenPublicKey(restarted), "authority keys absent");
    }
    catch (error) { fatal = error; note(`[fatal] ${String(error?.stack ?? error)}`); check("P13 directed collaboration gate runner completed", false, String(error?.message ?? error)); }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
    const summary = { at: new Date().toISOString(), checks, teamId: team?.id, channelId: channel?.id, targetCoworkerId: builder?.id, reviewCoworkerId: quality?.id, wakeLog, requestStats, snapshot, fatal: fatal ? String(fatal?.message ?? fatal) : undefined };
    writeFileSync(join(EVIDENCE_DIR, "verify-p13-team-collaboration.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    writeFileSync(join(EVIDENCE_DIR, "verify-p13-team-collaboration.log"), `${log.join("\n")}\n`, "utf8");
    try { restartUnbind?.(); } catch {} try { unbind?.(); } catch {} try { uninstallProtocol?.(); } catch {} try { restartWin?.destroy(); } catch {} try { win?.destroy(); } catch {} try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    if (fatal || failed.length) throw new Error(`P13 directed collaboration gate failed: ${failed.join(", ") || String(fatal?.message ?? fatal)}`);
    app.exit(0);
}
