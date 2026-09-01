const SEARCH_SCHEMA = "sovereignbot.desktop.search.v1";
const TYPES = new Set(["conversations", "channels", "coworkers", "projects", "artifacts", "skills", "playbooks", "routines"]);
const MAX_QUERY = 300;
const MAX_LIMIT = 100;

function clone(value) { return structuredClone(value); }
function safeText(value, max = 240) {
    return String(value ?? "").slice(0, max)
        .replace(/[A-Za-z]:[\\/][^\s"'<>|?\r\n]+/g, "[redacted-path]")
        .replace(/(?:bearer\s+|token\s*[:=]\s*|cookie\s*[:=]\s*|secret\s*[:=]\s*|password\s*[:=]\s*)[^\s,;]+/gi, "[redacted-secret]")
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]");
}
function normalizeQuery(value) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw new Error("search query must be a string");
    if (value.length > MAX_QUERY) throw new Error(`search query exceeds ${MAX_QUERY} characters`);
    if ([...value].some((char) => char.charCodeAt(0) < 32 && !["\t", "\n"].includes(char))) throw new Error("search query contains control characters");
    return value.trim();
}
function normalizeTypes(value) {
    if (value === undefined || value === null) return [...TYPES];
    if (!Array.isArray(value) || value.length > TYPES.size || value.some((entry) => typeof entry !== "string" || !TYPES.has(entry))) throw new Error("search types are invalid");
    return [...new Set(value)];
}
function tokens(query) { return query.toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 12); }
function scoreFor(record, query, extra = "") {
    const haystack = [record.title, record.subtitle, extra].join(" ").toLocaleLowerCase();
    if (!query) return 0;
    let score = 0;
    for (const token of tokens(query)) {
        if (!haystack.includes(token)) return -1;
        score += haystack === token ? 100 : record.title.toLocaleLowerCase().startsWith(token) ? 50 : 20;
    }
    return score;
}
function add(map, id, projectId) {
    if (!id || !projectId) return;
    if (!map.has(id)) map.set(id, new Set());
    map.get(id).add(projectId);
}
function onlyProject(ids) { return ids?.size === 1 ? [...ids][0] : undefined; }

export function createSearchService({ teamService, conversationStore, coworkerStore, projectService, artifactStore, skillStore, productSurfaces, getRoutines } = {}) {
    if (!teamService?.list || !conversationStore?.list || !coworkerStore?.list || !projectService?.list || !projectService?.resolveScope) throw new Error("search service requires product stores and Project scope");

    async function query(input = {}) {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("search request must be an object");
        const queryText = normalizeQuery(input.query);
        const selectedTypes = new Set(normalizeTypes(input.types));
        const limit = input.limit === undefined ? 50 : input.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`search limit must be 1-${MAX_LIMIT}`);
        if (Object.hasOwn(input, "projectId") && input.projectId !== undefined && input.projectId !== null && typeof input.projectId !== "string") throw new Error("projectId must be a Project identifier");

        const projects = (await projectService.list({ includeArchived: true, limit: 100 })).projects ?? [];
        const activeProjects = projects.filter((project) => project.state === "active" && project.available !== false);
        const requestedProject = input.projectId ? activeProjects.find((project) => project.projectId === input.projectId) : undefined;
        if (input.projectId && !requestedProject) return { schema: SEARCH_SCHEMA, query: queryText, results: [] };
        const scopeProjectId = requestedProject?.projectId;
        const teamProjects = new Map(), channelProjects = new Map(), conversationProjects = new Map(), coworkerProjects = new Map(), artifactProjects = new Map(), skillProjects = new Map(), playbookProjects = new Map(), routineProjects = new Map();
        const archivedOnly = { teams: new Set(), channels: new Set(), conversations: new Set(), coworkers: new Set(), artifacts: new Set(), skills: new Set(), playbooks: new Set(), routines: new Set() };
        const projectWorkspace = new Map();
        let unavailableProjectScope = false;
        for (const project of projects) {
            const active = project.state === "active" && project.available !== false;
            const target = active ? null : archivedOnly;
            let scope;
            try { scope = projectService.resolveScope(project.projectId); projectWorkspace.set(project.projectId, scope.workspaceId); } catch {
                unavailableProjectScope = true;
                for (const team of project.teams ?? []) {
                    archivedOnly.teams.add(team.id);
                    for (const channel of team.channels ?? []) { archivedOnly.channels.add(channel.id); if (channel.conversationId) archivedOnly.conversations.add(channel.conversationId); }
                }
                for (const coworker of project.coworkers ?? []) archivedOnly.coworkers.add(coworker.id);
                continue;
            }
            for (const teamId of scope.teamIds) {
                if (target) target.teams.add(teamId); else add(teamProjects, teamId, project.projectId);
            }
            for (const channelId of scope.channelIds) {
                if (target) target.channels.add(channelId); else add(channelProjects, channelId, project.projectId);
            }
            for (const conversationId of scope.conversationIds) {
                if (target) target.conversations.add(conversationId); else add(conversationProjects, conversationId, project.projectId);
            }
            for (const coworkerId of scope.coworkerIds) {
                if (target) target.coworkers.add(coworkerId); else add(coworkerProjects, coworkerId, project.projectId);
            }
        }
        const teams = teamService.list({ includeArchived: true })?.teams ?? [];
        const channels = teams.flatMap((team) => (team.channels ?? []).map((channel) => ({ ...channel, teamId: team.id, teamName: team.name })));
        const conversations = conversationStore.list().conversations ?? [];
        const coworkers = coworkerStore.list({ includeArchived: true }).coworkers ?? [];
        const artifacts = artifactStore?.list ? (artifactStore.list({ limit: 500 }).artifacts ?? []) : [];
        const skills = skillStore?.list ? (skillStore.list({ includeArchived: true }).skills ?? []) : [];
        const playbooks = productSurfaces?.listPlaybooks ? (productSurfaces.listPlaybooks({ includeArchived: true }).playbooks ?? []) : [];
        const routines = getRoutines?.()?.routines ?? [];
        if (unavailableProjectScope) for (const routine of routines) archivedOnly.routines.add(routine.id);
        for (const artifact of artifacts) for (const project of conversationProjects.get(artifact.conversationId) ?? []) add(artifactProjects, artifact.id, project);
        for (const skill of skills) for (const project of activeProjects) {
            if ((skill.assignedTeamIds ?? []).some((id) => teamProjects.get(id)?.has(project.projectId)) || (skill.assignedCoworkerIds ?? []).some((id) => coworkerProjects.get(id)?.has(project.projectId))) add(skillProjects, skill.id, project.projectId);
        }
        for (const playbook of playbooks) for (const project of activeProjects) {
            if ((playbook.assignedTeams ?? []).some((entry) => teamProjects.get(entry.id)?.has(project.projectId)) || (playbook.assignedChannels ?? []).some((entry) => channelProjects.get(entry.id)?.has(project.projectId))) add(playbookProjects, playbook.id, project.projectId);
        }
        for (const skill of skills) for (const project of projects.filter((entry) => entry.state !== "active")) {
            if ((skill.assignedTeamIds ?? []).some((id) => archivedOnly.teams.has(id)) || (skill.assignedCoworkerIds ?? []).some((id) => archivedOnly.coworkers.has(id))) archivedOnly.skills.add(skill.id);
        }
        for (const playbook of playbooks) for (const project of projects.filter((entry) => entry.state !== "active")) {
            if ((playbook.assignedTeams ?? []).some((entry) => archivedOnly.teams.has(entry.id)) || (playbook.assignedChannels ?? []).some((entry) => archivedOnly.channels.has(entry.id))) archivedOnly.playbooks.add(playbook.id);
        }
        for (const artifact of artifacts) if (archivedOnly.conversations.has(artifact.conversationId)) archivedOnly.artifacts.add(artifact.id);
        for (const routine of routines) for (const project of activeProjects) {
            if (routine.workspaceId && projectWorkspace.get(project.projectId) === routine.workspaceId) add(routineProjects, routine.id, project.projectId);
        }
        for (const routine of routines) for (const project of projects.filter((entry) => entry.state !== "active")) {
            if (routine.workspaceId && projectWorkspace.get(project.projectId) === routine.workspaceId) archivedOnly.routines.add(routine.id);
        }
        const result = [];
        const emit = (type, entry, title, subtitle, projectIds, updatedAt, navigation = {}, searchText = "") => {
            if (!selectedTypes.has(type) || entry?.state === "archived" || entry?.archived === true || archivedOnly[type]?.has(entry.id ?? entry.projectId)) return;
            const ids = projectIds ?? new Set();
            if (scopeProjectId && !ids.has(scopeProjectId)) return;
            const projectId = onlyProject(ids) ?? scopeProjectId;
            const record = { type, id: entry.id ?? entry.projectId, title: safeText(title, 180), subtitle: safeText(subtitle, 240), ...(projectId ? { projectId } : {}), updatedAt: safeText(updatedAt, 64), navigation: clone(navigation) };
            const score = scoreFor(record, queryText, safeText(searchText, 2_000));
            if (score >= 0) result.push({ ...record, score });
        };
        for (const project of activeProjects) emit("projects", project, project.name, "Project", new Set([project.projectId]), project.updatedAt, { view: "projects", projectId: project.projectId });
        for (const channel of channels) emit("channels", channel, channel.name, `${channel.teamName} · Channel`, channelProjects.get(channel.id), channel.updatedAt, { view: "channels", channelId: channel.id, conversationId: channel.conversationId });
        for (const conversation of conversations) emit("conversations", conversation, conversation.title, conversation.kind === "direct" ? "Conversation" : `${conversation.messageCount ?? 0} messages`, conversationProjects.get(conversation.id), conversation.updatedAt, { view: "conversation", conversationId: conversation.id }, conversation.lastMessage?.textPreview);
        for (const coworker of coworkers) emit("coworkers", coworker, coworker.name, coworker.role, coworkerProjects.get(coworker.id), coworker.updatedAt, { view: "conversation", coworkerId: coworker.id }, coworker.role);
        for (const artifact of artifacts) emit("artifacts", artifact, artifact.title, artifact.fileName, artifactProjects.get(artifact.id), artifact.createdAt, { view: "artifacts", artifactId: artifact.id, conversationId: artifact.conversationId }, artifact.fileName);
        for (const skill of skills) emit("skills", skill, skill.name, skill.description, skillProjects.get(skill.id), skill.updatedAt, { view: "skills", skillId: skill.id }, skill.description);
        for (const playbook of playbooks) emit("playbooks", playbook, playbook.name, playbook.description, playbookProjects.get(playbook.id), playbook.updatedAt, { view: "playbooks", playbookId: playbook.id }, playbook.description);
        for (const routine of routines) emit("routines", routine, routine.name, routine.enabled ? "Enabled routine" : "Disabled routine", routineProjects.get(routine.id), routine.updatedAt, { view: "routines", routineId: routine.id }, routine.instruction);
        result.sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.title).localeCompare(String(b.title)));
        return { schema: SEARCH_SCHEMA, query: queryText, results: result.slice(0, limit) };
    }
    return { schema: SEARCH_SCHEMA, query };
}

export { SEARCH_SCHEMA, TYPES as SEARCH_TYPES };
