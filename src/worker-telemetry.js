import { harnessActivitySnapshot } from "./harness.js";

const EXECUTION_STATUSES = new Set(["accepted", "running"]);
const REVIEW_STATUSES = new Set(["awaiting_review", "changes_requested"]);

function latestActivityByActor(events) {
    const latest = new Map();
    for (const event of events) {
        if (!event.actor)
            continue;
        const existing = latest.get(event.actor);
        if (!existing || String(event.at) >= String(existing.at)) {
            latest.set(event.actor, {
                taskId: event.taskId,
                type: event.type,
                at: event.at,
            });
        }
    }
    return latest;
}

export async function collectWorkerTelemetry(orchestrator) {
    const agents = orchestrator.listAgents();
    const tasks = await orchestrator.listTasks();
    const events = await orchestrator.taskEvents.list();
    const activity = harnessActivitySnapshot();
    const latestByActor = latestActivityByActor(events);
    const queued = tasks.filter((task) => task.kind !== "plan" && task.status === "queued");

    return agents.map((agent) => {
        const maxConcurrency = agent.maxConcurrency ?? 1;
        const inFlightHarnessCount = activity.get(agent.id) ?? 0;
        const assigned = tasks.filter((task) => task.assignedAgentId === agent.id);
        const activeTaskIds = assigned
            .filter((task) => EXECUTION_STATUSES.has(task.status))
            .map((task) => task.id);
        const reviewCount = assigned.filter((task) => REVIEW_STATUSES.has(task.status)).length;
        const resumableSessionTaskCount = assigned.filter((task) => Boolean(task.harnessState?.sessionId)).length;

        let compatibleQueuedCount = 0;
        let runnableQueuedCount = 0;
        for (const task of queued) {
            const compatible = orchestrator.compatibleAgents(task).some((candidate) => candidate.id === agent.id);
            if (!compatible)
                continue;
            compatibleQueuedCount += 1;
            if (orchestrator.dependencyState(task, tasks).ready)
                runnableQueuedCount += 1;
        }

        return {
            id: agent.id,
            name: agent.name,
            role: agent.role,
            harnessKind: agent.harness?.kind,
            capabilities: [...(agent.capabilities ?? [])],
            maxConcurrency,
            inFlightHarnessCount,
            remainingHarnessCapacity: Math.max(0, maxConcurrency - inFlightHarnessCount),
            activeTaskIds,
            reviewCount,
            compatibleQueuedCount,
            runnableQueuedCount,
            resumableSessionTaskCount,
            latestActivity: latestByActor.get(agent.id),
        };
    });
}
