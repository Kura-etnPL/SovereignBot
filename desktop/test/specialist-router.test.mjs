import assert from "node:assert/strict";
import test from "node:test";
import { selectSpecialist } from "../src/main/lib/specialist-router.js";

const chief = { id: "chief", name: "Chief", role: "Coordinate the outcome", instructions: "Delegate bounded work", state: "active" };
const coder = { id: "coder", name: "Coding Lead", role: "Implement and test software", instructions: "Build and debug focused code changes", state: "active" };
const reviewer = { id: "reviewer", name: "Reviewer", role: "Review quality and security", instructions: "Audit and verify results", state: "active" };
const researcher = { id: "researcher", name: "Research Lead", role: "Investigate questions", instructions: "Gather evidence and cite sources", state: "active" };

test("specialist router selects only an active legal roster member with bounded delegate shape", () => {
  const decision = selectSpecialist({ objective: "Implement and test this software fix", currentCoworkerId: chief.id, candidates: [chief, coder, reviewer] });
  assert.deepEqual(Object.keys(decision).sort(), ["boundedTask", "handoffType", "reason", "targetCoworkerId"].sort());
  assert.equal(decision.targetCoworkerId, coder.id);
  assert.equal(decision.handoffType, "delegate");
  assert.equal(decision.boundedTask, "Implement and test this software fix");
  assert.equal("capability" in decision, false);
  assert.equal("provider" in decision, false);
  assert.equal("session" in decision, false);
});

test("specialist router uses goal and workload without waking inactive or current coworkers", () => {
  const decision = selectSpecialist({ objective: "Investigate the evidence and cite sources", currentCoworkerId: chief.id, candidates: [chief, { ...researcher, pendingCount: 4 }, { ...reviewer, state: "paused", pendingCount: 0 }] });
  assert.equal(decision.targetCoworkerId, researcher.id);
  assert.equal(decision.boundedTask.length <= 1_000, true);
  assert.equal(selectSpecialist({ objective: "Coordinate this", currentCoworkerId: chief.id, candidates: [chief, coder] }), undefined);
});
