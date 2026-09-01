import { join, resolve } from "node:path";
import { AuditLog } from "./audit.js";
import { ComputerGateway } from "./computer-gateway.js";
import { ComputerLifecycleManager } from "./computer-lifecycle.js";
import { ComputerRegistry } from "./computer-registry.js";
import { GovernedToolBridgeManager } from "./governed-tool-bridge.js";
import { Governor } from "./governor.js";
import { registerAgentToolBridgeManager } from "./harness.js";
import { registerAgentWorkerNodeClient } from "./worker-node-harness.js";
import { registerAgentChatGPTWebAdapter } from "./chatgpt-web-harness.js";
import { registerAgentAntigravityAdapter } from "./antigravity-harness.js";
import { MemoryStore } from "./memory.js";
import { OperatorSessionStore } from "./operator-session.js";
import { Orchestrator } from "./orchestrator.js";
import { PolicyManager } from "./policy-manager.js";
import { PolicyEngine } from "./policy.js";
import { PolicyVersionStore } from "./policy-version-store.js";
import { RepeatStore } from "./repeat-store.js";
import { createWebDriverSidecarFactory } from "./sidecar-computer-driver.js";
import { preflightRuntimeStartup } from "./startup-preflight.js";
import { TaskBoundComputerGateway } from "./task-bound-computer.js";
import { TaskEventStore } from "./task-events.js";
import { TaskStore } from "./task-store.js";

export async function createRuntime(config, options = {}) {
    // This must remain the first stateful boundary in runtime construction. It performs reads only
    // and refuses hard state-integrity/filesystem failures before normal initialization can create,
    // prune, migrate, recover, or otherwise mutate unrelated runtime state.
    await preflightRuntimeStartup(config);

    const dataDir = resolve(config.dataDir);
    const audit = new AuditLog(join(dataDir, "audit.jsonl"));
    await audit.init();

    const policyVersions = options.policyVersionStore ?? new PolicyVersionStore(dataDir);
    const policyBootstrap = await policyVersions.init(config.policy, { audit });
    const activePolicyVersion = policyBootstrap.version;
    const runtimeConfig = {
        ...config,
        policy: structuredClone(activePolicyVersion.policy),
    };

    const memory = new MemoryStore(join(dataDir, "memory.jsonl"));
    const tasks = new TaskStore(dataDir);
    const taskEvents = new TaskEventStore(dataDir);
    await taskEvents.init();
    const policy = new PolicyEngine(runtimeConfig.policy);
    const repeatStore = options.repeatStore ?? new RepeatStore(dataDir, {
        windowMs: runtimeConfig.policy.repeatWindowMs ?? 180_000,
        maxActiveFingerprints: runtimeConfig.policy.repeatMaxActiveFingerprints ?? 10_000,
    });
    await repeatStore.init?.();
    const operatorSessions = options.operatorSessions ?? new OperatorSessionStore(dataDir);
    await operatorSessions.init?.();
    const governor = new Governor(policy, audit, repeatStore);
    const policyManager = new PolicyManager({
        store: policyVersions,
        governor,
        audit,
        runtimeConfig,
    });
    const orchestrator = new Orchestrator(runtimeConfig.agents, tasks, taskEvents, memory, governor, audit);

    const computerRegistry = new ComputerRegistry(dataDir, runtimeConfig.agents.map((agent) => agent.id));
    await computerRegistry.init();

    let managedComputerDriverFactory;
    let computerDriverFactory = options.computerDriverFactory;
    if (!computerDriverFactory && runtimeConfig.computer?.driver?.kind === "webdriver-sidecar") {
        managedComputerDriverFactory = createWebDriverSidecarFactory({
            ...runtimeConfig.computer.driver,
            allowPrivateHosts: runtimeConfig.computer.allowPrivateHosts ?? false,
        });
        computerDriverFactory = managedComputerDriverFactory;
    }

    const rawComputer = new ComputerGateway({
        registry: computerRegistry,
        governor,
        audit,
        driverFactory: computerDriverFactory,
        allowPrivateHosts: runtimeConfig.computer?.allowPrivateHosts ?? false,
    });

    const computer = options.bindComputerToTasks === false
        ? rawComputer
        : new TaskBoundComputerGateway({
            inner: rawComputer,
            taskResolver: (taskId) => tasks.get(taskId),
            registry: computerRegistry,
            governor,
        });

    const computerLifecycle = new ComputerLifecycleManager({
        registry: computerRegistry,
        driverFactory: computerDriverFactory,
        audit,
    });

    const governedToolBridge = new GovernedToolBridgeManager({ dataDir, computer, audit });
    for (const agent of runtimeConfig.agents) {
        if (Array.isArray(agent.governedTools) && agent.governedTools.length)
            registerAgentToolBridgeManager(agent, governedToolBridge);
        if (agent.harness?.kind === "worker-node" && options.workerNodeClientResolver)
            registerAgentWorkerNodeClient(agent, options.workerNodeClientResolver);
        if (agent.harness?.kind === "chatgpt-web" && options.chatgptWebAdapterResolver)
            registerAgentChatGPTWebAdapter(agent, options.chatgptWebAdapterResolver(agent));
        if (agent.harness?.kind === "antigravity" && options.antigravityAdapterResolver)
            registerAgentAntigravityAdapter(agent, options.antigravityAdapterResolver(agent));
    }

    return {
        config: runtimeConfig,
        orchestrator,
        memory,
        audit,
        taskEvents,
        repeatStore,
        operatorSessions,
        policyVersions,
        policyManager,
        computer,
        rawComputer,
        computerLifecycle,
        computerRegistry,
        governedToolBridge,
        policyBootstrapped: policyBootstrap.bootstrapped,
        async close() {
            for (const agent of runtimeConfig.agents) {
                if (agent.harness?.kind === "worker-node")
                    registerAgentWorkerNodeClient(agent, undefined);
                if (agent.harness?.kind === "chatgpt-web")
                    registerAgentChatGPTWebAdapter(agent, undefined);
                if (agent.harness?.kind === "antigravity")
                    registerAgentAntigravityAdapter(agent, undefined);
            }
            await governedToolBridge.close();
            await (managedComputerDriverFactory ?? computerDriverFactory)?.close?.();
        },
    };
}
