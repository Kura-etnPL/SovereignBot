import { createOperatorFacade } from "../../vendor/core/src/operator-facade.js";

// Desktop operator bridge: binds the vendored Core OperatorFacade (fixed desktop principal)
// to enumerated IPC channels. Handlers receive already-validated payloads from ipc.js and
// never accept caller-chosen identities — the facade's actor is fixed at construction.
export function createOperatorBridge(runtime) {
    const facade = createOperatorFacade(runtime, { actor: "desktop-operator" });
    return {
        facade,
        handlers: {
            "operator:getOverview": () => facade.getOverview(),
            "operator:getWorkers": () => facade.getWorkers(),
            "operator:getAudit": ({ limit }) => facade.getAudit({ limit }),
            "operator:searchMemory": ({ scope, query }) => facade.searchMemory({ scope, query }),
            "operator:getPolicy": () => facade.getPolicy(),
            "operator:getPolicyVersion": ({ versionId }) => facade.getPolicyVersion(versionId),
            "operator:validatePolicy": ({ policy }) => facade.validatePolicy(policy),
            "operator:dryRunPolicy": ({ policy, action, repeatCount }) => facade.dryRunPolicy({ policy, action, repeatCount }),
            "operator:applyPolicy": ({ policy, checks, label }) => facade.applyPolicy({ policy, checks, label }),
            "operator:rollbackPolicy": ({ versionId }) => facade.rollbackPolicy({ versionId }),
            "operator:getTaskGraph": ({ taskId }) => facade.getTaskGraph(taskId),
            "operator:getTaskEvents": ({ taskId }) => facade.getTaskEvents(taskId),
            "computer:control": ({ agentId, action }) => facade.computerControl(agentId, action),
            "computer:lifecycle": ({ agentId, action }) => facade.computerLifecycle(agentId, action),
            // Plaintext crosses once into the facade; rejections are sanitized there.
            "computer:supplySecret": async ({ agentId, requestId, value }) => {
                await facade.supplySecret(agentId, requestId, value);
                return { supplied: true };
            },
        },
    };
}
