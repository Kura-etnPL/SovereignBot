const COMMANDS = Object.freeze([
    Object.freeze({ id: "new-coworker", label: "New Coworker", risk: "low" }),
    Object.freeze({ id: "new-team", label: "New Team", risk: "low" }),
    Object.freeze({ id: "new-channel", label: "New Channel", risk: "low" }),
    Object.freeze({ id: "run-routine", label: "Run Routine", risk: "governed" }),
    Object.freeze({ id: "teach-skill", label: "Teach Skill", risk: "governed" }),
    Object.freeze({ id: "open-computer", label: "Open Computer", risk: "governed" }),
    Object.freeze({ id: "search", label: "Search", risk: "read-only" }),
]);
const IDS = new Set(COMMANDS.map((command) => command.id));
function clone(value) { return structuredClone(value); }
function text(value, label, max, required = false) {
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    const trimmed = value.trim();
    if (required && !trimmed) throw new Error(`${label} is required`);
    if (trimmed.length > max) throw new Error(`${label} exceeds ${max} characters`);
    return trimmed;
}
function id(value, label, prefix) { const pattern = prefix ? new RegExp(`^${prefix}_[a-f0-9]{16}$`, "i") : /^[A-Za-z0-9][\w:.-]{0,127}$/; if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} must be a trusted opaque identifier`); return value; }
function exact(value, allowed, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} args must be an object`); for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} args contain unknown field: ${key}`); }

export function createCommandPaletteService({ createCoworker, createTeam, createChannel, runRoutine, teachSkill, openComputer } = {}) {
    const actions = { createCoworker, createTeam, createChannel, runRoutine, teachSkill, openComputer };
    function list() { return { commands: COMMANDS.map(clone) }; }
    async function execute({ commandId, args = {} } = {}) {
        if (!IDS.has(commandId)) throw new Error("unknown command id");
        switch (commandId) {
            case "search": exact(args, new Set(), commandId); return { action: "search" };
            case "new-coworker": exact(args, new Set(["name", "role", "instructions"]), commandId); return actions.createCoworker({ name: text(args.name, "name", 80, true), role: text(args.role, "role", 120, true), instructions: args.instructions === undefined ? "" : text(args.instructions, "instructions", 12_000) });
            case "new-team": exact(args, new Set(["title", "coworkerIds", "leadCoworkerId"]), commandId); if (!Array.isArray(args.coworkerIds) || args.coworkerIds.length < 2 || args.coworkerIds.length > 7) throw new Error("coworkerIds must contain 2-7 trusted IDs"); return actions.createTeam({ title: text(args.title, "title", 120, true), coworkerIds: [...new Set(args.coworkerIds.map((value) => id(value, "coworkerId", "coworker")))], ...(args.leadCoworkerId ? { leadCoworkerId: id(args.leadCoworkerId, "leadCoworkerId", "coworker") } : {}) });
            case "new-channel": exact(args, new Set(["teamId", "name"]), commandId); return actions.createChannel({ teamId: id(args.teamId, "teamId", "team"), name: text(args.name, "name", 120, true) });
            case "run-routine": exact(args, new Set(["routineId"]), commandId); return actions.runRoutine(id(args.routineId, "routineId", "routine"));
            case "teach-skill": exact(args, new Set(["coworkerId", "name", "description"]), commandId); return actions.teachSkill({ coworkerId: id(args.coworkerId, "coworkerId", "coworker"), name: text(args.name, "name", 100, true), description: args.description === undefined ? "" : text(args.description, "description", 280) });
            case "open-computer": exact(args, new Set(["coworkerId"]), commandId); return actions.openComputer({ coworkerId: id(args.coworkerId, "coworkerId", "coworker") });
            default: throw new Error("command is not implemented");
        }
    }
    return { list, execute };
}

export { COMMANDS };
