import { join } from "node:path";
import { GOVERNED_MCP_TOOLS } from "../../vendor/core/src/governed-tool-bridge.js";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

export const CONNECTED_APPS_SCHEMA = "sovereignbot.desktop.connected-apps.v1";

const TEAM_ID = /^team_[a-f0-9]{16}$/i;
const COWORKER_ID = /^coworker_[a-f0-9]{16}$/i;
const PROJECT_ID = /^project_[a-f0-9]{16}$/i;
const TASK_ID = /^task_[a-f0-9]{16}$/i;
const APP_ID = /^[a-z][a-z0-9._-]{1,63}$/i;
const TOOL_ID = /^[a-z][a-z0-9_]{1,63}$/i;
const MAX_ASSIGNMENTS = 128;
const MAX_QUERY = 120;
const MAX_INVOKE_BYTES = 16 * 1024;
const HEALTH_STATES = new Set(["ready", "attention", "unavailable"]);
const CONNECTION_STATES = new Set(["connected", "attention", "disconnected"]);

const COMPUTER_TOOLS = new Set(["snapshot", "navigate", "click", "type", "key", "scroll", "request_help", "request_secret"]);
const WORKSPACE_TOOLS = new Set(["list_files", "read_file", "write_file"]);
const GOVERNED_TOOL_SET = new Set(GOVERNED_MCP_TOOLS);

// First-party manifests are the only production catalog source. Future configured
// manifests may be injected by the trusted main process; transport, URL, and secret
// material are deliberately absent from this model.
export const FIRST_PARTY_APP_MANIFESTS = Object.freeze([
    Object.freeze({ id: "sovereignbot-computer", name: "This PC / 此电脑", service: "SovereignBot governed computer", description: "Use the existing governed browser/computer lane with human takeover when needed.", capabilities: Object.freeze(["View a live screen", "Navigate and interact", "Request human help"]), tools: Object.freeze([...COMPUTER_TOOLS]), toolGroup: "computer", connectionMode: "built-in" }),
    Object.freeze({ id: "sovereignbot-workspace", name: "Project workspace / 项目工作区", service: "SovereignBot governed workspace", description: "Read and write within the trusted shared or private workspace selected by the Governor.", capabilities: Object.freeze(["List files", "Read files", "Write files"]), tools: Object.freeze([...WORKSPACE_TOOLS]), toolGroup: "workspace", connectionMode: "built-in" }),
]);

function clone(value) { return structuredClone(value); }
function safeText(value, max = 240) {
    return String(value ?? "").slice(0, max)
        .replace(/[A-Za-z]:[\\/][^\s"'<>|?\r\n]+/g, "[redacted-path]")
        .replace(/(?:bearer\s+|token\s*[:=]\s*|cookie\s*[:=]\s*|secret\s*[:=]\s*|password\s*[:=]\s*)[^\s,;]+/gi, "[redacted-secret]")
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]");
}
function valid(value, pattern, label) {
    if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} must be a valid opaque identifier`);
    return value;
}
function boundedIds(value, pattern) {
    if (!Array.isArray(value) || value.length > MAX_ASSIGNMENTS) return [];
    return [...new Set(value.filter((entry) => typeof entry === "string" && pattern.test(entry)))];
}
function emptyAssignment() { return { teams: [], coworkers: [], projects: {} }; }
function normalizeAssignments(value, manifests) {
    const assignments = {};
    for (const app of manifests) {
        const entry = value?.[app.id] ?? {};
        const normalized = { teams: boundedIds(entry.teams, TEAM_ID), coworkers: boundedIds(entry.coworkers, COWORKER_ID), projects: {} };
        if (entry.projects && typeof entry.projects === "object" && !Array.isArray(entry.projects)) {
            for (const [projectId, scoped] of Object.entries(entry.projects).slice(0, MAX_ASSIGNMENTS)) {
                if (!PROJECT_ID.test(projectId) || !scoped || typeof scoped !== "object") continue;
                normalized.projects[projectId] = { teams: boundedIds(scoped.teams, TEAM_ID), coworkers: boundedIds(scoped.coworkers, COWORKER_ID) };
            }
        }
        assignments[app.id] = normalized;
    }
    return assignments;
}
function normalizeManifests(value) {
    const source = Array.isArray(value) && value.length ? [...FIRST_PARTY_APP_MANIFESTS, ...value] : FIRST_PARTY_APP_MANIFESTS;
    const seen = new Set(), manifests = [];
    for (const entry of source.slice(0, 64)) {
        if (!entry || typeof entry !== "object" || !APP_ID.test(String(entry.id)) || seen.has(String(entry.id))) continue;
        const tools = Array.isArray(entry.tools) ? [...new Set(entry.tools.filter((tool) => typeof tool === "string" && TOOL_ID.test(tool)).slice(0, 32))] : [];
        const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities.filter((item) => typeof item === "string").map((item) => safeText(item, 100)).slice(0, 16) : [];
        if (!tools.length || !capabilities.length) continue;
        seen.add(String(entry.id));
        manifests.push(Object.freeze({ id: String(entry.id), name: safeText(entry.name, 120), service: safeText(entry.service, 120), description: safeText(entry.description, 400), capabilities: Object.freeze(capabilities), tools: Object.freeze(tools), toolGroup: typeof entry.toolGroup === "string" ? entry.toolGroup : undefined, connectionMode: entry.connectionMode === "built-in" ? "built-in" : "configured", initialConnection: entry.initialConnection === "connected" ? "connected" : "disconnected" }));
    }
    return manifests;
}
function normalizeConnection(value, manifest) {
    const connection = value && typeof value === "object" ? value : {};
    const state = CONNECTION_STATES.has(connection.state) ? connection.state : manifest.connectionMode === "built-in" ? "connected" : manifest.initialConnection;
    const health = HEALTH_STATES.has(connection.health) ? connection.health : state === "connected" ? "ready" : "attention";
    return { state, health, ...(connection.reason ? { reason: safeText(connection.reason) } : {}), ...(connection.checkedAt ? { checkedAt: safeText(connection.checkedAt, 64) } : {}) };
}
function normalizeInvokeArgs(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("connected app arguments must be an object");
    if (JSON.stringify(value).length > MAX_INVOKE_BYTES) throw new Error("connected app arguments are too large");
    const forbidden = /(?:token|secret|cookie|password|session|provider|endpoint|transport|schema|command|cwd|capability)/i;
    const visit = (node) => { if (!node || typeof node !== "object") return; for (const [key, child] of Object.entries(node)) { if (forbidden.test(key)) throw new Error("connected app arguments contain forbidden authority fields"); visit(child); } };
    visit(value);
    return clone(value);
}

export function createConnectedAppsService({ dataDir, persistPath = join(dataDir, "desktop-state", "connected-apps.json"), teamService, coworkerStore, manifests, adapters = {}, getProjectScope, healthProbe, invokeTrusted } = {}) {
    if (!dataDir || !teamService?.list || !coworkerStore?.list) throw new Error("connected apps service requires dataDir, teamService and coworkerStore");
    const catalog = normalizeManifests(manifests);
    const adapterFor = (app) => adapters instanceof Map ? adapters.get(app.id) : adapters?.[app.id];
    const loaded = loadJsonState(persistPath, null);
    const state = { schema: CONNECTED_APPS_SCHEMA, assignments: normalizeAssignments(loaded?.assignments, catalog), connections: Object.fromEntries(catalog.map((app) => [app.id, normalizeConnection(loaded?.connections?.[app.id], app)])) };
    let projectScopeResolver = getProjectScope;
    let runtimeHealthProbe = healthProbe;

    function save() { saveJsonState(persistPath, state); }
    function requireApp(appId) { const app = catalog.find((entry) => entry.id === String(appId)); if (!app) throw new Error(`unknown connected app: ${String(appId)}`); return app; }
    function requireProjectScope(projectId) {
        const id = valid(projectId, PROJECT_ID, "projectId");
        let scope; try { scope = projectScopeResolver?.(id); } catch { scope = undefined; }
        if (!scope || scope.state === "archived") throw new Error("Project scope is unavailable");
        return { ...scope, projectId: id };
    }
    function targetExists(kind, id) {
        if (kind === "team") return teamService.list().teams.some((entry) => entry.id === id && entry.state !== "archived");
        return coworkerStore.list().coworkers.some((entry) => entry.id === id && entry.state !== "archived");
    }
    function scopeAssignments(app, projectId, scopeOverride) {
        const entry = state.assignments[app.id] ?? emptyAssignment();
        if (!projectId) return { teams: [...entry.teams], coworkers: [...entry.coworkers] };
        const scope = scopeOverride ?? requireProjectScope(projectId), scoped = entry.projects[projectId] ?? { teams: [], coworkers: [] };
        return { teams: [...new Set([...scoped.teams, ...entry.teams.filter((id) => scope.teamIds?.includes(id))])], coworkers: [...new Set([...scoped.coworkers, ...entry.coworkers.filter((id) => scope.coworkerIds?.includes(id))])] };
    }
    function connection(app) { return state.connections[app.id] ?? normalizeConnection(undefined, app); }
    function publicApp(app, projectId, scopeOverride) {
        const assignment = scopeAssignments(app, projectId, scopeOverride), current = connection(app), adapter = adapterFor(app);
        const connectionSummary = current.state === "connected" ? "Connected through the trusted App bridge." : current.state === "attention" ? "Connection needs human attention." : "Not connected; assignments are inactive.";
        const healthSummary = current.health === "ready" ? "Ready for governed task-bound use." : current.health === "attention" ? "Signed out or needs attention." : "Connector is unavailable.";
        return { id: app.id, name: app.name, service: app.service, description: app.description, capabilities: [...app.capabilities], capabilitySummary: `${app.capabilities.length} governed capabilities`, state: current.health, connectionState: current.state, connection: { state: current.state, summary: connectionSummary }, health: { state: current.health, summary: healthSummary, ...(current.checkedAt ? { checkedAt: current.checkedAt } : {}) }, authority: "Governor-controlled", approval: { mode: "governed", summary: "Every action is task-bound and subject to Governor policy." }, approvalSummary: "Governor-controlled; task-bound approval required.", assignedTeamIds: assignment.teams, assignedCoworkerIds: assignment.coworkers, ...(projectId ? { projectId } : {}), ...(adapter?.connect || app.connectionMode === "built-in" ? {} : { connectable: false }) };
    }
    function appUsable(app) { const current = connection(app); const governed = app.connectionMode !== "built-in" || app.tools.every((tool) => GOVERNED_TOOL_SET.has(tool)); return current.state === "connected" && current.health === "ready" && governed && (app.connectionMode === "built-in" || typeof adapterFor(app)?.invoke === "function"); }
    function assignedTo(app, coworkerId, projectId) {
        const assignment = scopeAssignments(app, projectId); if (assignment.coworkers.includes(coworkerId)) return true;
        const teams = new Set(teamService.list().teams.filter((team) => team.state !== "archived" && (team.coworkerIds ?? []).includes(coworkerId)).map((team) => team.id));
        return assignment.teams.some((id) => teams.has(id));
    }
    function removeAssignments(app, projectId) {
        const entry = state.assignments[app.id] ?? emptyAssignment();
        if (projectId) delete entry.projects[projectId]; else { entry.teams = []; entry.coworkers = []; entry.projects = {}; }
        state.assignments[app.id] = entry;
    }

    return {
        schema: CONNECTED_APPS_SCHEMA,
        setProjectScopeResolver(resolver) { projectScopeResolver = resolver; },
        setHealthProbe(probe) { runtimeHealthProbe = probe; },
        list({ projectId, query = "", limit = 64 } = {}) {
            if (projectId !== undefined) requireProjectScope(projectId);
            if (typeof query !== "string" || query.length > MAX_QUERY) throw new Error("connected app search query is invalid");
            if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("connected app limit must be 1-100");
            const needle = query.trim().toLocaleLowerCase();
            const apps = catalog.filter((app) => !needle || [app.name, app.service, app.description, ...app.capabilities].join(" ").toLocaleLowerCase().includes(needle));
            return { schema: CONNECTED_APPS_SCHEMA, query: query.trim(), ...(projectId ? { projectId } : {}), apps: apps.slice(0, limit).map((app) => publicApp(app, projectId)) };
        },
        listForScope({ projectId, scope, query = "", limit = 64 } = {}) {
            if (!scope || scope.projectId !== projectId) throw new Error("Project scope is unavailable");
            if (typeof query !== "string" || query.length > MAX_QUERY) throw new Error("connected app search query is invalid");
            if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("connected app limit must be 1-100");
            const needle = query.trim().toLocaleLowerCase();
            const apps = catalog.filter((app) => !needle || [app.name, app.service, app.description, ...app.capabilities].join(" ").toLocaleLowerCase().includes(needle));
            return { schema: CONNECTED_APPS_SCHEMA, query: query.trim(), projectId, apps: apps.slice(0, limit).map((app) => publicApp(app, projectId, scope)) };
        },
        search(input = {}) { return this.list(input); },
        get(appId, { projectId } = {}) { if (projectId !== undefined) requireProjectScope(projectId); return publicApp(requireApp(appId), projectId); },
        async connect({ appId, projectId } = {}) {
            const app = requireApp(appId); if (projectId !== undefined) requireProjectScope(projectId);
            const adapter = adapterFor(app);
            try {
                const result = adapter?.connect ? await adapter.connect({ appId: app.id, projectId }) : app.connectionMode === "built-in" ? { state: "connected", health: "ready" } : { state: "attention", health: "attention", reason: "Complete connection in the trusted App settings." };
                const stateName = result?.state === "connected" ? "connected" : "attention";
                const health = result?.health === "ready" && stateName === "connected" ? "ready" : stateName === "connected" ? "unavailable" : "attention";
                state.connections[app.id] = { state: stateName, health, ...(result?.reason ? { reason: safeText(result.reason) } : {}), checkedAt: new Date().toISOString() }; save();
                return { ...publicApp(app, projectId), ...(stateName === "attention" ? { attention: { required: true, summary: safeText(result?.reason || "Connection needs human attention.") } } : {}) };
            } catch (error) {
                state.connections[app.id] = { state: "attention", health: "attention", reason: safeText(error?.message || "Connection needs human attention."), checkedAt: new Date().toISOString() }; save();
                return { ...publicApp(app, projectId), attention: { required: true, summary: "Connection needs human attention." } };
            }
        },
        async disconnect({ appId, projectId } = {}) {
            const app = requireApp(appId); if (projectId !== undefined) requireProjectScope(projectId);
            const adapter = adapterFor(app); if (adapter?.disconnect) await Promise.resolve(adapter.disconnect({ appId: app.id, projectId })).catch(() => undefined);
            removeAssignments(app, projectId); state.connections[app.id] = { state: "disconnected", health: "attention", checkedAt: new Date().toISOString() }; save(); return publicApp(app, projectId);
        },
        async health({ appId, projectId } = {}) {
            const app = requireApp(appId); if (projectId !== undefined) requireProjectScope(projectId); const adapter = adapterFor(app); const probe = adapter?.health ?? runtimeHealthProbe; if (!probe) return publicApp(app, projectId);
            try { const result = await probe({ appId: app.id, projectId, manifest: app }); const health = HEALTH_STATES.has(result?.health) ? result.health : result?.health === "signed-out" ? "attention" : "unavailable"; state.connections[app.id] = { ...connection(app), health, checkedAt: new Date().toISOString(), ...(result?.reason ? { reason: safeText(result.reason) } : {}) }; }
            catch (error) { state.connections[app.id] = { ...connection(app), health: "unavailable", checkedAt: new Date().toISOString(), reason: safeText(error?.message || "Connector is unavailable.") }; }
            save(); return publicApp(app, projectId);
        },
        setAssignment({ appId, projectId, teamId, coworkerId, enabled } = {}) {
            const app = requireApp(appId); if ((teamId === undefined) === (coworkerId === undefined)) throw new Error("connected app assignment requires exactly one teamId or coworkerId");
            const kind = teamId === undefined ? "coworker" : "team", id = valid(teamId ?? coworkerId, kind === "team" ? TEAM_ID : COWORKER_ID, `${kind}Id`);
            if (!targetExists(kind, id)) throw new Error(`unknown ${kind}: ${id}`); if (typeof enabled !== "boolean") throw new Error("connected app assignment enabled must be boolean");
            const entry = state.assignments[app.id] ?? emptyAssignment(); let bucket = entry;
            if (projectId !== undefined) { const scope = requireProjectScope(projectId); if (!(kind === "team" ? scope.teamIds : scope.coworkerIds)?.includes(id)) throw new Error("assignment target is outside Project scope"); bucket = entry.projects[projectId] ??= { teams: [], coworkers: [] }; }
            const ids = bucket[kind === "team" ? "teams" : "coworkers"]; if (enabled && !ids.includes(id)) ids.push(id); if (!enabled) { const index = ids.indexOf(id); if (index >= 0) ids.splice(index, 1); }
            state.assignments[app.id] = entry; save(); return publicApp(app, projectId);
        },
        isAssigned({ appId, teamId, coworkerId, projectId } = {}) { const app = requireApp(appId); if (teamId !== undefined) return scopeAssignments(app, projectId).teams.includes(teamId); if (coworkerId !== undefined) return scopeAssignments(app, projectId).coworkers.includes(coworkerId); return false; },
        assignedToolsForCoworker(coworkerId, projectId) {
            const id = valid(coworkerId, COWORKER_ID, "coworkerId"), coworker = coworkerStore.get(id); if (coworker.state !== "active") return { tools: [], appIds: [], approvalProfiles: [] };
            const tools = new Set(), appIds = []; for (const app of catalog) { if (!appUsable(app) || !assignedTo(app, id, projectId)) continue; appIds.push(app.id); if (app.toolGroup) tools.add(app.toolGroup); }
            return { tools: [...tools], appIds, approvalProfiles: [] };
        },
        async invoke({ appId, coworkerId, projectId, taskId, tool, args = {} } = {}) {
            const app = requireApp(appId); valid(coworkerId, COWORKER_ID, "coworkerId"); valid(projectId, PROJECT_ID, "projectId"); valid(taskId, TASK_ID, "taskId");
            if (!app.tools.includes(tool)) throw new Error("tool is not declared by this connected app"); if (!targetExists("coworker", coworkerId)) throw new Error("coworker is unavailable");
            const scope = requireProjectScope(projectId); if (!(scope.coworkerIds ?? []).includes(coworkerId) || !assignedTo(app, coworkerId, projectId)) throw new Error("connected app is not assigned in this Project scope");
            if (!appUsable(app)) throw new Error("connected app is disconnected or unhealthy"); if (typeof invokeTrusted !== "function") throw new Error("trusted App bridge is unavailable");
            return invokeTrusted({ appId: app.id, coworkerId, projectId, taskId, tool, args: normalizeInvokeArgs(args), scope: { projectId: scope.projectId } });
        },
    };
}
