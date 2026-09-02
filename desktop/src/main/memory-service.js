export const DESKTOP_MEMORY_SCHEMA = "sovereignbot.desktop.memory.v1";
const SCOPE_TYPES = new Set(["coworker", "team", "project"]);
const SOURCE_TYPES = new Set(["conversation", "artifact", "job", "correction", "fact"]);
const FORBIDDEN_DRAFT_FIELDS = new Set(["scope", "scopeType", "ownerId", "source", "sourceRef", "provenance", "approved", "state", "pinned", "memoryId", "id"]);
const ID = /^[A-Za-z0-9][\w:.-]{0,127}$/;
const PROJECT_ID = /^project_[a-f0-9]{16}$/i;

function clone(value) { return structuredClone(value); }
function safeId(value, label) { if (typeof value !== "string" || !ID.test(value)) throw new Error(`${label} must be an identifier`); return value; }
function text(value, label, max, required = false) {
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    const output = value.trim();
    if (required && !output) throw new Error(`${label} is required`);
    if (output.length > max) throw new Error(`${label} exceeds ${max} characters`);
    return output;
}
function tags(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 16) throw new Error("memory tags are invalid");
    return [...new Set(value.map((entry) => text(entry, "memory tag", 80, true)))];
}
function sourceLabel(value) {
    return text(String(value ?? "Source unavailable"), "memory source label", 180, true)
        .replace(/[A-Za-z]:[\\/][^\s"'<>|?\r\n]+/g, "[REDACTED_PATH]")
        .replace(/\\\\[^\\/\s]+(?:[\\/][^\\/\s]+)+/g, "[REDACTED_PATH]")
        .replace(/(?:bearer\s+|token\s*[:=]\s*|cookie\s*[:=]\s*|secret\s*[:=]\s*|password\s*[:=]\s*)[^\s,;]+/gi, "[REDACTED_SECRET]")
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]");
}
function scopeTarget(scope, ownerId) {
    if (!SCOPE_TYPES.has(scope)) throw new Error("memory scope must be coworker, team, or project");
    const safeOwnerId = safeId(ownerId, `${scope}Id`);
    if (scope === "project" && !PROJECT_ID.test(safeOwnerId)) throw new Error("projectId must be a canonical Project identifier");
    return { kind: scope, ownerId: safeOwnerId, scope: `${scope}:${safeOwnerId}` };
}
function sourceDraft(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("memory source is invalid");
    for (const key of Object.keys(value)) if (!["type", "sourceId", "label"].includes(key)) throw new Error(`memory source field is not allowed: ${key}`);
    if (!SOURCE_TYPES.has(value.type)) throw new Error("memory source type is invalid");
    if (value.sourceId !== undefined) safeId(value.sourceId, "memory sourceId");
    return { type: value.type, ...(value.sourceId ? { sourceId: value.sourceId } : {}), ...(value.label ? { label: sourceLabel(value.label) } : {}) };
}

export function createMemoryService({ runtime, getRuntime, services, coworkerStore, teamService, conversationStore, artifactStore, getJobs = () => undefined, projectResolver = () => undefined, onChanged = () => {} } = {}) {
    if (!runtime || !coworkerStore || !teamService || !conversationStore || !artifactStore)
        throw new Error("memory service requires existing runtime and product stores");
    const resolveRuntime = typeof getRuntime === "function" ? getRuntime : () => runtime;
    function resolveProject(id) {
        try { return projectResolver(id); } catch { return undefined; }
    }

    function memoryStore() {
        const value = resolveRuntime()?.memory;
        if (!value) throw new Error("memory runtime is unavailable");
        return value;
    }
    function requireTarget(scope, ownerId) {
        const target = scopeTarget(scope, ownerId);
        if (scope === "coworker") {
            coworkerStore.get(target.ownerId);
        } else if (scope === "team") {
            teamService.get(target.ownerId);
        } else {
            const trustedProject = resolveProject(target.ownerId);
            if (!trustedProject) throw new Error(`unknown project: ${target.ownerId}`);
        }
        return target;
    }
    function teamForConversation(conversationId) {
        return teamService.list().teams.find((team) => team.channels?.some((channel) => channel.conversationId === conversationId));
    }
    function projectMatches(target, team, conversation) {
        if (target.kind !== "project") return false;
        const project = resolveProject(target.ownerId);
        if (project?.workspaceId && (team?.sharedWorkspaceId === project.workspaceId)) return true;
        const channel = team?.channels?.find((entry) => entry.conversationId === conversation?.id);
        return Boolean(project?.workspaceId && channel?.workspaceId === project.workspaceId);
    }
    function sourceConversation(sourceId) {
        const conversation = conversationStore.get(sourceId);
        return { conversation, team: teamForConversation(sourceId) };
    }
    function assertConversationAccess(target, conversationId) {
        const { conversation, team } = sourceConversation(conversationId);
        if (target.kind === "coworker" && !conversation.participants.includes(target.ownerId)) throw new Error("memory source is outside coworker scope");
        if (target.kind === "team" && team?.id !== target.ownerId) throw new Error("memory source is outside team scope");
        if (target.kind === "project" && !projectMatches(target, team, conversation)) throw new Error("memory source is outside project scope");
        return { conversation, team };
    }
    function resolveSource(target, source) {
        const normalized = sourceDraft(source);
        if (normalized.type === "conversation") {
            const { conversation } = assertConversationAccess(target, normalized.sourceId);
            return { ...normalized, label: sourceLabel(normalized.label ?? conversation.title) };
        }
        if (normalized.type === "correction") {
            const messageId = safeId(normalized.sourceId, "correction messageId");
            const conversation = conversationStore.list().conversations.map((entry) => conversationStore.get(entry.id)).find((entry) => entry.messages.some((message) => message.id === messageId && message.senderId === "user"));
            if (!conversation) throw new Error("correction source message is unavailable");
            assertConversationAccess(target, conversation.id);
            return { ...normalized, label: sourceLabel(normalized.label ?? `User correction · ${conversation.title}`) };
        }
        if (normalized.type === "artifact") {
            const artifact = artifactStore.get(normalized.sourceId);
            if (!artifact.conversationId) throw new Error("artifact has no trusted conversation source");
            assertConversationAccess(target, artifact.conversationId);
            return { ...normalized, label: sourceLabel(normalized.label ?? artifact.title) };
        }
        if (normalized.type === "job") {
            const jobs = getJobs();
            if (!jobs?.getJob) throw new Error("job source is unavailable");
            const job = jobs.getJob(normalized.sourceId);
            if (job.status !== "completed") throw new Error("only completed Jobs can become Memory sources");
            if (target.kind === "coworker" && job.ownerCoworkerId !== target.ownerId) throw new Error("job source is outside coworker scope");
            if (target.kind === "team" || target.kind === "project") {
                if (!job.conversationId) throw new Error("job source has no team/project conversation");
                assertConversationAccess(target, job.conversationId);
            }
            return { ...normalized, label: sourceLabel(normalized.label ?? job.title) };
        }
        return { ...normalized, label: sourceLabel(normalized.label ?? "Approved durable fact") };
    }
    function normalizeDraft(draft) {
        if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error("memory draft must be an object");
        for (const key of Object.keys(draft)) {
            if (FORBIDDEN_DRAFT_FIELDS.has(key)) throw new Error(`memory draft field is not allowed: ${key}`);
            if (!["key", "title", "content", "tags"].includes(key)) throw new Error(`memory draft field is not allowed: ${key}`);
        }
        return {
            key: text(draft.key ?? draft.title ?? "fact", "memory key", 200, true),
            title: text(draft.title ?? draft.key ?? "Memory", "memory title", 180, true),
            content: text(draft.content ?? "", "memory content", 20_000, true),
            tags: tags(draft.tags),
        };
    }
    function internalById(memoryId, target, { includeForgotten = true } = {}) {
        const id = safeId(memoryId, "memoryId");
        return memoryStore().all({ includeForgotten }).then((rows) => {
            const record = rows.find((entry) => entry.memoryId === id);
            if (!record || record.scope !== target.scope) throw new Error("memory is outside the requested scope");
            return record;
        });
    }
    function notifyChanged() {
        try { onChanged(); } catch {}
    }
    function correctionConversation(sourceId) {
        if (!sourceId) return undefined;
        try {
            return conversationStore.list().conversations.map((entry) => conversationStore.get(entry.id)).find((entry) => entry.messages.some((message) => message.id === sourceId && message.senderId === "user"));
        } catch { return undefined; }
    }
    function sourceNavigation(provenance) {
        if (!provenance?.sourceId) return undefined;
        if (provenance.type === "conversation") return { view: "conversation", conversationId: provenance.sourceId };
        if (provenance.type === "correction") {
            const conversation = correctionConversation(provenance.sourceId);
            return conversation ? { view: "conversation", conversationId: conversation.id } : undefined;
        }
        if (provenance.type === "artifact") {
            try {
                const artifact = artifactStore.get(provenance.sourceId);
                return { view: "artifacts", artifactId: provenance.sourceId, ...(artifact.conversationId ? { conversationId: artifact.conversationId } : {}) };
            } catch { return { view: "artifacts", artifactId: provenance.sourceId }; }
        }
        if (provenance.type === "job") {
            try {
                const job = getJobs()?.getJob?.(provenance.sourceId);
                if (job?.conversationId) return { view: "conversation", conversationId: job.conversationId };
            } catch {}
            return { view: "work", jobId: provenance.sourceId };
        }
        return undefined;
    }
    function publicSource(provenance) {
        if (!provenance) return { type: "fact", label: "Approved durable fact" };
        const navigation = sourceNavigation(provenance);
        return {
            type: provenance.type,
            ...(provenance.sourceId ? { sourceId: provenance.sourceId } : {}),
            label: provenance.label ?? "Source unavailable",
            ...(navigation ? { navigation } : {}),
        };
    }
    async function traceFor(record) {
        const history = await memoryStore().history(record.memoryId);
        const provenance = history.findLast((entry) => entry.provenance)?.provenance;
        return publicSource(provenance);
    }
    async function publicMemory(record) {
        const history = await memoryStore().history(record.memoryId);
        const first = history[0] ?? record;
        const value = record.value && typeof record.value === "object" && !Array.isArray(record.value) ? record.value : { title: record.key, content: String(record.value ?? "") };
        return {
            schema: DESKTOP_MEMORY_SCHEMA,
            id: record.memoryId,
            title: text(String(value.title ?? record.key), "memory title", 180),
            content: text(String(value.content ?? ""), "memory content", 20_000),
            tags: [...record.tags],
            scope: record.scope.split(":", 1)[0],
            state: record.state ?? "active",
            pinned: record.pinned === true,
            createdAt: first.at,
            updatedAt: record.at,
            source: await traceFor(record),
        };
    }
    async function writeApproved(target, draft, source, pinned = false) {
        const normalized = normalizeDraft(draft);
        const provenance = resolveSource(target, source);
        const record = await memoryStore().put({
            scope: target.scope,
            key: normalized.key,
            value: { title: normalized.title, content: normalized.content },
            tags: normalized.tags,
            pinned,
            provenance,
        });
        notifyChanged();
        return publicMemory(record);
    }
    async function suggestImpl({ scope, ownerId, draft, source } = {}) {
        const target = requireTarget(scope, ownerId);
        const normalized = normalizeDraft(draft);
        const provenance = resolveSource(target, source);
        const result = await memoryStore().suggest({ scope: target.scope, key: normalized.key, value: { title: normalized.title, content: normalized.content }, tags: normalized.tags, provenance });
        notifyChanged();
        return { schema: DESKTOP_MEMORY_SCHEMA, suggestionId: result.suggestionId, state: "pending" };
    }
    async function publicSuggestion(entry) {
        const value = entry.value && typeof entry.value === "object" && !Array.isArray(entry.value) ? entry.value : { title: entry.key, content: String(entry.value ?? "") };
        return {
            schema: DESKTOP_MEMORY_SCHEMA,
            suggestionId: entry.suggestionId,
            title: text(String(value.title ?? entry.key), "memory title", 180),
            content: text(String(value.content ?? ""), "memory content", 20_000),
            tags: [...entry.tags],
            scope: entry.scope.split(":", 1)[0],
            state: entry.state,
            createdAt: entry.at,
            source: publicSource(entry.provenance),
        };
    }

    return {
        schema: DESKTOP_MEMORY_SCHEMA,
        list: async ({ scope, ownerId, query, limit = 50, includeForgotten = false } = {}) => {
            const target = requireTarget(scope, ownerId);
            const rows = includeForgotten ? (await memoryStore().all({ includeForgotten: true })).filter((entry) => entry.scope === target.scope && (!query || `${entry.key} ${JSON.stringify(entry.value)} ${entry.tags.join(" ")}`.toLowerCase().includes(String(query).trim().toLowerCase()))).slice(-Math.min(100, limit)).reverse() : await memoryStore().search({ scope: target.scope, query, limit: Math.min(100, limit) });
            return { schema: DESKTOP_MEMORY_SCHEMA, scope: target.kind, memories: await Promise.all(rows.map(publicMemory)) };
        },
        get: async ({ scope, ownerId, memoryId } = {}) => publicMemory(await internalById(memoryId, requireTarget(scope, ownerId))),
        update: async ({ scope, ownerId, memoryId, patch } = {}) => {
            const target = requireTarget(scope, ownerId);
            const current = await internalById(memoryId, target);
            if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("memory patch is invalid");
            for (const key of Object.keys(patch)) if (!["title", "content", "tags"].includes(key)) throw new Error(`memory patch field is not allowed: ${key}`);
            const value = current.value && typeof current.value === "object" ? current.value : {};
            const next = {
                title: patch.title === undefined ? String(value.title ?? current.key) : text(patch.title, "memory title", 180, true),
                content: patch.content === undefined ? String(value.content ?? "") : text(patch.content, "memory content", 20_000, true),
            };
            const result = await memoryStore().edit(current.memoryId, { value: next, tags: patch.tags === undefined ? current.tags : tags(patch.tags) });
            notifyChanged();
            return publicMemory(result);
        },
        forget: async ({ scope, ownerId, memoryId } = {}) => { const result = await memoryStore().forget((await internalById(memoryId, requireTarget(scope, ownerId))).memoryId); notifyChanged(); return publicMemory(result); },
        delete: async ({ scope, ownerId, memoryId } = {}) => { const result = await memoryStore().delete((await internalById(memoryId, requireTarget(scope, ownerId))).memoryId); notifyChanged(); return publicMemory(result); },
        pin: async ({ scope, ownerId, memoryId, pinned } = {}) => { const result = await memoryStore().pin((await internalById(memoryId, requireTarget(scope, ownerId))).memoryId, pinned === true); notifyChanged(); return publicMemory(result); },
        sourceTrace: async ({ scope, ownerId, memoryId } = {}) => traceFor(await internalById(memoryId, requireTarget(scope, ownerId))),
        indexRecords: async () => {
            const rows = await memoryStore().all({ includeForgotten: false });
            const result = [];
            for (const row of rows) {
                const separator = row.scope.indexOf(":");
                const scope = row.scope.slice(0, separator);
                const ownerId = row.scope.slice(separator + 1);
                if (!SCOPE_TYPES.has(scope) || !ownerId) continue;
                try { requireTarget(scope, ownerId); } catch { continue; }
                result.push({ ...(await publicMemory(row)), ownerId });
            }
            return result;
        },
        listSuggestions: async () => ({ schema: DESKTOP_MEMORY_SCHEMA, suggestions: await Promise.all((await memoryStore().suggestions()).filter((entry) => entry.state === "pending" && entry.kind === "suggestion").map(publicSuggestion)) }),
        suggest: suggestImpl,
        approveSuggestion: async (suggestionId) => {
            const suggestion = (await memoryStore().suggestions()).find((entry) => entry.suggestionId === safeId(suggestionId, "suggestionId"));
            if (!suggestion || suggestion.state !== "pending" || suggestion.kind !== "suggestion") throw new Error("suggestion is not pending");
            const target = requireTarget(suggestion.scope.split(":", 1)[0], suggestion.scope.slice(suggestion.scope.indexOf(":") + 1));
            const value = suggestion.value;
            const record = await memoryStore().put({ scope: target.scope, key: suggestion.key, value, tags: suggestion.tags, provenance: suggestion.provenance });
            await memoryStore().resolveSuggestion(suggestion.suggestionId, "approved");
            notifyChanged();
            return publicMemory(record);
        },
        rejectSuggestion: async (suggestionId) => { const result = await memoryStore().resolveSuggestion(safeId(suggestionId, "suggestionId"), "rejected"); notifyChanged(); return result; },
        suggestFromConversation: suggestImpl,
        suggestFromArtifact: suggestImpl,
        suggestFromJob: suggestImpl,
        suggestCorrection: (input) => suggestImpl({ ...input, source: { type: "correction", sourceId: input.messageId } }),
        putFact: async ({ scope, ownerId, draft, label = "Approved durable fact" } = {}) => writeApproved(requireTarget(scope, ownerId), draft, { type: "fact", label }, false),
    };
}
