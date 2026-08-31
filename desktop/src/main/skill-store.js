import { randomBytes } from "node:crypto";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

export const SKILLS_SCHEMA = "sovereignbot.desktop.skills.v1";
const MAX_SKILLS = 256;
const MAX_NAME = 100;
const MAX_DESCRIPTION = 280;
const MAX_INSTRUCTIONS = 16_000;
const MAX_MESSAGE_SKILLS = 8;
const MAX_INVOCATIONS = 10_000;
const MAX_INPUTS = 16;
const MAX_STEPS = 64;
const MAX_VALIDATORS = 24;
const SKILL_CAPABILITIES = new Set(["computer", "workspace"]);

function plainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function makeId() {
    return `skill_${randomBytes(8).toString("hex")}`;
}

function text(value, label, max, { required = false } = {}) {
    if (value === undefined || value === null) {
        if (required) throw new Error(`${label} is required`);
        return undefined;
    }
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    const trimmed = value.trim();
    if (!trimmed && required) throw new Error(`${label} is required`);
    if (trimmed.length > max) throw new Error(`${label} exceeds ${max} characters`);
    return trimmed || undefined;
}

function validId(value) {
    return typeof value === "string" && /^skill_[a-f0-9]{16}$/i.test(value);
}

function validMessageId(value) {
    return typeof value === "string" && /^msg_[a-f0-9]{16}$/i.test(value);
}

function clone(value) {
    return structuredClone(value);
}

function boundedText(value, label, max, { required = false } = {}) {
    if (value === undefined || value === null) {
        if (required) throw new Error(`${label} is required`);
        return undefined;
    }
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    const trimmed = value.trim();
    if (required && !trimmed) throw new Error(`${label} is required`);
    if (trimmed.length > max) throw new Error(`${label} exceeds ${max} characters`);
    return trimmed || undefined;
}

function normalizeInputs(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_INPUTS) throw new Error(`skill inputs must be an array of at most ${MAX_INPUTS} entries`);
    return value.map((entry, index) => {
        if (!plainObject(entry)) throw new Error(`skill input ${index} must be an object`);
        const allowed = new Set(["name", "type", "description", "required"]);
        for (const key of Object.keys(entry)) if (!allowed.has(key)) throw new Error(`unknown skill input field: ${key}`);
        const name = boundedText(entry.name, `skill input ${index} name`, 80, { required: true });
        if (!/^[A-Za-z][A-Za-z0-9 _-]{0,79}$/.test(name)) throw new Error(`skill input ${index} name is invalid`);
        const type = boundedText(entry.type ?? "string", `skill input ${index} type`, 40, { required: true });
        const description = boundedText(entry.description ?? "", `skill input ${index} description`, 240) ?? "";
        if (typeof entry.required !== "boolean" && entry.required !== undefined) throw new Error(`skill input ${index} required must be boolean`);
        return { name, type, description, required: entry.required !== false };
    });
}

function normalizeStringArray(value, label, max, itemMax) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be an array of at most ${max} entries`);
    return value.map((entry, index) => boundedText(entry, `${label}[${index}]`, itemMax, { required: true }));
}

function normalizeCapabilities(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > SKILL_CAPABILITIES.size) throw new Error("skill requestedCapabilities is invalid");
    const out = [];
    for (const capability of value) {
        if (typeof capability !== "string" || !SKILL_CAPABILITIES.has(capability)) throw new Error("skill requestedCapabilities contains an unsupported capability");
        if (!out.includes(capability)) out.push(capability);
    }
    return out;
}

function normalizeMetadata(input) {
    return {
        inputs: normalizeInputs(input.inputs),
        steps: normalizeStringArray(input.steps, "skill steps", MAX_STEPS, 800),
        expectedOutput: boundedText(input.expectedOutput ?? "", "skill expectedOutput", 1_000) ?? "",
        requestedCapabilities: normalizeCapabilities(input.requestedCapabilities),
        validators: normalizeStringArray(input.validators, "skill validators", MAX_VALIDATORS, 500),
        source: ["manual", "taught"].includes(input.source) ? input.source : "manual",
    };
}

function normalizeCreate(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("skill must be an object");
    const allowed = new Set(["name", "description", "instructions", "inputs", "steps", "expectedOutput", "requestedCapabilities", "validators", "source"]);
    for (const key of Object.keys(input)) {
        if (!allowed.has(key)) throw new Error(`unknown skill field: ${key}`);
    }
    const metadata = normalizeMetadata(input);
    return {
        name: text(input.name, "skill name", MAX_NAME, { required: true }),
        description: text(input.description, "skill description", MAX_DESCRIPTION) ?? "",
        instructions: text(input.instructions, "skill instructions", MAX_INSTRUCTIONS, { required: true }),
        ...metadata,
    };
}

function normalizePatch(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("skill patch must be an object");
    const allowed = new Set(["name", "description", "instructions", "inputs", "steps", "expectedOutput", "requestedCapabilities", "validators", "source", "state"]);
    const patch = {};
    for (const key of Object.keys(input)) {
        if (!allowed.has(key)) throw new Error(`unknown skill field: ${key}`);
    }
    if (Object.hasOwn(input, "name")) patch.name = text(input.name, "skill name", MAX_NAME, { required: true });
    if (Object.hasOwn(input, "description")) patch.description = text(input.description, "skill description", MAX_DESCRIPTION) ?? "";
    if (Object.hasOwn(input, "instructions")) patch.instructions = text(input.instructions, "skill instructions", MAX_INSTRUCTIONS, { required: true });
    if (Object.hasOwn(input, "inputs")) patch.inputs = normalizeInputs(input.inputs);
    if (Object.hasOwn(input, "steps")) patch.steps = normalizeStringArray(input.steps, "skill steps", MAX_STEPS, 800);
    if (Object.hasOwn(input, "expectedOutput")) patch.expectedOutput = boundedText(input.expectedOutput, "skill expectedOutput", 1_000) ?? "";
    if (Object.hasOwn(input, "requestedCapabilities")) patch.requestedCapabilities = normalizeCapabilities(input.requestedCapabilities);
    if (Object.hasOwn(input, "validators")) patch.validators = normalizeStringArray(input.validators, "skill validators", MAX_VALIDATORS, 500);
    if (Object.hasOwn(input, "source")) {
        if (!["manual", "taught"].includes(input.source)) throw new Error("skill source must be manual or taught");
        patch.source = input.source;
    }
    if (Object.hasOwn(input, "state")) {
        if (!new Set(["active", "archived"]).has(input.state)) throw new Error("skill state must be active or archived");
        patch.state = input.state;
    }
    return patch;
}

function sanitize(entry) {
    try {
        if (!entry || typeof entry !== "object" || !validId(entry.id)) return undefined;
        const normalized = normalizeCreate({
            name: entry.name,
            description: entry.description,
            instructions: entry.instructions,
            inputs: entry.inputs,
            steps: entry.steps,
            expectedOutput: entry.expectedOutput,
            requestedCapabilities: entry.requestedCapabilities,
            validators: entry.validators,
            source: entry.source,
        });
        if (!["active", "archived"].includes(entry.state)) return undefined;
        if (typeof entry.createdAt !== "string" || typeof entry.updatedAt !== "string") return undefined;
        return { id: entry.id, ...normalized, state: entry.state, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
    }
    catch {
        return undefined;
    }
}

function sanitizeInvocation(value) {
    try {
        if (!value || typeof value !== "object" || !validMessageId(value.messageId)) return undefined;
        if (!Array.isArray(value.skillIds) || value.skillIds.length > MAX_MESSAGE_SKILLS) return undefined;
        const skillIds = [...new Set(value.skillIds)];
        if (skillIds.some((id) => !validId(id))) return undefined;
        if (typeof value.createdAt !== "string") return undefined;
        return { messageId: value.messageId, skillIds, createdAt: value.createdAt };
    }
    catch {
        return undefined;
    }
}

export function createSkillStore({ persistPath, now = () => new Date().toISOString(), makeSkillId = makeId } = {}) {
    if (!persistPath) throw new Error("skill store requires persistPath");
    const loaded = loadJsonState(persistPath, null);
    const skills = loaded?.schema === SKILLS_SCHEMA && Array.isArray(loaded.skills)
        ? loaded.skills.map(sanitize).filter(Boolean).slice(-MAX_SKILLS)
        : [];
    const invocations = loaded?.schema === SKILLS_SCHEMA && Array.isArray(loaded.invocations)
        ? loaded.invocations.map(sanitizeInvocation).filter(Boolean).slice(-MAX_INVOCATIONS)
        : [];

    function save() {
        saveJsonState(persistPath, { schema: SKILLS_SCHEMA, skills, invocations });
    }

    function requireSkill(id) {
        const skill = skills.find((entry) => entry.id === String(id));
        if (!skill) throw new Error(`unknown skill id: ${id}`);
        return skill;
    }

    function activeSkills(skillIds) {
        const ids = [...new Set(skillIds ?? [])];
        if (ids.length > MAX_MESSAGE_SKILLS) throw new Error(`a message may use at most ${MAX_MESSAGE_SKILLS} skills`);
        return ids.map((id) => {
            if (!validId(id)) throw new Error(`invalid skill id: ${id}`);
            const skill = requireSkill(id);
            if (skill.state !== "active") throw new Error(`skill is archived: ${id}`);
            return skill;
        });
    }

    return {
        schema: SKILLS_SCHEMA,
        list({ includeArchived = false } = {}) {
            return { schema: SKILLS_SCHEMA, skills: skills.filter((entry) => includeArchived || entry.state !== "archived").map(clone) };
        },
        get(id) {
            return clone(requireSkill(id));
        },
        create(input) {
            if (skills.length >= MAX_SKILLS) throw new Error(`skill limit reached (${MAX_SKILLS})`);
            const normalized = normalizeCreate(input);
            const id = makeSkillId();
            if (!validId(id) || skills.some((entry) => entry.id === id)) throw new Error("skill id factory returned an invalid or duplicate id");
            const timestamp = now();
            const skill = { id, ...normalized, state: "active", createdAt: timestamp, updatedAt: timestamp };
            skills.push(skill);
            save();
            return clone(skill);
        },
        update(id, input) {
            const skill = requireSkill(id);
            Object.assign(skill, normalizePatch(input), { updatedAt: now() });
            save();
            return clone(skill);
        },
        archive(id) {
            return this.update(id, { state: "archived" });
        },
        restore(id) {
            return this.update(id, { state: "active" });
        },
        requireActive(id) {
            const skill = requireSkill(id);
            if (skill.state !== "active") throw new Error(`skill is archived: ${id}`);
            return clone(skill);
        },
        bindMessage(messageId, skillIds) {
            if (!validMessageId(messageId)) throw new Error("skill invocation requires a valid messageId");
            const selected = activeSkills(skillIds);
            const existing = invocations.find((entry) => entry.messageId === messageId);
            const invocation = { messageId, skillIds: selected.map((entry) => entry.id), createdAt: existing?.createdAt ?? now() };
            if (existing) Object.assign(existing, invocation);
            else invocations.push(invocation);
            if (invocations.length > MAX_INVOCATIONS) invocations.splice(0, invocations.length - MAX_INVOCATIONS);
            save();
            return clone(invocation);
        },
        skillsForMessage(messageId) {
            const invocation = invocations.find((entry) => entry.messageId === String(messageId));
            if (!invocation) return [];
            return invocation.skillIds.map((id) => skills.find((entry) => entry.id === id)).filter((entry) => entry?.state === "active").map(clone);
        },
        decorateConversation(conversation) {
            const copy = clone(conversation);
            copy.messages = copy.messages.map((message) => {
                const selected = this.skillsForMessage(message.id);
                if (!selected.length) return message;
                const skillBlock = selected.map((skill) => `Skill: ${skill.name}\n${skill.instructions}`).join("\n\n");
                return { ...message, text: `${message.text}\n\n<applied_skills>\n${skillBlock}\n</applied_skills>` };
            });
            return copy;
        },
    };
}
