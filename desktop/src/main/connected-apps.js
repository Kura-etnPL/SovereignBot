import { join } from "node:path";
import { GOVERNED_MCP_TOOLS } from "../../vendor/core/src/governed-tool-bridge.js";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

export const CONNECTED_APPS_SCHEMA = "sovereignbot.desktop.connected-apps.v1";

const TEAM_ID = /^team_[a-f0-9]{16}$/i;
const COWORKER_ID = /^coworker_[a-f0-9]{16}$/i;
const MAX_ASSIGNMENTS = 128;

const COMPUTER_TOOLS = new Set([
    "snapshot", "navigate", "click", "type", "key", "scroll", "request_help", "request_secret",
]);
const WORKSPACE_TOOLS = new Set(["list_files", "read_file", "write_file"]);

const APP_CATALOG = Object.freeze([
    Object.freeze({
        id: "sovereignbot-computer",
        name: "This PC / 此电脑",
        service: "SovereignBot governed computer",
        description: "Use the existing governed browser/computer lane with human takeover when needed.",
        capabilities: Object.freeze(["View a live screen", "Navigate and interact", "Request human help"]),
        requiredTools: Object.freeze([...COMPUTER_TOOLS]),
    }),
    Object.freeze({
        id: "sovereignbot-workspace",
        name: "Project workspace / 项目工作区",
        service: "SovereignBot governed workspace",
        description: "Read and write within the trusted shared or private workspace selected by the Governor.",
        capabilities: Object.freeze(["List files", "Read files", "Write files"]),
        requiredTools: Object.freeze([...WORKSPACE_TOOLS]),
    }),
]);

function validTarget(value, pattern, label) {
    if (typeof value !== "string" || !pattern.test(value))
        throw new Error(`${label} must be a valid opaque identifier`);
    return value;
}

function boundedIds(value, pattern, label) {
    if (!Array.isArray(value) || value.length > MAX_ASSIGNMENTS)
        return [];
    return [...new Set(value.filter((entry) => typeof entry === "string" && pattern.test(entry)))];
}

function assignmentState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    const assignments = {};
    for (const app of APP_CATALOG) {
        const entry = value[app.id];
        assignments[app.id] = {
            teams: boundedIds(entry?.teams, TEAM_ID, "teamIds"),
            coworkers: boundedIds(entry?.coworkers, COWORKER_ID, "coworkerIds"),
        };
    }
    return assignments;
}

function toolAvailability(requiredTools) {
    const available = new Set(GOVERNED_MCP_TOOLS);
    return requiredTools.every((tool) => available.has(tool));
}

export function createConnectedAppsService({ dataDir, persistPath = join(dataDir, "desktop-state", "connected-apps.json"), teamService, coworkerStore } = {}) {
    if (!dataDir || !teamService?.list || !coworkerStore?.list)
        throw new Error("connected apps service requires dataDir, teamService and coworkerStore");

    const loaded = loadJsonState(persistPath, null);
    const state = {
        schema: CONNECTED_APPS_SCHEMA,
        assignments: assignmentState(loaded?.schema === CONNECTED_APPS_SCHEMA ? loaded.assignments : undefined),
    };

    function save() {
        saveJsonState(persistPath, state);
    }

    function requireApp(appId) {
        const app = APP_CATALOG.find((entry) => entry.id === String(appId));
        if (!app) throw new Error(`unknown connected app: ${String(appId)}`);
        return app;
    }

    function targetExists(kind, id) {
        if (kind === "team")
            return teamService.list().teams.some((entry) => entry.id === id);
        return coworkerStore.list().coworkers.some((entry) => entry.id === id);
    }

    function publicApp(app) {
        const assignment = state.assignments[app.id] ?? { teams: [], coworkers: [] };
        const active = toolAvailability(app.requiredTools);
        return {
            id: app.id,
            name: app.name,
            service: app.service,
            description: app.description,
            capabilities: [...app.capabilities],
            state: active ? "available" : "unavailable",
            authority: "Governor-controlled",
            assignedTeamIds: [...assignment.teams],
            assignedCoworkerIds: [...assignment.coworkers],
        };
    }

    return {
        schema: CONNECTED_APPS_SCHEMA,

        list() {
            return { schema: CONNECTED_APPS_SCHEMA, apps: APP_CATALOG.map(publicApp) };
        },

        get(appId) {
            return publicApp(requireApp(appId));
        },

        setAssignment({ appId, teamId, coworkerId, enabled } = {}) {
            const app = requireApp(appId);
            if ((teamId === undefined) === (coworkerId === undefined))
                throw new Error("connected app assignment requires exactly one teamId or coworkerId");
            const kind = teamId === undefined ? "coworker" : "team";
            const id = validTarget(teamId ?? coworkerId, kind === "team" ? TEAM_ID : COWORKER_ID, `${kind}Id`);
            if (!targetExists(kind, id))
                throw new Error(`unknown ${kind}: ${id}`);
            if (typeof enabled !== "boolean")
                throw new Error("connected app assignment enabled must be boolean");
            const entry = state.assignments[app.id] ?? { teams: [], coworkers: [] };
            const ids = entry[kind === "team" ? "teams" : "coworkers"];
            if (enabled && !ids.includes(id)) ids.push(id);
            if (!enabled) {
                const index = ids.indexOf(id);
                if (index >= 0) ids.splice(index, 1);
            }
            state.assignments[app.id] = entry;
            save();
            return publicApp(app);
        },

        isAssigned({ appId, teamId, coworkerId } = {}) {
            const app = requireApp(appId);
            const assignment = state.assignments[app.id] ?? { teams: [], coworkers: [] };
            return Boolean(
                (teamId && assignment.teams.includes(teamId))
                || (coworkerId && assignment.coworkers.includes(coworkerId)),
            );
        },
    };
}
