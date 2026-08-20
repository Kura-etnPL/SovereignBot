import { join, resolve } from "node:path";
import { AuditLog } from "./audit.js";
import { Governor } from "./governor.js";
import { MemoryStore } from "./memory.js";
import { Orchestrator } from "./orchestrator.js";
import { PolicyEngine } from "./policy.js";
import { TaskEventStore } from "./task-events.js";
import { TaskStore } from "./task-store.js";

export async function createRuntime(config) {
    const dataDir = resolve(config.dataDir);
    const audit = new AuditLog(join(dataDir, "audit.jsonl"));
    await audit.init();
    const memory = new MemoryStore(join(dataDir, "memory.jsonl"));
    const tasks = new TaskStore(dataDir);
    const taskEvents = new TaskEventStore(dataDir);
    await taskEvents.init();
    const policy = new PolicyEngine(config.policy);
    const governor = new Governor(policy, audit);
    const orchestrator = new Orchestrator(config.agents, tasks, taskEvents, memory, governor, audit);
    return { config, orchestrator, memory, audit, taskEvents };
}
