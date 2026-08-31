import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

export const TEAMS_SCHEMA = "sovereignbot.desktop.teams.v1";

const MAX_TEAMS = 32;
const MAX_CHANNELS = 128;
const TEAM_ID = /^team_[a-f0-9]{16}$/i;
const CHANNEL_ID = /^channel_[a-f0-9]{16}$/i;

export const SOFTWARE_TEAM_PACK = Object.freeze({
    id: "software-team",
    name: "Software Team",
    description: "A small delivery team that scopes, implements, reviews, and reports the result.",
    coworkers: Object.freeze([
        {
            key: "chief",
            name: "Chief of Staff",
            role: "Own the outcome and coordinate the software delivery.",
            instructions: "Scope the desired outcome, delegate implementation to Coding Lead, ask Reviewer to check the result, then synthesize the final answer for the user.",
            avatar: "✦",
            modelBinding: { profile: "automatic" },
        },
        {
            key: "coding-lead",
            name: "Coding Lead",
            role: "Implement and validate the requested software change.",
            instructions: "Work in the shared project workspace, make focused changes, run the smallest useful checks, and return an honest implementation result for review.",
            avatar: "⌘",
            modelBinding: { profile: "efficient", provider: "codex", model: "luna" },
        },
        {
            key: "reviewer",
            name: "Reviewer",
            role: "Review the implementation and report risks or approval.",
            instructions: "Review the Coding Lead result independently, identify concrete issues, and give the Chief a concise go/no-go assessment.",
            avatar: "✓",
            modelBinding: { profile: "efficient", provider: "codex", model: "luna" },
        },
    ]),
    channels: Object.freeze([
        {
            key: "project",
            name: "Project Channel",
            kind: "project",
            instructions: "Software Delivery: Chief scopes the outcome, Coding Lead implements, Reviewer reviews, and Chief synthesizes the result.",
            playbookId: "software-delivery",
        },
    ]),
    playbooks: Object.freeze([
        {
            id: "software-delivery",
            name: "Software Delivery",
            description: "Chief scopes → Coding Lead implements → Reviewer reviews → Chief synthesizes.",
            steps: Object.freeze(["chief", "coding-lead", "reviewer", "chief"]),
        },
    ]),
});

function createSimpleTeamPack({ id, name, description, specialistName, specialistRole, specialistInstructions, channelName, channelInstructions, playbookId, playbookName, playbookDescription }) {
    return Object.freeze({
        id,
        name,
        description,
        coworkers: Object.freeze([
            {
                key: "chief",
                name: "Chief of Staff",
                role: "Own the outcome and coordinate the team.",
                instructions: `Scope the desired outcome, delegate the work to ${specialistName}, ask the Reviewer to check it, then synthesize the final answer for the user.`,
                avatar: "✦",
                modelBinding: { profile: "automatic" },
            },
            {
                key: "specialist",
                name: specialistName,
                role: specialistRole,
                instructions: specialistInstructions,
                avatar: "⌘",
                modelBinding: { profile: "efficient", provider: "codex", model: "luna" },
            },
            {
                key: "reviewer",
                name: "Reviewer",
                role: "Review the specialist result and report risks or approval.",
                instructions: "Review the specialist result independently, identify concrete issues, and give the Chief a concise go/no-go assessment.",
                avatar: "✓",
                modelBinding: { profile: "efficient", provider: "codex", model: "luna" },
            },
        ]),
        channels: Object.freeze([
            {
                key: "project",
                name: channelName,
                kind: "project",
                instructions: channelInstructions,
                playbookId,
            },
        ]),
        playbooks: Object.freeze([
            {
                id: playbookId,
                name: playbookName,
                description: playbookDescription,
                steps: Object.freeze(["chief", "specialist", "reviewer", "chief"]),
            },
        ]),
    });
}

export const RESEARCH_TEAM_PACK = createSimpleTeamPack({
    id: "research-team",
    name: "Research Team",
    description: "A focused research team that frames a question, investigates it, reviews evidence, and reports the result.",
    specialistName: "Research Lead",
    specialistRole: "Investigate the question and synthesize grounded findings.",
    specialistInstructions: "Investigate the bounded question, separate evidence from inference, cite the available sources, and return a concise findings brief for review.",
    channelName: "Research Room",
    channelInstructions: "Research Brief: Chief frames the question, Research Lead investigates, Reviewer checks evidence, and Chief reports the result.",
    playbookId: "research-brief",
    playbookName: "Research Brief",
    playbookDescription: "Chief frames → Research Lead investigates → Reviewer checks evidence → Chief reports.",
});

export const CONTENT_TEAM_PACK = createSimpleTeamPack({
    id: "content-team",
    name: "Content Team",
    description: "A compact content team that shapes a brief, drafts the piece, reviews it, and delivers a polished result.",
    specialistName: "Content Lead",
    specialistRole: "Turn the brief into a clear, audience-ready draft.",
    specialistInstructions: "Turn the bounded brief into a useful draft, preserve the requested voice and facts, and return the deliverable for review.",
    channelName: "Content Studio",
    channelInstructions: "Content Delivery: Chief shapes the brief, Content Lead drafts, Reviewer checks quality, and Chief delivers the result.",
    playbookId: "content-delivery",
    playbookName: "Content Delivery",
    playbookDescription: "Chief briefs → Content Lead drafts → Reviewer checks quality → Chief delivers.",
});

export const OPERATIONS_TEAM_PACK = createSimpleTeamPack({
    id: "operations-team",
    name: "Operations Team",
    description: "A practical operations team that scopes a runbook, carries out bounded work, reviews it, and reports status.",
    specialistName: "Operations Lead",
    specialistRole: "Execute bounded operational work and keep the runbook current.",
    specialistInstructions: "Execute only the bounded operational objective, record what changed and what remains, and return an honest runbook update for review.",
    channelName: "Operations Room",
    channelInstructions: "Operations Runbook: Chief scopes the work, Operations Lead executes, Reviewer checks the result, and Chief reports status.",
    playbookId: "operations-runbook",
    playbookName: "Operations Runbook",
    playbookDescription: "Chief scopes → Operations Lead executes → Reviewer checks → Chief reports.",
});

export const TEAM_PACKS = Object.freeze([
    SOFTWARE_TEAM_PACK,
    RESEARCH_TEAM_PACK,
    CONTENT_TEAM_PACK,
    OPERATIONS_TEAM_PACK,
]);

const TEAM_PACK_BY_ID = new Map(TEAM_PACKS.map((pack) => [pack.id, pack]));

function idFactory(prefix) {
    return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function clone(value) {
    return structuredClone(value);
}

function safeString(value, label, max = 200) {
    if (typeof value !== "string" || !value.trim() || value.length > max)
        throw new Error(`${label} must be a non-empty bounded string`);
    return value.trim();
}

function safeId(value, label, pattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) {
    if (typeof value !== "string" || !pattern.test(value))
        throw new Error(`${label} must be an identifier`);
    return value;
}

function safeCoworkerIds(value) {
    if (!Array.isArray(value) || value.length < 2 || value.length > 8)
        throw new Error("team coworker roster must contain 2 to 8 coworkers");
    return [...new Set(value.map((entry) => safeId(entry, "coworkerId")))];
}

function safePlaybooks(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 8).map((entry) => ({
        id: safeId(entry.id, "playbookId"),
        name: safeString(entry.name, "playbook name", 120),
        description: safeString(entry.description ?? "", "playbook description", 500),
        steps: Array.isArray(entry.steps) ? entry.steps.slice(0, 12).map((step) => safeId(step, "playbook step")) : [],
    }));
}

function sanitizePersisted(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== TEAMS_SCHEMA)
        return { teams: [], channels: [], flows: {} };
    const channels = Array.isArray(value.channels) ? value.channels.map((entry) => {
        try {
            if (!entry || !CHANNEL_ID.test(entry.id) || !TEAM_ID.test(entry.teamId)) return undefined;
            return {
                id: entry.id,
                teamId: entry.teamId,
                kind: ["work", "personal", "project"].includes(entry.kind) ? entry.kind : "project",
                name: safeString(entry.name, "channel name", 120),
                instructions: safeString(entry.instructions ?? "", "channel instructions", 12_000),
                coworkerIds: safeCoworkerIds(entry.coworkerIds),
                workspaceId: safeId(entry.workspaceId, "workspaceId"),
                conversationId: safeId(entry.conversationId, "conversationId"),
                playbookId: safeId(entry.playbookId, "playbookId"),
                createdAt: safeString(entry.createdAt, "channel createdAt", 80),
                updatedAt: safeString(entry.updatedAt, "channel updatedAt", 80),
            };
        }
        catch { return undefined; }
    }).filter(Boolean).slice(0, MAX_CHANNELS) : [];
    const channelIds = new Set(channels.map((entry) => entry.id));
    const teams = Array.isArray(value.teams) ? value.teams.map((entry) => {
        try {
            if (!entry || !TEAM_ID.test(entry.id)) return undefined;
            const ids = safeCoworkerIds(entry.coworkerIds);
            const validChannels = Array.isArray(entry.channelIds) ? entry.channelIds.filter((id) => channelIds.has(id)).slice(0, 16) : [];
            return {
                id: entry.id,
                packId: safeId(entry.packId, "packId"),
                name: safeString(entry.name, "team name", 120),
                coworkerIds: ids,
                sharedWorkspaceId: safeId(entry.sharedWorkspaceId, "sharedWorkspaceId"),
                channelIds: validChannels,
                playbooks: safePlaybooks(entry.playbooks),
                createdAt: safeString(entry.createdAt, "team createdAt", 80),
                updatedAt: safeString(entry.updatedAt, "team updatedAt", 80),
            };
        }
        catch { return undefined; }
    }).filter(Boolean).slice(0, MAX_TEAMS) : [];
    const teamIds = new Set(teams.map((entry) => entry.id));
    const filteredChannels = channels.filter((entry) => teamIds.has(entry.teamId));
    const flows = {};
    if (value.flows && typeof value.flows === "object" && !Array.isArray(value.flows)) {
        for (const [teamId, flow] of Object.entries(value.flows)) {
            if (!teamIds.has(teamId) || !flow || typeof flow !== "object") continue;
            const stage = ["chief", "coding-lead", "specialist", "reviewer", "synthesis", "complete"].includes(flow.stage) ? flow.stage : "complete";
            flows[teamId] = {
                stage,
                ...(Number.isInteger(flow.handoffIndex) && flow.handoffIndex >= 0 && flow.handoffIndex <= 16 ? { handoffIndex: flow.handoffIndex } : {}),
                ...(typeof flow.userMessageId === "string" ? { userMessageId: flow.userMessageId } : {}),
                ...(typeof flow.lastHandoffSourceId === "string" ? { lastHandoffSourceId: flow.lastHandoffSourceId } : {}),
                ...(typeof flow.lastHandoffTargetId === "string" ? { lastHandoffTargetId: flow.lastHandoffTargetId } : {}),
                ...(typeof flow.updatedAt === "string" ? { updatedAt: flow.updatedAt } : {}),
            };
        }
    }
    return { teams, channels: filteredChannels, flows };
}

function publicChannel(channel) {
    return {
        id: channel.id,
        teamId: channel.teamId,
        kind: channel.kind,
        name: channel.name,
        instructions: channel.instructions,
        coworkerIds: [...channel.coworkerIds],
        workspaceId: channel.workspaceId,
        conversationId: channel.conversationId,
        playbookId: channel.playbookId,
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
    };
}

export function createTeamService({ dataDir, persistPath = join(dataDir, "desktop-state", "teams.json"), coworkerStore, conversationStore, services, now = () => new Date().toISOString(), makeTeamId = () => idFactory("team"), makeChannelId = () => idFactory("channel") } = {}) {
    if (!dataDir || !coworkerStore?.list || !coworkerStore?.create || !conversationStore?.createTeam || !conversationStore?.get || !services?.createManagedWorkspace || !services?.workspacePath)
        throw new Error("team service requires dataDir, stores and managed workspace services");
    const loaded = sanitizePersisted(loadJsonState(persistPath, null));
    const state = { schema: TEAMS_SCHEMA, ...loaded };

    function save() {
        saveJsonState(persistPath, state);
    }

    function requireTeam(teamId) {
        const team = state.teams.find((entry) => entry.id === String(teamId));
        if (!team) throw new Error(`unknown team id: ${teamId}`);
        return team;
    }

    function requireChannel(channelId) {
        const channel = state.channels.find((entry) => entry.id === String(channelId));
        if (!channel) throw new Error(`unknown channel id: ${channelId}`);
        return channel;
    }

    function coworkerName(id) {
        try { return coworkerStore.get(id)?.name ?? id; }
        catch { return id; }
    }

    function handoffOrder(team) {
        const ids = [...team.coworkerIds];
        if (ids.length < 2) return ids;
        // The first teammate owns intake, the last is the reviewer, and any middle
        // teammates are bounded specialists.  This keeps Team Packs declarative and
        // lets ordinary user-created teams use the same one-owner handoff contract.
        return ids.length === 2
            ? [ids[0], ids[1], ids[0]]
            : [ids[0], ...ids.slice(1, -1), ids.at(-1), ids[0]];
    }

    function indexForFlow(flow, order) {
        if (Number.isInteger(flow.handoffIndex) && flow.handoffIndex >= 0 && flow.handoffIndex < order.length)
            return flow.handoffIndex;
        if (flow.stage === "chief") return 0;
        if (flow.stage === "synthesis") return Math.max(0, order.length - 1);
        if (flow.stage === "reviewer") return Math.max(0, order.length - 2);
        if (flow.stage === "coding-lead") return Math.min(1, Math.max(0, order.length - 1));
        return undefined;
    }

    function stageForIndex(index, order) {
        if (index === 0) return "chief";
        if (index === order.length - 1) return "synthesis";
        if (index === order.length - 2) return "reviewer";
        return index === 1 ? "coding-lead" : "specialist";
    }

    function flowStatus(team) {
        const flow = state.flows[team.id] ?? { stage: "complete" };
        const channel = state.channels.find((entry) => entry.teamId === team.id);
        const order = handoffOrder(team);
        const ownerIndex = indexForFlow(flow, order);
        const currentOwnerId = flow.stage === "complete" || ownerIndex === undefined ? undefined : order[ownerIndex];
        const conversation = channel ? conversationStore.get(channel.conversationId) : undefined;
        const pending = conversation
            ? Object.entries(conversation.messages.at(-1)?.delivery ?? {}).filter(([, value]) => value?.status === "pending").map(([id]) => id)
            : [];
        return {
            stage: flow.stage,
            status: pending.length ? "active" : flow.stage === "complete" ? "available" : "waiting",
            currentOwnerId,
            currentOwner: currentOwnerId ? coworkerName(currentOwnerId) : undefined,
            pendingCoworkerIds: pending,
            channelId: channel?.id,
        };
    }

    function publicTeam(team) {
        const channel = state.channels.find((entry) => entry.teamId === team.id);
        return {
            id: team.id,
            packId: team.packId,
            name: team.name,
            coworkerIds: [...team.coworkerIds],
            coworkers: team.coworkerIds.map((id) => ({ id, name: coworkerName(id) })),
            channelIds: [...team.channelIds],
            channels: channel ? [publicChannel(channel)] : [],
            sharedWorkspaceId: team.sharedWorkspaceId,
            sharedWorkspaceLabel: services.workspaceLabel?.(team.sharedWorkspaceId) ?? "Shared project workspace",
            privateWorkspaceLabel: "Private workspace",
            playbooks: clone(team.playbooks),
            flow: flowStatus(team),
            createdAt: team.createdAt,
            updatedAt: team.updatedAt,
        };
    }

    function findCoworkerByName(name) {
        return coworkerStore.list({ includeArchived: true }).coworkers.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    }

    function ensureCoworker(definition) {
        const existing = findCoworkerByName(definition.name);
        const coworkerId = existing
            ? (existing.state === "archived" ? coworkerStore.restore(existing.id).id : existing.id)
            : coworkerStore.create({
                name: definition.name,
                role: definition.role,
                instructions: definition.instructions,
                avatar: definition.avatar,
                modelBinding: definition.modelBinding,
            }).id;

        // Every installed teammate gets a durable private scratch.  The path is owned by
        // the trusted main-process workspace service; only its opaque id is kept on the
        // coworker record and exposed to the renderer.
        const current = coworkerStore.get(coworkerId);
        const privateHint = `${coworkerId}-private`;
        const privateWorkspace = services.createManagedWorkspace({
            label: `${definition.name} private scratch`,
            kind: "private-scratch",
            idHint: privateHint,
        });
        const privateWorkspaceId = privateWorkspace.workspace?.id;
        safeId(privateWorkspaceId, "privateWorkspaceId");
        const workspaceIds = [...(current.workspaceIds ?? [])];
        if (!workspaceIds.includes(privateWorkspaceId))
            coworkerStore.update(coworkerId, { workspaceIds: [privateWorkspaceId, ...workspaceIds] });
        return coworkerId;
    }

    function installPack(packId = SOFTWARE_TEAM_PACK.id) {
        const pack = TEAM_PACK_BY_ID.get(packId);
        if (!pack)
            throw new Error(`unknown team pack: ${packId}`);
        const existing = state.teams.find((entry) => entry.packId === packId);
        if (existing)
            return { installed: false, team: publicTeam(existing) };
        if (state.teams.length >= MAX_TEAMS)
            throw new Error(`team limit reached (${MAX_TEAMS})`);

        const idsByKey = new Map(pack.coworkers.map((definition) => [definition.key, ensureCoworker(definition)]));
        const coworkerIds = pack.coworkers.map((definition) => idsByKey.get(definition.key));
        const teamId = makeTeamId();
        safeId(teamId, "teamId", TEAM_ID);
        const managed = services.createManagedWorkspace({ label: `${pack.name} project`, kind: "shared-project", idHint: teamId });
        const sharedWorkspaceId = managed.workspace?.id;
        safeId(sharedWorkspaceId, "sharedWorkspaceId");
        const timestamp = now();
        const team = {
            id: teamId,
            packId,
            name: pack.name,
            coworkerIds,
            sharedWorkspaceId,
            channelIds: [],
            playbooks: clone(pack.playbooks),
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        state.teams.push(team);
        state.flows[team.id] = { stage: "complete", updatedAt: timestamp };

        for (const definition of pack.channels) {
            const channelId = makeChannelId();
            safeId(channelId, "channelId", CHANNEL_ID);
            const conversation = conversationStore.createTeam({
                title: definition.name,
                coworkerIds,
                leadCoworkerId: idsByKey.get("chief"),
            });
            const channel = {
                id: channelId,
                teamId: team.id,
                kind: definition.kind,
                name: definition.name,
                instructions: definition.instructions,
                coworkerIds: [...coworkerIds],
                workspaceId: sharedWorkspaceId,
                conversationId: conversation.id,
                playbookId: definition.playbookId,
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            state.channels.push(channel);
            team.channelIds.push(channel.id);
        }
        save();
        return { installed: true, team: publicTeam(team) };
    }

    function channelForConversation(conversationId) {
        return state.channels.find((entry) => entry.conversationId === String(conversationId));
    }

    function onMessageQueued({ conversation, message }) {
        if (message?.senderId !== "user") return;
        const channel = channelForConversation(conversation?.id);
        if (!channel) return;
        const team = requireTeam(channel.teamId);
        const current = state.flows[team.id];
        if (current?.userMessageId === message.id) return;
        state.flows[team.id] = { stage: "chief", handoffIndex: 0, userMessageId: message.id, updatedAt: now() };
        team.updatedAt = now();
        save();
    }

    function nextHandoff({ conversation, coworkerId, source }) {
        const channel = channelForConversation(conversation?.id);
        if (!channel) return undefined;
        const team = requireTeam(channel.teamId);
        const flow = state.flows[team.id] ?? { stage: "complete" };
        if (source?.id && flow.lastHandoffSourceId === source.id)
            return flow.lastHandoffTargetId;
        const order = handoffOrder(team);
        const currentIndex = indexForFlow(flow, order);
        let target;
        if (currentIndex !== undefined && order[currentIndex] === coworkerId) {
            if (currentIndex < order.length - 1) {
                target = order[currentIndex + 1];
                flow.handoffIndex = currentIndex + 1;
                flow.stage = stageForIndex(flow.handoffIndex, order);
            }
            else {
                flow.stage = "complete";
                delete flow.handoffIndex;
            }
        }
        if (target) {
            const targetCoworker = coworkerStore.get(target);
            if (targetCoworker.state !== "active")
                throw new Error(`team handoff target is not active: ${target}`);
        }
        if (source?.id) {
            flow.lastHandoffSourceId = source.id;
            if (target) flow.lastHandoffTargetId = target;
            else delete flow.lastHandoffTargetId;
        }
        flow.updatedAt = now();
        state.flows[team.id] = flow;
        team.updatedAt = flow.updatedAt;
        save();
        return target;
    }

    function workspaceIdForConversation(conversationId) {
        return channelForConversation(conversationId)?.workspaceId;
    }

    return {
        schema: TEAMS_SCHEMA,
        list() {
            return {
                schema: TEAMS_SCHEMA,
                teams: state.teams.map(publicTeam),
                packs: TEAM_PACKS.map((pack) => ({
                    id: pack.id,
                    name: pack.name,
                    description: pack.description,
                    installed: state.teams.some((entry) => entry.packId === pack.id),
                })),
            };
        },
        get(teamId) { return publicTeam(requireTeam(teamId)); },
        listChannels({ teamId } = {}) {
            const channels = teamId === undefined ? state.channels : state.channels.filter((entry) => entry.teamId === String(teamId));
            if (teamId !== undefined) requireTeam(teamId);
            return { schema: TEAMS_SCHEMA, channels: channels.map(publicChannel) };
        },
        getChannel(channelId) { return publicChannel(requireChannel(channelId)); },
        installPack,
        onMessageQueued,
        nextHandoff,
        workspaceIdForConversation,
        status(teamId) { return flowStatus(requireTeam(teamId)); },
    };
}
