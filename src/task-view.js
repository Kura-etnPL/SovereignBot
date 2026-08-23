const RESUMABLE_PROVIDER_KINDS = new Set(["codex", "claude-code"]);
const TASK_RESULT_TAGS = new Set(["task-result", "candidate-result"]);

function providerContinuityRef(task) {
    const state = task?.harnessState;
    return RESUMABLE_PROVIDER_KINDS.has(state?.kind) && typeof state.sessionId === "string" && state.sessionId
        ? state.sessionId
        : undefined;
}

export function providerContinuityRefs(tasks = []) {
    return new Set(tasks.map(providerContinuityRef).filter(Boolean));
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
        output[key] = redactProviderContinuityRefs(child, refs);
    }
    return output;
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
