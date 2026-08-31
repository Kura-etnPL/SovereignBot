import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSkillStore } from "../src/main/skill-store.js";
import { createSkillHandlers } from "../src/main/skill-integration.js";

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

test("skills support validated Coworker and Team assignment with restart persistence", () => {
  const root = mkdtempSync(join(tmpdir(), "sovereign-skill-assignment-"));
  const persistPath = join(root, "skills.json");
  const coworkerId = "coworker_0000000000000001";
  const teamId = "team_0000000000000001";
  try {
    const store = createSkillStore({ persistPath, makeSkillId: () => "skill_0000000000000002" });
    store.setTargetResolver({
      hasCoworker: (id) => id === coworkerId,
      hasTeam: (id) => id === teamId,
      teamIdsForCoworker: (id) => id === coworkerId ? [teamId] : [],
    });
    const skill = store.create({ name: "Review", instructions: "Check the bounded result." });
    assert.deepEqual(store.assign(skill.id, { targetKind: "coworker", targetId: coworkerId, enabled: true }).assignedCoworkerIds, [coworkerId]);
    assert.deepEqual(store.assign(skill.id, { targetKind: "team", targetId: teamId, enabled: true }).assignedTeamIds, [teamId]);
    assert.deepEqual(store.assignedSkillIdsForCoworkers([coworkerId]), [skill.id]);
    assert.throws(() => store.assign(skill.id, { targetKind: "team", targetId: "team_ffffffffffffffff", enabled: true }), /unknown team/);
    const handlers = createSkillHandlers({
      skillStore: store,
      conversationStore: {
        postUserMessage() {
          return { id: "msg_0000000000000002", delivery: { [coworkerId]: { status: "pending" } } };
        },
      },
      dispatchMessage: () => [],
    });
    const sent = handlers["conversation:send"]({ conversationId: "conv_0000000000000001", text: "Use the assigned workflow." });
    assert.deepEqual(sent.appliedSkillIds, [skill.id]);
    assert.deepEqual(store.skillsForMessage("msg_0000000000000002").map((entry) => entry.id), [skill.id]);

    const reloaded = createSkillStore({ persistPath });
    assert.deepEqual(reloaded.get(skill.id).assignedCoworkerIds, [coworkerId]);
    assert.deepEqual(reloaded.get(skill.id).assignedTeamIds, [teamId]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
