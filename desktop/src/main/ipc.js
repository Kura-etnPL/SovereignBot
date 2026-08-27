import { ipcMain } from "electron";
import { IPC_CHANNELS, validateIpcRequest } from "./lib/ipc-schema.js";
import { V3_IPC_CHANNELS, validateV3IpcRequest } from "./lib/v3-ipc-schema.js";

const LIVE_FRAME_CHANNEL = "computer:frame";
const ATTACH_CHANNEL = "artifact:attachViaDialog";
const SKILL_CHANNELS = Object.freeze({
    "skill:list": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "skill:get": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "skill:create": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 20_000 }),
    "skill:update": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 20_000 }),
    "skill:archive": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "skill:restore": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
});
const ALL_IPC_CHANNELS = Object.freeze({
    ...IPC_CHANNELS,
    ...V3_IPC_CHANNELS,
    [LIVE_FRAME_CHANNEL]: Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    [ATTACH_CHANNEL]: Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    ...SKILL_CHANNELS,
});

function assertObject(payload, label) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Error(`${label} payload must be an object`);
}

function exactKeys(payload, allowed, label) {
    assertObject(payload, label);
    for (const key of Object.keys(payload)) {
        if (!allowed.has(key)) throw new Error(`${label} payload contains unknown field: ${key}`);
    }
}

function conversationId(value) {
    if (typeof value !== "string" || !/^conv_[A-Za-z0-9][\w:-]{0,127}$/.test(value))
        throw new Error("conversationId must be a conversation identifier");
    return value;
}

function skillId(value) {
    if (typeof value !== "string" || !/^skill_[a-f0-9]{16}$/i.test(value))
        throw new Error("skillId must be a skill identifier");
    return value;
}

function skillIds(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 8) throw new Error("skillIds must be an array of at most 8 skills");
    return [...new Set(value.map(skillId))];
}

function boundedString(value, label, max, required = false) {
    if (value === undefined || value === null) {
        if (required) throw new Error(`${label} is required`);
        return undefined;
    }
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    const trimmed = value.trim();
    if (required && !trimmed) throw new Error(`${label} is required`);
    if (trimmed.length > max) throw new Error(`${label} exceeds ${max} characters`);
    return trimmed;
}

function validateSkillDocument(value, { patch = false } = {}) {
    exactKeys(value, patch ? new Set(["name", "description", "instructions", "state"]) : new Set(["name", "description", "instructions"]), "skill");
    const out = {};
    if (!patch || Object.hasOwn(value, "name")) out.name = boundedString(value.name, "skill name", 100, !patch);
    if (!patch || Object.hasOwn(value, "description")) out.description = boundedString(value.description ?? "", "skill description", 280) ?? "";
    if (!patch || Object.hasOwn(value, "instructions")) out.instructions = boundedString(value.instructions, "skill instructions", 16_000, !patch);
    if (patch && Object.hasOwn(value, "state")) {
        if (!["active", "archived"].includes(value.state)) throw new Error("skill state must be active or archived");
        out.state = value.state;
    }
    return out;
}

function validateSkillRequest(channel, payload) {
    const bytes = Buffer.byteLength(JSON.stringify(payload ?? {}));
    if (bytes > SKILL_CHANNELS[channel].maxPayloadBytes) throw new Error(`${channel} payload is too large`);
    switch (channel) {
        case "skill:list": {
            exactKeys(payload, new Set(["includeArchived"]), channel);
            return { includeArchived: payload.includeArchived === true };
        }
        case "skill:get":
        case "skill:archive":
        case "skill:restore":
            exactKeys(payload, new Set(["skillId"]), channel);
            return { skillId: skillId(payload.skillId) };
        case "skill:create":
            exactKeys(payload, new Set(["skill"]), channel);
            return { skill: validateSkillDocument(payload.skill) };
        case "skill:update":
            exactKeys(payload, new Set(["skillId", "patch"]), channel);
            return { skillId: skillId(payload.skillId), patch: validateSkillDocument(payload.patch, { patch: true }) };
        default:
            throw new Error(`unknown skill IPC channel: ${channel}`);
    }
}

function validateLiveFrame(payload) {
    exactKeys(payload, new Set(["agentId"]), LIVE_FRAME_CHANNEL);
    if (typeof payload.agentId !== "string" || !/^[A-Za-z0-9][\w:.-]{0,127}$/.test(payload.agentId))
        throw new Error("agentId must be an identifier");
    return { agentId: payload.agentId };
}

function validateConversationSend(payload) {
    assertObject(payload, "conversation:send");
    const selected = skillIds(payload.skillIds);
    const { skillIds: _ignored, ...basePayload } = payload;
    const base = validateV3IpcRequest("conversation:send", basePayload);
    return { ...base, ...(selected.length ? { skillIds: selected } : {}) };
}

function validateRequest(channel, payload) {
    if (channel === LIVE_FRAME_CHANNEL)
        return validateLiveFrame(payload);
    if (channel === ATTACH_CHANNEL) {
        exactKeys(payload, new Set(["conversationId"]), channel);
        return { conversationId: conversationId(payload.conversationId) };
    }
    if (SKILL_CHANNELS[channel])
        return validateSkillRequest(channel, payload);
    if (channel === "conversation:send")
        return validateConversationSend(payload);
    return V3_IPC_CHANNELS[channel]
        ? validateV3IpcRequest(channel, payload)
        : validateIpcRequest(channel, payload);
}

export function bindIpcChannels({ win, handlers }) {
    const bound = [];
    for (const channel of Object.keys(ALL_IPC_CHANNELS)) {
        const businessHandler = handlers[channel];
        if (!businessHandler)
            continue;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, payload) => {
            if (win.isDestroyed() || event.sender !== win.webContents || event.sender.isDestroyed())
                throw new Error("ipc sender is not the main window");
            const request = validateRequest(channel, payload);
            return businessHandler(request);
        });
        bound.push(channel);
    }
    return function unbindAll() {
        for (const channel of bound)
            ipcMain.removeHandler(channel);
    };
}

export function channelNames() {
    return Object.keys(ALL_IPC_CHANNELS);
}
