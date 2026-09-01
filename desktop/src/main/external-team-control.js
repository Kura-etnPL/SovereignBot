import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

export const EXTERNAL_TEAM_CONTROL_SCHEMA = "sovereignbot.external-team-control.v1";
export const EXTERNAL_TEAM_CONTROL_PROTOCOL = "sovereignbot.team-control.v1";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_OUTCOMES = 256;
const MAX_TEXT = 12_000;
const MAX_ARTIFACTS = 24;
const MAX_LIST_ITEMS = 128;
const MAX_CONVERSATION_MESSAGES = 100;
const OUTCOME_ID = /^outcome_[a-f0-9]{16}$/i;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXTERNAL_MCP_PROTOCOL_VERSION = "2025-06-18";
const FORBIDDEN_KEYS = new Set([
    "actor", "account", "apikey", "args", "bearer", "capability", "command", "cookie",
    "credential", "cwd", "env", "executable", "header", "password", "path", "policy",
    "profile", "provider", "secret", "session", "token", "transport", "url",
]);

function makeOutcomeId() {
    return "outcome_" + randomBytes(8).toString("hex");
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function squeezedKey(value) {
    return String(value).replaceAll(/[-_\s]/g, "").toLowerCase();
}

function rejectAuthority(value, path = "request") {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => rejectAuthority(entry, path + "[" + index + "]"));
        return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(squeezedKey(key)))
            throw new Error("external team control field is not allowed: " + path + "." + key);
        rejectAuthority(child, path + "." + key);
    }
}

function opaqueId(value, label) {
    if (typeof value !== "string" || !OPAQUE_ID.test(value))
        throw new Error(label + " must be an opaque identifier");
    return value;
}

function boundedText(value, label, max = MAX_TEXT, required = false) {
    if (value === undefined || value === null) {
        if (required) throw new Error(label + " is required");
        return undefined;
    }
    if (typeof value !== "string")
        throw new Error(label + " must be a string");
    const result = value.trim();
    if (required && !result) throw new Error(label + " is required");
    if (result.length > max) throw new Error(label + " exceeds " + max + " characters");
    return result || undefined;
}

function artifactIds(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_ARTIFACTS)
        throw new Error("artifactIds must contain at most " + MAX_ARTIFACTS + " identifiers");
    return [...new Set(value.map((entry) => opaqueId(entry, "artifactId")))];
}

function safeError(error) {
    return publicText(String(error?.message ?? error ?? "external team control failed").replace(/[\r\n]+/g, " ")).slice(0, 500);
}

function publicText(value) {
    return String(value ?? "")
        .replace(/[A-Za-z]:[\\/][^"'<>\r\n]*/g, "<private-path>")
        .replace(/\\\\[^"'<>\r\n]+/g, "<private-path>")
        .replace(/(?:^|\s)\/(?:Users|home|tmp|var|private|workspace|worktrees?)[^\s"'<>\r\n]*/gi, " <private-path>")
        .replace(/file:\/\/[^\s"'<>]+/gi, "<private-path>")
        .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
            try { return new URL(url).origin; }
            catch { return "<redacted-url>"; }
        })
        .replace(/\b(?:bearer\s+\S+|authorization\s*[:=]\s*\S+|api[-_ ]?key\s*[:=]\s*\S+|token|secret|password|cookie|session(?:id)?|credential)\s*[:=]?\s*\S*/gi, "<redacted>")
        .slice(0, 4_000);
}

function publicArtifact(artifact) {
    if (!artifact || typeof artifact !== "object") return undefined;
    return {
        id: artifact.id,
        title: publicText(artifact.title),
        fileName: publicText(artifact.fileName),
        mimeType: artifact.mimeType,
        size: artifact.size,
        createdAt: artifact.createdAt,
    };
}

function publicMessage(message) {
    if (!message || typeof message !== "object") return undefined;
    return {
        id: message.id,
        senderId: message.senderId,
        text: publicText(message.text),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(Array.isArray(message.artifactIds) && message.artifactIds.length ? { artifactIds: [...message.artifactIds] } : {}),
        createdAt: message.createdAt,
    };
}

function loopbackHost(value) {
    const host = String(value ?? "").toLowerCase().replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function loopbackRemote(value) {
    const address = String(value ?? "").toLowerCase();
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function bearer(request) {
    const value = request.headers.authorization;
    return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

async function readJson(request) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_BODY_BYTES)
            throw new Error("external team control request body is too large");
        chunks.push(buffer);
    }
    if (!chunks.length) return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isPlainObject(parsed)) throw new Error("external team control body must be an object");
    return parsed;
}

function send(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
    });
    response.end(body);
}

function pathParts(pathname) {
    return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function sanitizePersistedOutcome(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !OUTCOME_ID.test(value.id))
        return undefined;
    if (!["queued", "working", "completed", "failed", "cancelled", "needs_attention"].includes(value.status))
        return undefined;
    if (![value.teamId, value.channelId, value.messageId].every((entry) => typeof entry === "string" && OPAQUE_ID.test(entry)))
        return undefined;
    if (value.coworkerId !== undefined && (typeof value.coworkerId !== "string" || !OPAQUE_ID.test(value.coworkerId)))
        return undefined;
    if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string")
        return undefined;
    return {
        id: value.id,
        teamId: value.teamId,
        channelId: value.channelId,
        coworkerId: value.coworkerId,
        messageId: value.messageId,
        clientRequestId: typeof value.clientRequestId === "string" ? value.clientRequestId.slice(0, 128) : undefined,
        inputHash: typeof value.inputHash === "string" && /^[a-f0-9]{64}$/i.test(value.inputHash) ? value.inputHash : undefined,
        inputPreview: publicText(value.inputPreview),
        artifactIds: Array.isArray(value.artifactIds) ? value.artifactIds.filter((entry) => typeof entry === "string" && OPAQUE_ID.test(entry)).slice(0, MAX_ARTIFACTS) : [],
        status: value.status,
        error: value.error ? publicText(value.error).slice(0, 500) : undefined,
        takeoverReason: value.takeoverReason ? publicText(value.takeoverReason).slice(0, 500) : undefined,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        conversationId: typeof value.conversationId === "string" && OPAQUE_ID.test(value.conversationId) ? value.conversationId : undefined,
    };
}

function exactKeys(value, allowed, label) {
    for (const key of Object.keys(value))
        if (!allowed.has(key)) throw new Error(label + " contains an unexpected field: " + key);
}

function publicTeam(team) {
    return {
        id: team.id,
        packId: team.packId,
        name: publicText(team.name),
        coworkerIds: [...(team.coworkerIds ?? [])],
        channelIds: [...(team.channelIds ?? [])],
        flow: team.flow ? {
            stage: team.flow.stage,
            status: team.flow.status,
            currentOwnerId: team.flow.currentOwnerId,
            currentOwner: team.flow.currentOwner ? publicText(team.flow.currentOwner) : undefined,
        } : undefined,
    };
}

function publicChannel(channel) {
    return {
        id: channel.id,
        teamId: channel.teamId,
        kind: channel.kind,
        name: publicText(channel.name),
        coworkerIds: [...(channel.coworkerIds ?? [])],
        conversationId: channel.conversationId,
        playbookId: channel.playbookId,
    };
}

const EXTERNAL_MCP_TOOLS = Object.freeze([
    Object.freeze({
        name: "listTeams",
        description: "List the user's governed teams using opaque IDs and safe product metadata.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
    Object.freeze({
        name: "listCoworkers",
        description: "List the user's governed coworkers without provider sessions or execution authority.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
    Object.freeze({
        name: "listChannels",
        description: "List Project Channels, optionally narrowed to one opaque team ID.",
        inputSchema: { type: "object", properties: { teamId: { type: "string" }, includeArchived: { type: "boolean" } }, additionalProperties: false },
    }),
    Object.freeze({
        name: "sendMessage",
        description: "Send a bounded message to a governed Team Channel; execution stays with the current owner and Governor.",
        inputSchema: { type: "object", properties: { teamId: { type: "string" }, channelId: { type: "string" }, coworkerId: { type: "string" }, text: { type: "string", maxLength: MAX_TEXT }, artifactIds: { type: "array", maxItems: MAX_ARTIFACTS, items: { type: "string" } }, clientRequestId: { type: "string", maxLength: 128 } }, required: ["teamId", "channelId", "text"], additionalProperties: false },
    }),
    Object.freeze({
        name: "getConversation",
        description: "Read the bounded safe message projection for one governed Team Channel.",
        inputSchema: { type: "object", properties: { teamId: { type: "string" }, channelId: { type: "string" } }, required: ["teamId", "channelId"], additionalProperties: false },
    }),
    Object.freeze({
        name: "listSkills",
        description: "List safe Skill metadata and assignments without credentials or execution authority.",
        inputSchema: { type: "object", properties: { includeArchived: { type: "boolean" } }, additionalProperties: false },
    }),
    Object.freeze({
        name: "listRoutines",
        description: "List safe Routine metadata without scheduler or workspace authority.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
    Object.freeze({
        name: "runRoutineNow",
        description: "Run one enabled Routine through the existing governed Job path.",
        inputSchema: { type: "object", properties: { routineId: { type: "string" } }, required: ["routineId"], additionalProperties: false },
    }),
    Object.freeze({
        name: "getAttention",
        description: "Read bounded Jobs that need human attention.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
    Object.freeze({
        name: "submitOutcome",
        description: "Submit a bounded outcome to a governed Team Channel; execution stays with the current owner and Governor.",
        inputSchema: { type: "object", properties: { teamId: { type: "string" }, channelId: { type: "string" }, coworkerId: { type: "string" }, text: { type: "string", maxLength: MAX_TEXT }, artifactIds: { type: "array", maxItems: MAX_ARTIFACTS, items: { type: "string" } }, clientRequestId: { type: "string", maxLength: 128 }, options: { type: "object", properties: { notify: { type: "boolean" } }, additionalProperties: false } }, required: ["teamId", "channelId", "text"], additionalProperties: false },
    }),
    Object.freeze({
        name: "getOutcomeStatus",
        description: "Read the safe status and latest visible reply for one opaque outcome ID.",
        inputSchema: { type: "object", properties: { outcomeId: { type: "string" } }, required: ["outcomeId"], additionalProperties: false },
    }),
    Object.freeze({
        name: "getArtifacts",
        description: "Read safe artifact metadata attached to one governed outcome.",
        inputSchema: { type: "object", properties: { outcomeId: { type: "string" } }, required: ["outcomeId"], additionalProperties: false },
    }),
    Object.freeze({
        name: "cancelOutcome",
        description: "Cancel a queued or working outcome and block further delivery for its conversation.",
        inputSchema: { type: "object", properties: { outcomeId: { type: "string" } }, required: ["outcomeId"], additionalProperties: false },
    }),
    Object.freeze({
        name: "requestTakeover",
        description: "Stop automated delivery for an outcome and request human attention with a bounded reason.",
        inputSchema: { type: "object", properties: { outcomeId: { type: "string" }, reason: { type: "string", maxLength: 500 } }, required: ["outcomeId"], additionalProperties: false },
    }),
]);

const EXTERNAL_MCP_METHODS = Object.freeze([
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/call",
]);

function rpcResult(id, result) {
    return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
    return { jsonrpc: "2.0", id, error: { code, message: safeError(message) } };
}

function rpcToolResult(value) {
    return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
    };
}

function rpcRequestId(value) {
    if (value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))
        return value;
    throw new Error("JSON-RPC id must be a string, number, or null");
}

export function createExternalTeamControlApi({
    dataDir,
    teamService,
    coworkerStore,
    conversationStore,
    artifactStore,
    skillStore,
    routineController,
    jobs,
    dispatchMessage,
    blockConversation = () => {},
    isConversationBlocked = () => false,
    cancelConversation = () => undefined,
    requestAttention = () => undefined,
    audit,
    getAudit = () => audit,
    getRoutineController = () => routineController,
    getJobs = () => jobs,
    controllerRegistry,
    projectService,
    now = () => new Date().toISOString(),
    makeOutcomeId: makeOutcomeIdFn = makeOutcomeId,
} = {}) {
    if (!dataDir || !teamService?.list || !teamService?.getChannel || !coworkerStore?.list || !conversationStore?.get || !conversationStore?.postUserMessage || typeof dispatchMessage !== "function" || typeof getAudit !== "function")
        throw new Error("external team control requires team, coworker, conversation, dispatch, and audit services");
    const persistPath = join(dataDir, "desktop-state", "external-team-outcomes.json");
    const loaded = loadJsonState(persistPath, null);
    const outcomes = new Map(
        loaded?.schema === EXTERNAL_TEAM_CONTROL_SCHEMA && Array.isArray(loaded.outcomes)
            ? loaded.outcomes.map(sanitizePersistedOutcome).filter(Boolean).slice(-MAX_OUTCOMES).map((entry) => [entry.id, entry])
            : [],
    );
    const restoredBlockedConversations = new Set([...outcomes.values()]
        .filter((entry) => ["cancelled", "needs_attention"].includes(entry.status))
        .map((entry) => entry.conversationId));
    for (const conversationId of restoredBlockedConversations) {
        try { blockConversation(conversationId, "restored-external-outcome"); }
        catch {}
    }

    function save() {
        saveJsonState(persistPath, { schema: EXTERNAL_TEAM_CONTROL_SCHEMA, outcomes: [...outcomes.values()].slice(-MAX_OUTCOMES) });
    }

    function conversationBlocked(conversationId) {
        return restoredBlockedConversations.has(conversationId) || isConversationBlocked(conversationId);
    }

    function block(conversationId, reason) {
        restoredBlockedConversations.add(conversationId);
        blockConversation(conversationId, reason);
    }

    function requireTeam(teamId) {
        const team = teamService.list().teams.find((entry) => entry.id === teamId);
        if (!team) throw new Error("unknown team: " + teamId);
        return team;
    }

    function requireChannel(teamId, channelId) {
        const channel = teamService.getChannel(channelId);
        if (channel.teamId !== teamId) throw new Error("channel does not belong to team");
        return channel;
    }

    function requireCoworker(channel, coworkerId) {
        const coworker = coworkerStore.get(coworkerId);
        if (coworker.state !== "active" || !channel.coworkerIds.includes(coworkerId))
            throw new Error("coworker is not an active member of the channel");
        return coworker;
    }

    function requireOutcome(outcomeId) {
        if (!OUTCOME_ID.test(String(outcomeId))) throw new Error("outcomeId must be an outcome identifier");
        const outcome = outcomes.get(String(outcomeId));
        if (!outcome) throw new Error("unknown outcome: " + outcomeId);
        return outcome;
    }

    function controllerBinding(principal) {
        if (!principal?.deviceId || !controllerRegistry?.get) throw new Error("paired external controller authority is unavailable");
        return controllerRegistry.get(principal.deviceId);
    }

    function projectContainsTeam(projectId, teamId) {
        try { return projectService?.resolveScope?.(projectId)?.teamIds?.includes(teamId) === true; }
        catch { return false; }
    }

    function visibleTeam(team, principal) {
        if (!principal) return true;
        const binding = controllerBinding(principal);
        if (binding.teamIds.includes(team.id)) return true;
        return binding.projectIds.some((projectId) => projectContainsTeam(projectId, team.id));
    }

    function visibleTeams(principal) {
        return teamService.list().teams.filter((team) => visibleTeam(team, principal));
    }

    function principalContext(input = {}, principal) {
        if (input.teamId !== undefined) {
            const team = requireTeam(input.teamId);
            const channel = input.channelId === undefined ? undefined : requireChannel(team.id, input.channelId);
            const binding = principal ? controllerBinding(principal) : undefined;
            const boundProjectId = binding?.projectIds.find((projectId) => projectContainsTeam(projectId, team.id));
            return { teamId: team.id, ...(channel?.projectId ? { projectId: channel.projectId } : {}), ...(team.projectId ? { projectId: team.projectId } : {}), ...(boundProjectId ? { projectId: boundProjectId } : {}) };
        }
        if (input.outcomeId !== undefined) {
            const outcome = requireOutcome(input.outcomeId);
            const binding = principal ? controllerBinding(principal) : undefined;
            const boundProjectId = binding?.projectIds.find((projectId) => projectContainsTeam(projectId, outcome.teamId));
            return { teamId: outcome.teamId, ...(outcome.projectId ? { projectId: outcome.projectId } : {}), ...(boundProjectId ? { projectId: boundProjectId } : {}) };
        }
        if (input.routineId !== undefined) {
            const routine = getRoutineController()?.list?.().routines?.find((entry) => entry.id === input.routineId);
            if (!routine) throw new Error("unknown routine: " + input.routineId);
            return { ...(routine.teamId ? { teamId: routine.teamId } : {}), ...(routine.projectId ? { projectId: routine.projectId } : {}) };
        }
        return {};
    }

    function inputHash(request) {
        return createHash("sha256").update(JSON.stringify({ teamId: request.team.id, channelId: request.channel.id, coworkerId: request.coworkerId, text: request.text, artifactIds: request.artifactIds, options: request.options })).digest("hex");
    }

    function messageChain(conversation, rootMessageId) {
        const root = conversation.messages.find((entry) => entry.id === rootMessageId);
        if (!root) return [];
        const chain = [root];
        const seen = new Set([root.id]);
        for (let index = 0; index < chain.length; index += 1) {
            const parent = chain[index];
            for (const message of conversation.messages) {
                if (!seen.has(message.id) && message.replyTo === parent.id) {
                    seen.add(message.id);
                    chain.push(message);
                }
            }
        }
        return chain;
    }

    function sync(outcome) {
        if (outcome.status === "cancelled" || outcome.status === "needs_attention")
            return outcome;
        if (conversationBlocked(outcome.conversationId)) {
            outcome.status = "needs_attention";
            outcome.updatedAt = now();
            save();
            return outcome;
        }
        let conversation;
        try { conversation = conversationStore.get(outcome.conversationId); }
        catch { return outcome; }
        const chain = messageChain(conversation, outcome.messageId);
        if (!chain.length) return outcome;
        const root = chain[0];
        const deliveries = chain.flatMap((message) => Object.values(message.delivery ?? {}));
        if (deliveries.some((entry) => entry?.status === "failed")) {
            outcome.status = "failed";
            outcome.error = publicText(deliveries.find((entry) => entry?.status === "failed")?.detail ?? "team delivery failed").slice(0, 500);
        }
        else if (deliveries.some((entry) => entry?.status === "pending")) {
            outcome.status = "working";
        }
        else {
            outcome.status = "completed";
        }
        outcome.updatedAt = now();
        save();
        return outcome;
    }

    function publicOutcome(outcome) {
        const current = sync(outcome);
        let latestMessage;
        try {
            const conversation = conversationStore.get(current.conversationId);
            latestMessage = messageChain(conversation, current.messageId).at(-1);
        }
        catch {}
        return {
            id: current.id,
            status: current.status,
            teamId: current.teamId,
            channelId: current.channelId,
            ...(current.coworkerId ? { coworkerId: current.coworkerId } : {}),
            messageId: current.messageId,
            inputPreview: publicText(current.inputPreview),
            artifactIds: [...current.artifactIds],
            latestMessage: publicMessage(latestMessage),
            ...(current.error ? { error: publicText(current.error) } : {}),
            ...(current.takeoverReason ? { takeoverReason: publicText(current.takeoverReason) } : {}),
            createdAt: current.createdAt,
            updatedAt: current.updatedAt,
        };
    }

    function validateSubmit(input) {
        if (!isPlainObject(input)) throw new Error("submitOutcome payload must be an object");
        rejectAuthority(input);
        exactKeys(input, new Set(["teamId", "channelId", "coworkerId", "text", "artifactIds", "clientRequestId", "options"]), "submitOutcome");
        const teamId = opaqueId(input.teamId, "teamId");
        const channelId = opaqueId(input.channelId, "channelId");
        const text = boundedText(input.text, "text", MAX_TEXT, true);
        const team = requireTeam(teamId);
        const channel = requireChannel(team.id, channelId);
        let coworkerId;
        if (input.coworkerId !== undefined) {
            coworkerId = opaqueId(input.coworkerId, "coworkerId");
            requireCoworker(channel, coworkerId);
        }
        const refs = artifactIds(input.artifactIds);
        for (const artifactId of refs) {
            if (!artifactStore) throw new Error("artifact references are unavailable");
            const artifact = artifactStore.get(artifactId);
            if (artifact.conversationId && artifact.conversationId !== channel.conversationId)
                throw new Error("artifact is not attached to this channel");
        }
        let options;
        if (input.options !== undefined) {
            if (!isPlainObject(input.options)) throw new Error("options must be an object");
            rejectAuthority(input.options, "options");
            exactKeys(input.options, new Set(["notify"]), "options");
            if (input.options.notify !== undefined && typeof input.options.notify !== "boolean")
                throw new Error("options.notify must be boolean");
            options = { ...(input.options.notify !== undefined ? { notify: input.options.notify } : {}) };
        }
        const clientRequestId = input.clientRequestId === undefined ? undefined : opaqueId(input.clientRequestId, "clientRequestId");
        return { team, channel, coworkerId, text, artifactIds: refs, clientRequestId, options };
    }

    function validateChannelRead(input, label) {
        if (!isPlainObject(input)) throw new Error(label + " payload must be an object");
        rejectAuthority(input, label);
        exactKeys(input, new Set(["teamId", "channelId"]), label);
        const team = requireTeam(opaqueId(input.teamId, "teamId"));
        const channel = requireChannel(team.id, opaqueId(input.channelId, "channelId"));
        return { team, channel };
    }

    const api = {
        protocol: EXTERNAL_TEAM_CONTROL_PROTOCOL,

        listTeams(_input = {}, principal) {
            return { protocol: EXTERNAL_TEAM_CONTROL_PROTOCOL, teams: visibleTeams(principal).map(publicTeam) };
        },

        listCoworkers(_input = {}, principal) {
            const visibleCoworkerIds = new Set(visibleTeams(principal).flatMap((team) => team.coworkerIds ?? []));
            return {
                protocol: EXTERNAL_TEAM_CONTROL_PROTOCOL,
                coworkers: coworkerStore.list().coworkers.filter((entry) => !principal || visibleCoworkerIds.has(entry.id)).map((entry) => ({
                    id: entry.id,
                    name: publicText(entry.name),
                    role: publicText(entry.role),
                    state: entry.state,
                    modelProfile: entry.modelBinding?.profile ?? "automatic",
                })),
            };
        },

        listChannels(input = {}, principal) {
            rejectAuthority(input);
            exactKeys(input, new Set(["teamId", "includeArchived"]), "listChannels");
            if (input.includeArchived !== undefined && typeof input.includeArchived !== "boolean") throw new Error("listChannels.includeArchived must be boolean");
            const teamId = input.teamId === undefined ? undefined : opaqueId(input.teamId, "teamId");
            if (teamId) { requireTeam(teamId); if (principal && !visibleTeams(principal).some((team) => team.id === teamId)) throw new Error("external controller Team binding denied"); }
            const channels = teamService.listChannels(teamId ? { teamId, includeArchived: input.includeArchived === true } : { includeArchived: input.includeArchived === true }).channels;
            return { protocol: EXTERNAL_TEAM_CONTROL_PROTOCOL, channels: channels.filter((channel) => !principal || visibleTeams(principal).some((team) => team.id === channel.teamId)).map(publicChannel) };
        },

        sendMessage(input) {
            return this.submitOutcome(input);
        },

        getConversation(input, principal) {
            const { channel } = validateChannelRead(input, "getConversation");
            const conversation = conversationStore.get(channel.conversationId);
            return {
                protocol: EXTERNAL_TEAM_CONTROL_PROTOCOL,
                teamId: channel.teamId,
                channelId: channel.id,
                conversationId: channel.conversationId,
                messages: conversation.messages.slice(-MAX_CONVERSATION_MESSAGES).map(publicMessage).filter(Boolean),
            };
        },

        listSkills(input = {}, principal) {
            if (!skillStore?.list) throw new Error("skills are unavailable");
            rejectAuthority(input, "listSkills");
            exactKeys(input, new Set(["includeArchived"]), "listSkills");
            if (input.includeArchived !== undefined && typeof input.includeArchived !== "boolean") throw new Error("listSkills.includeArchived must be boolean");
            const allowedTeams = new Set(visibleTeams(principal).map((team) => team.id));
            const skills = (skillStore.list({ includeArchived: input.includeArchived === true }).skills ?? []).filter((skill) => !principal || (skill.assignedTeamIds ?? []).some((id) => allowedTeams.has(id)));
            return {
                protocol: EXTERNAL_TEAM_CONTROL_PROTOCOL,
                skills: skills.slice(0, MAX_LIST_ITEMS).map((skill) => ({
                    id: skill.id,
                    name: publicText(skill.name),
                    description: publicText(skill.description),
                    state: skill.state,
                    assignedCoworkerIds: [...(skill.assignedCoworkerIds ?? [])],
                    assignedTeamIds: [...(skill.assignedTeamIds ?? [])],
                })),
            };
        },

        listRoutines(_input = {}, principal) {
            const currentRoutineController = getRoutineController();
            if (!currentRoutineController?.list) throw new Error("routines are unavailable");
            const allowedTeams = new Set(visibleTeams(principal).map((team) => team.id));
            const allowedCoworkers = new Set([...allowedTeams].flatMap((teamId) => requireTeam(teamId).coworkerIds ?? []));
            const routines = (currentRoutineController.list().routines ?? []).filter((routine) => !principal || (routine.teamId && allowedTeams.has(routine.teamId)) || (routine.coworkerId && allowedCoworkers.has(routine.coworkerId)));
            return {
                protocol: EXTERNAL_TEAM_CONTROL_PROTOCOL,
                routines: routines.slice(0, MAX_LIST_ITEMS).map((routine) => ({
                    id: routine.id,
                    name: publicText(routine.name),
                    enabled: routine.enabled === true,
                    coworkerId: routine.coworkerId,
                    skillId: routine.skillId,
                    schedule: routine.schedule,
                    lastStatus: routine.lastStatus,
                    lastRunAt: routine.lastRunAt,
                    nextRunAt: routine.nextRunAt,
                })),
            };
        },

        runRoutineNow(input) {
            const currentRoutineController = getRoutineController();
            if (!currentRoutineController?.runNow) throw new Error("routine execution is unavailable");
            if (!isPlainObject(input)) throw new Error("runRoutineNow payload must be an object");
            rejectAuthority(input, "runRoutineNow");
            exactKeys(input, new Set(["routineId"]), "runRoutineNow");
            const routineId = opaqueId(input.routineId, "routineId");
            const result = currentRoutineController.runNow(routineId);
            return {
                protocol: EXTERNAL_TEAM_CONTROL_PROTOCOL,
                routineId,
                result: {
                    routine: result?.routine ? { id: result.routine.id, name: publicText(result.routine.name), enabled: result.routine.enabled === true, lastStatus: result.routine.lastStatus, lastRunAt: result.routine.lastRunAt, nextRunAt: result.routine.nextRunAt } : undefined,
                    job: result?.job ? { id: result.job.id, title: publicText(result.job.title), status: result.job.status, createdAt: result.job.createdAt, updatedAt: result.job.updatedAt } : undefined,
                    run: result?.run ? { id: result.run.id, status: result.run.status, scheduledFor: result.run.scheduledFor, startedAt: result.run.startedAt, finishedAt: result.run.finishedAt, source: result.run.source } : undefined,
                },
            };
        },

        getAttention(_input = {}, principal) {
            const currentJobs = getJobs();
            if (!currentJobs?.attentionJobs) throw new Error("attention center is unavailable");
            const allowedTeams = new Set(visibleTeams(principal).map((team) => team.id));
            const attention = (currentJobs.attentionJobs().jobs ?? []).filter((job) => !principal || (job.teamId && allowedTeams.has(job.teamId)));
            const takeoverAttention = [...outcomes.values()]
                .filter((outcome) => outcome.status === "needs_attention")
                .filter((outcome) => !principal || allowedTeams.has(outcome.teamId))
                .map((outcome) => ({
                    id: outcome.id,
                    title: `External takeover: ${outcome.inputPreview}`,
                    status: outcome.status,
                    priority: "high",
                    ownerCoworkerId: outcome.coworkerId,
                    conversationId: outcome.conversationId,
                    createdAt: outcome.createdAt,
                    updatedAt: outcome.updatedAt,
                    attentionState: { reason: outcome.takeoverReason },
                }));
            return {
                protocol: EXTERNAL_TEAM_CONTROL_PROTOCOL,
                jobs: [...attention, ...takeoverAttention].slice(0, MAX_LIST_ITEMS).map((job) => ({
                    id: job.id,
                    title: publicText(job.title),
                    status: job.status,
                    priority: job.priority,
                    ownerCoworkerId: job.ownerCoworkerId,
                    conversationId: job.conversationId,
                    createdAt: job.createdAt,
                    updatedAt: job.updatedAt,
                    ...(job.attentionState?.reason ? { reason: publicText(job.attentionState.reason) } : {}),
                })),
            };
        },

        submitOutcome(input) {
            const request = validateSubmit(input);
            if (request.clientRequestId) {
                const existing = [...outcomes.values()].find((entry) => entry.clientRequestId === request.clientRequestId && entry.teamId === request.team.id && entry.channelId === request.channel.id);
                if (existing) {
                    if (existing.inputHash && existing.inputHash !== inputHash(request)) throw new Error("clientRequestId conflicts with a different request");
                    return publicOutcome(existing);
                }
            }
            if (conversationBlocked(request.channel.conversationId))
                throw new Error("channel is blocked for takeover or cancellation");
            const id = makeOutcomeIdFn();
            if (!OUTCOME_ID.test(id) || outcomes.has(id)) throw new Error("outcome id factory returned an invalid or duplicate id");
            const message = conversationStore.postUserMessage(request.channel.conversationId, {
                text: request.text,
                ...(request.coworkerId ? { mentions: [request.coworkerId] } : {}),
                ...(request.artifactIds.length ? { artifactIds: request.artifactIds } : {}),
                ...(request.clientRequestId ? { clientMessageId: ("external-" + request.clientRequestId).slice(0, 128) } : {}),
            });
            const timestamp = now();
            const outcome = {
                id,
                teamId: request.team.id,
                channelId: request.channel.id,
                coworkerId: request.coworkerId,
                conversationId: request.channel.conversationId,
                messageId: message.id,
                clientRequestId: request.clientRequestId,
                inputHash: inputHash(request),
                inputPreview: publicText(request.text),
                artifactIds: [...request.artifactIds],
                status: "queued",
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            outcomes.set(id, outcome);
            while (outcomes.size > MAX_OUTCOMES) outcomes.delete(outcomes.keys().next().value);
            save();
            try {
                const deliveries = dispatchMessage(request.channel.conversationId, message.id);
                Promise.allSettled(deliveries).then(() => sync(outcome)).catch(() => {});
            }
            catch (error) {
                outcome.status = "failed";
                outcome.error = safeError(error);
                outcome.updatedAt = now();
                save();
            }
            return publicOutcome(outcome);
        },

        getOutcome(outcomeId) {
            return publicOutcome(requireOutcome(outcomeId));
        },

        getOutcomeStatus(outcomeId) {
            return publicOutcome(requireOutcome(outcomeId));
        },

        getArtifacts(outcomeId) {
            const outcome = requireOutcome(outcomeId);
            const ids = new Set(outcome.artifactIds);
            try {
                const conversation = conversationStore.get(outcome.conversationId);
                const relevant = messageChain(conversation, outcome.messageId);
                for (const message of relevant)
                    for (const id of message.artifactIds ?? []) ids.add(id);
            }
            catch {}
            const artifacts = [...ids].flatMap((id) => {
                try { return [publicArtifact(artifactStore?.get(id))]; }
                catch { return []; }
            }).filter(Boolean);
            return { protocol: EXTERNAL_TEAM_CONTROL_PROTOCOL, outcomeId: outcome.id, artifacts };
        },

        cancelOutcome(outcomeId) {
            const outcome = requireOutcome(outcomeId);
            if (!(["queued", "working"].includes(sync(outcome).status)))
                return publicOutcome(outcome);
            block(outcome.conversationId, "external-cancel");
            void Promise.resolve(cancelConversation(outcome.conversationId, "external outcome cancelled")).catch(() => undefined);
            outcome.status = "cancelled";
            outcome.updatedAt = now();
            save();
            return publicOutcome(outcome);
        },

        async requestTakeover(outcomeId, input = {}) {
            const outcome = requireOutcome(outcomeId);
            if (!isPlainObject(input)) throw new Error("requestTakeover payload must be an object");
            rejectAuthority(input);
            exactKeys(input, new Set(["reason"]), "requestTakeover");
            const reason = boundedText(input.reason, "reason", 500) ?? "External operator requested takeover.";
            const safeReason = publicText(reason).slice(0, 500);
            const currentStatus = sync(outcome).status;
            if (["completed", "failed", "cancelled"].includes(currentStatus))
                return publicOutcome(outcome);
            const activeAudit = getAudit();
            if (!activeAudit || typeof activeAudit.append !== "function") throw new Error("external takeover audit is unavailable");
            block(outcome.conversationId, "external-takeover");
            try { requestAttention({ outcomeId: outcome.id, conversationId: outcome.conversationId, reason: safeReason }); }
            catch {}
            outcome.status = "needs_attention";
            outcome.takeoverReason = safeReason;
            outcome.updatedAt = now();
            save();
            await activeAudit.append({
                type: "takeover.requested",
                actor: "external-operator",
                data: {
                    ...(outcome.coworkerId ? { coworkerId: outcome.coworkerId } : {}),
                    action: "request takeover",
                    status: "needs_attention",
                },
            });
            return publicOutcome(outcome);
        },

        async invoke(operation, input = {}, principal) {
            if (!isPlainObject(input)) throw new Error("secure external control input must be an object");
            if (!controllerRegistry?.authorize) throw new Error("paired external controller authority is unavailable");
            let context;
            let release;
            try {
                context = principalContext(input, principal);
                controllerRegistry.authorize(principal?.deviceId, operation, { ...context, ...(principal?.transport ? { transport: principal.transport } : {}) });
                release = controllerRegistry.beginRequest?.(principal.deviceId);
            }
            catch (error) {
                const activeAudit = getAudit();
                if (activeAudit?.append) {
                    try { await activeAudit.append({ type: "external.control.denied", actor: "external-controller", data: { operation: publicText(operation).slice(0, 64), reason: safeError(error) } }); }
                    catch {}
                }
                throw error;
            }
            try {
                switch (operation) {
                    case "listTeams": return this.listTeams({}, principal);
                    case "listCoworkers": return this.listCoworkers({}, principal);
                    case "listChannels": return this.listChannels(input, principal);
                    case "sendMessage": return this.submitOutcome(input, principal);
                    case "getConversation": return this.getConversation(input, principal);
                    case "submitOutcome": return this.submitOutcome(input, principal);
                    case "getStatus": return this.getOutcomeStatus(input.outcomeId);
                    case "cancel": return this.cancelOutcome(input.outcomeId);
                    case "getArtifacts": return this.getArtifacts(input.outcomeId);
                    case "listSkills": return this.listSkills(input, principal);
                    case "listRoutines": return this.listRoutines({}, principal);
                    case "runRoutineNow": return this.runRoutineNow(input);
                    case "getAttention": return this.getAttention({}, principal);
                    case "requestTakeover": return await this.requestTakeover(input.outcomeId, { ...(input.reason === undefined ? {} : { reason: input.reason }) });
                    default: throw new Error("secure external control operation is not supported");
                }
            }
            catch (error) {
                const activeAudit = getAudit();
                if (activeAudit?.append) {
                    try { await activeAudit.append({ type: "external.control.failed", actor: "external-controller", data: { operation: publicText(operation).slice(0, 64), reason: safeError(error) } }); }
                    catch {}
                }
                throw error;
            }
            finally {
                release?.();
            }
        },

        publicStatus() {
            return {
                protocol: EXTERNAL_TEAM_CONTROL_PROTOCOL,
                authentication: "operator-session",
                transport: "loopback-http",
                endpoint: "/mcp/v1",
                mcpProtocolVersion: EXTERNAL_MCP_PROTOCOL_VERSION,
                methods: ["listTeams", "listCoworkers", "listChannels", "sendMessage", "getConversation", "listSkills", "listRoutines", "runRoutineNow", "getAttention", "submitOutcome", "getOutcomeStatus", "getArtifacts", "cancelOutcome", "requestTakeover"],
                mcpMethods: [...EXTERNAL_MCP_METHODS],
                secureControl: { transport: "paired-device-direct-or-opaque-relay", operations: ["listTeams", "listCoworkers", "listChannels", "sendMessage", "getConversation", "submitOutcome", "getStatus", "cancel", "getArtifacts", "listSkills", "listRoutines", "runRoutineNow", "getAttention", "requestTakeover"] },
            };
        },
    };
    return api;
}

export function createExternalTeamControlServer({
    host = "127.0.0.1",
    port = 0,
    authenticate,
    ...apiOptions
} = {}) {
    if (!loopbackHost(host)) throw new Error("external team control must bind to loopback");
    if (typeof authenticate !== "function") throw new Error("external team control requires an authenticator");
    const api = createExternalTeamControlApi(apiOptions);
    let server;
    let address;
    let statusPath;

    async function authorized(request, response) {
        if (!loopbackRemote(request.socket.remoteAddress)) {
            send(response, 403, { error: "external team control is available only on loopback" });
            return false;
        }
        const token = bearer(request);
        if (!await authenticate(token)) {
            send(response, 401, { error: "invalid or expired operator session" });
            return false;
        }
        const origin = request.headers.origin;
        if (origin && origin !== "http://" + request.headers.host) {
            send(response, 403, { error: "cross-origin team control request refused" });
            return false;
        }
        return true;
    }

    function emptyRpcResponse(response) {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
    }

    function initializeResult(params) {
        if (!isPlainObject(params)) throw new Error("initialize params must be an object");
        exactKeys(params, new Set(["protocolVersion", "clientInfo", "capabilities"]), "initialize");
        if (params.protocolVersion !== undefined)
            boundedText(params.protocolVersion, "protocolVersion", 100);
        if (params.clientInfo !== undefined) {
            if (!isPlainObject(params.clientInfo)) throw new Error("clientInfo must be an object");
            exactKeys(params.clientInfo, new Set(["name", "version"]), "clientInfo");
            boundedText(params.clientInfo.name, "clientInfo.name", 100, true);
            boundedText(params.clientInfo.version, "clientInfo.version", 100, true);
        }
        // The product does not accept client-declared authority or capability grants.
        // An empty MCP capability advertisement is harmless and keeps standard clients compatible.
        if (params.capabilities !== undefined) {
            if (!isPlainObject(params.capabilities) || Object.keys(params.capabilities).length)
                throw new Error("client capabilities are not accepted by external team control");
        }
        return {
            protocolVersion: EXTERNAL_MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "SovereignBot", version: "product-burst" },
            instructions: "Use only bounded team, channel, outcome, and artifact operations; execution remains Governor-controlled.",
        };
    }

    async function toolCall(name, input) {
        if (typeof name !== "string" || !name) throw new Error("tools/call name is required");
        if (!isPlainObject(input)) throw new Error("tools/call arguments must be an object");
        rejectAuthority(input, "tools/call.arguments");
        switch (name) {
            case "listTeams":
                exactKeys(input, new Set(), "listTeams");
                return api.listTeams();
            case "listCoworkers":
                exactKeys(input, new Set(), "listCoworkers");
                return api.listCoworkers();
            case "listChannels":
                return api.listChannels(input);
            case "sendMessage":
                return api.sendMessage(input);
            case "getConversation":
                return api.getConversation(input);
            case "listSkills":
                return api.listSkills(input);
            case "listRoutines":
                exactKeys(input, new Set(), "listRoutines");
                return api.listRoutines();
            case "runRoutineNow":
                return api.runRoutineNow(input);
            case "getAttention":
                exactKeys(input, new Set(), "getAttention");
                return api.getAttention();
            case "submitOutcome":
                return api.submitOutcome(input);
            case "getOutcomeStatus":
                exactKeys(input, new Set(["outcomeId"]), "getOutcomeStatus");
                return api.getOutcomeStatus(input.outcomeId);
            case "getArtifacts":
                exactKeys(input, new Set(["outcomeId"]), "getArtifacts");
                return api.getArtifacts(input.outcomeId);
            case "cancelOutcome":
                exactKeys(input, new Set(["outcomeId"]), "cancelOutcome");
                return api.cancelOutcome(input.outcomeId);
            case "requestTakeover":
                exactKeys(input, new Set(["outcomeId", "reason"]), "requestTakeover");
                return await api.requestTakeover(input.outcomeId, input);
            default:
                throw new Error("unknown MCP tool: " + name);
        }
    }

    async function handleJsonRpc(request, response) {
        const payload = await readJson(request);
        const hasId = Object.prototype.hasOwnProperty.call(payload, "id");
        const id = hasId ? rpcRequestId(payload.id) : null;
        if (payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
            if (hasId) send(response, 200, rpcError(id, -32600, "invalid JSON-RPC request"));
            else emptyRpcResponse(response);
            return;
        }
        const params = payload.params === undefined ? {} : payload.params;
        let result;
        try {
            if (payload.method === "notifications/initialized") {
                if (!isPlainObject(params)) throw new Error("notification params must be an object");
                exactKeys(params, new Set(), "notifications/initialized");
                emptyRpcResponse(response);
                return;
            }
            switch (payload.method) {
                case "initialize":
                    result = initializeResult(params);
                    break;
                case "tools/list":
                    if (!isPlainObject(params)) throw new Error("tools/list params must be an object");
                    exactKeys(params, new Set(), "tools/list");
                    result = { tools: EXTERNAL_MCP_TOOLS };
                    break;
                case "tools/call":
                    if (!isPlainObject(params)) throw new Error("tools/call params must be an object");
                    exactKeys(params, new Set(["name", "arguments"]), "tools/call");
                    result = rpcToolResult(await toolCall(params.name, params.arguments ?? {}));
                    break;
                default:
                    if (hasId) send(response, 200, rpcError(id, -32601, "method not found"));
                    else emptyRpcResponse(response);
                    return;
            }
            if (hasId) send(response, 200, rpcResult(id, result));
            else emptyRpcResponse(response);
        }
        catch (error) {
            if (hasId) send(response, 200, rpcError(id, -32602, error));
            else emptyRpcResponse(response);
        }
    }

    async function handle(request, response) {
        try {
            if (!await authorized(request, response)) return;
            const fallbackHost = String(request.headers.host ?? (host + ":" + String(address?.port ?? port)));
            const url = new URL(request.url ?? "/", "http://" + fallbackHost);
            const parts = pathParts(url.pathname);
            if (request.method === "POST" && url.pathname === "/mcp/v1") {
                await handleJsonRpc(request, response);
                return;
            }
            if (request.method === "GET" && url.pathname === "/mcp/v1/status") {
                send(response, 200, api.publicStatus());
                return;
            }
            if (request.method === "GET" && url.pathname === "/mcp/v1/teams") {
                send(response, 200, api.listTeams());
                return;
            }
            if (request.method === "GET" && url.pathname === "/mcp/v1/coworkers") {
                send(response, 200, api.listCoworkers());
                return;
            }
            if (request.method === "GET" && url.pathname === "/mcp/v1/channels") {
                send(response, 200, api.listChannels({ teamId: url.searchParams.get("teamId") ?? undefined }));
                return;
            }
            if (request.method === "POST" && url.pathname === "/mcp/v1/outcomes") {
                send(response, 201, api.submitOutcome(await readJson(request)));
                return;
            }
            if (parts[0] === "mcp" && parts[1] === "v1" && parts[2] === "outcomes" && parts[3]) {
                const outcomeId = parts[3];
                if (request.method === "GET" && parts.length === 4) {
                    send(response, 200, api.getOutcome(outcomeId));
                    return;
                }
                if (request.method === "GET" && parts.length === 5 && parts[4] === "artifacts") {
                    send(response, 200, api.getArtifacts(outcomeId));
                    return;
                }
                if (request.method === "POST" && parts.length === 5 && parts[4] === "cancel") {
                    send(response, 200, api.cancelOutcome(outcomeId));
                    return;
                }
                if (request.method === "POST" && parts.length === 5 && parts[4] === "takeover") {
                    send(response, 200, await api.requestTakeover(outcomeId, await readJson(request)));
                    return;
                }
            }
            send(response, 404, { error: "not found" });
        }
        catch (error) {
            send(response, Number.isInteger(error?.statusCode) ? error.statusCode : 400, { error: safeError(error) });
        }
    }

    return {
        api,
        async start() {
            if (server) return { ...address, statusPath };
            server = createServer((request, response) => { void handle(request, response); });
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(port, host, () => {
                    address = server.address();
                    resolve();
                });
            });
            const actualPort = typeof address === "object" && address ? address.port : port;
            statusPath = join(apiOptions.dataDir, "desktop-state", "external-team-control.endpoint.json");
            saveJsonState(statusPath, {
                schema: EXTERNAL_TEAM_CONTROL_SCHEMA,
                protocol: EXTERNAL_TEAM_CONTROL_PROTOCOL,
                host,
                port: actualPort,
                authentication: "operator-session",
            });
            return { host, port: actualPort, statusPath };
        },
        status() {
            return {
                ...api.publicStatus(),
                ...(address ? { host, port: address.port } : { state: "starting" }),
            };
        },
        async close() {
            if (!server) return;
            const current = server;
            server = undefined;
            await new Promise((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
        },
    };
}
