import assert from "node:assert/strict";
import test from "node:test";
import { extractCompletionManifest, extractFanoutManifest, extractHandoffManifest, extractReviewDecision, fanoutPromptInstruction, handoffPromptInstruction, reviewPromptInstruction } from "../src/main/lib/handoff-manifest.js";

const a = "coworker_0000000000000001";
const b = "coworker_0000000000000002";

test("completion manifest accepts only the final structured reply-only marker", () => {
  const parsed = extractCompletionManifest('Chief confirmation.\nSOVEREIGN_COMPLETION: "reply-only"');
  assert.equal(parsed.text, "Chief confirmation.");
  assert.equal(parsed.requested, true);
  assert.equal(parsed.invalidManifest, undefined);
});

test("completion manifest rejects duplicates, non-final markers, and unsupported values", () => {
  for (const text of [
    'SOVEREIGN_COMPLETION: "reply-only"\nStill talking.',
    'SOVEREIGN_COMPLETION: "reply-only"\nSOVEREIGN_COMPLETION: "reply-only"',
    'SOVEREIGN_COMPLETION: "complete"',
    'SOVEREIGN_COMPLETION: reply-only',
  ]) {
    const parsed = extractCompletionManifest(text);
    assert.equal(parsed.requested, false);
    assert.equal(parsed.invalidManifest, true);
    assert.doesNotMatch(parsed.text, /SOVEREIGN_COMPLETION/);
  }
  assert.deepEqual(extractCompletionManifest("ordinary reply"), { text: "ordinary reply", requested: false });
});

test("handoff manifest accepts only listed teammates and strips the internal marker", () => {
  const parsed = extractHandoffManifest(`I finished research and Coding Lead should implement next.\nSOVEREIGN_HANDOFFS: ["${b}"]`, [a, b]);
  assert.equal(parsed.text, "I finished research and Coding Lead should implement next.");
  assert.deepEqual(parsed.coworkerIds, [b]);
  assert.equal(parsed.invalidManifest, undefined);
});

test("unknown handoff target is rejected and hidden from the visible reply", () => {
  const unknown = "coworker_ffffffffffffffff";
  const parsed = extractHandoffManifest(`I cannot route this target.\nSOVEREIGN_HANDOFFS: ["${unknown}"]`, [a, b]);
  assert.equal(parsed.text, "I cannot route this target.");
  assert.deepEqual(parsed.coworkerIds, []);
  assert.equal(parsed.invalidManifest, true);
  assert.doesNotMatch(parsed.text, /SOVEREIGN_HANDOFFS/);
});

test("handoff prompt names only the explicitly available coworkers", () => {
  const prompt = handoffPromptInstruction([{ id: b, name: "Coding Lead", role: "Build" }]);
  assert.match(prompt, new RegExp(b));
  assert.match(prompt, /Coding Lead/);
  assert.doesNotMatch(prompt, new RegExp(a));
});

test("review decision manifest accepts only the two protocol decisions", () => {
  const approved = extractReviewDecision(`Review complete.\nSOVEREIGN_REVIEW: "approved"`);
  assert.equal(approved.text, "Review complete.");
  assert.equal(approved.decision, "approved");
  const rejected = extractReviewDecision(`Review complete.\nSOVEREIGN_REVIEW: "ship-it"`);
  assert.equal(rejected.decision, undefined);
  assert.equal(rejected.invalidDecision, true);
  assert.match(reviewPromptInstruction(), /approved/);
  assert.match(reviewPromptInstruction(), /changes-requested/);
});

test("fanout manifest requires bounded unique children and an independent reviewer", () => {
  const research = "coworker_1111111111111111";
  const coder = "coworker_2222222222222222";
  const reviewer = "coworker_3333333333333333";
  const parsed = extractFanoutManifest(`Parallelize this.\nSOVEREIGN_FANOUT: ${JSON.stringify({ reviewerCoworkerId: reviewer, children: [{ key: "research", coworkerId: research, task: "Gather evidence." }, { key: "implement", coworkerId: coder, task: "Implement the isolated fix." }] })}`, [research, coder, reviewer]);
  assert.deepEqual(parsed.children.map((entry) => entry.key), ["research", "implement"]);
  assert.equal(parsed.children[0].workspace, "private");
  assert.equal(extractFanoutManifest(`SOVEREIGN_FANOUT: ${JSON.stringify({ reviewerCoworkerId: reviewer, children: [{ key: "same", coworkerId: research, task: "one" }, { key: "same", coworkerId: coder, task: "two" }] })}`, [research, coder, reviewer]).invalidManifest, true);
  assert.match(fanoutPromptInstruction([{ name: "Research", id: research }, { name: "Coder", id: coder }]), /SOVEREIGN_FANOUT/);
});
