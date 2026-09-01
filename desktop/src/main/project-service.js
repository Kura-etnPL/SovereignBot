import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

export const PROJECTS_SCHEMA = "sovereignbot.desktop.projects.v1";
const PROJECT_ID = /^project_[a-f0-9]{16}$/i;
const ACTIVE_JOBS = new Set(["queued", "working", "waiting"]);
const MAX_NAME = 120;

function clone(value) { return structuredClone(value); }
function stamp(now) { return new Date(now()).toISOString(); }
function projectId() { return `project_${randomBytes(8).toString("hex")}`; }
function safeName(value) {
    if (typeof value !== "string") throw new Error("project name must be a string");
    const name = value.trim();
    if (!name || name.length > MAX_NAME) throw new Error(`project name must be 1-${MAX_NAME} characters`);
    return name;
}
function validId(value, label = "projectId") {
    if (typeof value !== "string" || !PROJECT_ID.test(value)) throw new Error(`${label} must be a Project identifier`);
    return value;
}
function portableText(value, max = 20_000) {
    return String(value ?? "").slice(0, max)
        .replace(/[A-Za-z]:[\\/][^\s"'<>|?\r\n]+/g, "[redacted-path]")
        .replace(/(?:bearer\s+|token\s*[:=]\s*|cookie\s*[:=]\s*|secret\s*[:=]\s*|password\s*[:=]\s*)[^\s,;]+/gi, "[redacted-secret]")
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]");
}
function publicName(value) { return portableText(value, MAX_NAME); }

export function createProjectService({
    dataDir, services, teamService, coworkerStore, artifactStore, skillStore, connectedApps,
    getRoutines = () => undefined, getEventTriggers = () => undefined, getJobs = () => undefined,
    getComputers = () => undefined, now = () => Date.now(), makeId = projectId,
} = {}) {
    if (!dataDir || !services?.workspacePath || !teamService?.list || !coworkerStore?.list)
        throw new Error("project service requires trusted workspace and product services");
    const persistPath = join(dataDir, "desktop-state", "projects.json");
    const backupDir = join(dataDir, "desktop-state", "project-backups");
    const loaded = loadJsonState(persistPath, null);
    const projects = [];
    let memoryService;

    function workspaceRecords() {
        return services.listWorkspacesInternal?.()?.workspaces ?? [];
    }
    function normalize(entry) {
        if (!entry || typeof entry !== "object" || !PROJECT_ID.test(entry.projectId)) return undefined;
        if (typeof entry.workspaceId !== "string" || !services.workspacePath(entry.workspaceId)) return undefined;
        try {
            const name = safeName(entry.name);
            const state = entry.state === "archived" ? "archived" : "active";
            return { projectId: entry.projectId, name, workspaceId: entry.workspaceId, state,
                createdAt: String(entry.createdAt ?? stamp(now)), updatedAt: String(entry.updatedAt ?? stamp(now)),
                ...(entry.lastOpenedAt ? { lastOpenedAt: String(entry.lastOpenedAt) } : {}) };
        } catch { return undefined; }
    }
    if (loaded?.schema === PROJECTS_SCHEMA && Array.isArray(loaded.projects)) {
        for (const entry of loaded.projects.map(normalize).filter(Boolean)) if (!projects.some((item) => item.projectId === entry.projectId)) projects.push(entry);
    }

    function teams() { return teamService.list({ includeArchived: true })?.teams ?? []; }
    function migrationCandidates() {
        const candidates = new Set();
        for (const team of teams()) {
            if (team.sharedWorkspaceId && services.workspacePath(team.sharedWorkspaceId)) candidates.add(team.sharedWorkspaceId);
            for (const channel of team.channels ?? []) if (channel.workspaceId && services.workspacePath(channel.workspaceId)) candidates.add(channel.workspaceId);
        }
        for (const entry of workspaceRecords()) if (entry.kind === "shared-project" && services.workspacePath(entry.id)) candidates.add(entry.id);
        return candidates;
    }
    function save() { saveJsonState(persistPath, { schema: PROJECTS_SCHEMA, projects }); }
    function ensureMigration() {
        let changed = false;
        const existing = new Set(projects.map((entry) => entry.workspaceId));
        for (const workspaceId of migrationCandidates()) {
            if (existing.has(workspaceId)) continue;
            const team = teams().find((entry) => entry.sharedWorkspaceId === workspaceId);
            const workspace = workspaceRecords().find((entry) => entry.id === workspaceId);
            const createdAt = stamp(now);
            projects.push({ projectId: makeId(), name: safeName(team?.name ?? workspace?.label ?? "Project"), workspaceId, state: "active", createdAt, updatedAt: createdAt });
            existing.add(workspaceId); changed = true;
        }
        if (changed) save();
    }
    ensureMigration();

    function requireProject(id) {
        const project = projects.find((entry) => entry.projectId === String(id));
        if (!project) throw new Error(`unknown Project: ${String(id)}`);
        if (!services.workspacePath(project.workspaceId)) throw new Error("Project workspace is unavailable");
        return project;
    }
    function association(project) {
        const projectTeams = teams().filter((team) => team.sharedWorkspaceId === project.workspaceId);
        const teamIds = new Set(projectTeams.map((team) => team.id));
        const channels = projectTeams.flatMap((team) => (team.channels ?? []).filter((channel) => channel.workspaceId === project.workspaceId).map((channel) => ({
            id: channel.id, name: channel.name, conversationId: channel.conversationId, teamId: team.id,
        })));
        const coworkerIds = new Set(projectTeams.flatMap((team) => team.coworkerIds ?? []));
        for (const coworker of coworkerStore.list({ includeArchived: true })?.coworkers ?? []) if ((coworker.workspaceIds ?? []).includes(project.workspaceId)) coworkerIds.add(coworker.id);
        const conversationIds = new Set(channels.map((channel) => channel.conversationId).filter(Boolean));
        const artifacts = artifactStore?.list ? (artifactStore.list({ limit: 500 }).artifacts ?? []).filter((entry) => conversationIds.has(entry.conversationId)) : [];
        const skills = skillStore?.list ? (skillStore.list({ includeArchived: true }).skills ?? []).filter((entry) => (entry.assignedTeamIds ?? []).some((id) => teamIds.has(id)) || (entry.assignedCoworkerIds ?? []).some((id) => coworkerIds.has(id))) : [];
        const routines = getRoutines()?.routines ?? [];
        const triggers = getEventTriggers()?.triggers ?? [];
        const projectRoutines = routines.filter((entry) => entry.workspaceId === project.workspaceId || coworkerIds.has(entry.coworkerId));
        const projectTriggers = triggers.filter((entry) => entry.workspaceId === project.workspaceId || projectRoutines.some((routine) => routine.id === entry.routineId));
        const apps = (connectedApps?.list?.().apps ?? []).filter((entry) => (entry.assignedTeamIds ?? []).some((id) => teamIds.has(id)) || (entry.assignedCoworkerIds ?? []).some((id) => coworkerIds.has(id)));
        return { projectTeams, teamIds, channels, coworkerIds, conversationIds, artifacts, skills, projectRoutines, projectTriggers, apps };
    }
    async function memoryRows(project) {
        if (!memoryService?.list) return [];
        try { return (await memoryService.list({ scope: "project", ownerId: project.projectId, limit: 100, includeForgotten: false })).memories ?? []; } catch { return []; }
    }
    async function publicProject(project) {
        const a = association(project);
        const memories = await memoryRows(project);
        return {
            projectId: project.projectId,
            name: project.name,
            state: project.state,
            available: Boolean(services.workspacePath(project.workspaceId)),
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            lastOpenedAt: project.lastOpenedAt,
            teams: a.projectTeams.map((team) => ({ id: team.id, name: team.name, channels: a.channels.filter((channel) => channel.teamId === team.id).map(({ id, name, conversationId }) => ({ id, name, conversationId })) })),
            coworkers: [...a.coworkerIds].map((id) => { const coworker = coworkerStore.get(id); return { id, name: coworker.name }; }),
            counts: { teams: a.projectTeams.length, channels: a.channels.length, coworkers: a.coworkerIds.size, files: a.artifacts.length, artifacts: a.artifacts.length, skills: a.skills.length, playbooks: a.projectTeams.reduce((n, team) => n + (team.playbooks?.length ?? 0), 0), routines: a.projectRoutines.length, triggers: a.projectTriggers.length, memory: memories.length, connectedApps: a.apps.length },
            connectedApps: a.apps.map((app) => ({ id: app.id, name: app.name })),
            memory: memories.map((entry) => ({ id: entry.id, title: entry.title, content: entry.content, tags: entry.tags, state: entry.state, pinned: entry.pinned })),
        };
    }
    async function portable(project) {
        const view = await publicProject(project);
        return {
            schema: "sovereignbot.project-export.v1",
            exportedAt: stamp(now),
            project: {
                name: publicName(view.name), state: view.state, createdAt: view.createdAt, updatedAt: view.updatedAt,
                counts: clone(view.counts),
                teams: view.teams.map((team) => ({ name: publicName(team.name), channels: team.channels.map((channel) => ({ name: publicName(channel.name) })) })),
                coworkers: view.coworkers.map((entry) => ({ name: publicName(entry.name) })),
                connectedApps: view.connectedApps.map((entry) => ({ name: publicName(entry.name) })),
                memory: view.memory.map((entry) => ({ title: publicName(entry.title), content: portableText(entry.content), tags: [...(entry.tags ?? [])].map((tag) => portableText(tag, 80)), pinned: entry.pinned === true })),
            },
        };
    }
    async function activeBlockers(project) {
        const a = association(project);
        const jobs = getJobs()?.listJobs?.().jobs ?? [];
        const activeJobs = jobs.filter((job) => ACTIVE_JOBS.has(job.status) && (job.workspaceId === project.workspaceId || a.conversationIds.has(job.conversationId)));
        if (activeJobs.length) return [`active Jobs: ${activeJobs.map((job) => job.id).join(", ")}`];
        const activeTeams = a.projectTeams.filter((team) => ["active", "waiting"].includes(team.flow?.status));
        if (activeTeams.length) return [`active Team flow: ${activeTeams.map((team) => team.name).join(", ")}`];
        const enabledRoutines = a.projectRoutines.filter((entry) => entry.enabled);
        if (enabledRoutines.length) return [`enabled Routines: ${enabledRoutines.map((entry) => entry.name).join(", ")}`];
        const enabledTriggers = a.projectTriggers.filter((entry) => entry.enabled);
        if (enabledTriggers.length) return [`enabled Triggers: ${enabledTriggers.map((entry) => entry.name).join(", ")}`];
        let computers;
        try { computers = await getComputers(); } catch { return ["Computer lease state is unavailable"]; }
        if (Array.isArray(computers) && computers.some((entry) => entry?.control && !["available", "released", "none"].includes(entry.control.mode))) return ["an active Computer lease is present"];
        return [];
    }

    return {
        schema: PROJECTS_SCHEMA,
        resolveProject(id) { return clone(requireProject(validId(id))); },
        // Main-process-only scope materialization for bounded product queries.  It
        // reuses the same association resolver as Project pages and never crosses IPC.
        resolveScope(id) {
            const project = requireProject(validId(id));
            const a = association(project);
            return { projectId: project.projectId, workspaceId: project.workspaceId, teamIds: [...a.teamIds], channelIds: a.channels.map((entry) => entry.id), conversationIds: [...a.conversationIds], coworkerIds: [...a.coworkerIds] };
        },
        setMemoryService(service) { memoryService = service; },
        async list({ includeArchived = false, limit = 50 } = {}) {
            ensureMigration();
            const result = projects.filter((entry) => includeArchived || entry.state !== "archived").sort((a, b) => String(b.lastOpenedAt ?? b.updatedAt).localeCompare(String(a.lastOpenedAt ?? a.updatedAt))).slice(0, limit);
            return { schema: PROJECTS_SCHEMA, projects: await Promise.all(result.map(publicProject)) };
        },
        async get(projectId) { return publicProject(requireProject(validId(projectId))); },
        async open(projectId) { const project = requireProject(validId(projectId)); if (project.state === "archived") throw new Error("archived Project must be restored before opening"); project.lastOpenedAt = stamp(now); project.updatedAt = project.lastOpenedAt; save(); return publicProject(project); },
        async create(input = {}) {
            if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Project create payload must be an object");
            if (Object.keys(input).some((key) => key !== "name")) throw new Error("Project creation accepts only name; workspace authority is main-process-owned");
            const name = safeName(input.name);
            const managed = services.createManagedWorkspace({ label: `${name} project`, kind: "shared-project", idHint: `${name}-${Date.now().toString(36)}` });
            const workspaceId = managed.workspace?.id;
            if (!workspaceId || !services.workspacePath(workspaceId)) throw new Error("trusted Project workspace allocation failed");
            const createdAt = stamp(now);
            const project = { projectId: makeId(), name, workspaceId, state: "active", createdAt, updatedAt: createdAt };
            if (!PROJECT_ID.test(project.projectId) || projects.some((entry) => entry.projectId === project.projectId)) throw new Error("Project id factory returned an invalid or duplicate id");
            projects.push(project); save(); return publicProject(project);
        },
        async archive(projectId) {
            const project = requireProject(validId(projectId));
            if (project.state === "archived") return publicProject(project);
            const blockers = await activeBlockers(project);
            if (blockers.length) throw new Error(`Project cannot be archived safely: ${blockers.join("; ")}`);
            project.state = "archived"; project.updatedAt = stamp(now); save(); return publicProject(project);
        },
        async restore(projectId) { const project = requireProject(validId(projectId)); project.state = "active"; project.updatedAt = stamp(now); save(); return publicProject(project); },
        async export(projectId) { return portable(requireProject(validId(projectId))); },
        async backup(projectId) {
            const project = requireProject(validId(projectId));
            const payload = await portable(project);
            saveJsonState(join(backupDir, `${project.projectId}.json`), payload);
            return { backedUp: true, projectId: project.projectId, createdAt: payload.exportedAt, counts: clone(payload.project.counts) };
        },
    };
}
