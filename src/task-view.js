const RESUMABLE_PROVIDER_KINDS = new Set(["codex", "claude-code"]);
const TASK_RESULT_TAGS = new Set(["task-result", "candidate-result"]);
const PROVIDER_SESSION_REDACTION = "[REDACTED_PROVIDER_SESSION]";

function providerContinuityRef(task) {
    const state = task?.harnessState;
    return RESUMABLE_PROVIDER_KINDS.has(state?.kind) && typeof state.sessionId === "string" && state.sessionId
        ? state.sessionId
        : undefined;
}

export function providerContinuityRefs(tasks = []) {
    return new Set(tasks.map(providerContinuityRef).filter(Boolean));
}

function redactErrorString(value, refs) {
    let output = value;
    for (const ref of refs)
        output = output.split(ref).join(PROVIDER_SESSION_REDACTION);
    return output;
}

export function redactProviderContinuityRefs(value, refs) {
    if (!refs?.size || value === null || value === undefined)
        return value;
    if (Array.isArray(value))
        return value.map((item) => redactProviderContinuityRefs(item, refs));
    if (typeof value !== "object")
        return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
        if (key === "sessionId" && typeof child === "string" && refs.has(child))
            continue;
        if (key === "error" && typeof child === "string") {
            output[key] = redactErrorString(child, refs);
            continue;
        }
        output[key] = redactProviderContinuityRefs(child, refs);
    }
    return output;
}

export function publicAgentView(agent) {
    if (!agent || typeof agent !== "object" || Array.isArray(agent))
        return agent;
    return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        capabilities: agent.capabilities,
        governedTools: agent.governedTools,
        harnessKind: agent.harness?.kind,
        maxConcurrency: agent.maxConcurrency,
        priority: agent.priority,
    };
}

export function publicAgentListView(agents = []) {
    return agents.map(publicAgentView);
}

export function publicTaskView(task, refs = providerContinuityRefs([task])) {
    if (!task || typeof task !== "object" || Array.isArray(task))
        return task;
    const ownContinuityRef = providerContinuityRef(task);
    const { harnessState: _internalHarnessState, ...visible } = task;
    return {
        ...visible,
        ...(Object.hasOwn(visible, "result")
            ? { result: redactProviderContinuityRefs(visible.result, refs) }
            : {}),
        ...(Object.hasOwn(visible, "candidateResult")
            ? { candidateResult: redactProviderContinuityRefs(visible.candidateResult, refs) }
            : {}),
        ...(typeof visible.error === "string"
            ? { error: redactErrorString(visible.error, refs) }
            : {}),
        hasResumableSession: Boolean(ownContinuityRef),
    };
}

export function publicTaskListView(tasks = []) {
    const refs = providerContinuityRefs(tasks);
    return tasks.map((task) => publicTaskView(task, refs));
}

export function publicTaskGraphView(graph) {
    if (!graph || typeof graph !== "object")
        return graph;
    const refs = providerContinuityRefs(graph.nodes ?? []);
    return {
        ...graph,
        nodes: (graph.nodes ?? []).map((task) => publicTaskView(task, refs)),
        events: Array.isArray(graph.events)
            ? graph.events.map((record) => redactProviderContinuityRefs(record, refs))
            : graph.events,
    };
}

export function publicProgressView(progress, refs) {
    if (!progress || typeof progress !== "object")
        return progress;
    return {
        ...progress,
        task: publicTaskView(progress.task, refs ?? providerContinuityRefs([progress.task])),
    };
}

export function publicMemoryRecords(records = [], tasks = []) {
    const refs = providerContinuityRefs(tasks);
    if (!refs.size)
        return records;
    return records.map((record) => {
        const tags = Array.isArray(record?.tags) ? record.tags : [];
        if (!tags.some((tag) => TASK_RESULT_TAGS.has(tag)))
            return record;
        return {
            ...record,
            value: redactProviderContinuityRefs(record.value, refs),
        };
    });
}

export function publicRuntimeRecords(records = [], tasks = []) {
    const refs = providerContinuityRefs(tasks);
    return refs.size
        ? records.map((record) => redactProviderContinuityRefs(record, refs))
        : records;
}
