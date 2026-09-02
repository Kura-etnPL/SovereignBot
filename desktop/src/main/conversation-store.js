import { randomBytes } from "node:crypto";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

export const CONVERSATIONS_SCHEMA = "sovereignbot.desktop.conversations.v1";

const MAX_CONVERSATIONS = 256;
const MAX_MESSAGES_PER_CONVERSATION = 5_000;
const MAX_PARTICIPANTS = 8;
const MAX_MESSAGE_TEXT = 12_000;
const MAX_TITLE = 120;
const MAX_REFERENCES = 24;
const USER_PARTICIPANT = "user";

const AUTHORITY_KEYS = new Set([
    "command", "executable", "args", "prefixargs", "env", "environment", "cwd",
    "workspacepath", "sessionid", "harnessstate", "token", "bearer", "bearertoken",
    "apikey", "secret", "actorid", "owneragentid", "assignedagentid", "policy",
    "allowprivatehosts", "governedtools", "capabilities",
]);

function makeConversationId() { return `conv_${randomBytes(8).toString("hex")}`; }
function makeMessageId() { return `msg_${randomBytes(8).toString("hex")}`; }
function normalizedKey(key) { return String(key).replaceAll(/[-_\s]/g, "").toLowerCase(); }
function rejectAuthority(value, path = "message") {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((entry, index) => rejectAuthority(entry, `${path}[${index}]`)); return; }
    for (const [key, child] of Object.entries(value)) {
        if (AUTHORITY_KEYS.has(normalizedKey(key))) throw new Error(`authority-bearing conversation field is not allowed: ${path}.${key}`);
        rejectAuthority(child, `${path}.${key}`);
    }
}
function plainObject(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); }
function boundedText(value, label, max, { required = false } = {}) {
    if (value === undefined || value === null) { if (required) throw new Error(`${label} is required`); return undefined; }
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    const trimmed = value.trim();
    if (!trimmed && required) throw new Error(`${label} is required`);
    if (trimmed.length > max) throw new Error(`${label} exceeds ${max} characters`);
    return trimmed || undefined;
}
function idList(value, label, { max = MAX_REFERENCES } = {}) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    if (value.length > max) throw new Error(`${label} exceeds ${max} entries`);
    const result = [];
    for (const item of value) {
        if (typeof item !== "string" || !/^[A-Za-z0-9][\w:.-]{0,127}$/.test(item)) throw new Error(`${label} contains an invalid identifier`);
        if (!result.includes(item)) result.push(item);
    }
    return result;
}
function validConversationId(value) { return typeof value === "string" && /^conv_[a-f0-9]{16}$/i.test(value); }
function validMessageId(value) { return typeof value === "string" && /^msg_[a-f0-9]{16}$/i.test(value); }
function clone(value) { return structuredClone(value); }

export function createConversationStore({ persistPath, coworkerStore, now = () => new Date().toISOString(), makeConversationId: makeConversationIdFn = makeConversationId, makeMessageId: makeMessageIdFn = makeMessageId, teamRouteResolver } = {}) {
    if (!persistPath) throw new Error("conversation store requires persistPath");
    if (!coworkerStore?.get || !coworkerStore?.list) throw new Error("conversation store requires coworkerStore");

    function requireCoworker(id) {
        const coworker = coworkerStore.get(id);
        if (coworker.state === "archived") throw new Error(`archived coworker cannot join new work: ${id}`);
        return coworker;
    }

    function sanitizePersistedMessage(message, participants) {
        try {
            if (!message || typeof message !== "object" || !validMessageId(message.id)) return false;
            if (typeof message.senderId !== "string" || !participants.includes(message.senderId)) return false;
            if (typeof message.text !== "string" || !message.text.trim() || message.text.length > MAX_MESSAGE_TEXT) return false;
            if (typeof message.createdAt !== "string") return false;
            if (message.replyTo !== undefined && !validMessageId(message.replyTo)) return false;
            if (message.voiceEligible !== undefined && typeof message.voiceEligible !== "boolean") return false;
            if (message.voiceEligible === true && message.senderId === USER_PARTICIPANT) return false;
            idList(message.mentions, "mentions", { max: MAX_PARTICIPANTS });
            idList(message.artifactIds, "artifactIds");
            if (!message.delivery || typeof message.delivery !== "object" || Array.isArray(message.delivery)) return false;
            return true;
        } catch { return false; }
    }

    function sanitizePersistedConversation(entry) {
        try {
            if (!entry || typeof entry !== "object" || !validConversationId(entry.id)) return undefined;
            if (!["direct", "team"].includes(entry.kind)) return undefined;
            const participants = idList(entry.participants, "participants", { max: MAX_PARTICIPANTS });
            if (!participants.includes(USER_PARTICIPANT)) return undefined;
            for (const id of participants.filter((id) => id !== USER_PARTICIPANT)) requireCoworker(id);
            if (entry.kind === "direct" && participants.length !== 2) return undefined;
            let leadCoworkerId;
            if (entry.leadCoworkerId !== undefined) {
                if (entry.kind !== "team" || typeof entry.leadCoworkerId !== "string" || !participants.includes(entry.leadCoworkerId) || entry.leadCoworkerId === USER_PARTICIPANT) return undefined;
                requireCoworker(entry.leadCoworkerId);
                leadCoworkerId = entry.leadCoworkerId;
            }
            const messages = Array.isArray(entry.messages) ? entry.messages.filter((message) => sanitizePersistedMessage(message, participants)).slice(-MAX_MESSAGES_PER_CONVERSATION) : [];
            const title = boundedText(entry.title, "title", MAX_TITLE) ?? (entry.kind === "direct" ? "Conversation" : "Team");
            if (typeof entry.createdAt !== "string" || typeof entry.updatedAt !== "string") return undefined;
            return { id: entry.id, kind: entry.kind, title, participants, ...(leadCoworkerId ? { leadCoworkerId } : {}), messages, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
        } catch { return undefined; }
    }

    const loaded = loadJsonState(persistPath, null);
    const conversations = loaded?.schema === CONVERSATIONS_SCHEMA && Array.isArray(loaded.conversations)
        ? loaded.conversations.map(sanitizePersistedConversation).filter(Boolean).slice(0, MAX_CONVERSATIONS)
        : [];

    let resolveTeamRoute = typeof teamRouteResolver === "function" ? teamRouteResolver : undefined;
    let validateArtifactReferences;

    function save() { saveJsonState(persistPath, { schema: CONVERSATIONS_SCHEMA, conversations }); }
    function requireConversation(id) { const conversation = conversations.find((entry) => entry.id === String(id)); if (!conversation) throw new Error(`unknown conversation id: ${id}`); return conversation; }
    function requireParticipant(conversation, participantId) { if (!conversation.participants.includes(participantId)) throw new Error(`participant ${participantId} is not in conversation ${conversation.id}`); if (participantId !== USER_PARTICIPANT) requireCoworker(participantId); }

    function recipientIds(conversation, senderId, mentions) {
        const coworkers = conversation.participants.filter((id) => id !== USER_PARTICIPANT && id !== senderId);
        if (mentions.includes("everyone")) {
            if (mentions.length !== 1)
                throw new Error("@everyone cannot be combined with another mention");
            return coworkers;
        }
        if (!mentions.length) {
            if (conversation.kind === "team") {
                // A team room has one current ingress owner.  Explicit mentions (or
                // @everyone) are the only way to fan work out; an ordinary message
                // must not wake every Bot in the roster.
                const routedOwner = resolveTeamRoute?.(conversation);
                if (routedOwner === senderId)
                    return [];
                if (routedOwner && coworkers.includes(routedOwner))
                    return [routedOwner];
                const lead = conversation.leadCoworkerId ?? coworkers[0];
                if (lead && coworkers.includes(lead))
                    return [lead];
                return coworkers.slice(0, 1);
            }
            return coworkers;
        }
        for (const mention of mentions) {
            if (!coworkers.includes(mention)) throw new Error(`mentioned coworker is not an eligible participant: ${mention}`);
        }
        return mentions;
    }

    function summarize(conversation) {
        const lastMessage = conversation.messages.at(-1);
        return {
            id: conversation.id,
            kind: conversation.kind,
            title: conversation.title,
            participants: [...conversation.participants],
            ...(conversation.leadCoworkerId ? { leadCoworkerId: conversation.leadCoworkerId } : {}),
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            messageCount: conversation.messages.length,
            lastMessage: lastMessage ? { id: lastMessage.id, senderId: lastMessage.senderId, textPreview: lastMessage.text.slice(0, 160), createdAt: lastMessage.createdAt } : undefined,
        };
    }

    function createConversation({ kind, title, coworkerIds, leadCoworkerId }) {
        if (conversations.length >= MAX_CONVERSATIONS) throw new Error(`conversation limit reached (${MAX_CONVERSATIONS})`);
        if (!["direct", "team"].includes(kind)) throw new Error("conversation kind must be direct or team");
        const ids = idList(coworkerIds, "coworkerIds", { max: MAX_PARTICIPANTS - 1 });
        if (!ids.length) throw new Error("conversation requires at least one coworker");
        ids.forEach(requireCoworker);
        if (kind === "direct" && ids.length !== 1) throw new Error("direct conversation requires exactly one coworker");
        if (kind === "team" && ids.length < 2) throw new Error("team conversation requires at least two coworkers");
        if (leadCoworkerId !== undefined && (kind !== "team" || !ids.includes(leadCoworkerId))) throw new Error("lead coworker must be a member of the team");
        const id = makeConversationIdFn();
        if (!validConversationId(id) || conversations.some((entry) => entry.id === id)) throw new Error("conversation id factory returned an invalid or duplicate id");
        const timestamp = now();
        const fallbackTitle = kind === "direct" ? requireCoworker(ids[0]).name : "Team";
        // Product-created team rooms are Chief-led by default.  Callers can still
        // choose another explicit lead, while direct user messages remain bounded to
        // one owner until the owner sends a governed handoff.
        const effectiveLead = kind === "team" ? (leadCoworkerId ?? ids[0]) : undefined;
        const conversation = { id, kind, title: boundedText(title, "title", MAX_TITLE) ?? fallbackTitle, participants: [USER_PARTICIPANT, ...ids], ...(effectiveLead ? { leadCoworkerId: effectiveLead } : {}), messages: [], createdAt: timestamp, updatedAt: timestamp };
        conversations.push(conversation);
        save();
        return summarize(conversation);
    }

    function post(conversationId, payload, { senderId, voiceEligible = false }) {
        const conversation = requireConversation(conversationId);
        requireParticipant(conversation, senderId);
        plainObject(payload, "message");
        rejectAuthority(payload);
        const allowed = new Set(["text", "mentions", "replyTo", "artifactIds", "clientMessageId"]);
        for (const key of Object.keys(payload)) { if (!allowed.has(key)) throw new Error(`unknown message field: ${key}`); }
        const text = boundedText(payload.text, "text", MAX_MESSAGE_TEXT, { required: true });
        const mentions = idList(payload.mentions, "mentions", { max: MAX_PARTICIPANTS });
        const artifactIds = idList(payload.artifactIds, "artifactIds");
        validateArtifactReferences?.({ conversationId: conversation.id, artifactIds });
        const replyTo = payload.replyTo;
        if (replyTo !== undefined && (!validMessageId(replyTo) || !conversation.messages.some((entry) => entry.id === replyTo))) throw new Error("replyTo must reference an existing message in this conversation");
        const clientMessageId = boundedText(payload.clientMessageId, "clientMessageId", 128);
        if (clientMessageId) {
            const duplicate = conversation.messages.find((entry) => entry.clientMessageId === clientMessageId && entry.senderId === senderId);
            if (duplicate) return clone(duplicate);
        }
        const recipients = recipientIds(conversation, senderId, mentions);
        const id = makeMessageIdFn();
        if (!validMessageId(id) || conversation.messages.some((entry) => entry.id === id)) throw new Error("message id factory returned an invalid or duplicate id");
        const createdAt = now();
        const delivery = Object.fromEntries(recipients.map((recipientId) => [recipientId, { status: "pending", updatedAt: createdAt }]));
        const message = { id, senderId, text, mentions, artifactIds, ...(replyTo ? { replyTo } : {}), ...(clientMessageId ? { clientMessageId } : {}), ...(voiceEligible === true ? { voiceEligible: true } : {}), delivery, createdAt };
        conversation.messages.push(message);
        if (conversation.messages.length > MAX_MESSAGES_PER_CONVERSATION) conversation.messages.splice(0, conversation.messages.length - MAX_MESSAGES_PER_CONVERSATION);
        conversation.updatedAt = createdAt;
        save();
        return clone(message);
    }

    return {
        schema: CONVERSATIONS_SCHEMA,
        setTeamRouteResolver(resolver) {
            if (resolver !== undefined && typeof resolver !== "function") throw new Error("team route resolver must be a function");
            resolveTeamRoute = resolver;
        },
        setArtifactReferenceValidator(validator) {
            if (validator !== undefined && typeof validator !== "function") throw new Error("artifact reference validator must be a function");
            validateArtifactReferences = validator;
        },
        list() { return { schema: CONVERSATIONS_SCHEMA, conversations: conversations.map(summarize) }; },
        get(id) { const conversation = requireConversation(id); return { ...summarize(conversation), messages: clone(conversation.messages) }; },
        createDirect(coworkerId) {
            const existing = conversations.find((entry) => entry.kind === "direct" && entry.participants.length === 2 && entry.participants.includes(coworkerId));
            return existing ? summarize(existing) : createConversation({ kind: "direct", coworkerIds: [coworkerId] });
        },
        createTeam({ title, coworkerIds, leadCoworkerId, deduplicate = true }) {
            if (deduplicate && leadCoworkerId) {
                const requestedTitle = title === undefined ? undefined : boundedText(title, "title", MAX_TITLE);
                const existing = conversations.find((entry) => entry.kind === "team" && entry.leadCoworkerId === leadCoworkerId && (!requestedTitle || entry.title === requestedTitle));
                if (existing) return summarize(existing);
            }
            return createConversation({ kind: "team", title, coworkerIds, leadCoworkerId });
        },
        postUserMessage(conversationId, payload) { return post(conversationId, payload, { senderId: USER_PARTICIPANT }); },
        postCoworkerMessage(conversationId, coworkerId, payload, options = {}) { requireCoworker(coworkerId); return post(conversationId, payload, { senderId: coworkerId, voiceEligible: options.voiceEligible === true }); },
        markDelivery(conversationId, messageId, coworkerId, status, detail) {
            if (!["pending", "delivered", "failed"].includes(status)) throw new Error("delivery status must be pending, delivered, or failed");
            const conversation = requireConversation(conversationId);
            const message = conversation.messages.find((entry) => entry.id === String(messageId));
            if (!message) throw new Error(`unknown message id: ${messageId}`);
            if (!Object.hasOwn(message.delivery, coworkerId)) throw new Error(`coworker ${coworkerId} is not a recipient of message ${messageId}`);
            message.delivery[coworkerId] = { status, updatedAt: now(), ...(detail ? { detail: boundedText(detail, "detail", 500) } : {}) };
            conversation.updatedAt = message.delivery[coworkerId].updatedAt;
            save();
            return clone(message.delivery[coworkerId]);
        },
        pendingFor(coworkerId, { limit = 50 } = {}) {
            requireCoworker(coworkerId);
            if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("pending delivery limit must be between 1 and 200");
            const pending = [];
            for (const conversation of conversations) {
                for (const message of conversation.messages) {
                    if (message.delivery?.[coworkerId]?.status === "pending") {
                        pending.push({ conversation: summarize(conversation), message: clone(message) });
                        if (pending.length >= limit) return pending;
                    }
                }
            }
            return pending;
        },
    };
}
