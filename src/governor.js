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
            subject: action.target,
            data: {
                category: action.category,
                operation: action.operation,
                taskId: action.taskId,
                ruleId: decision.ruleId,
                reason: decision.reason,
                repeatCount: decision.repeatCount,
            },
        });
        return decision;
    }
}
