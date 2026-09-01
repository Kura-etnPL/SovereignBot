const ADAPTERS = new WeakMap();

function requireAgent(agent) {
    if (!agent || typeof agent !== "object") throw new Error("Economy adapter registration requires an agent");
}

export function registerAgentEconomyAdapter(agent, adapter) {
    requireAgent(agent);
    if (adapter === undefined || adapter === null) ADAPTERS.delete(agent);
    else ADAPTERS.set(agent, adapter);
}

export function economyAdapterFor(agent) {
    requireAgent(agent);
    return ADAPTERS.get(agent);
}
