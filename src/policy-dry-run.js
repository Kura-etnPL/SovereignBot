import { explainRuleMatch } from "./policy.js";

const MATCH_FIELDS = new Set([
    "category",
    "operation",
    "agentId",
    "intent",
    "key",
    "elementRole",
    "elementType",
    "fileExtension",
    "targetGlob",
    "pageUrlGlob",
    "pageHostGlob",
    "elementRefGlob",
    "elementNameGlob",
    "filePathGlob",
    "fileNameGlob",
    "repeatAtLeast",
]);

function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOrArray(value, name) {
    if (typeof value === "string" && value.length)
        return;
    if (Array.isArray(value) && value.length && value.every((entry) => typeof entry === "string" && entry.length))
        return;
    throw new Error(`${name} must be a non-empty string or non-empty array of strings`);
}

function optionalPositiveInteger(value, name) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0))
        throw new Error(`${name} must be a positive integer`);
}

export function validatePolicyDraft(policy) {
    if (!isObject(policy))
        throw new Error("policy draft must be an object");
    if (!Array.isArray(policy.rules))
        throw new Error("policy draft rules must be an array");
    optionalPositiveInteger(policy.repeatWindowMs, "policy.repeatWindowMs");
    optionalPositiveInteger(policy.repeatMaxActiveFingerprints, "policy.repeatMaxActiveFingerprints");

    const ids = new Set();
    for (let index = 0; index < policy.rules.length; index += 1) {
        const rule = policy.rules[index];
        const prefix = `policy.rules[${index}]`;
        if (!isObject(rule))
            throw new Error(`${prefix} must be an object`);
        if (typeof rule.id !== "string" || !rule.id.trim())
            throw new Error(`${prefix}.id must be a non-empty string`);
        if (ids.has(rule.id))
            throw new Error(`duplicate policy rule id: ${rule.id}`);
        ids.add(rule.id);
        if (!new Set(["allow", "deny"]).has(rule.effect))
            throw new Error(`${prefix}.effect must be allow or deny`);
        if (rule.description !== undefined && typeof rule.description !== "string")
            throw new Error(`${prefix}.description must be a string`);
        if (rule.match === undefined)
            continue;
        if (!isObject(rule.match))
            throw new Error(`${prefix}.match must be an object`);
        for (const [key, value] of Object.entries(rule.match)) {
            if (!MATCH_FIELDS.has(key))
                throw new Error(`${prefix}.match contains unsupported field: ${key}`);
            if (key === "repeatAtLeast")
                optionalPositiveInteger(value, `${prefix}.match.repeatAtLeast`);
            else
                stringOrArray(value, `${prefix}.match.${key}`);
        }
    }
    return structuredClone(policy);
}

function validateAction(action) {
    if (!isObject(action))
        throw new Error("simulated action must be an object");
    if (typeof action.category !== "string" || !action.category.trim())
        throw new Error("simulated action.category must be a non-empty string");
    if (typeof action.operation !== "string" || !action.operation.trim())
        throw new Error("simulated action.operation must be a non-empty string");
    if (action.hardDeny !== undefined && typeof action.hardDeny !== "string")
        throw new Error("simulated action.hardDeny must be a string when supplied");
    return action;
}

function safeDecision(allowed, ruleId, repeatCount, hardSafety = false) {
    return {
        allowed,
        ruleId,
        reason: hardSafety
            ? "blocked by simulated hard-safety invariant"
            : ruleId
                ? `${allowed ? "would be allowed" : "would be denied"} by ${ruleId}`
                : "no allow rule matched (fail closed)",
        repeatCount,
        hardSafety,
    };
}

/**
 * Pure evaluator for operator policy drafts.
 * It never calls Governor, RepeatStore, AuditLog, ComputerGateway, or any harness.
 */
export function dryRunPolicy({ policy, action, repeatCount = 1 }) {
    const draft = validatePolicyDraft(policy);
    const simulatedAction = validateAction(action);
    if (!Number.isInteger(repeatCount) || repeatCount <= 0)
        throw new Error("simulated repeatCount must be a positive integer");

    const explanation = [];
    if (simulatedAction.hardDeny) {
        explanation.push({
            stage: "hard-safety",
            matched: true,
            ruleId: "__safety__",
            effect: "deny",
            failedConditions: [],
        });
        return {
            decision: safeDecision(false, "__safety__", repeatCount, true),
            explanation,
        };
    }

    const denied = draft.rules.filter((rule) => rule.effect === "deny");
    for (const rule of denied) {
        const result = explainRuleMatch(rule, simulatedAction, repeatCount);
        explanation.push({
            stage: "deny",
            ruleId: rule.id,
            effect: rule.effect,
            matched: result.matched,
            failedConditions: result.failedConditions,
        });
        if (result.matched) {
            return {
                decision: safeDecision(false, rule.id, repeatCount),
                explanation,
            };
        }
    }

    const allowed = draft.rules.filter((rule) => rule.effect === "allow");
    for (const rule of allowed) {
        const result = explainRuleMatch(rule, simulatedAction, repeatCount);
        explanation.push({
            stage: "allow",
            ruleId: rule.id,
            effect: rule.effect,
            matched: result.matched,
            failedConditions: result.failedConditions,
        });
        if (result.matched) {
            return {
                decision: safeDecision(true, rule.id, repeatCount),
                explanation,
            };
        }
    }

    explanation.push({
        stage: "default",
        effect: "deny",
        matched: true,
        failedConditions: [],
    });
    return {
        decision: safeDecision(false, undefined, repeatCount),
        explanation,
    };
}
