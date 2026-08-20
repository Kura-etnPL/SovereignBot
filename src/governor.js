function sanitizeUrl(value) {
    if (!value || typeof value !== "string")
        return value;
    try {
        const parsed = new URL(value);
        if (!["http:", "https:"].includes(parsed.protocol))
            return value;
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
    }
    catch {
        return value;
    }
}

function auditSubject(action) {
    return action.category === "computer" ? sanitizeUrl(action.target) : action.target;
}

function safePage(page) {
    if (!page)
        return undefined;
    return {
        url: sanitizeUrl(page.url),
        host: page.host,
    };
}

export class Governor {
    policy;
    audit;

    constructor(policy, audit) {
        this.policy = policy;
        this.audit = audit;
    }

    async authorize(action) {
        let decision;
        try {
            decision = this.policy.decide(action);
        }
        catch (error) {
            decision = {
                allowed: false,
                reason: `policy evaluation failed: ${error.message}`,
                repeatCount: 0,
            };
        }
        await this.audit.append({
            type: decision.allowed ? "action.allowed" : "action.denied",
            actor: action.agentId ?? "runtime",
            subject: auditSubject(action),
            data: {
                category: action.category,
                operation: action.operation,
                taskId: action.taskId,
                intent: action.intent,
                page: safePage(action.page),
                element: action.element,
                file: action.file,
                key: action.key,
                ruleId: decision.ruleId,
                reason: decision.reason,
                repeatCount: decision.repeatCount,
            },
        });
        return decision;
    }
}
