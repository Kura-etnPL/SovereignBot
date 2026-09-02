import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotificationService } from "../src/main/notification-service.js";
import { createConversationStore } from "../src/main/conversation-store.js";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createTeamService } from "../src/main/team-service.js";
import { createDesktopServices } from "../src/main/services.js";
import { createChannelUnreadProducer } from "../src/main/channel-unread-producer.js";
import { createCoworkerDispatcher } from "../src/main/coworker-dispatcher.js";
import { createArtifactStore } from "../src/main/artifact-store.js";
import { buildProviderRoster, coworkerAgentId } from "../src/main/provider-roster.js";

function setupEnvironment() {
    const dataDir = mkdtempSync(join(tmpdir(), "sb-p18-unread-"));
    const persistPath = join(dataDir, "desktop-state", "notifications.json");
    const notifications = createNotificationService({
        dataDir,
        getSettings: () => ({ notifications: true }),
        NotificationClass: class FakeNotification {
            constructor(opts) { this.opts = opts; }
            show() {}
            static isSupported() { return true; }
        },
    });

    const services = createDesktopServices({ dataDir, dialog: {} });
    const coworkerStore = createCoworkerStore({ persistPath: join(dataDir, "desktop-state", "coworkers.json") });
    coworkerStore.ensureDefaults();
    const lead = coworkerStore.create({ name: "Lead Operator", role: "Team Lead", instructions: "Coordinate" });
    const coworker = coworkerStore.create({ name: "Specialist Alpha", role: "Coding Lead", instructions: "Build safely" });

    const conversationStore = createConversationStore({
        persistPath: join(dataDir, "desktop-state", "conversations.json"),
        coworkerStore,
    });

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

    return {
        dataDir,
        persistPath,
        notifications,
        coworkerStore,
        lead,
        coworker,
        conversationStore,
        teamService,
        channelUnreadProducer,
        cleanup: () => {
            channelUnreadProducer.dispose?.();
            rmSync(dataDir, { recursive: true, force: true });
        },
    };
}

test("P18: produces channel-unread notification when notifyChannelUnread===true for active coworker in active team channel", () => {
    const env = setupEnvironment();
    try {
        const teamRes = env.teamService.createTeam({
            title: "Engineering Team",
            coworkerIds: [env.lead.id, env.coworker.id],
            leadCoworkerId: env.lead.id,
        });
        const channels = env.teamService.listChannels().channels;
        const workChannel = channels.find((c) => c.teamId === teamRes.team.id);
        assert.ok(workChannel, "work channel should exist");

        // Coworker posts an explicit user-facing update to the channel
        env.conversationStore.postCoworkerMessage(workChannel.conversationId, env.coworker.id, {
            text: "Initial deliverable is ready for inspection.",
        }, { notifyChannelUnread: true });

        const list = env.notifications.list();
        assert.equal(list.unreadCount, 1);
        assert.equal(list.totalCount, 1);

        const notif = list.notifications[0];
        assert.equal(notif.category, "channel-unread");
        assert.ok(notif.title.includes(workChannel.name));
        assert.ok(notif.title.includes(env.coworker.name));
        assert.equal(notif.body, "Initial deliverable is ready for inspection.");
        assert.deepEqual(notif.source, {
            target: "conversation",
            conversationId: workChannel.conversationId,
        });
        assert.equal(notif.read, false);
    } finally {
        env.cleanup();
    }
});

test("P18: fail-closed default suppresses unspecified intent (undefined) and explicit opt-out (false)", () => {
    const env = setupEnvironment();
    try {
        const teamRes = env.teamService.createTeam({
            title: "Strict Team",
            coworkerIds: [env.lead.id, env.coworker.id],
            leadCoworkerId: env.lead.id,
        });
        const workChannel = env.teamService.listChannels().channels.find((c) => c.teamId === teamRes.team.id);

        // Unspecified intent (notifyChannelUnread === undefined) must not notify
        env.conversationStore.postCoworkerMessage(workChannel.conversationId, env.coworker.id, {
            text: "Unspecified intent message",
        });
        assert.equal(env.notifications.list().totalCount, 0, "undefined notifyChannelUnread must fail closed");

        // Explicit opt-out (notifyChannelUnread: false)
        env.conversationStore.postCoworkerMessage(workChannel.conversationId, env.coworker.id, {
            text: "Explicitly quiet message",
        }, { notifyChannelUnread: false });
        assert.equal(env.notifications.list().totalCount, 0, "false notifyChannelUnread must not notify");
    } finally {
        env.cleanup();
    }
});

test("P18: suppresses user self-messages", () => {
    const env = setupEnvironment();
    try {
        const teamRes = env.teamService.createTeam({
            title: "Design Team",
            coworkerIds: [env.lead.id, env.coworker.id],
            leadCoworkerId: env.lead.id,
        });
        const workChannel = env.teamService.listChannels().channels.find((c) => c.teamId === teamRes.team.id);

        // User posts to the channel
        env.conversationStore.postUserMessage(workChannel.conversationId, {
            text: "Hello team, let us get started.",
        });

        const list = env.notifications.list();
        assert.equal(list.unreadCount, 0);
        assert.equal(list.totalCount, 0);
    } finally {
        env.cleanup();
    }
});

test("P18: suppresses explicit internal protocol messages", () => {
    const env = setupEnvironment();
    try {
        const teamRes = env.teamService.createTeam({
            title: "Ops Team",
            coworkerIds: [env.lead.id, env.coworker.id],
            leadCoworkerId: env.lead.id,
        });
        const workChannel = env.teamService.listChannels().channels.find((c) => c.teamId === teamRes.team.id);

        // Post with internal: true even if notifyChannelUnread accidentally set
        env.conversationStore.postCoworkerMessage(
            workChannel.conversationId,
            env.coworker.id,
            { text: "Internal coordination turn" },
            { internal: true, notifyChannelUnread: true }
        );
        assert.equal(env.notifications.list().totalCount, 0);
    } finally {
        env.cleanup();
    }
});

test("P18: suppresses archived channels and inactive coworkers", () => {
    const env = setupEnvironment();
    try {
        const teamRes = env.teamService.createTeam({
            title: "Archived Project Team",
            coworkerIds: [env.lead.id, env.coworker.id],
            leadCoworkerId: env.lead.id,
        });
        const extraChannel = env.teamService.createChannel({
            teamId: teamRes.team.id,
            name: "Secondary Channel",
            kind: "work",
            instructions: "Secondary channel for archive testing",
        });

        // Archive the secondary channel (primary channel remains active)
        env.teamService.archiveChannel(extraChannel.channel.id);

        // Message to archived channel must be suppressed
        env.conversationStore.postCoworkerMessage(extraChannel.channel.conversationId, env.coworker.id, {
            text: "Post to archived channel",
        }, { notifyChannelUnread: true });
        assert.equal(env.notifications.list().totalCount, 0);

        // Paused coworker in active channel
        const activeTeam = env.teamService.createTeam({
            title: "Active Team 2",
            coworkerIds: [env.lead.id, env.coworker.id],
            leadCoworkerId: env.lead.id,
        });
        const activeChannel = env.teamService.listChannels().channels.find((c) => c.teamId === activeTeam.team.id);
        env.coworkerStore.update(env.coworker.id, { state: "paused" });

        env.conversationStore.postCoworkerMessage(activeChannel.conversationId, env.coworker.id, {
            text: "Message from paused coworker",
        }, { notifyChannelUnread: true });
        assert.equal(env.notifications.list().totalCount, 0);
    } finally {
        env.cleanup();
    }
});

test("P18: deduplicates and coalesces subsequent unread messages in the same channel", () => {
    const env = setupEnvironment();
    try {
        const teamRes = env.teamService.createTeam({
            title: "Product Team",
            coworkerIds: [env.lead.id, env.coworker.id],
            leadCoworkerId: env.lead.id,
        });
        const workChannel = env.teamService.listChannels().channels.find((c) => c.teamId === teamRes.team.id);

        // First message creates notification
        env.conversationStore.postCoworkerMessage(workChannel.conversationId, env.coworker.id, {
            text: "First update message.",
        }, { notifyChannelUnread: true });
        let list = env.notifications.list();
        assert.equal(list.unreadCount, 1);
        assert.equal(list.totalCount, 1);
        const originalId = list.notifications[0].id;
        assert.equal(list.notifications[0].body, "First update message.");

        // Second message in same channel coalesces in place without duplicate spam
        env.conversationStore.postCoworkerMessage(workChannel.conversationId, env.coworker.id, {
            text: "Second update message with more progress.",
        }, { notifyChannelUnread: true });
        list = env.notifications.list();
        assert.equal(list.unreadCount, 1, "unread count must remain 1 (coalesced)");
        assert.equal(list.totalCount, 1, "total count must remain 1 (no duplicate card)");
        assert.equal(list.notifications[0].id, originalId, "opaque ID must be preserved");
        assert.equal(list.notifications[0].body, "Second update message with more progress.");
    } finally {
        env.cleanup();
    }
});

test("P18: truthful read resolution clears unread state only via acknowledge and subsequent activity reactivates", () => {
    const env = setupEnvironment();
    try {
        const teamRes = env.teamService.createTeam({
            title: "Support Team",
            coworkerIds: [env.lead.id, env.coworker.id],
            leadCoworkerId: env.lead.id,
        });
        const workChannel = env.teamService.listChannels().channels.find((c) => c.teamId === teamRes.team.id);

        // Coworker posts
        env.conversationStore.postCoworkerMessage(workChannel.conversationId, env.coworker.id, {
            text: "Ticket #402 has been resolved.",
        }, { notifyChannelUnread: true });
        assert.equal(env.notifications.list().unreadCount, 1);

        // A mere conversation:get does NOT clear unread state
        const got = env.conversationStore.get(workChannel.conversationId);
        assert.ok(got, "conversationStore.get succeeds");
        assert.equal(env.notifications.list().unreadCount, 1, "conversation:get must remain read-only");

        // Explicit read acknowledgement resolves unread
        const resolveRes = env.notifications.resolveChannelUnread(workChannel.conversationId);
        assert.equal(resolveRes.resolved, true);
        assert.equal(resolveRes.count, 1);

        // Verify unread state is cleared
        let list = env.notifications.list();
        assert.equal(list.unreadCount, 0);
        assert.equal(list.totalCount, 1);
        assert.equal(list.notifications[0].read, true);
        assert.ok(typeof list.notifications[0].readAt === "string");

        // Subsequent coworker message arrives later -> reactivates as unread
        env.conversationStore.postCoworkerMessage(workChannel.conversationId, env.coworker.id, {
            text: "Follow-up question on ticket #402.",
        }, { notifyChannelUnread: true });
        list = env.notifications.list();
        assert.equal(list.unreadCount, 1, "must reactivate as unread");
        assert.equal(list.totalCount, 1, "coalesces into the channel entry");
        assert.equal(list.notifications[0].read, false);
        assert.equal(list.notifications[0].readAt, null);
        assert.equal(list.notifications[0].body, "Follow-up question on ticket #402.");
    } finally {
        env.cleanup();
    }
});

test("P18: redacts secrets and absolute paths from channel notifications on disk and in projection", () => {
    const env = setupEnvironment();
    try {
        const teamRes = env.teamService.createTeam({
            title: "Security Team",
            coworkerIds: [env.lead.id, env.coworker.id],
            leadCoworkerId: env.lead.id,
        });
        const workChannel = env.teamService.listChannels().channels.find((c) => c.teamId === teamRes.team.id);

        env.conversationStore.postCoworkerMessage(workChannel.conversationId, env.coworker.id, {
            text: "Config loaded from C:\\\\Users\\\\Eternal\\\\AppData\\\\Local\\\\secret.json with Bearer sk-secret-token-12345678",
        }, { notifyChannelUnread: true });

        const list = env.notifications.list();
        assert.equal(list.totalCount, 1);
        const notif = list.notifications[0];

        // Public projection must have redacted secrets and paths
        assert.ok(!notif.body.includes("sk-secret-token-12345678"), "token must not be in public projection");
        assert.ok(!notif.body.includes("C:\\\\Users\\\\Eternal"), "path must not be in public projection");
        assert.ok(notif.body.includes("[REDACTED_SECRET]") || notif.body.includes("[REDACTED_CREDENTIAL]") || notif.body.includes("[REDACTED_PATH]"));

        // Disk persistence must also be redacted
        const diskRaw = readFileSync(env.persistPath, "utf8");
        assert.ok(!diskRaw.includes("sk-secret-token-12345678"), "token must not exist on disk");
        assert.ok(!diskRaw.includes("C:\\\\Users\\\\Eternal"), "path must not exist on disk");
        assert.ok(!diskRaw.includes("Bearer sk-"), "Bearer token must be redacted on disk");
    } finally {
        env.cleanup();
    }
});

test("P18: restart persistence preserves channel-unread digest keys and read states", () => {
    const env = setupEnvironment();
    try {
        const teamRes = env.teamService.createTeam({
            title: "Persistence Team",
            coworkerIds: [env.lead.id, env.coworker.id],
            leadCoworkerId: env.lead.id,
        });
        const workChannel = env.teamService.listChannels().channels.find((c) => c.teamId === teamRes.team.id);

        env.conversationStore.postCoworkerMessage(workChannel.conversationId, env.coworker.id, {
            text: "Persistent unread message before restart.",
        }, { notifyChannelUnread: true });

        const beforeRestart = env.notifications.list();
        assert.equal(beforeRestart.unreadCount, 1);
        const notifId = beforeRestart.notifications[0].id;

        // Simulate desktop restart: create a new service reading from the same dataDir
        const restartedService = createNotificationService({
            dataDir: env.dataDir,
            getSettings: () => ({ notifications: true }),
        });

        const afterRestart = restartedService.list();
        assert.equal(afterRestart.unreadCount, 1);
        assert.equal(afterRestart.totalCount, 1);
        assert.equal(afterRestart.notifications[0].id, notifId);
        assert.equal(afterRestart.notifications[0].body, "Persistent unread message before restart.");
        assert.equal(afterRestart.notifications[0].read, false);
    } finally {
        env.cleanup();
    }
});

test("P18 production-path: multi-stage coworker dispatcher suppresses intermediate handoffs/reviews and notifies on final synthesis", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-p18-dispatch-"));
    try {
        const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
        const chief = coworkers.create({ name: "Chief", role: "Coordinate work", providerPreference: "auto" });
        const researcher = coworkers.create({ name: "Researcher", role: "Research", providerPreference: "codex" });
        const coder = coworkers.create({ name: "Coder", role: "Code", providerPreference: "codex" });
        const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
        const services = createDesktopServices({ dataDir: root, dialog: {} });
        const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
        conversations.setTeamRouteResolver((conv) => teams.currentOwnerForConversation(conv.id));

        const notifications = createNotificationService({
            dataDir: root,
            getSettings: () => ({ notifications: true }),
            NotificationClass: class FakeNotification {
                constructor(opts) { this.opts = opts; }
                show() {}
                static isSupported() { return true; }
            },
        });
        const unreadProducer = createChannelUnreadProducer({
            notifications,
            teamService: teams,
            coworkerStore: coworkers,
            conversationStore: conversations,
        });

        const created = teams.createTeam({ title: "Research delivery", coworkerIds: [chief.id, researcher.id, coder.id] });
        const roster = buildProviderRoster({
            discovery: { codex: { found: true, auth: { state: "signed-in" } }, claude: { found: true, auth: { state: "signed-in" } } },
            settings: {},
            coworkers: coworkers.list().coworkers,
        });
        const responses = [
            `Chief scoped the question.\nSOVEREIGN_HANDOFFS: ["${researcher.id}"]`,
            `Research is complete.\nSOVEREIGN_HANDOFFS: ["${coder.id}"]`,
            `Coder completed the bounded implementation.\nSOVEREIGN_HANDOFFS: ["${chief.id}"]\nSOVEREIGN_REVIEW: "approved"`,
            "Chief synthesized the result.",
        ];
        const tasks = [];
        let seq = 0;
        const runtime = {
            orchestrator: {
                async createPlan(spec) { return { id: `plan_${++seq}`, ...spec }; },
                async delegateTrusted(planId, spec, ctx) {
                    const t = { id: `task_${++seq}`, parentTaskId: planId, status: "queued", ...structuredClone(spec), executionContext: structuredClone(ctx) };
                    tasks.push(t);
                    return structuredClone(t);
                },
                async preflightTrustedTask(taskId) {
                    return { allowed: true, agentId: tasks.find((t) => t.id === taskId)?.preferredAgentId };
                },
                requireAgent(id) { return roster.agents.find((a) => a.id === id); },
                async runUntilIdle() {
                    for (const t of tasks.filter((x) => x.status === "queued")) {
                        t.status = "completed";
                        t.result = { text: responses.shift() ?? "Completed." };
                    }
                },
                async listTasks() { return structuredClone(tasks); },
                async cancel() {},
            },
            audit: { async append() {} },
            tasks,
        };
        teams.setRuntimeHandoffPreflight(({ conversationId, targetCoworkerId, workspaceId }) => ({
            targetCoworkerId,
            agentId: coworkerAgentId(targetCoworkerId),
            workspaceId: workspaceId ?? teams.workspaceIdForConversation(conversationId),
        }));

        const dispatcher = createCoworkerDispatcher({
            dataDir: root,
            runtime,
            roster: () => roster,
            coworkerStore: coworkers,
            conversationStore: conversations,
            artifactStore: createArtifactStore({ dataDir: root }),
            services,
            teamFlow: teams,
        });

        const first = conversations.postUserMessage(created.conversation.id, { text: "Research and implement this bounded change." });
        assert.equal(notifications.list().totalCount, 0, "user message produces no notification");
        dispatcher.dispatchMessage(created.conversation.id, first.id);

        // Stage 1: Chief handoff -> researcher (suppressed)
        await dispatcher.flush();
        assert.equal(notifications.list().totalCount, 0, "Chief intermediate handoff must not notify");

        // Stage 2: Researcher handoff -> coder (suppressed)
        await dispatcher.flush();
        assert.equal(notifications.list().totalCount, 0, "Researcher intermediate handoff must not notify");

        // Stage 3: Coder review/handoff -> chief (suppressed)
        await dispatcher.flush();
        assert.equal(notifications.list().totalCount, 0, "Coder intermediate review must not notify");

        // Stage 4: Chief final synthesis (notifies!)
        await dispatcher.flush();
        const postSynthesis = notifications.list();
        assert.equal(postSynthesis.totalCount, 1, "final synthesis must produce exactly 1 notification");
        assert.equal(postSynthesis.unreadCount, 1);
        assert.equal(postSynthesis.notifications[0].category, "channel-unread");
        assert.equal(postSynthesis.notifications[0].title, "Project Channel · Chief");
        assert.equal(postSynthesis.notifications[0].body, "Chief synthesized the result.");
        assert.equal(postSynthesis.notifications[0].read, false);

        // Subsequent user-facing completion in same channel coalesces in place
        conversations.postCoworkerMessage(created.conversation.id, chief.id, { text: "Follow-up deliverable." }, { notifyChannelUnread: true });
        const coalesced = notifications.list();
        assert.equal(coalesced.totalCount, 1, "subsequent completion must coalesce into existing notification");
        assert.equal(coalesced.unreadCount, 1);
        assert.equal(coalesced.notifications[0].body, "Follow-up deliverable.");

        unreadProducer.dispose?.();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
