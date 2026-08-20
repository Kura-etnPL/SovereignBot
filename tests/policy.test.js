import assert from "node:assert/strict";
import test from "node:test";
import { PolicyEngine } from "../src/policy.js";
const action = {
    category: "harness",
    operation: "run",
    target: "codex",
    agentId: "worker-1",
};
test("policy fails closed when nothing allows the action", () => {
    const engine = new PolicyEngine({ rules: [] });
    assert.equal(engine.decide(action).allowed, false);
});
test("deny wins even when an allow rule also matches", () => {
    const engine = new PolicyEngine({
        rules: [
            { id: "allow", effect: "allow", match: { category: "harness" } },
            { id: "deny", effect: "deny", match: { targetGlob: "cod*" } },
        ],
    });
    const decision = engine.decide(action);
    assert.equal(decision.allowed, false);
    assert.equal(decision.ruleId, "deny");
});
test("repeat count can stop a looping action", () => {
    const engine = new PolicyEngine({
        rules: [
            { id: "stop-loop", effect: "deny", match: { repeatAtLeast: 3 } },
            { id: "allow", effect: "allow", match: { category: "harness" } },
        ],
    });
    assert.equal(engine.decide(action).allowed, true);
    assert.equal(engine.decide(action).allowed, true);
    const third = engine.decide(action);
    assert.equal(third.allowed, false);
    assert.equal(third.repeatCount, 3);
});
