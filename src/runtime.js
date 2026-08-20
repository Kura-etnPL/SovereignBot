import { join, resolve } from "node:path";
import { AuditLog } from "./audit.js";
import { ComputerGateway } from "./computer-gateway.js";
import { ComputerRegistry } from "./computer-registry.js";
import { Governor } from "./governor.js";
import { MemoryStore } from "./memory.js";
import { Orchestrator } from "./orchestrator.js";
import { PolicyEngine } from "./policy.js";
import { createWebDriverSidecarFactory } from "./sidecar-computer-driver.js";
import { TaskBoundComputerGateway } from "./task-bound-computer.js";
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

    let managedComputerDriverFactory;
    let computerDriverFactory = options.computerDriverFactory;
    if (!computerDriverFactory && config.computer?.driver?.kind === "webdriver-sidecar") {
        managedComputerDriverFactory = createWebDriverSidecarFactory({
            ...config.computer.driver,
            allowPrivateHosts: config.computer.allowPrivateHosts ?? false,
        });
        computerDriverFactory = managedComputerDriverFactory;
    }

    const rawComputer = new ComputerGateway({
        registry: computerRegistry,
        governor,
        audit,
        driverFactory: computerDriverFactory,
        allowPrivateHosts: config.computer?.allowPrivateHosts ?? false,
    });

    // Production callers get task ownership binding by default. Low-level gateway contract tests may
    // explicitly disable it so they can test refs/secrets/workspace mechanics without constructing an
    // unrelated running task for every call.
    const computer = options.bindComputerToTasks === false
        ? rawComputer
        : new TaskBoundComputerGateway({
            inner: rawComputer,
            taskResolver: (taskId) => tasks.get(taskId),
            registry: computerRegistry,
            governor,
        });

    return {
        config,
        orchestrator,
        memory,
        audit,
        taskEvents,
        computer,
        rawComputer,
        computerRegistry,
        async close() {
            await managedComputerDriverFactory?.close?.();
        },
    };
}
