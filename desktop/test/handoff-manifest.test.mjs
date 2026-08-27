import assert from "node:assert/strict";
import test from "node:test";
import { extractHandoffManifest, handoffPromptInstruction } from "../src/main/lib/handoff-manifest.js";

const a = "coworker_0000000000000001";
const b = "coworker_0000000000000002";

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
