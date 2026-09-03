const SEARCH_SCHEMA = "sovereignbot.desktop.search.v1";
const TYPES = new Set(["conversations", "channels", "coworkers", "projects", "artifacts", "skills", "playbooks", "routines", "memory", "jobs", "history"]);
const STATUSES = new Set(["active", "archived", "all"]);
const MAX_QUERY = 300;
const MAX_LIMIT = 100;
const SEARCH_MATCH_REASONS = Object.freeze(["title-exact", "title-prefix", "title-contains", "phrase", "tags", "subtitle", "content", "token"]);

function clone(value) { return structuredClone(value); }
function safeText(value, max = 240) {
    return String(value ?? "").slice(0, max)
        .replace(/[A-Za-z]:[\\/][^\s"'<>|?\r\n]+/g, "[redacted-path]")
        .replace(/(?:file:\/\/|\\\\|\/(?:Users|home|tmp|var|private|mnt|workspace|opt|etc)\/)[^\s"'<>|?\r\n]*/gi, "[redacted-path]")
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
function normalizeStatus(value) {
    if (value === undefined || value === null) return "active";
    if (typeof value !== "string" || !STATUSES.has(value)) throw new Error("search status is invalid");
    return value;
}
function tokens(query) { return query.toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 12); }
function normalized(value) { return String(value ?? "").trim().toLocaleLowerCase(); }
function matchFor(record, query) {
    if (!query) return { score: 0, key: "token", fields: [] };
    const normalizedQuery = normalized(query);
    const queryTokens = tokens(query);
    const title = normalized(record.title);
    const subtitle = normalized(record.subtitle);
    const content = normalized(record.searchText);
    const tags = (record.tags ?? []).map(normalized).filter(Boolean);
    const fields = new Set();
    const phraseFields = new Set();
    const titleExact = title === normalizedQuery;
    const titlePrefix = title.startsWith(normalizedQuery);
    const titleContains = title.includes(normalizedQuery);
    if (titleContains) fields.add("title");
    if (tags.some((tag) => tag === normalizedQuery || tag.includes(normalizedQuery))) fields.add("tags");
    if (subtitle.includes(normalizedQuery)) { fields.add("subtitle"); phraseFields.add("subtitle"); }
    if (content.includes(normalizedQuery)) { fields.add("content"); phraseFields.add("content"); }
    if (titleContains) phraseFields.add("title");

    let matchedTokenCount = 0;
    let score = 0;
    for (const token of queryTokens) {
        const titleHit = title.includes(token);
        const tagHit = tags.some((tag) => tag === token || tag.includes(token));
        const subtitleHit = subtitle.includes(token);
        const contentHit = content.includes(token);
        if (titleHit || tagHit || subtitleHit || contentHit) matchedTokenCount += 1;
        if (titleHit) { fields.add("title"); score += title.startsWith(token) ? 125 : 100; }
        if (tagHit) { fields.add("tags"); score += 90; }
        if (subtitleHit) { fields.add("subtitle"); score += 45; }
        if (contentHit) { fields.add("content"); score += 25; }
    }
    if (!matchedTokenCount) return null;
    const coverage = matchedTokenCount / Math.max(1, queryTokens.length);
    const strongField = fields.has("title") || fields.has("tags") || phraseFields.has("title");
    if (queryTokens.length > 1 && matchedTokenCount < Math.ceil(queryTokens.length / 2)) return null;
    if (queryTokens.length > 1 && matchedTokenCount < queryTokens.length && !strongField) return null;

    if (titleExact) score += 1000;
    else if (titlePrefix) score += 700;
    else if (titleContains) score += 500;
    if (tags.some((tag) => tag === normalizedQuery)) score += 460;
    else if (fields.has("tags")) score += 300;
    if (phraseFields.has("title")) score += queryTokens.length > 1 ? 300 : 100;
    if (phraseFields.has("subtitle")) score += 140;
    if (phraseFields.has("content")) score += 100;
    score += Math.round(coverage * 180);
    if (matchedTokenCount < queryTokens.length) score -= (queryTokens.length - matchedTokenCount) * 35;

    const key = titleExact ? "title-exact"
        : titlePrefix ? "title-prefix"
            : titleContains ? "title-contains"
                : queryTokens.length > 1 && phraseFields.size ? "phrase"
                    : fields.has("tags") ? "tags"
                        : phraseFields.has("subtitle") ? "subtitle"
                            : phraseFields.has("content") ? "content" : "token";
    return { score, key, fields: [...fields].sort(), coverage: Number(coverage.toFixed(3)) };
}
function add(map, id, projectId) {
    if (!id || !projectId) return;
    if (!map.has(id)) map.set(id, new Set());
    map.get(id).add(projectId);
}
function onlyProject(ids) { return ids?.size === 1 ? [...ids][0] : undefined; }

export function createSearchService({ teamService, conversationStore, coworkerStore, projectService, artifactStore, skillStore, productSurfaces, getRoutines, memoryService, getJobs, getHistory } = {}) {
    if (!teamService?.list || !conversationStore?.list || !coworkerStore?.list || !projectService?.list || !projectService?.resolveScope) throw new Error("search service requires product stores and Project scope");

    let index;
    let indexPromise;
    let generation = 0;

    function invalidate() {
        generation += 1;
        index = undefined;
        indexPromise = undefined;
    }

    async function buildIndex() {
        const projects = (await projectService.list({ includeArchived: true, limit: 100 })).projects ?? [];
        const projectById = new Map(projects.map((project) => [project.projectId, project]));
        const projectWorkspace = new Map();
        const teamProjects = new Map();
        const channelProjects = new Map();
        const conversationProjects = new Map();
        const coworkerProjects = new Map();

        for (const project of projects) {
            let scope;
            try {
                scope = projectService.resolveScope(project.projectId);
            } catch {
                scope = {
                    workspaceId: undefined,
                    teamIds: (project.teams ?? []).map((team) => team.id),
                    channelIds: (project.teams ?? []).flatMap((team) => (team.channels ?? []).map((channel) => channel.id)),
                    conversationIds: (project.teams ?? []).flatMap((team) => (team.channels ?? []).map((channel) => channel.conversationId).filter(Boolean)),
                    coworkerIds: (project.coworkers ?? []).map((coworker) => coworker.id),
                };
            }
            projectWorkspace.set(project.projectId, scope.workspaceId);
            for (const id of scope.teamIds ?? []) add(teamProjects, id, project.projectId);
            for (const id of scope.channelIds ?? []) add(channelProjects, id, project.projectId);
            for (const id of scope.conversationIds ?? []) add(conversationProjects, id, project.projectId);
            for (const id of scope.coworkerIds ?? []) add(coworkerProjects, id, project.projectId);
        }

        const teams = teamService.list({ includeArchived: true })?.teams ?? [];
        const channels = teams.flatMap((team) => (team.channels ?? []).map((channel) => ({ ...channel, teamId: team.id, teamName: team.name })));
        const conversations = conversationStore.list().conversations ?? [];
        const coworkers = coworkerStore.list({ includeArchived: true }).coworkers ?? [];
        const artifacts = artifactStore?.indexRecords
            ? (artifactStore.indexRecords({ visibility: "all", limit: 5_000 }).artifacts ?? [])
            : artifactStore?.list ? (artifactStore.list({ visibility: "all", limit: 500 }).artifacts ?? []) : [];
        const skills = skillStore?.list ? (skillStore.list({ includeArchived: true }).skills ?? []) : [];
        const playbooks = productSurfaces?.listPlaybooks ? (productSurfaces.listPlaybooks({ includeArchived: true }).playbooks ?? []) : [];
        const routines = getRoutines?.()?.routines ?? [];
        const jobs = getJobs?.()?.listJobs?.().jobs ?? [];
        let history = [];
        try { history = (await getHistory?.({ limit: 500 }))?.history ?? []; } catch {}
        const artifactProjects = new Map();
        const skillProjects = new Map();
        const playbookProjects = new Map();
        const routineProjects = new Map();
        const jobProjects = new Map();
        const historyProjects = new Map();
        for (const artifact of artifacts) for (const projectId of conversationProjects.get(artifact.conversationId) ?? []) add(artifactProjects, artifact.id, projectId);
        for (const skill of skills) for (const project of projects) {
            if ((skill.assignedTeamIds ?? []).some((id) => teamProjects.get(id)?.has(project.projectId)) || (skill.assignedCoworkerIds ?? []).some((id) => coworkerProjects.get(id)?.has(project.projectId))) add(skillProjects, skill.id, project.projectId);
        }
        for (const playbook of playbooks) for (const project of projects) {
            if ((playbook.assignedTeams ?? []).some((entry) => teamProjects.get(entry.id)?.has(project.projectId)) || (playbook.assignedChannels ?? []).some((entry) => channelProjects.get(entry.id)?.has(project.projectId))) add(playbookProjects, playbook.id, project.projectId);
        }
        for (const routine of routines) for (const project of projects) if (routine.workspaceId && projectWorkspace.get(project.projectId) === routine.workspaceId) add(routineProjects, routine.id, project.projectId);
        for (const job of jobs) for (const project of projects) if ((job.workspaceId && projectWorkspace.get(project.projectId) === job.workspaceId) || (job.conversationId && conversationProjects.get(job.conversationId)?.has(project.projectId))) add(jobProjects, job.id, project.projectId);
        for (const entry of history) for (const projectId of coworkerProjects.get(entry.coworkerId) ?? []) add(historyProjects, entry.id, projectId);

        const records = [];
        const statusFor = (entry, projectIds) => {
            if (entry?.state === "archived" || entry?.archived === true) return "archived";
            if (projectIds?.size && ![...projectIds].some((id) => projectById.get(id)?.state === "active" && projectById.get(id)?.available !== false)) return "archived";
            return "active";
        };
        const emit = (type, entry, title, subtitle, projectIds, updatedAt, navigation = {}, searchText = "", explicitStatus, internal = {}) => {
            const status = explicitStatus ?? statusFor(entry, projectIds);
            const ids = projectIds ?? new Set();
            const projectId = onlyProject(ids);
            records.push({
                type,
                id: entry.id ?? entry.projectId,
                title: safeText(title, 180),
                subtitle: safeText(subtitle, 240),
                ...(projectId ? { projectId } : {}),
                projectIds: [...ids],
                status,
                updatedAt: safeText(updatedAt, 64),
                navigation: clone(navigation),
                searchText: safeText(searchText, 20_000),
                ...internal,
            });
        };
        for (const project of projects) emit("projects", project, project.name, "Project", new Set([project.projectId]), project.updatedAt, { view: "projects", projectId: project.projectId }, project.name, project.state === "active" && project.available !== false ? "active" : "archived");
        for (const channel of channels) emit("channels", channel, channel.name, `${channel.teamName} · Channel`, channelProjects.get(channel.id), channel.updatedAt, { view: "channels", channelId: channel.id, conversationId: channel.conversationId }, channel.instructions);
        for (const conversation of conversations) emit("conversations", conversation, conversation.title, conversation.kind === "direct" ? "Conversation" : `${conversation.messageCount ?? 0} messages`, conversationProjects.get(conversation.id), conversation.updatedAt, { view: "conversation", conversationId: conversation.id }, conversation.lastMessage?.textPreview);
        for (const coworker of coworkers) emit("coworkers", coworker, coworker.name, coworker.role, coworkerProjects.get(coworker.id), coworker.updatedAt, { view: "conversation", coworkerId: coworker.id }, coworker.role);
        for (const artifact of artifacts) emit("artifacts", artifact, artifact.title, artifact.fileName, artifactProjects.get(artifact.id), artifact.createdAt, { view: "artifacts", artifactId: artifact.id, conversationId: artifact.conversationId }, artifact.fileName);
        for (const skill of skills) emit("skills", skill, skill.name, skill.description, skillProjects.get(skill.id), skill.updatedAt, { view: "skills", skillId: skill.id }, skill.description);
        for (const playbook of playbooks) emit("playbooks", playbook, playbook.name, playbook.description, playbookProjects.get(playbook.id), playbook.updatedAt, { view: "playbooks", playbookId: playbook.id }, playbook.description);
        for (const routine of routines) emit("routines", routine, routine.name, routine.enabled ? "Enabled routine" : "Disabled routine", routineProjects.get(routine.id), routine.updatedAt, { view: "routines", routineId: routine.id }, routine.instruction);
        for (const job of jobs) {
            const safeJob = { id: job.id, title: job.title, status: job.status, updatedAt: job.updatedAt ?? job.createdAt };
            emit("jobs", safeJob, job.title, `${job.status} · Job`, jobProjects.get(job.id), safeJob.updatedAt, { view: "work", jobId: job.id }, `${job.objective ?? ""} ${job.outcomeSummary ?? ""} ${job.status ?? ""}`);
        }
        for (const entry of history) emit("history", entry, entry.activity ?? entry.eventType, `${entry.source ?? "audit"} · Computer History`, historyProjects.get(entry.id), entry.timestamp, { view: "computer-history" }, `${entry.summary ?? ""} ${entry.app ?? ""} ${entry.site ?? ""}`);

        if (memoryService?.indexRecords) {
            for (const memory of await memoryService.indexRecords()) {
                const projectIds = memory.scope === "project" ? new Set([memory.ownerId]) : memory.scope === "team" ? teamProjects.get(memory.ownerId) : coworkerProjects.get(memory.ownerId);
                emit("memory", memory, memory.title, `${memory.scope} memory · ${memory.source?.label ?? "Source unavailable"}`, projectIds, memory.updatedAt, {
                    view: "memory",
                    memoryId: memory.id,
                    scope: memory.scope,
                    ownerId: memory.ownerId,
                    ...(onlyProject(projectIds) ? { projectId: onlyProject(projectIds) } : {}),
                }, `${memory.content} ${memory.source?.label ?? ""}`, memory.state === "active" ? undefined : "archived", {
                    tags: (memory.tags ?? []).filter((tag) => typeof tag === "string").map((tag) => safeText(tag, 80)),
                });
            }
        }
        return { records, projects, indexedAt: new Date().toISOString() };
    }

    async function getIndex() {
        if (index) return index;
        if (!indexPromise) {
            const startedGeneration = generation;
            indexPromise = buildIndex().then((value) => {
                if (generation !== startedGeneration) { indexPromise = undefined; return getIndex(); }
                index = value;
                indexPromise = undefined;
                return value;
            }).catch((error) => { indexPromise = undefined; throw error; });
        }
        return indexPromise;
    }

    async function query(input = {}) {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("search request must be an object");
        const queryText = normalizeQuery(input.query);
        const selectedTypes = new Set(normalizeTypes(input.types));
        const status = normalizeStatus(input.status);
        const limit = input.limit === undefined ? 50 : input.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`search limit must be 1-${MAX_LIMIT}`);
        if (Object.hasOwn(input, "projectId") && input.projectId !== undefined && input.projectId !== null && typeof input.projectId !== "string") throw new Error("projectId must be a Project identifier");
        const built = await getIndex();
        const requestedProject = input.projectId ? built.projects.find((project) => project.projectId === input.projectId) : undefined;
        if (input.projectId && (!requestedProject || (requestedProject.state !== "active" && status === "active"))) return { schema: SEARCH_SCHEMA, query: queryText, status, indexedAt: built.indexedAt, total: 0, hasMore: false, results: [] };
        const scopeProjectId = requestedProject?.projectId;
        const { records, indexedAt } = built;
        const result = [];
        for (const record of records) {
            if (!selectedTypes.has(record.type) || (status !== "all" && record.status !== status)) continue;
            if (scopeProjectId && !record.projectIds.includes(scopeProjectId)) continue;
            const match = matchFor(record, queryText);
            if (!match) continue;
            const { searchText: _searchText, projectIds: _projectIds, tags: _tags, ...publicRecord } = record;
            if (scopeProjectId && !publicRecord.projectId) publicRecord.projectId = scopeProjectId;
            result.push({ ...publicRecord, score: match.score, matchReason: { key: match.key, fields: match.fields, coverage: match.coverage }, action: "open" });
        }
        result.sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id)));
        return { schema: SEARCH_SCHEMA, query: queryText, status, indexedAt, total: result.length, hasMore: result.length > limit, results: result.slice(0, limit) };
    }
    return { schema: SEARCH_SCHEMA, query, invalidate, refresh: async () => { invalidate(); const built = await getIndex(); return { schema: SEARCH_SCHEMA, indexedAt: built.indexedAt, count: built.records.length }; } };
}

export { SEARCH_SCHEMA, TYPES as SEARCH_TYPES, STATUSES as SEARCH_STATUSES, SEARCH_MATCH_REASONS };
