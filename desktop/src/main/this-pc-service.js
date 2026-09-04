const SERVICE_SCHEMA = "sovereignbot.desktop.this-pc.v1";
const ACTIVITY_TYPES = /(?:^|[._:-])computer(?:[._:-]|$)/i;
const HIDDEN_TYPES = /secret|credential|auth|login|session|cookie|password|token|webdriver|driver|coordinate|path/i;
const FRAME_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const UNHEALTHY_STATES = new Set(["offline", "unavailable", "error", "failed", "stopped", "permission", "permission-denied", "denied", "forbidden", "blocked"]);

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
        ? { kind: "private", label: "Private context / 私有上下文", detail: "Only this Coworker can use this context." }
        : { kind: "shared", label: "Shared context / 共享上下文", detail: "Shared Coworkers take turns in this Project." };
}

function statusOf({ binding, lifecycle, health, control, task, attention }) {
    if (!binding?.ready || !binding.agentId || lifecycle?.managed !== true) return "unavailable";
    if (health?.status === "unavailable") return "unavailable";
    if (attention || control?.mode === "requested") return "attention";
    if (control?.mode === "human") return "takeover";
    if (task) return "working";
    return "idle";
}

function publicHealth(value, hasBinding) {
    if (!hasBinding) return { status: "unavailable", message: "Coworker connection is not ready." };
    const state = String(value?.state ?? "").toLowerCase();
    if (value?.ok === false || UNHEALTHY_STATES.has(state)) return { status: "unavailable", message: "Computer is temporarily unavailable." };
    return { status: "ready", message: "Computer is ready." };
}

function attentionMessage(control, fallback) {
    const reason = safeText(control?.reason, 240).trim();
    if (!reason || HIDDEN_TYPES.test(reason)) return fallback;
    return reason;
}

function safeFailure(error, fallback) {
    const message = safeText(error?.message ?? error, 180).trim();
    return !message || HIDDEN_TYPES.test(message) ? fallback : message;
}

function validFrameData(value) {
    return typeof value === "string"
        && value.length > 0
        && value.length <= 8 * 1024 * 1024
        && value.length % 4 === 0
        && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
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
    const computerQueues = new Map();

    async function withQueue(queue, key, operation) {
        const previous = queue.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        const queued = previous.then(() => current);
        queue.set(key, queued);
        await previous;
        try { return await operation(); }
        finally {
            release();
            if (queue.get(key) === queued) queue.delete(key);
        }
    }

    function withProjectQueue(projectId, operation) { return withQueue(projectQueues, projectId, operation); }

    function computerQueueKey(selection) {
        return selection.coworker.computerMode === "private-profile"
            ? `${selection.scope.projectId}:private:${selection.coworker.id}`
            : `${selection.scope.projectId}:shared`;
    }

    function withComputerQueue(selection, operation) { return withQueue(computerQueues, computerQueueKey(selection), operation); }

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

    async function healthSnapshot(agentId) {
        if (!agentId) return undefined;
        try { return await resolveRuntime().computerLifecycle.health(agentId); }
        catch { return undefined; }
    }

    async function currentPage(agentId) {
        if (!agentId) return {};
        try {
            const value = await resolveRuntime().computerLifecycle.frame(agentId);
            const site = safeSite(value?.url);
            return site ? { app: "Web browser", site } : {};
        }
        catch { return {}; }
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
        const [currentControl, currentLifecycle, currentHealth] = await Promise.all([
            control(selection.agentId),
            lifecycle(selection.agentId),
            healthSnapshot(selection.agentId),
        ]);
        const health = publicHealth(currentHealth, Boolean(selection.agentId));
        const attention = !selection.agentId ? "Coworker provider binding is not ready"
            : health.status === "unavailable" ? health.message
                : !active ? "Ready when this Coworker starts work"
                : undefined;
        const status = statusOf({ binding: selection.binding, lifecycle: currentLifecycle, health, control: currentControl, task: active, attention: currentControl.mode === "requested" });
        const result = {
            coworkerId: selection.coworker.id,
            coworkerName: selection.coworker.name,
            status,
            statusMessage: status === "attention" ? attentionMessage(currentControl, "This Coworker needs your attention.")
                : status === "unavailable" ? (attention || "Computer is temporarily unavailable.")
                    : status === "idle" ? "Ready to work."
                        : status === "takeover" ? "You have control; Coworker actions are paused."
                            : "Working on this Project.",
            health,
            context: contextOf(selection.coworker),
            currentApp: undefined,
            currentSite: undefined,
            currentWork: active ? safeText(active.title ?? active.name ?? "Current work", 180) : undefined,
            canTakeOver: Boolean(active && selection.agentId && currentControl.mode !== "human" && status !== "unavailable"),
            canHandBack: currentControl.mode === "human" && Boolean(active && selection.agentId),
            activity: [],
            files: [],
            artifacts: [],
            history: [],
        };
        if (!includeDetails) return result;
        const [activity, page] = await Promise.all([activities(selection, active), currentPage(selection.agentId)]);
        result.activity = activity;
        result.history = result.activity.slice();
        result.currentApp = result.activity.find((entry) => entry.app)?.app ?? page.app;
        result.currentSite = result.activity.find((entry) => entry.site)?.site ?? page.site;
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
        return withComputerQueue(selection, async () => {
            const active = await activeTask(selection);
            if (!selection.agentId || !active) throw new Error("Live screen is available when this Coworker is working");
            const value = await resolveRuntime().computerLifecycle.frame(selection.agentId);
            if (!value || typeof value.data !== "string" || typeof value.mimeType !== "string") throw new Error("Live screen is temporarily unavailable");
            const mimeType = value.mimeType.toLowerCase();
            if (!FRAME_MIME_TYPES.has(mimeType) || !validFrameData(value.data))
                throw new Error("Live screen returned an unsupported frame");
            return { available: true, mimeType, data: value.data, site: safeSite(value.url), capturedAt: now() };
        });
    }

    async function snapshot(projectId, coworkerId) {
        const selection = await selectionPayload(projectId, coworkerId);
        return withComputerQueue(selection, async () => {
            const active = await activeTask(selection);
            if (!selection.agentId || !active) throw new Error("Page details are available when this Coworker is working");
            const value = await resolveRuntime().computer.snapshot(selection.agentId, active.id);
            return {
                snapshotId: id(value.snapshotId, "snapshotId"),
                site: safeSite(value.url),
                elements: (value.elements ?? []).slice(0, 100).map((entry) => ({
                    ref: id(entry.ref, "snapshot ref"),
                    role: safeText(entry.role, 80),
                    name: safeText(entry.name, 160),
                    type: entry.type === undefined ? undefined : safeText(entry.type, 80),
                })),
            };
        });
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
            if (!selection.agentId || !active) throw new Error("Take Over is available when this Coworker is working");
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
            if (!selection.agentId || !active) throw new Error("Hand Back is available while this Coworker is working");
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
                throw new Error(`Hand Back was rejected: ${safeFailure(error, "the Coworker could not resume safely")}`);
            }
            return publicSelection(selection, { includeDetails: false });
        });
    }

    async function health(projectId, coworkerId) {
        const selection = await selectionPayload(projectId, coworkerId);
        if (!selection.agentId) return { ok: false, status: "unavailable", message: "Coworker connection is not ready." };
        try {
            const value = await resolveRuntime().computerLifecycle.health(selection.agentId);
            const result = publicHealth(value, true);
            return { ok: result.status === "ready", ...result };
        }
        catch { return { ok: false, status: "unavailable", message: "Computer is temporarily unavailable." }; }
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
