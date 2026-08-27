import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSkillStore } from "../src/main/skill-store.js";

test("skills persist message invocation and decorate only the model-facing conversation copy", () => {
  const root = mkdtempSync(join(tmpdir(), "sovereign-skills-"));
  const persistPath = join(root, "skills.json");
  try {
    const store = createSkillStore({
      persistPath,
      makeSkillId: () => "skill_0000000000000001",
      now: () => "2026-08-27T00:00:00.000Z",
    });
    const skill = store.create({
      name: "Release Builder",
      description: "Prepare a release without skipping checks that matter.",
      instructions: "Inspect the current release state, build the requested artifact, and report the exact output.",
    });
    store.bindMessage("msg_0000000000000001", [skill.id]);

    const conversation = {
      id: "conv_0000000000000001",
      messages: [{ id: "msg_0000000000000001", senderId: "user", text: "Ship this build." }],
    };
    const decorated = store.decorateConversation(conversation);
    assert.equal(conversation.messages[0].text, "Ship this build.");
    assert.match(decorated.messages[0].text, /Ship this build\./);
    assert.match(decorated.messages[0].text, /Skill: Release Builder/);
    assert.match(decorated.messages[0].text, /Inspect the current release state/);

    const reloaded = createSkillStore({ persistPath });
    assert.deepEqual(reloaded.skillsForMessage("msg_0000000000000001").map((entry) => entry.id), [skill.id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
