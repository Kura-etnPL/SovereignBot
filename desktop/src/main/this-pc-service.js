const SERVICE_SCHEMA = "sovereignbot.desktop.this-pc.v1";
const ACTIVITY_TYPES = /(?:^|[._:-])computer(?:[._:-]|$)/i;
const HIDDEN_TYPES = /secret|credential|auth|login|session|cookie|password|token|webdriver|driver|coordinate|path/i;

function clone(value) { return structuredClone(value); }

function id(value, label) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value))
        throw new Error(`${label} is invalid`);
    return value;
}

function limit(value, fallback = 50, maximum = 100) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error("limit is out of range");
    return value;
}

function safeText(value, maximum = 180) {
    return String(value ?? "").slice(0, maximum)
        .replace(/[A-Za-z]:[\\/][^\s"'<>|?\r\n]+/g, "[redacted-path]")
        .replace(/(?:^|\s)\/(?:Users|home|tmp|var|private|workspace|worktrees?)[^\s"'<>]*/gi, "$1[redacted-path]")
        .replace(/file:\/\/[^\s"'<>]+/gi, "[redacted-path]")
        .replace(/https?:\/\/[^\s"'<>]+/gi, (value) => safeSite(value) ?? "[redacted-url]")
        .replace(/(?:bearer\s+|authorization\s*[:=]|api[-_]?key\s*[:=]|token\s*[:=]|secret\s*[:=]|password\s*[:=]|cookie\s*[:=])\s*[^\s,;]+/gi, "[redacted]");
}

function safeSite(value) {
    try {
        const parsed = new URL(String(value));
        if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
        return parsed.hostname.toLowerCase();
    }
    catch { return undefined; }
}

function contextOf(coworker) {
    return coworker.computerMode === "private-profile"
        ? { kind: "private", label: "Private context / 私有上下文" }
        : { kind: "shared", label: "Shared context / 共享上下文" };
}

function statusOf({ binding, lifecycle, control, task, attention }) {
    if (!binding?.ready || !binding.agentId || lifecycle?.managed !== true) return "unavailable";
    if (attention || control?.mode === "requested") return "attention";
    if (control?.mode === "human") return "takeover";
    if (task) return "working";
    return "idle";
}

function publicFile(entry) {
    if (!entry || typeof entry !== "object") return undefined;
    return {
        name: safeText(entry.name, 160),
        type: ["file", "directory", "symlink", "other"].includes(entry.type) ? entry.type : "other",
        size: Number.isFinite(entry.size) ? entry.size : undefined,
        modifiedAt: typeof entry.modifiedAt === "string" ? entry.modifiedAt : undefined,
    };
}

function publicArtifact(entry) {
    if (!entry || typeof entry !== "object") return undefined;
    return {
        id: typeof entry.id === "string" ? entry.id : undefined,
        title: safeText(entry.title || entry.fileName, 180),
        fileName: safeText(entry.fileName, 160),
        mimeType: safeText(entry.mimeType, 120),
        size: Number.isFinite(entry.size) ? entry.size : undefined,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : undefined,
    };
}

function publicActivity(row, data, status) {
    const activity = data.activity ?? data.operation ?? data.action ?? row.type;
    const summary = data.summary ?? data.intent ?? data.title ?? data.action ?? data.operation ?? row.type;
    return {
        eventType: safeText(row.type, 100),
        activity: safeText(activity, 120),
        summary: safeText(summary, 180),
        app: data.app ? safeText(data.app, 80) : undefined,
        site: data.site ? safeSite(data.site) ?? safeText(data.site, 120) : undefined,
        timestamp: typeof row.at === "string" ? row.at : undefined,
        status,
    };
}

export function createThisPcService({
    projectService, coworkerStore, artifactStore, runtime, getRuntime,
    getBinding, getTeams = () => [], actor = "desktop-operator", now = () => new Date().toISOString(),
} = {}) {
    if (!projectService?.resolveScope || !coworkerStore?.getInternal || !artifactStore?.list || !runtime)
        throw new Error("This PC service requires trusted Project, Coworker, Artifact, and Computer services");
    if (typeof getBinding !== "function") throw new Error("This PC service requires a trusted Coworker binding resolver");
    const resolveRuntime = typeof getRuntime === "function" ? getRuntime : () => runtime;
    const projectQueues = new Map();

    async function withProjectQueue(projectId, operation) {
        const previous = projectQueues.get(projectId) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        const queued = previous.then(() => current);
        projectQueues.set(projectId, queued);
        await previous;
        try { return await operation(); }
        finally {
            release();
            if (projectQueues.get(projectId) === queued) projectQueues.delete(projectId);
        }
    }

    function resolveScope(projectId, coworkerId, { allowInactive = false } = {}) {
        const scope = projectService.resolveScope(id(projectId, "projectId"));
        if (scope.state === "archived") throw new Error("This PC is unavailable for an archived Project");
        const coworker = coworkerStore.getInternal(id(coworkerId, "coworkerId"));
        if (coworker.state !== "active" && !allowInactive) throw new Error("This Coworker is not active in the selected Project");
        if (!scope.coworkerIds.includes(coworker.id)) throw new Error("Coworker is not a member of the selected Project");
        if (coworker.state === "active" && coworker.computerMode === "private-profile") {
            const privateProfile = coworker.computerProfileId ?? coworker.id;
            const reused = (coworkerStore.listInternal({ includeArchived: false })?.coworkers ?? [])
                .some((entry) => entry.id !== coworker.id && entry.computerMode === "private-profile"
                    && (entry.computerProfileId ?? entry.id) === privateProfile);
            if (reused) throw new Error("Private Computer context cannot be reused by another Coworker");
        }
        const binding = coworker.state === "active" ? getBinding(coworker.id) : undefined;
        if (!binding?.ready || !binding.agentId) return { scope, coworker, binding, agentId: undefined };
        const expectedTarget = `coworker:${coworker.id}`;
        if (binding.coworkerId && binding.coworkerId !== coworker.id) throw new Error("Coworker target affinity is invalid");
        return { scope, coworker, binding, agentId: binding.agentId, expectedTarget };
    }

    async function activeTask(selection) {
        if (!selection.agentId || !resolveRuntime().orchestrator?.listTasks) return undefined;
        const tasks = await resolveRuntime().orchestrator.listTasks();
        return tasks.filter((task) => task?.status === "running"
            && (task.ownerAgentId ?? task.assignedAgentId) === selection.agentId
            && task.input?.coworkerId === selection.coworker.id
            && (!task.input?.conversationId || selection.scope.conversationIds.includes(task.input.conversationId)))
            .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")))[0];
    }

    async function lifecycle(agentId) {
        try { return await resolveRuntime().computerLifecycle.status(agentId); }
        catch { return { managed: false, running: false }; }
    }

    async function control(agentId) {
        try { return await resolveRuntime().computer.control(agentId); }
        catch { return { mode: "unavailable" }; }
    }

    async function activities(selection, task) {
        const rows = await resolveRuntime().audit.readAll();
        const relevantTaskIds = new Set([task?.id].filter(Boolean));
        return rows.slice(-400).reverse().filter((row) => {
            const type = String(row?.type ?? "");
            if (!ACTIVITY_TYPES.test(type) || HIDDEN_TYPES.test(type)) return false;
            const data = row?.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {};
            return data.coworkerId === selection.coworker.id
                || data.agentId === selection.agentId
                || data.taskId && relevantTaskIds.has(data.taskId)
                || row.actor === selection.agentId
                || row.subject === `computer:${selection.agentId}`;
        }).slice(0, 20).map((row) => {
            const data = row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {};
            const status = data.ok === false || /failed|denied|rejected/i.test(String(row.type)) ? "failed"
                : /take|release|requested|attention|paused/i.test(String(row.type)) ? "attention" : "completed";
            return publicActivity(row, data, status);
        });
    }

    async function projectArtifacts(selection) {
        const conversations = new Set(selection.scope.conversationIds);
        return artifactStore.list({ limit: 500 }).artifacts
            .filter((entry) => conversations.has(entry.conversationId))
            .slice(0, 50).map(publicArtifact).filter(Boolean);
    }

    async function publicSelection(selection, { includeDetails = true } = {}) {
        const active = await activeTask(selection);
        const [currentControl, currentLifecycle] = await Promise.all([control(selection.agentId), lifecycle(selection.agentId)]);
        const attention = !selection.agentId ? "Coworker provider binding is not ready"
            : !active ? "No active task-bound Computer lease is available"
                : undefined;
        const status = statusOf({ binding: selection.binding, lifecycle: currentLifecycle, control: currentControl, task: active, attention: currentControl.mode === "requested" });
        const result = {
            coworkerId: selection.coworker.id,
            coworkerName: selection.coworker.name,
            status,
            statusMessage: status === "attention" ? (currentControl.reason || attention || "Computer needs attention")
                : status === "unavailable" ? (attention || "Computer is unavailable")
                    : status === "idle" ? "Ready for a task-bound Computer session"
                        : status === "takeover" ? "Agent actions are paused while you have control"
                            : "Coworker is working in a governed Computer session",
            context: contextOf(selection.coworker),
            currentApp: undefined,
            currentSite: undefined,
            canTakeOver: Boolean(active && selection.agentId && currentControl.mode !== "human" && status !== "unavailable"),
            canHandBack: currentControl.mode === "human" && Boolean(active && selection.agentId),
            activity: [],
            files: [],
            artifacts: [],
            history: [],
        };
        if (!includeDetails) return result;
        result.activity = await activities(selection, active);
        result.history = result.activity.slice();
        result.currentApp = result.activity[0]?.app;
        result.currentSite = result.activity[0]?.site;
        result.artifacts = await projectArtifacts(selection);
        if (active && selection.agentId) {
            try {
                const listed = await resolveRuntime().computer.listFiles(selection.agentId, active.id, ".");
                result.files = (Array.isArray(listed) ? listed : []).slice(0, 50).map(publicFile).filter(Boolean);
            }
            catch { result.files = []; }
        }
        return result;
    }

    async function selectionPayload(projectId, coworkerId) {
        return resolveScope(projectId, coworkerId);
    }

    async function frame(projectId, coworkerId) {
        const selection = await selectionPayload(projectId, coworkerId);
        const active = await activeTask(selection);
        if (!selection.agentId || !active) throw new Error("Live screen requires an active task-bound Computer lease");
        const value = await resolveRuntime().computerLifecycle.frame(selection.agentId);
        if (!value || typeof value.data !== "string" || typeof value.mimeType !== "string") throw new Error("Live screen returned an invalid safe frame");
        return { available: true, mimeType: value.mimeType.slice(0, 80), data: value.data.slice(0, 8 * 1024 * 1024), site: safeSite(value.url), capturedAt: now() };
    }

    async function snapshot(projectId, coworkerId) {
        const selection = await selectionPayload(projectId, coworkerId);
        const active = await activeTask(selection);
        if (!selection.agentId || !active) throw new Error("Snapshot requires an active task-bound Computer lease");
        const value = await resolveRuntime().computer.snapshot(selection.agentId, active.id);
        return {
            snapshotId: value.snapshotId,
            site: safeSite(value.url),
            elements: (value.elements ?? []).map((entry) => ({ ref: entry.ref, role: entry.role, name: safeText(entry.name, 160), type: entry.type })),
        };
    }

    function operatorActor(value) {
        if (value === undefined) return actor;
        if (typeof value !== "string" || !/^external-controller:device_[0-9a-f]{16}$/i.test(value)) throw new Error("Computer operator identity is invalid");
        return value;
    }

    async function takeOver(projectId, coworkerId, options = {}) {
        const currentActor = operatorActor(options?.actor);
        const selection = await selectionPayload(projectId, coworkerId);
        return withProjectQueue(selection.scope.projectId, async () => {
            const active = await activeTask(selection);
            if (!selection.agentId || !active) throw new Error("Take Over requires a valid active task-bound Computer lease");
            const current = await control(selection.agentId);
            if (current.mode === "human" && current.actorId !== currentActor) throw new Error("Computer is already controlled by another operator");
            if (selection.coworker.computerMode === "shared-login") {
                for (const memberId of selection.scope.coworkerIds) {
                    if (memberId === selection.coworker.id) continue;
                    const member = coworkerStore.getInternal(memberId);
                    if (member.state !== "active" || member.computerMode !== "shared-login") continue;
                    const memberBinding = getBinding(memberId);
                    const memberControl = memberBinding?.agentId ? await control(memberBinding.agentId) : undefined;
                    if (memberControl?.mode === "human")
                        throw new Error("Shared Computer context is already controlled by another operator");
                }
            }
            await resolveRuntime().computer.takeControl(selection.agentId, currentActor);
            return publicSelection(selection, { includeDetails: false });
        });
    }

    async function handBack(projectId, coworkerId, options = {}) {
        const currentActor = operatorActor(options?.actor);
        const selection = await selectionPayload(projectId, coworkerId);
        return withProjectQueue(selection.scope.projectId, async () => {
            const active = await activeTask(selection);
            if (!selection.agentId || !active) throw new Error("Hand Back requires a valid active task-bound Computer lease");
            const current = await control(selection.agentId);
            if (current.mode !== "human" || (current.actorId && current.actorId !== currentActor)) throw new Error("Only the operator holding Computer control can Hand Back");
            await resolveRuntime().computer.releaseControl(selection.agentId, currentActor);
            try {
                // Re-enter through the real TaskBound + Governor path. This is the lease
                // reacquisition proof; a renderer toggle is never sufficient.
                await resolveRuntime().computer.snapshot(selection.agentId, active.id);
            }
            catch (error) {
                await resolveRuntime().computer.takeControl(selection.agentId, currentActor).catch(() => undefined);
                throw new Error(`Hand Back was rejected: ${String(error?.message ?? error).slice(0, 180)}`);
            }
            return publicSelection(selection, { includeDetails: false });
        });
    }

    async function health(projectId, coworkerId) {
        const selection = await selectionPayload(projectId, coworkerId);
        if (!selection.agentId) return { ok: false, status: "unavailable" };
        try {
            const value = await resolveRuntime().computerLifecycle.health(selection.agentId);
            return { ok: value?.ok !== false, status: value?.ok === false ? "unavailable" : "ready" };
        }
        catch { return { ok: false, status: "unavailable" }; }
    }

    return {
        schema: SERVICE_SCHEMA,
        async list({ projectId, coworkerId, limit: requestedLimit } = {}) {
            if (coworkerId !== undefined) return { schema: SERVICE_SCHEMA, projectId, computers: [await publicSelection(resolveScope(projectId, coworkerId, { allowInactive: true }))] };
            const scope = projectService.resolveScope(id(projectId, "projectId"));
            const ids = scope.coworkerIds.slice(0, limit(requestedLimit));
            const computers = [];
            for (const memberId of ids) computers.push(await publicSelection(resolveScope(projectId, memberId, { allowInactive: true })));
            return { schema: SERVICE_SCHEMA, projectId, computers };
        },
        frame,
        snapshot,
        takeOver,
        handBack,
        health,
    };
}
