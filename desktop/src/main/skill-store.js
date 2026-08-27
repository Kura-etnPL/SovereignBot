import { randomBytes } from "node:crypto";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

export const SKILLS_SCHEMA = "sovereignbot.desktop.skills.v1";
const MAX_SKILLS = 256;
const MAX_NAME = 100;
const MAX_DESCRIPTION = 280;
const MAX_INSTRUCTIONS = 16_000;

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

function clone(value) {
    return structuredClone(value);
}

function normalizeCreate(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("skill must be an object");
    const allowed = new Set(["name", "description", "instructions"]);
    for (const key of Object.keys(input)) {
        if (!allowed.has(key)) throw new Error(`unknown skill field: ${key}`);
    }
    return {
        name: text(input.name, "skill name", MAX_NAME, { required: true }),
        description: text(input.description, "skill description", MAX_DESCRIPTION) ?? "",
        instructions: text(input.instructions, "skill instructions", MAX_INSTRUCTIONS, { required: true }),
    };
}

function normalizePatch(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("skill patch must be an object");
    const allowed = new Set(["name", "description", "instructions", "state"]);
    const patch = {};
    for (const key of Object.keys(input)) {
        if (!allowed.has(key)) throw new Error(`unknown skill field: ${key}`);
    }
    if (Object.hasOwn(input, "name")) patch.name = text(input.name, "skill name", MAX_NAME, { required: true });
    if (Object.hasOwn(input, "description")) patch.description = text(input.description, "skill description", MAX_DESCRIPTION) ?? "";
    if (Object.hasOwn(input, "instructions")) patch.instructions = text(input.instructions, "skill instructions", MAX_INSTRUCTIONS, { required: true });
    if (Object.hasOwn(input, "state")) {
        if (!new Set(["active", "archived"]).has(input.state)) throw new Error("skill state must be active or archived");
        patch.state = input.state;
    }
    return patch;
}

function sanitize(entry) {
    try {
        if (!entry || typeof entry !== "object" || !validId(entry.id)) return undefined;
        const normalized = normalizeCreate({ name: entry.name, description: entry.description, instructions: entry.instructions });
        if (!["active", "archived"].includes(entry.state)) return undefined;
        if (typeof entry.createdAt !== "string" || typeof entry.updatedAt !== "string") return undefined;
        return { id: entry.id, ...normalized, state: entry.state, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
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

    function save() {
        saveJsonState(persistPath, { schema: SKILLS_SCHEMA, skills });
    }

    function requireSkill(id) {
        const skill = skills.find((entry) => entry.id === String(id));
        if (!skill) throw new Error(`unknown skill id: ${id}`);
        return skill;
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
    };
}
