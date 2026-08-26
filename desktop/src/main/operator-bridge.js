import { createOperatorFacade } from "../../vendor/core/src/operator-facade.js";

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
            // Read-only observation is bound to the current runtime directly so `npm start`
            // does not depend on a prior vendored-Core sync. Packaging still syncs Core as usual.
            "computer:frame": ({ agentId }) => runtime.computerLifecycle.frame(agentId),
            "computer:supplySecret": async ({ agentId, requestId, value }) => {
                await facade.supplySecret(agentId, requestId, value);
                return { supplied: true };
            },
        },
    };
}