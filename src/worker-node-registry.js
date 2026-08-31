const CLIENTS = new WeakMap();

export function registerAgentWorkerNodeClient(agent, resolver) {
    if (!agent || typeof agent !== "object")
        throw new Error("worker node client registration requires an agent");
    if (resolver === undefined || resolver === null)
        CLIENTS.delete(agent);
    else if (typeof resolver !== "function" && typeof resolver !== "object")
        throw new Error("worker node client registration requires a resolver or client");
    else
        CLIENTS.set(agent, resolver);
    return resolver;
}

registerAgentWorkerNodeClient.get = (agent) => CLIENTS.get(agent);
