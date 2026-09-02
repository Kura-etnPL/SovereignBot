import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProductSurfaceService } from "../src/main/product-surface-service.js";
import { createSkillStore } from "../src/main/skill-store.js";

function fixture() {
  const team = { id: "team_1111111111111111", name: "Software", packId: "custom-team", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", playbooks: [{ id: "delivery", name: "Delivery", description: "Ship safely", steps: ["chief", "reviewer"] }], channels: [{ id: "channel_1111111111111111", teamId: "team_1111111111111111", name: "Project", playbookId: "delivery", conversationId: "conv_1111111111111111" }] };
  const teams = [team];
  const teamService = {
    list: () => ({ teams }),
    get: (id) => teams.find((entry) => entry.id === id),
    getChannel: (id) => teams.flatMap((entry) => entry.channels).find((entry) => entry.id === id),
    importPlaybook: (teamId, playbook) => { const { schema, ...definition } = playbook; teams.find((entry) => entry.id === teamId).playbooks.push({ ...definition, steps: [...playbook.steps], ...(playbook.stages ? { stages: structuredClone(playbook.stages) } : {}), ...(playbook.reviewPoints ? { reviewPoints: structuredClone(playbook.reviewPoints) } : {}), ...(playbook.recommendedCoworkerRoles ? { recommendedCoworkerRoles: [...playbook.recommendedCoworkerRoles] } : {}), ...(playbook.recommendedSkillIds ? { recommendedSkillIds: [...playbook.recommendedSkillIds] } : {}) }); },
    updatePlaybook: (teamId, playbookId, patch) => { const entry = teams.find((item) => item.id === teamId).playbooks.find((item) => item.id === playbookId); Object.assign(entry, { name: patch.name, description: patch.description, steps: [...patch.steps], ...(patch.stages !== undefined ? { stages: structuredClone(patch.stages) } : {}), ...(patch.reviewPoints !== undefined ? { reviewPoints: structuredClone(patch.reviewPoints) } : {}), ...(patch.expectedOutput !== undefined ? { expectedOutput: patch.expectedOutput } : {}), ...(patch.recommendedCoworkerRoles !== undefined ? { recommendedCoworkerRoles: [...patch.recommendedCoworkerRoles] } : {}), ...(patch.recommendedSkillIds !== undefined ? { recommendedSkillIds: [...patch.recommendedSkillIds] } : {}) }); },
    updateChannel: (channelId, patch) => { const channel = teamService.getChannel(channelId); Object.assign(channel, patch); },
    exportPack: () => ({ schema: "sovereignbot.desktop.team-pack.v1", id: "custom-team", name: "Software", description: "Software", coworkers: [{ key: "chief", name: "Chief", role: "Chief", instructions: "Lead" }, { key: "reviewer", name: "Reviewer", role: "Reviewer", instructions: "Review" }], channels: [{ key: "project", name: "Project", kind: "project", instructions: "Work", playbookId: "delivery" }], playbooks: [{ id: "delivery", name: "Delivery", description: "Ship safely", steps: ["chief", "reviewer"] }] }),
  };
  return { team, teamService };
}

test("product surfaces provide safe playbook, artifact, computer, and pack projections", async () => {
  const { team, teamService } = fixture();
  const service = createProductSurfaceService({
    dataDir: mkdtempSync(join(tmpdir(), "sovereign-product-")), teamService,
    coworkerStore: { get: (id) => ({ id, name: id === "coworker_1111111111111111" ? "Coding Lead" : "Coworker" }) },
    artifactStore: { list: () => ({ artifacts: [{ id: "artifact_1111111111111111", title: "result C:\\private\\takeover.txt token=never-show", fileName: "result.md", mimeType: "text/markdown", size: 10, createdAt: "2026-09-01T00:00:00.000Z", createdByCoworkerId: "coworker_1111111111111111", conversationId: "conv_1111111111111111", storageRelativePath: "secret", sourceRelativePath: "private/result.md" }, { id: "artifact_2222222222222222", title: "loose", fileName: "loose.md", mimeType: "text/markdown", size: 5, createdAt: "2026-09-01T00:00:00.000Z" }] }) },
    runtime: { audit: { readAll: async () => [{ id: "audit_1", at: "2026-09-01T00:00:00.000Z", type: "computer.action_succeeded", data: { action: "click", app: "Browser", ok: true } }, { id: "audit_2", at: "2026-09-01T00:00:00.500Z", type: "task.completed", data: { title: "Review result", app: "Editor", ok: true } }, { id: "audit_4", at: "2026-09-01T00:00:00.750Z", type: "computer.action_failed", actor: "coworker_1111111111111111", data: { operation: "click", intent: "Review result", app: "Browser", error: "C:\\private\\takeover.txt token=never-show" } }, { id: "audit_3", at: "2026-09-01T00:00:01.000Z", type: "computer.secret_supplied", data: { password: "never-show" } }] } },
    now: () => "2026-09-01T00:00:02.000Z",
  });
  const library = service.listPlaybooks();
  assert.equal(library.playbooks.some((entry) => entry.id === "delivery"), true);
  const created = service.createPlaybook({ name: "Release", description: "Bounded release", steps: ["chief", "reviewer"] });
  assert.equal(service.duplicatePlaybook(created.id).name, "Release copy");
  service.assignPlaybook(created.id, { channelId: team.channels[0].id });
  assert.equal(team.channels[0].playbookId, created.id);
  service.updatePlaybook("delivery", { name: "Delivery updated", description: "Updated", steps: ["chief", "reviewer"] });
  assert.equal(team.playbooks.find((entry) => entry.id === "delivery").name, "Delivery updated");
  assert.equal(service.artifactHub().artifacts[0].storageRelativePath, undefined);
  assert.equal(service.artifactHub().artifacts[0].sourceRelativePath, undefined);
  assert.equal(service.artifactHub({ type: "text/markdown" }).artifacts.length, 2);
  assert.equal(service.artifactHub().artifacts[0].history[0].event, "created");
  assert.equal(JSON.stringify(service.artifactHub()).includes("C:\\private"), false);
  assert.equal(JSON.stringify(service.artifactHub()).includes("never-show"), false);
  assert.equal(service.artifactHub({ teamId: team.id }).artifacts.some((entry) => entry.id === "artifact_2222222222222222"), false);
  const history = await service.computerHistory();
  assert.equal(history.history.length, 3);
  assert.equal(history.history.some((entry) => entry.eventType === "computer.action_failed" && entry.status === "failed" && entry.coworkerId === "coworker_1111111111111111"), true);
  assert.equal(JSON.stringify(history).includes("C:\\private"), false);
  assert.equal(JSON.stringify(history).includes("never-show"), false);
  const pack = service.duplicatePack("custom-team");
  assert.match(pack.id, /^custom-pack-/);
  assert.equal(service.editPack(pack.id, { name: "Edited" }).name, "Edited");
});

test("semantic Playbooks stay ordered, declarative, assignable, and transferable", () => {
  const { team, teamService } = fixture();
  const dataDir = mkdtempSync(join(tmpdir(), "sovereign-semantic-playbook-"));
  const service = createProductSurfaceService({
    dataDir, teamService,
    coworkerStore: { get: (id) => ({ id, name: "Coworker" }) },
    artifactStore: { list: () => ({ artifacts: [] }) },
    runtime: { audit: { readAll: async () => [] } },
    now: () => "2026-09-01T00:00:02.000Z",
  });
  const plan = {
    stages: [{ id: "discover", name: "Discover", instructions: "Clarify the decision.", expectedOutput: "Decision brief", recommendedCoworkerRole: "Product Lead", recommendedSkillIds: ["skill_research"] }, { id: "review", name: "Review", instructions: "Check the evidence.", recommendedCoworkerRole: "Reviewer" }],
    reviewPoints: [{ id: "evidence-check", name: "Evidence check", instructions: "Current owner reviews the evidence before proceeding.", recommendedCoworkerRole: "Reviewer" }],
    expectedOutput: "A bounded product decision.",
    recommendedCoworkerRoles: ["Product Lead", "Reviewer"],
    recommendedSkillIds: ["skill_research", "skill_synthesis"],
  };
  const created = service.createPlaybook({ name: "Discovery Method", description: "A reusable decision method.", steps: ["chief", "reviewer"], ...plan });
  assert.deepEqual(created.stages, plan.stages);
  assert.deepEqual(created.reviewPoints, plan.reviewPoints);
  assert.equal(created.expectedOutput, plan.expectedOutput);
  assert.deepEqual(service.duplicatePlaybook(created.id).stages, plan.stages);
  assert.deepEqual(service.exportPlaybook(created.id).recommendedSkillIds, plan.recommendedSkillIds);
  const imported = service.importPlaybook({ ...service.exportPlaybook(created.id), id: "discovery-import" });
  assert.equal(imported.imported, true);
  service.assignPlaybook(created.id, { teamId: team.id });
  service.assignPlaybook(created.id, { channelId: team.channels[0].id });
  assert.deepEqual(team.playbooks.find((entry) => entry.id === created.id).stages, plan.stages);
  const updated = service.updatePlaybook(created.id, { expectedOutput: "An approved product decision.", reviewPoints: [] });
  assert.equal(updated.expectedOutput, "An approved product decision.");
  assert.deepEqual(updated.reviewPoints, []);
  assert.deepEqual(teamService.get(team.id).playbooks.find((entry) => entry.id === created.id).reviewPoints, []);
  assert.throws(() => service.importPlaybook({ ...service.exportPlaybook(created.id), id: "unsafe-import", workspacePath: "E:/private" }), /field is not allowed/);
  const restarted = createProductSurfaceService({
    dataDir, teamService,
    coworkerStore: { get: (id) => ({ id, name: "Coworker" }) },
    artifactStore: { list: () => ({ artifacts: [] }) },
    runtime: { audit: { readAll: async () => [] } },
    now: () => "2026-09-01T00:00:03.000Z",
  });
  assert.equal(restarted.listPlaybooks({ includeArchived: true }).playbooks.some((entry) => entry.id === "discovery-import"), true);
});

test("skill transfer is declarative and duplicate starts unassigned", () => {
  const root = mkdtempSync(join(tmpdir(), "sovereign-skills-"));
  const store = createSkillStore({ persistPath: join(root, "skills.json") });
  const source = store.create({ name: "Review", description: "Safe review", instructions: "Review the result", steps: ["check"], requestedCapabilities: ["workspace"] });
  const exported = store.exportSkill(source.id);
  assert.equal(exported.assignedTeamIds, undefined);
  const imported = store.importSkill(exported).skill;
  const duplicate = store.duplicateSkill(source.id);
  const retested = store.retestSkill(source.id);
  assert.equal(imported.assignedTeamIds.length, 0);
  assert.equal(duplicate.assignedTeamIds.length, 0);
  assert.equal(imported.source, "imported");
  assert.equal(retested.tested, true);
  assert.equal(retested.mode, "declarative-validation");
  assert.ok(retested.skill.lastTestedAt);
});
