import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

export const PROJECTS_SCHEMA = "sovereignbot.desktop.projects.v1";
const PROJECT_ID = /^project_[a-f0-9]{16}$/i;
const ACTIVE_JOBS = new Set(["queued", "working", "waiting"]);
const MAX_NAME = 120;
const MAX_CONTENT_ITEMS = 50;
const MAX_ARTIFACTS_PER_CONVERSATION = 500;

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
    getRoutines = () => undefined, getEventTriggers = () => undefined, getPlaybooks = () => undefined, getJobs = () => undefined,
    getComputers = () => undefined, now = () => Date.now(), makeId = projectId, onChanged = () => {},
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
        // Keep a Project record when its trusted workspace is temporarily unavailable.
        // Reads can still render an inspectable, unavailable card; mutations continue
        // to fail closed through requireProject().
        if (typeof entry.workspaceId !== "string" || !entry.workspaceId) return undefined;
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
    function notifyChanged() { try { onChanged(); } catch {} }
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
        const project = findProject(id);
        if (!project) throw new Error(`unknown Project: ${String(id)}`);
        if (!services.workspacePath(project.workspaceId)) throw new Error("Project workspace is unavailable");
        return project;
    }
    function findProject(id) { return projects.find((entry) => entry.projectId === String(id)); }
    function association(project) {
        const projectTeams = teams().filter((team) => team.sharedWorkspaceId === project.workspaceId);
        const teamIds = new Set(projectTeams.map((team) => team.id));
        const channels = projectTeams.flatMap((team) => (team.channels ?? []).filter((channel) => channel.workspaceId === project.workspaceId).map((channel) => ({
            id: channel.id, name: channel.name, conversationId: channel.conversationId, teamId: team.id, archived: channel.archived === true,
        })));
        const coworkerIds = new Set(projectTeams.flatMap((team) => team.coworkerIds ?? []));
        for (const coworker of coworkerStore.list({ includeArchived: true })?.coworkers ?? []) if ((coworker.workspaceIds ?? []).includes(project.workspaceId)) coworkerIds.add(coworker.id);
        const conversationIds = new Set(channels.map((channel) => channel.conversationId).filter(Boolean));
        const artifacts = [];
        let artifactsTruncated = false;
        if (artifactStore?.list) for (const conversationId of conversationIds) {
            const result = artifactStore.list({ conversationId, limit: MAX_ARTIFACTS_PER_CONVERSATION });
            const rows = result?.artifacts ?? [];
            if (rows.length >= MAX_ARTIFACTS_PER_CONVERSATION) artifactsTruncated = true;
            for (const entry of rows) if (!artifacts.some((item) => item.id === entry.id)) artifacts.push(entry);
        }
        const skills = skillStore?.list ? (skillStore.list({ includeArchived: true }).skills ?? []).filter((entry) => (entry.assignedTeamIds ?? []).some((id) => teamIds.has(id)) || (entry.assignedCoworkerIds ?? []).some((id) => coworkerIds.has(id))) : [];
        const routines = getRoutines()?.routines ?? [];
        const triggers = getEventTriggers()?.triggers ?? [];
        const projectRoutines = routines.filter((entry) => entry.projectId === project.projectId || entry.workspaceId === project.workspaceId || coworkerIds.has(entry.coworkerId) || teamIds.has(entry.teamId));
        const projectTriggers = triggers.filter((entry) => entry.workspaceId === project.workspaceId || projectRoutines.some((routine) => routine.id === entry.routineId));
        const apps = (connectedApps?.listForScope?.({ projectId: project.projectId, scope: { projectId: project.projectId, teamIds: [...teamIds], coworkerIds: [...coworkerIds] } })?.apps ?? connectedApps?.list?.().apps ?? []).filter((entry) => (entry.assignedTeamIds ?? []).some((id) => teamIds.has(id)) || (entry.assignedCoworkerIds ?? []).some((id) => coworkerIds.has(id)));
        return { projectTeams, teamIds, channels, coworkerIds, conversationIds, artifacts, artifactsTruncated, skills, projectRoutines, projectTriggers, apps };
    }
    async function memoryRows(project) {
        if (!memoryService?.list) return [];
        try { return (await memoryService.list({ scope: "project", ownerId: project.projectId, limit: 100, includeForgotten: false })).memories ?? []; } catch { return []; }
    }
    function section(items, map, { sourceTruncated = false } = {}) {
        const source = Array.isArray(items) ? items : [];
        return { items: source.slice(0, MAX_CONTENT_ITEMS).map(map), total: source.length, truncated: Boolean(sourceTruncated || source.length > MAX_CONTENT_ITEMS) };
    }
    function emptyContents(summary = "Project workspace is unavailable") {
        const names = ["teams", "channels", "coworkers", "files", "artifacts", "skills", "playbooks", "routines", "triggers", "memory", "connectedApps"];
        return Object.fromEntries(names.map((name) => [name, { items: [], total: 0, truncated: false }]));
    }
    function safeCoworkerMap() {
        return new Map((coworkerStore.list({ includeArchived: true })?.coworkers ?? []).map((entry) => [entry.id, entry]));
    }
    function safeArtifact(entry) {
        return {
            id: entry.id, title: publicName(entry.title), fileName: publicName(entry.fileName), mimeType: publicName(entry.mimeType, 120), size: entry.size,
            state: entry.published === false ? "unavailable" : "active", createdAt: entry.createdAt, conversationId: entry.conversationId,
            summary: `${publicName(entry.fileName)} · ${publicName(entry.mimeType, 120)}`,
            navigation: { view: "artifacts", artifactId: entry.id, ...(entry.conversationId ? { conversationId: entry.conversationId } : {}) },
        };
    }
    function safeMemory(entry) {
        const source = entry.source && typeof entry.source === "object" ? entry.source : undefined;
        return {
            id: entry.id, title: publicName(entry.title, 180), content: portableText(entry.content, 20_000), tags: [...(entry.tags ?? [])].map((tag) => portableText(tag, 80)),
            state: entry.state ?? "active", pinned: entry.pinned === true, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
            ...(source ? { source: { type: source.type, ...(source.sourceId ? { sourceId: source.sourceId } : {}), ...(source.label ? { label: portableText(source.label, 180) } : {}), ...(source.navigation ? { navigation: clone(source.navigation) } : {}) } } : {}),
            navigation: { view: "memory", scope: "project", memoryId: entry.id },
        };
    }
    async function publicProject(project) {
        const available = Boolean(services.workspacePath(project.workspaceId));
        if (!available) return {
            projectId: project.projectId,
            name: project.name,
            state: project.state,
            available: false,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            lastOpenedAt: project.lastOpenedAt,
            summary: "Project workspace is unavailable; contents are read-only.",
            contents: emptyContents(),
            counts: { teams: 0, channels: 0, coworkers: 0, files: 0, artifacts: 0, skills: 0, playbooks: 0, routines: 0, triggers: 0, memory: 0, connectedApps: 0 },
            teams: [], coworkers: [], connectedApps: [], memory: [],
        };
        const a = association(project);
        const memories = await memoryRows(project);
        const coworkers = safeCoworkerMap();
        const projectChannels = a.channels.map((channel) => ({ id: channel.id, teamId: channel.teamId, name: publicName(channel.name), state: channel.archived === true ? "archived" : "active", summary: `Channel in ${publicName(a.projectTeams.find((team) => team.id === channel.teamId)?.name ?? "Team")}`, conversationId: channel.conversationId, navigation: { view: "conversation", conversationId: channel.conversationId } }));
        const teamItems = a.projectTeams.map((team) => {
            const channels = projectChannels.filter((channel) => channel.teamId === team.id);
            return { id: team.id, name: publicName(team.name), state: team.state === "archived" ? "archived" : "active", status: team.flow?.status ?? "available", summary: `${channels.length} channel${channels.length === 1 ? "" : "s"}`, navigation: { view: "work", teamId: team.id }, channels };
        });
        const coworkerItems = [...a.coworkerIds].map((id) => {
            const coworker = coworkers.get(id);
            return { id, name: publicName(coworker?.name ?? "Unavailable Coworker"), state: coworker?.state ?? "unavailable", status: coworker?.state ?? "unavailable", summary: coworker ? "Project member" : "Membership record is unavailable", navigation: { view: "settings", coworkerId: id } };
        });
        const artifactItems = a.artifacts.map(safeArtifact);
        const fileItems = a.artifacts.map((entry) => ({ id: entry.id, name: publicName(entry.fileName), artifactId: entry.id, mimeType: publicName(entry.mimeType, 120), size: entry.size, state: entry.published === false ? "unavailable" : "active", summary: `${publicName(entry.mimeType, 120)} · ${entry.size} bytes`, conversationId: entry.conversationId, navigation: { view: "artifacts", artifactId: entry.id, ...(entry.conversationId ? { conversationId: entry.conversationId } : {}) } }));
        const skills = a.skills.map((entry) => ({ id: entry.id, name: publicName(entry.name), state: entry.state ?? "active", status: entry.state ?? "active", summary: publicName(entry.description ?? "Assigned Project skill", 240), assignedTeamIds: [...(entry.assignedTeamIds ?? [])].filter((id) => a.teamIds.has(id)), assignedCoworkerIds: [...(entry.assignedCoworkerIds ?? [])].filter((id) => a.coworkerIds.has(id)), navigation: { view: "skills", skillId: entry.id } }));
        const playbookRows = getPlaybooks()?.playbooks ?? [];
        const embeddedPlaybooks = a.projectTeams.flatMap((team) => (team.playbooks ?? []).map((entry) => ({ ...entry, assignedTeams: [{ id: team.id, name: team.name }] })));
        const playbookMap = new Map([...embeddedPlaybooks, ...playbookRows].map((entry) => [entry.id, entry]));
        const playbooks = [...playbookMap.values()].filter((entry) => {
            const assignedTeams = entry.assignedTeams ?? [];
            const assignedChannels = entry.assignedChannels ?? [];
            return assignedTeams.some((team) => a.teamIds.has(team.id)) || assignedChannels.some((channel) => a.channels.some((item) => item.id === channel.id));
        }).map((entry) => ({ id: entry.id, name: publicName(entry.name), state: entry.state ?? "active", status: entry.state ?? "active", summary: publicName(entry.description ?? "Assigned Project playbook", 240), navigation: { view: "playbooks", playbookId: entry.id } }));
        const routineItems = a.projectRoutines.map((entry) => ({ id: entry.id, name: publicName(entry.name), state: entry.state ?? (entry.enabled ? "active" : "disabled"), status: entry.lastStatus ?? (entry.enabled ? "enabled" : "disabled"), summary: entry.nextRunAt ? `Next run ${entry.nextRunAt}` : entry.enabled ? "Enabled Routine" : "Disabled Routine", teamId: entry.teamId, coworkerId: entry.coworkerId, skillId: entry.skillId, navigation: { view: "routines", routineId: entry.id } }));
        const triggerItems = a.projectTriggers.map((entry) => ({ id: entry.id, name: publicName(entry.name), state: entry.enabled ? "active" : "disabled", status: entry.lastStatus ?? (entry.enabled ? "enabled" : "disabled"), summary: entry.lastError ? publicName(entry.lastError, 240) : "Event trigger", routineId: entry.routineId, navigation: { view: "triggers", triggerId: entry.id } }));
        const appItems = a.apps.map((entry) => ({ id: entry.id, name: publicName(entry.name), state: entry.status ?? entry.state ?? "unavailable", status: entry.status ?? entry.state ?? "unavailable", summary: publicName(entry.description ?? entry.connection?.summary ?? "Connected App", 240), navigation: { view: "apps", appId: entry.id } }));
        const memoryItems = memories.map((entry) => ({ ...safeMemory(entry), navigation: { view: "memory", scope: "project", ownerId: project.projectId, memoryId: entry.id } }));
        const contents = {
            teams: section(teamItems, (entry) => entry),
            channels: section(projectChannels, (entry) => entry),
            coworkers: section(coworkerItems, (entry) => entry),
            files: section(fileItems, (entry) => entry, { sourceTruncated: a.artifactsTruncated }),
            artifacts: section(artifactItems, (entry) => entry, { sourceTruncated: a.artifactsTruncated }),
            skills: section(skills, (entry) => entry),
            playbooks: section(playbooks, (entry) => entry),
            routines: section(routineItems, (entry) => entry),
            triggers: section(triggerItems, (entry) => entry),
            memory: section(memoryItems, (entry) => entry),
            connectedApps: section(appItems, (entry) => entry),
        };
        const counts = Object.fromEntries(Object.entries(contents).map(([key, value]) => [key, value.total]));
        return {
            projectId: project.projectId, name: project.name, state: project.state, available: true, createdAt: project.createdAt, updatedAt: project.updatedAt, lastOpenedAt: project.lastOpenedAt,
            summary: `${counts.teams} Teams · ${counts.channels} Channels · ${counts.coworkers} Coworkers`,
            contents,
            counts: { ...counts, files: contents.files.total, artifacts: contents.artifacts.total },
            teams: teamItems.map(({ id, name, channels }) => ({ id, name, channels: channels.map(({ id, name, conversationId }) => ({ id, name, conversationId })) })),
            coworkers: coworkerItems.map(({ id, name }) => ({ id, name })),
            connectedApps: appItems.map(({ id, name }) => ({ id, name })),
            memory: memoryItems,
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
            return { projectId: project.projectId, workspaceId: project.workspaceId, state: project.state, teamIds: [...a.teamIds], channelIds: a.channels.map((entry) => entry.id), conversationIds: [...a.conversationIds], coworkerIds: [...a.coworkerIds] };
        },
        setMemoryService(service) { memoryService = service; },
        async list({ includeArchived = false, limit = 50 } = {}) {
            ensureMigration();
            const result = projects.filter((entry) => includeArchived || entry.state !== "archived").sort((a, b) => String(b.lastOpenedAt ?? b.updatedAt).localeCompare(String(a.lastOpenedAt ?? a.updatedAt))).slice(0, limit);
            return { schema: PROJECTS_SCHEMA, projects: await Promise.all(result.map(publicProject)) };
        },
        async get(projectId) {
            const project = findProject(validId(projectId));
            if (!project) throw new Error(`unknown Project: ${String(projectId)}`);
            return publicProject(project);
        },
        async open(projectId) { const project = requireProject(validId(projectId)); if (project.state === "archived") throw new Error("archived Project must be restored before opening"); project.lastOpenedAt = stamp(now); project.updatedAt = project.lastOpenedAt; save(); notifyChanged(); return publicProject(project); },
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
            projects.push(project); save(); notifyChanged(); return publicProject(project);
        },
        async archive(projectId) {
            const project = requireProject(validId(projectId));
            if (project.state === "archived") return publicProject(project);
            const blockers = await activeBlockers(project);
            if (blockers.length) throw new Error(`Project cannot be archived safely: ${blockers.join("; ")}`);
            project.state = "archived"; project.updatedAt = stamp(now); save(); notifyChanged(); return publicProject(project);
        },
        async restore(projectId) { const project = requireProject(validId(projectId)); project.state = "active"; project.updatedAt = stamp(now); save(); notifyChanged(); return publicProject(project); },
        async export(projectId) { return portable(requireProject(validId(projectId))); },
        async backup(projectId) {
            const project = requireProject(validId(projectId));
            const payload = await portable(project);
            saveJsonState(join(backupDir, `${project.projectId}.json`), payload);
            return { backedUp: true, projectId: project.projectId, createdAt: payload.exportedAt, counts: clone(payload.project.counts) };
        },
    };
}
