import { join, resolve } from "node:path";
import { AuditLog } from "./audit.js";
import { ComputerGateway } from "./computer-gateway.js";
import { ComputerRegistry } from "./computer-registry.js";
import { Governor } from "./governor.js";
import { MemoryStore } from "./memory.js";
import { Orchestrator } from "./orchestrator.js";
import { PolicyEngine } from "./policy.js";
import { TaskEventStore } from "./task-events.js";
import { TaskStore } from "./task-store.js";

export async function createRuntime(config, options = {}) {
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

    const computerRegistry = new ComputerRegistry(dataDir, config.agents.map((agent) => agent.id));
    await computerRegistry.init();
    const computer = new ComputerGateway({
        registry: computerRegistry,
        governor,
        audit,
        driverFactory: options.computerDriverFactory,
        allowPrivateHosts: config.computer?.allowPrivateHosts ?? false,
    });

    return {
        config,
        orchestrator,
        memory,
        audit,
        taskEvents,
        computer,
        computerRegistry,
    };
}
