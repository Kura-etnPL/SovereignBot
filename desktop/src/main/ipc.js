import { ipcMain } from "electron";
import { IPC_CHANNELS, validateIpcRequest } from "./lib/ipc-schema.js";
import { V3_IPC_CHANNELS, validateV3IpcRequest } from "./lib/v3-ipc-schema.js";
import { normalizeEventRelativePath } from "./lib/event-metadata.js";
import { validateComputerActionList } from "../../vendor/core/src/worker-computer-protocol.js";

const LIVE_FRAME_CHANNEL = "computer:frame";
const ATTACH_CHANNEL = "artifact:attachViaDialog";
const SKILL_CHANNELS = Object.freeze({
    "skill:list": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "skill:get": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "skill:create": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 20_000 }),
    "skill:update": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 20_000 }),
    "skill:archive": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "skill:restore": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "skill:assign": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 2048 }),
    "skill:export": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "skill:import": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 24_000 }),
    "skill:duplicate": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "skill:retest": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
});
const TEACH_CHANNELS = Object.freeze({
    "teach:list": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "teach:start": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 4096 }),
    "teach:get": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "teach:snapshot": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "teach:recordAction": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 16_000 }),
    "teach:finish": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "teach:test": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "teach:confirm": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "teach:save": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "teach:cancel": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
});
const CONVERSATION_CONTROL_CHANNELS = Object.freeze({
    "conversation:stop": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "conversation:redirect": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 32_000 }),
});
const TEAM_ACTIVITY_CHANNELS = Object.freeze({
    "team:activity": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 2048 }),
});
const ROUTINE_CHANNELS = Object.freeze({
    "routine:create": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 16_000 }),
    "routine:list": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "routine:get": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "routine:history": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "routine:runNow": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "routine:archive": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "routine:restore": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "routine:retry": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "routine:setEnabled": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "routine:remove": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
});
const EVENT_TRIGGER_CHANNELS = Object.freeze({
    "eventTrigger:create": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 4096 }),
    "eventTrigger:list": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "eventTrigger:get": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "eventTrigger:setEnabled": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "eventTrigger:remove": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
});
const WORKER_NODE_CHANNELS = Object.freeze({
    "workerNode:pairViaDialog": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "workerNode:list": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "workerNode:get": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "workerNode:refresh": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "workerNode:setEnabled": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "workerNode:remove": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "workerNode:trustBegin": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 2048 }),
    "workerNode:trustComplete": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 16384 }),
    "workerNode:trustCompleteViaDialog": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "workerNode:trustRevoke": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    "workerNode:trustRotate": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
});
const COMPUTER_TARGET_CHANNELS = Object.freeze({
    "computerTarget:list": Object.freeze({ direction: "renderer->main", maxPayloadBytes: 2048 }),
});
const ALL_IPC_CHANNELS = Object.freeze({
    ...IPC_CHANNELS,
    ...V3_IPC_CHANNELS,
    [LIVE_FRAME_CHANNEL]: Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    [ATTACH_CHANNEL]: Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
    ...SKILL_CHANNELS,
    ...TEACH_CHANNELS,
    ...CONVERSATION_CONTROL_CHANNELS,
    ...TEAM_ACTIVITY_CHANNELS,
    ...ROUTINE_CHANNELS,
    ...EVENT_TRIGGER_CHANNELS,
    ...WORKER_NODE_CHANNELS,
    ...COMPUTER_TARGET_CHANNELS,
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

function teachSessionId(value) {
    if (typeof value !== "string" || !/^teach_[a-f0-9]{16}$/i.test(value))
        throw new Error("sessionId must be a teach session identifier");
    return value;
}

function routineId(value) {
    if (typeof value !== "string" || !/^routine_[a-f0-9]{16}$/i.test(value))
        throw new Error("routineId must be a routine identifier");
    return value;
}

function eventTriggerId(value) {
    if (typeof value !== "string" || !/^trigger_[a-f0-9]{16}$/i.test(value))
        throw new Error("triggerId must be an event trigger identifier");
    return value;
}

function generalId(value, label) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][\w:.-]{0,159}$/.test(value))
        throw new Error(`${label} must be an identifier`);
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

function participantIds(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 8) throw new Error("mentions must be an array of at most 8 identifiers");
    const out = [];
    for (const item of value) {
        if (item !== "everyone") generalId(item, "mention");
        if (!out.includes(item)) out.push(item);
    }
    return out;
}

function validateTeamActivityRequest(payload) {
    exactKeys(payload, new Set(["teamId", "conversationId", "limit"]), "team:activity");
    if (payload.teamId === undefined && payload.conversationId === undefined)
        throw new Error("team:activity requires teamId or conversationId");
    const out = {};
    if (payload.teamId !== undefined) out.teamId = generalId(payload.teamId, "teamId");
    if (payload.conversationId !== undefined) out.conversationId = conversationId(payload.conversationId);
    if (payload.limit !== undefined) {
        if (!Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 100) throw new Error("limit must be an integer between 1 and 100");
        out.limit = payload.limit;
    }
    return out;
}

function integerField(min, max) {
    return (value, label) => {
        if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
        return value;
    };
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
        case "skill:export":
        case "skill:duplicate":
        case "skill:retest":
            exactKeys(payload, new Set(["skillId"]), channel);
            return { skillId: skillId(payload.skillId) };
        case "skill:assign":
            exactKeys(payload, new Set(["skillId", "targetKind", "targetId", "enabled"]), channel);
            if (!["coworker", "team"].includes(payload.targetKind)) throw new Error("skill assignment targetKind is invalid");
            if (typeof payload.enabled !== "boolean") throw new Error("skill assignment enabled must be boolean");
            return { skillId: skillId(payload.skillId), targetKind: payload.targetKind, targetId: generalId(payload.targetId, "targetId"), enabled: payload.enabled };
        case "skill:create":
            exactKeys(payload, new Set(["skill"]), channel);
            return { skill: validateSkillDocument(payload.skill) };
        case "skill:update":
            exactKeys(payload, new Set(["skillId", "patch"]), channel);
            return { skillId: skillId(payload.skillId), patch: validateSkillDocument(payload.patch, { patch: true }) };
        case "skill:import": {
            exactKeys(payload, new Set(["skill"]), channel);
            const value = payload.skill;
            exactKeys(value, new Set(["schema", "name", "description", "instructions", "inputs", "steps", "expectedOutput", "requestedCapabilities", "validators", "source"]), "skill import");
            if (value.schema !== "sovereignbot.desktop.skill.v1") throw new Error("skill import schema is invalid");
            return { skill: structuredClone(value) };
        }
        default:
            throw new Error(`unknown skill IPC channel: ${channel}`);
    }
}

function validateTeachAction(value) {
    exactKeys(value, new Set([
        "kind", "url", "ref", "snapshotId", "target", "app", "inputName", "text", "sensitive",
        "key", "direction", "amount", "milliseconds", "validator", "expectedOutput",
    ]), "teach action");
    const kind = boundedString(value.kind, "action kind", 32, true);
    if (!["navigate", "click", "type", "key", "scroll", "wait", "assert"].includes(kind)) throw new Error("action kind is not supported");
    const out = { kind };
    if (value.url !== undefined) out.url = boundedString(value.url, "navigate url", 2_000, true);
    if (value.ref !== undefined) out.ref = boundedString(value.ref, "element ref", 160, true);
    if (value.snapshotId !== undefined) out.snapshotId = boundedString(value.snapshotId, "snapshotId", 160, true);
    if (value.target !== undefined) out.target = boundedString(value.target, "action target", 240, true);
    if (value.app !== undefined) out.app = boundedString(value.app, "action app", 120);
    if (value.inputName !== undefined) out.inputName = boundedString(value.inputName, "inputName", 80, true);
    if (value.text !== undefined) out.text = boundedString(value.text, "demo input", 4_000, true);
    if (value.sensitive !== undefined) {
        if (typeof value.sensitive !== "boolean") throw new Error("sensitive must be boolean");
        out.sensitive = value.sensitive;
    }
    if (value.key !== undefined) out.key = boundedString(value.key, "key", 32, true);
    if (value.direction !== undefined) {
        if (!["up", "down"].includes(value.direction)) throw new Error("scroll direction must be up or down");
        out.direction = value.direction;
    }
    if (value.amount !== undefined) out.amount = integerField(1, 10)(value.amount, "amount");
    if (value.milliseconds !== undefined) out.milliseconds = integerField(0, 10_000)(value.milliseconds, "milliseconds");
    if (value.validator !== undefined) {
        if (!["exists", "contains", "equals", "manual"].includes(value.validator)) throw new Error("validator is invalid");
        out.validator = value.validator;
    }
    if (value.expectedOutput !== undefined) out.expectedOutput = boundedString(value.expectedOutput, "expectedOutput", 500);
    return out;
}

function validateTeachRequest(channel, payload) {
    const bytes = Buffer.byteLength(JSON.stringify(payload ?? {}));
    if (bytes > TEACH_CHANNELS[channel].maxPayloadBytes) throw new Error(`${channel} payload is too large`);
    if (channel === "teach:list") {
        exactKeys(payload, new Set(), channel);
        return {};
    }
    if (["teach:get", "teach:snapshot", "teach:finish", "teach:test", "teach:confirm", "teach:save", "teach:cancel"].includes(channel)) {
        exactKeys(payload, new Set(["sessionId"]), channel);
        return { sessionId: teachSessionId(payload.sessionId) };
    }
    if (channel === "teach:start") {
        exactKeys(payload, new Set(["coworkerId", "name", "description"]), channel);
        return {
            coworkerId: generalId(payload.coworkerId, "coworkerId"),
            name: boundedString(payload.name, "teach name", 100, true),
            description: boundedString(payload.description ?? "", "teach description", 280) ?? "",
        };
    }
    if (channel === "teach:recordAction") {
        exactKeys(payload, new Set(["sessionId", "action"]), channel);
        return { sessionId: teachSessionId(payload.sessionId), action: validateTeachAction(payload.action) };
    }
    throw new Error(`unknown teach IPC channel: ${channel}`);
}

function validateConversationControlRequest(channel, payload) {
    const bytes = Buffer.byteLength(JSON.stringify(payload ?? {}));
    if (bytes > CONVERSATION_CONTROL_CHANNELS[channel].maxPayloadBytes) throw new Error(`${channel} payload is too large`);
    if (channel === "conversation:stop") {
        exactKeys(payload, new Set(["conversationId"]), channel);
        return { conversationId: conversationId(payload.conversationId) };
    }
    exactKeys(payload, new Set(["conversationId", "text", "mentions", "replyTo", "clientMessageId"]), channel);
    const out = { conversationId: conversationId(payload.conversationId), text: boundedString(payload.text, "text", 12_000, true) };
    if (payload.mentions !== undefined) out.mentions = participantIds(payload.mentions);
    if (payload.replyTo !== undefined) out.replyTo = generalId(payload.replyTo, "replyTo");
    if (payload.clientMessageId !== undefined) out.clientMessageId = boundedString(payload.clientMessageId, "clientMessageId", 128);
    return out;
}

function validateRoutineSchedule(value) {
    exactKeys(value, new Set(["type", "at", "minute", "time", "weekday", "intervalMinutes"]), "routine schedule");
    if (!["one-time", "hourly", "daily", "weekly", "custom"].includes(value.type)) throw new Error("invalid routine schedule type");
    if (value.type === "one-time") {
        if (Object.keys(value).some((key) => !["type", "at"].includes(key))) throw new Error("one-time schedule accepts only type and at");
        const at = boundedString(value.at, "schedule.at", 64, true);
        if (Number.isNaN(Date.parse(at))) throw new Error("schedule.at must be a valid date");
        return { type: "one-time", at };
    }
    if (value.type === "hourly") {
        if (Object.keys(value).some((key) => !["type", "minute"].includes(key))) throw new Error("hourly schedule accepts only type and minute");
        if (!Number.isInteger(value.minute) || value.minute < 0 || value.minute > 59) throw new Error("schedule.minute must be 0-59");
        return { type: "hourly", minute: value.minute };
    }
    if (value.type === "custom") {
        if (Object.keys(value).some((key) => !["type", "intervalMinutes"].includes(key))) throw new Error("custom schedule accepts only type and intervalMinutes");
        if (!Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 1 || value.intervalMinutes > 10080) throw new Error("schedule.intervalMinutes must be 1-10080");
        return { type: "custom", intervalMinutes: value.intervalMinutes };
    }
    const time = boundedString(value.time, "schedule.time", 5, true);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("schedule.time must be HH:MM");
    if (value.type === "daily") {
        if (Object.keys(value).some((key) => !["type", "time"].includes(key))) throw new Error("daily schedule accepts only type and time");
        return { type: "daily", time };
    }
    if (Object.keys(value).some((key) => !["type", "weekday", "time"].includes(key))) throw new Error("weekly schedule accepts only type, weekday, and time");
    if (!Number.isInteger(value.weekday) || value.weekday < 0 || value.weekday > 6) throw new Error("schedule.weekday must be 0-6");
    return { type: "weekly", weekday: value.weekday, time };
}

function validateRoutineRequest(channel, payload) {
    // Compatibility marker for the retired Worker Node selector; Worker Computer
    // is a separate governed target and is intentionally allowed below.
    // exactKeys(payload, new Set(["name", "coworkerId", "teamId", "projectId", "instruction", "skillId", "workspaceId", "schedule"])
    const bytes = Buffer.byteLength(JSON.stringify(payload ?? {}));
    if (bytes > ROUTINE_CHANNELS[channel].maxPayloadBytes) throw new Error(`${channel} payload is too large`);
    if (channel === "routine:list") {
        exactKeys(payload, new Set(["includeArchived"]), channel);
        if (payload.includeArchived !== undefined && typeof payload.includeArchived !== "boolean") throw new Error("includeArchived must be boolean");
        return payload.includeArchived === undefined ? {} : { includeArchived: payload.includeArchived };
    }
    if (["routine:get", "routine:history", "routine:runNow", "routine:archive", "routine:restore", "routine:remove"].includes(channel)) {
        exactKeys(payload, new Set(["routineId"]), channel);
        return { routineId: routineId(payload.routineId) };
    }
    if (channel === "routine:retry") {
        exactKeys(payload, new Set(["routineId", "runId"]), channel);
        const out = { routineId: routineId(payload.routineId) };
        if (payload.runId !== undefined) out.runId = boundedString(payload.runId, "runId", 80, true);
        return out;
    }
    if (channel === "routine:setEnabled") {
        exactKeys(payload, new Set(["routineId", "enabled"]), channel);
        if (typeof payload.enabled !== "boolean") throw new Error("enabled must be boolean");
        return { routineId: routineId(payload.routineId), enabled: payload.enabled };
    }
    if (channel === "routine:create") {
        exactKeys(payload, new Set(["name", "coworkerId", "teamId", "projectId", "instruction", "skillId", "workspaceId", "schedule", "computerTarget", "computerActions"]), channel);
        const out = {
            name: boundedString(payload.name, "routine name", 120, true),
            coworkerId: generalId(payload.coworkerId, "coworkerId"),
            instruction: boundedString(payload.instruction, "routine instruction", 8000, true),
            schedule: validateRoutineSchedule(payload.schedule),
        };
        if (payload.teamId !== undefined && payload.teamId !== "") out.teamId = generalId(payload.teamId, "teamId");
        if (payload.projectId !== undefined && payload.projectId !== "") out.projectId = generalId(payload.projectId, "projectId");
        if (payload.skillId !== undefined && payload.skillId !== "") out.skillId = skillId(payload.skillId);
        if (payload.workspaceId !== undefined && payload.workspaceId !== "") out.workspaceId = generalId(payload.workspaceId, "workspaceId");
        if (payload.computerTarget !== undefined) out.computerTarget = validateComputerTarget(payload.computerTarget);
        if (payload.computerActions !== undefined) out.computerActions = validateComputerActionList(payload.computerActions);
        return out;
    }
    throw new Error(`unknown routine IPC channel: ${channel}`);
}

function validateComputerTarget(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("computer target must be an object");
    const identifier = (entry, key) => {
        if (typeof entry !== "string" || !/^[A-Za-z0-9][\w:.-]{0,159}$/.test(entry)) throw new Error(`computer target ${key} is invalid`);
        return entry;
    };
    if (["worker-computer", "vm"].includes(value.kind)) {
        exactKeys(value, new Set(["kind", "nodeId", "workspaceId", "computerId"]), "computer target");
        if (typeof value.nodeId !== "string" || !/^worker_[0-9a-f]{16}$/i.test(value.nodeId)) throw new Error("computer target nodeId is invalid");
        return { kind: value.kind, nodeId: value.nodeId, workspaceId: identifier(value.workspaceId, "workspaceId"), computerId: identifier(value.computerId, "computerId") };
    }
    if (["local-isolated", "cloud"].includes(value.kind)) {
        exactKeys(value, value.kind === "cloud" ? new Set(["kind", "profileId", "workspaceId", "optIn"]) : new Set(["kind", "profileId", "workspaceId"]), "computer target");
        if (value.kind === "cloud" && typeof value.optIn !== "boolean") throw new Error("computer target optIn is invalid");
        return { kind: value.kind, profileId: identifier(value.profileId, "profileId"), workspaceId: identifier(value.workspaceId, "workspaceId"), ...(value.kind === "cloud" ? { optIn: value.optIn } : {}) };
    }
    if (value.kind === "this-pc") {
        exactKeys(value, new Set(["kind", "workspaceId"]), "computer target");
        return { kind: value.kind, workspaceId: identifier(value.workspaceId, "workspaceId") };
    }
    throw new Error("computer target kind is unsupported");
}

function validateEventPathPrefix(value) {
    const clean = boundedString(value ?? "", "pathPrefix", 512) ?? "";
    if (!clean) return "";
    return normalizeEventRelativePath(clean, "pathPrefix");
}

function validateEventTriggerRequest(channel, payload) {
    const bytes = Buffer.byteLength(JSON.stringify(payload ?? {}));
    if (bytes > EVENT_TRIGGER_CHANNELS[channel].maxPayloadBytes) throw new Error(`${channel} payload is too large`);
    if (channel === "eventTrigger:list") {
        exactKeys(payload, new Set(), channel);
        return {};
    }
    if (["eventTrigger:get", "eventTrigger:remove"].includes(channel)) {
        exactKeys(payload, new Set(["triggerId"]), channel);
        return { triggerId: eventTriggerId(payload.triggerId) };
    }
    if (channel === "eventTrigger:setEnabled") {
        exactKeys(payload, new Set(["triggerId", "enabled"]), channel);
        if (typeof payload.enabled !== "boolean") throw new Error("enabled must be boolean");
        return { triggerId: eventTriggerId(payload.triggerId), enabled: payload.enabled };
    }
    if (channel === "eventTrigger:create") {
        exactKeys(payload, new Set(["name", "routineId", "workspaceId", "pathPrefix"]), channel);
        return {
            name: boundedString(payload.name, "trigger name", 120, true),
            routineId: routineId(payload.routineId),
            workspaceId: generalId(payload.workspaceId, "workspaceId"),
            pathPrefix: validateEventPathPrefix(payload.pathPrefix),
        };
    }
    throw new Error(`unknown event trigger IPC channel: ${channel}`);
}

function validateWorkerNodeRequest(channel, payload) {
    const bytes = Buffer.byteLength(JSON.stringify(payload ?? {}));
    if (bytes > WORKER_NODE_CHANNELS[channel].maxPayloadBytes) throw new Error(`${channel} payload is too large`);
    if (["workerNode:pairViaDialog", "workerNode:list"].includes(channel)) {
        exactKeys(payload, new Set(), channel);
        return {};
    }
    if (["workerNode:get", "workerNode:remove"].includes(channel)) {
        exactKeys(payload, new Set(["nodeId"]), channel);
        if (typeof payload.nodeId !== "string" || !/^worker_[0-9a-f]{16}$/i.test(payload.nodeId)) throw new Error("nodeId must be a Worker Node identifier");
        return { nodeId: payload.nodeId };
    }
    if (channel === "workerNode:refresh") {
        exactKeys(payload, new Set(["nodeId"]), channel);
        if (payload.nodeId === undefined) return {};
        if (typeof payload.nodeId !== "string" || !/^worker_[0-9a-f]{16}$/i.test(payload.nodeId)) throw new Error("nodeId must be a Worker Node identifier");
        return { nodeId: payload.nodeId };
    }
    if (["workerNode:trustRevoke", "workerNode:trustRotate", "workerNode:trustCompleteViaDialog"].includes(channel)) {
        exactKeys(payload, new Set(["nodeId"]), channel);
        if (typeof payload.nodeId !== "string" || !/^worker_[0-9a-f]{16}$/i.test(payload.nodeId)) throw new Error("nodeId must be a Worker Node identifier");
        return { nodeId: payload.nodeId };
    }
    if (channel === "workerNode:trustBegin") {
        exactKeys(payload, new Set(["nodeId", "transport", "ttlMs"]), channel);
        if (typeof payload.nodeId !== "string" || !/^worker_[0-9a-f]{16}$/i.test(payload.nodeId)) throw new Error("nodeId must be a Worker Node identifier");
        if (!['lan', 'remote-relay'].includes(payload.transport)) throw new Error("transport must be lan or remote-relay");
        if (payload.ttlMs !== undefined && (!Number.isInteger(payload.ttlMs) || payload.ttlMs < 1000 || payload.ttlMs > 600000)) throw new Error("ttlMs is invalid");
        return { nodeId: payload.nodeId, transport: payload.transport, ...(payload.ttlMs === undefined ? {} : { ttlMs: payload.ttlMs }) };
    }
    if (channel === "workerNode:trustComplete") {
        exactKeys(payload, new Set(["nodeId", "offer", "response"]), channel);
        if (typeof payload.nodeId !== "string" || !/^worker_[0-9a-f]{16}$/i.test(payload.nodeId)) throw new Error("nodeId must be a Worker Node identifier");
        if (!payload.offer || typeof payload.offer !== "object" || Array.isArray(payload.offer) || !payload.response || typeof payload.response !== "object" || Array.isArray(payload.response)) throw new Error("pairing offer and response are required");
        return { nodeId: payload.nodeId, offer: structuredClone(payload.offer), response: structuredClone(payload.response) };
    }
    exactKeys(payload, new Set(["nodeId", "enabled"]), channel);
    if (typeof payload.nodeId !== "string" || !/^worker_[0-9a-f]{16}$/i.test(payload.nodeId)) throw new Error("nodeId must be a Worker Node identifier");
    if (typeof payload.enabled !== "boolean") throw new Error("enabled must be boolean");
    return { nodeId: payload.nodeId, enabled: payload.enabled };
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
    if (TEAM_ACTIVITY_CHANNELS[channel])
        return validateTeamActivityRequest(payload);
    if (channel === ATTACH_CHANNEL) {
        exactKeys(payload, new Set(["conversationId"]), channel);
        return { conversationId: conversationId(payload.conversationId) };
    }
    if (SKILL_CHANNELS[channel])
        return validateSkillRequest(channel, payload);
    if (TEACH_CHANNELS[channel])
        return validateTeachRequest(channel, payload);
    if (CONVERSATION_CONTROL_CHANNELS[channel])
        return validateConversationControlRequest(channel, payload);
    if (ROUTINE_CHANNELS[channel])
        return validateRoutineRequest(channel, payload);
    if (EVENT_TRIGGER_CHANNELS[channel])
        return validateEventTriggerRequest(channel, payload);
    if (WORKER_NODE_CHANNELS[channel])
        return validateWorkerNodeRequest(channel, payload);
    if (COMPUTER_TARGET_CHANNELS[channel]) {
        exactKeys(payload, new Set(), channel);
        return {};
    }
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
