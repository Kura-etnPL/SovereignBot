export function publicTaskView(task) {
    if (!task || typeof task !== "object" || Array.isArray(task))
        return task;
    const { harnessState: _internalHarnessState, ...visible } = task;
    return {
        ...visible,
        hasResumableSession: Boolean(task.harnessState?.sessionId),
    };
}

export function publicTaskGraphView(graph) {
    if (!graph || typeof graph !== "object")
        return graph;
    return {
        ...graph,
        nodes: (graph.nodes ?? []).map(publicTaskView),
    };
}

export function publicProgressView(progress) {
    if (!progress || typeof progress !== "object")
        return progress;
    return {
        ...progress,
        task: publicTaskView(progress.task),
    };
}
