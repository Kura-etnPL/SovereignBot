import { dryRunPolicy, validatePolicyDraft } from "./policy-dry-run.js";
import { PolicyEngine } from "./policy.js";

function repeatSettings(policy) {
    return {
        repeatWindowMs: policy.repeatWindowMs ?? 180_000,
        repeatMaxActiveFingerprints: policy.repeatMaxActiveFingerprints ?? 10_000,
    };
}

function sameRepeatSettings(a, b) {
    const left = repeatSettings(a);
    const right = repeatSettings(b);
    return left.repeatWindowMs === right.repeatWindowMs
        && left.repeatMaxActiveFingerprints === right.repeatMaxActiveFingerprints;
}

function safeVersionMetadata(version, activeId) {
    return {
        id: version.id,
        hash: version.hash,
        createdAt: version.createdAt,
        source: version.source,
        label: version.label,
        parentVersionId: version.parentVersionId,
        active: version.id === activeId,
    };
}

function validateChecks(policy, checks) {
    if (!Array.isArray(checks) || checks.length === 0)
        throw new Error("policy apply requires at least one dry-run check");
    if (checks.length > 50)
        throw new Error("policy apply accepts at most 50 dry-run checks");
    return checks.map((check, index) => {
        if (!check || typeof check !== "object" || Array.isArray(check))
            throw new Error(`policy apply check ${index} must be an object`);
        const result = dryRunPolicy({
            policy,
            action: check.action,
            repeatCount: check.repeatCount ?? 1,
        });
        if (!check.expect || typeof check.expect.allowed !== "boolean")
            throw new Error(`policy apply check ${index} must declare expect.allowed`);
        if (result.decision.allowed !== check.expect.allowed) {
            throw new Error(`policy apply check ${index} decision mismatch: expected allowed=${check.expect.allowed}`);
        }
        if (check.expect.ruleId !== undefined && result.decision.ruleId !== check.expect.ruleId) {
            throw new Error(`policy apply check ${index} rule mismatch`);
        }
        return {
            index,
            decision: result.decision,
        };
    });
}

export class PolicyManager {
    #store;
    #governor;
    #audit;
    #runtimeConfig;
    #queue = Promise.resolve();

    constructor({ store, governor, audit, runtimeConfig }) {
        this.#store = store;
        this.#governor = governor;
        this.#audit = audit;
        this.#runtimeConfig = runtimeConfig;
    }

    current() {
        return this.#store.current();
    }

    async snapshot() {
        const current = this.#store.current();
        const versions = await this.#store.listVersions();
        return {
            active: structuredClone(current.policy),
            version: safeVersionMetadata(current, current.id),
            versions: versions.map((version) => safeVersionMetadata(version, current.id)),
        };
    }

    async getVersion(id) {
        const current = this.#store.current();
        const version = await this.#store.readVersion(id);
        return {
            ...safeVersionMetadata(version, current.id),
            policy: structuredClone(version.policy),
        };
    }

    apply(input) {
        const operation = this.#queue.then(() => this.#applyNow(input));
        this.#queue = operation.catch(() => undefined);
        return operation;
    }

    rollback(input) {
        const operation = this.#queue.then(() => this.#rollbackNow(input));
        this.#queue = operation.catch(() => undefined);
        return operation;
    }

    async #applyNow({ policy, checks, actor = "operator-console", label } = {}) {
        const current = this.#store.current();
        const draft = validatePolicyDraft(policy);
        if (!sameRepeatSettings(current.policy, draft)) {
            throw new Error("repeatWindowMs and repeatMaxActiveFingerprints are restart-only safety settings and cannot change during live policy activation");
        }
        const checkResults = validateChecks(draft, checks);
        const version = await this.#store.createVersion(draft, {
            source: "apply",
            label,
            parentVersionId: current.id,
        });
        const activation = await this.#activate(version, current, {
            actor,
            auditType: "policy.activated",
        });
        return {
            ...activation,
            checks: checkResults,
        };
    }

    async #rollbackNow({ versionId, actor = "operator-console" } = {}) {
        const current = this.#store.current();
        const target = await this.#store.readVersion(versionId);
        if (target.id === current.id) {
            return {
                active: safeVersionMetadata(current, current.id),
                previousVersionId: current.id,
                noChange: true,
            };
        }
        if (!sameRepeatSettings(current.policy, target.policy)) {
            throw new Error("cannot live-roll back to a policy version with different repeat safety settings");
        }
        return this.#activate(target, current, {
            actor,
            auditType: "policy.rolled_back",
        });
    }

    async #activate(target, previous, { actor, auditType }) {
        // Build the new engine before changing durable or runtime authority state.
        const nextEngine = new PolicyEngine(target.policy);
        const previousEngine = new PolicyEngine(previous.policy);
        const transaction = await this.#store.beginActivation({
            fromVersionId: previous.id,
            toVersionId: target.id,
            toHash: target.hash,
        });

        let pointerMoved = false;
        let runtimeMoved = false;
        let committed = false;
        try {
            await this.#store.setActive(target);
            pointerMoved = true;
            this.#governor.replacePolicy(nextEngine);
            this.#runtimeConfig.policy = structuredClone(target.policy);
            runtimeMoved = true;

            await this.#audit.append({
                type: auditType,
                actor: String(actor || "operator-console").slice(0, 120),
                subject: target.id,
                data: {
                    transactionId: transaction.transactionId,
                    fromVersionId: previous.id,
                    toVersionId: target.id,
                    hash: target.hash,
                },
            });
            committed = true;

            // The audit record is the durable commit record. If marker cleanup fails after this point,
            // keep the new policy active. Startup reconciles the marker against that audit record.
            let recoveryPending = false;
            try {
                await this.#store.clearTransaction();
            }
            catch {
                recoveryPending = true;
            }
            return {
                active: safeVersionMetadata(target, target.id),
                previousVersionId: previous.id,
                transactionId: transaction.transactionId,
                recoveryPending,
            };
        }
        catch (error) {
            if (committed)
                throw error;
            const rollbackErrors = [];
            if (runtimeMoved) {
                try {
                    this.#governor.replacePolicy(previousEngine);
                    this.#runtimeConfig.policy = structuredClone(previous.policy);
                }
                catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
            if (pointerMoved) {
                try {
                    await this.#store.setActive(previous);
                }
                catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
            if (rollbackErrors.length === 0) {
                try {
                    await this.#store.clearTransaction();
                }
                catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
            }
            if (rollbackErrors.length) {
                throw new AggregateError(
                    [error, ...rollbackErrors],
                    `policy activation failed and rollback was incomplete: ${error.message}`,
                );
            }
            throw error;
        }
    }
}
