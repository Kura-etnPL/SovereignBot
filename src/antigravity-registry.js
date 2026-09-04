// Antigravity adapters are attached to in-memory agent identities only. Browser
// profiles, credentials, and continuity remain owned by the Desktop main process.
const ADAPTERS = new WeakMap();

export function registerAgentAntigravityAdapter(agent, adapter) {
    if (adapter === undefined || adapter === null) {
        ADAPTERS.delete(agent);
        return;
    }
    const required = ["start", "continue", "cancel", "health", "capabilities", "models"];
    if (!required.every((method) => typeof adapter[method] === "function"))
        throw new Error("Antigravity adapter does not implement the required boundary");
    ADAPTERS.set(agent, adapter);
}

export function antigravityAdapterFor(agent) {
    return ADAPTERS.get(agent);
}
