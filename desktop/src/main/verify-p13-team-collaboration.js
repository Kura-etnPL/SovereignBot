// Hidden Electron acceptance for the first real Team collaboration slice.
// It drives the renderer/preload/IPC boundary, then checks the durable Team flow
// and safe activity projection after a restart. The wake callback is intentionally
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
const EVIDENCE_DIR = join(WORKTREE_ROOT, "_evidence_v51_2026-09-02");
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

function handlers(fixture, wakeLog) {
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
    const tempRoot = process.env.SOVEREIGNBOT_V51_TEMP_ROOT;
    if (!tempRoot) throw new Error("V51 temp root is missing; refusing to use the default user profile");
    const dataDir = join(tempRoot, "data");
    let fixture; let win; let unbind; let uninstallProtocol; let restartFixture; let restartWin; let restartUnbind; let fatal;
    let team; let channel; let builder; let snapshot; const wakeLog = [];
    try {
        fixture = makeFixture(dataDir);
        const chief = fixture.coworkerStore.create({ name: "P13 Chief", role: "Coordinate" });
        fixture.coworkerStore.create({ name: "P13 Research", role: "Research" });
        builder = fixture.coworkerStore.create({ name: "P13 Build Specialist", role: "Build" });
        fixture.coworkerStore.create({ name: "P13 Quality Specialist", role: "Review" });
        const created = fixture.teamService.createTeam({ title: "P13 Directed Team", coworkerIds: fixture.coworkerStore.list().coworkers.filter((entry) => entry.id !== "user").map((entry) => entry.id).slice(-4), leadCoworkerId: chief.id });
        team = created.team;
        channel = team.channels[0];
        const first = fixture.conversationStore.postUserMessage(channel.conversationId, { text: "Start a bounded Team delivery." });
        fixture.teamService.onMessageQueued({ conversation: fixture.conversationStore.get(channel.conversationId), message: first });
        fixture.conversationStore.markDelivery(channel.conversationId, first.id, chief.id, "delivered");

        uninstallProtocol = installAppProtocolHandler();
        win = createMainWindow({ smoke: true });
        unbind = bindIpcChannels({ win, handlers: handlers(fixture, wakeLog) });
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
        const submitted = await invoke(win, `async()=>{document.getElementById('collaboration-target').value=${JSON.stringify(builder.id)}; document.getElementById('collaboration-type').value='handoff'; document.getElementById('collaboration-task').value='Inspect the bounded change and report the smallest safe result.'; document.getElementById('collaboration-reason').value='The build specialist owns this slice.'; document.getElementById('collaboration-submit').click(); return true}`);
        check("renderer submits only the bounded public collaboration fields", submitted === true, JSON.stringify(submitted));
        await waitFor("directed handoff durable state", async () => await invoke(win, `async()=>{const value=await window.sovereignbot.teams.get({teamId:${JSON.stringify(team.id)}}); return value.flow?.currentOwnerId===${JSON.stringify(builder.id)} && value.flow?.activeProtocol?.targetCoworkerId===${JSON.stringify(builder.id)}}`));
        snapshot = await invoke(win, `async()=>({team:await window.sovereignbot.teams.get({teamId:${JSON.stringify(team.id)}}),conversation:await window.sovereignbot.conversations.get({conversationId:${JSON.stringify(channel.conversationId)}}),activity:await window.sovereignbot.teams.activity({conversationId:${JSON.stringify(channel.conversationId)},limit:12})})`);
        const lastMessage = snapshot.conversation.messages.at(-1);
        check("non-hardcoded specialist becomes the single current owner", snapshot.team.flow.currentOwnerId === builder.id && snapshot.team.flow.activeProtocol?.kind === "handoff" && snapshot.team.flow.activeProtocol?.boundedTask?.startsWith("Inspect the bounded change"), JSON.stringify(snapshot.team.flow));
        check("only the selected teammate is woken", wakeLog.length === 1 && wakeLog[0] === builder.id && Object.keys(lastMessage.delivery ?? {}).length === 1 && lastMessage.delivery[builder.id]?.status === "pending", JSON.stringify({ wakeLog, delivery: lastMessage.delivery }));
        check("bot-to-bot projection is visible as safe handoff activity", snapshot.activity.events[0]?.label === "Handoff requested" && snapshot.activity.events[0]?.targetCoworker === "P13 Build Specialist" && !hasForbiddenPublicKey(snapshot.activity), JSON.stringify(snapshot.activity.events[0]));
        check("public Team and Channel state carries no execution authority", !hasForbiddenPublicKey({ team: snapshot.team, conversation: snapshot.conversation }), "authority keys absent");

        unbind?.(); unbind = undefined;
        restartFixture = makeFixture(dataDir);
        restartWin = win;
        restartUnbind = bindIpcChannels({ win: restartWin, handlers: handlers(restartFixture, []) });
        await loadWindow(restartWin);
        const restarted = await invoke(restartWin, `async()=>({team:await window.sovereignbot.teams.get({teamId:${JSON.stringify(team.id)}}),conversation:await window.sovereignbot.conversations.get({conversationId:${JSON.stringify(channel.conversationId)}}),activity:await window.sovereignbot.teams.activity({conversationId:${JSON.stringify(channel.conversationId)},limit:12})})`);
        check("restart preserves owner, bounded task, and pending target delivery", restarted.team.flow.currentOwnerId === builder.id && restarted.team.flow.activeProtocol?.targetCoworkerId === builder.id && restarted.team.flow.activeProtocol?.boundedTask?.startsWith("Inspect the bounded change") && restarted.conversation.messages.at(-1).delivery[builder.id]?.status === "pending", JSON.stringify(restarted.team.flow));
        check("restart safe projection remains authority-free", !hasForbiddenPublicKey(restarted), "authority keys absent");
    }
    catch (error) { fatal = error; note(`[fatal] ${String(error?.stack ?? error)}`); check("P13 directed collaboration gate runner completed", false, String(error?.message ?? error)); }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
    const summary = { at: new Date().toISOString(), checks, teamId: team?.id, channelId: channel?.id, targetCoworkerId: builder?.id, wakeLog, snapshot, fatal: fatal ? String(fatal?.message ?? fatal) : undefined };
    writeFileSync(join(EVIDENCE_DIR, "verify-p13-team-collaboration.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    writeFileSync(join(EVIDENCE_DIR, "verify-p13-team-collaboration.log"), `${log.join("\n")}\n`, "utf8");
    try { restartUnbind?.(); } catch {} try { unbind?.(); } catch {} try { uninstallProtocol?.(); } catch {} try { restartWin?.destroy(); } catch {} try { win?.destroy(); } catch {} try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    if (fatal || failed.length) throw new Error(`P13 directed collaboration gate failed: ${failed.join(", ") || String(fatal?.message ?? fatal)}`);
    app.exit(0);
}
