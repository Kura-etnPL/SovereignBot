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

function matchesAnyGlob(patterns, value) {
    const list = asArray(patterns);
    if (!list)
        return true;
    return list.some((pattern) => globToRegExp(pattern).test(value ?? ""));
}

function matchesExact(expected, actual) {
    const list = asArray(expected);
    return !list || list.includes(actual);
}

/**
 * Explain whether one policy rule matches without mutating repeat state.
 * Failure output intentionally contains condition names only, never action values.
 */
export function explainRuleMatch(rule, action, repeatCount) {
    const match = rule.match;
    if (!match)
        return { matched: true, failedConditions: [] };

    const failedConditions = [];
    if (!matchesExact(match.category, action.category))
        failedConditions.push("category");
    if (!matchesExact(match.operation, action.operation))
        failedConditions.push("operation");
    if (!matchesExact(match.agentId, action.agentId))
        failedConditions.push("agentId");
    if (!matchesExact(match.intent, action.intent))
        failedConditions.push("intent");
    if (!matchesExact(match.key, action.key))
        failedConditions.push("key");
    if (!matchesExact(match.elementRole, action.element?.role))
        failedConditions.push("elementRole");
    if (!matchesExact(match.elementType, action.element?.type))
        failedConditions.push("elementType");
    if (!matchesExact(match.fileExtension, action.file?.extension))
        failedConditions.push("fileExtension");

    if (!matchesAnyGlob(match.targetGlob, action.target))
        failedConditions.push("targetGlob");
    if (!matchesAnyGlob(match.pageUrlGlob, action.page?.url))
        failedConditions.push("pageUrlGlob");
    if (!matchesAnyGlob(match.pageHostGlob, action.page?.host))
        failedConditions.push("pageHostGlob");
    if (!matchesAnyGlob(match.elementRefGlob, action.element?.ref))
        failedConditions.push("elementRefGlob");
    if (!matchesAnyGlob(match.elementNameGlob, action.element?.name))
        failedConditions.push("elementNameGlob");
    if (!matchesAnyGlob(match.filePathGlob, action.file?.path))
        failedConditions.push("filePathGlob");
    if (!matchesAnyGlob(match.fileNameGlob, action.file?.name))
        failedConditions.push("fileNameGlob");

    if (match.repeatAtLeast !== undefined && repeatCount < match.repeatAtLeast)
        failedConditions.push("repeatAtLeast");
    return { matched: failedConditions.length === 0, failedConditions };
}

function matchesRule(rule, action, repeatCount) {
    return explainRuleMatch(rule, action, repeatCount).matched;
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
            action.repeatKey ?? action.target ?? "",
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

    decide(action, options = {}) {
        // Direct/in-memory callers keep the original synchronous semantics. Production Governor can
        // supply a repeatCount that was durably persisted before policy evaluation.
        const repeatCount = options.repeatCount ?? this.#repeat.count(action);

        if (action.hardDeny) {
            return {
                allowed: false,
                ruleId: "__safety__",
                reason: action.hardDeny,
                repeatCount,
            };
        }

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
