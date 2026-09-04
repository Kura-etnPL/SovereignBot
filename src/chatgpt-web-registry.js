// ChatGPT Web adapters are attached to in-memory agent identities only.  The adapter
// owns browser/profile/continuity details; none of those values are serialized into Core.
const ADAPTERS = new WeakMap();

export function registerAgentChatGPTWebAdapter(agent, adapter) {
    if (adapter === undefined || adapter === null) {
        ADAPTERS.delete(agent);
        return;
    }
    const required = ["start", "continue", "cancel", "health", "capabilities", "models"];
    if (!required.every((method) => typeof adapter[method] === "function"))
        throw new Error("ChatGPT Web adapter does not implement the required boundary");
    ADAPTERS.set(agent, adapter);
}

export function chatGPTWebAdapterFor(agent) {
    return ADAPTERS.get(agent);
}
