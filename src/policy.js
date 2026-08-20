function asArray(value) {
    return value === undefined ? undefined : Array.isArray(value) ? value : [value];
}
function globToRegExp(glob) {
    let out = "^";
    for (const char of glob) {
        if (char === "*")
            out += ".*";
        else if (char === "?")
            out += ".";
        else
            out += char.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&");
    }
    return new RegExp(`${out}$`, "i");
}
function matchesRule(rule, action, repeatCount) {
    const match = rule.match;
    if (!match)
        return true;
    const categories = asArray(match.category);
    if (categories && !categories.includes(action.category))
        return false;
    const operations = asArray(match.operation);
    if (operations && !operations.includes(action.operation))
        return false;
    const agents = asArray(match.agentId);
    if (agents && (!action.agentId || !agents.includes(action.agentId)))
        return false;
    if (match.targetGlob && !globToRegExp(match.targetGlob).test(action.target ?? ""))
        return false;
    if (match.repeatAtLeast !== undefined && repeatCount < match.repeatAtLeast)
        return false;
    return true;
}
class RepeatTracker {
    #windowMs;
    #seen = new Map();
    constructor(windowMs) {
        this.#windowMs = windowMs;
    }
    count(action) {
        const now = Date.now();
        const key = JSON.stringify([
            action.agentId ?? "",
            action.category,
            action.operation,
            action.target ?? "",
            action.taskId ?? "",
        ]);
        const fresh = (this.#seen.get(key) ?? []).filter((at) => now - at <= this.#windowMs);
        fresh.push(now);
        this.#seen.set(key, fresh);
        return fresh.length;
    }
}
export class PolicyEngine {
    #rules;
    #repeat;
    constructor(config) {
        this.#rules = config.rules;
        this.#repeat = new RepeatTracker(config.repeatWindowMs ?? 180_000);
    }
    decide(action) {
        const repeatCount = this.#repeat.count(action);
        for (const rule of this.#rules.filter((candidate) => candidate.effect === "deny")) {
            if (matchesRule(rule, action, repeatCount)) {
                return {
                    allowed: false,
                    ruleId: rule.id,
                    reason: rule.description ?? `denied by ${rule.id}`,
                    repeatCount,
                };
            }
        }
        for (const rule of this.#rules.filter((candidate) => candidate.effect === "allow")) {
            if (matchesRule(rule, action, repeatCount)) {
                return {
                    allowed: true,
                    ruleId: rule.id,
                    reason: rule.description ?? `allowed by ${rule.id}`,
                    repeatCount,
                };
            }
        }
        return {
            allowed: false,
            reason: "no allow rule matched (fail closed)",
            repeatCount,
        };
    }
}
