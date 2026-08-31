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
    importPlaybook: (teamId, playbook) => { teams.find((entry) => entry.id === teamId).playbooks.push({ id: playbook.id, name: playbook.name, description: playbook.description, steps: [...playbook.steps] }); },
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
    artifactStore: { list: () => ({ artifacts: [{ id: "artifact_1111111111111111", title: "result", fileName: "result.md", mimeType: "text/markdown", size: 10, createdAt: "2026-09-01T00:00:00.000Z", createdByCoworkerId: "coworker_1111111111111111", conversationId: "conv_1111111111111111", storageRelativePath: "secret", sourceRelativePath: "private/result.md" }] }) },
    runtime: { audit: { readAll: async () => [{ id: "audit_1", at: "2026-09-01T00:00:00.000Z", type: "computer.action_succeeded", data: { action: "click", app: "Browser", ok: true } }, { id: "audit_2", at: "2026-09-01T00:00:01.000Z", type: "computer.secret_supplied", data: { password: "never-show" } }] } },
    now: () => "2026-09-01T00:00:02.000Z",
  });
  const library = service.listPlaybooks();
  assert.equal(library.playbooks.some((entry) => entry.id === "delivery"), true);
  const created = service.createPlaybook({ name: "Release", description: "Bounded release", steps: ["chief", "reviewer"] });
  assert.equal(service.duplicatePlaybook(created.id).name, "Release copy");
  service.assignPlaybook(created.id, { channelId: team.channels[0].id });
  assert.equal(team.channels[0].playbookId, created.id);
  assert.equal(service.artifactHub().artifacts[0].storageRelativePath, undefined);
  assert.equal((await service.computerHistory()).history.length, 1);
  const pack = service.duplicatePack("custom-team");
  assert.match(pack.id, /^custom-pack-/);
  assert.equal(service.editPack(pack.id, { name: "Edited" }).name, "Edited");
});

test("skill transfer is declarative and duplicate starts unassigned", () => {
  const root = mkdtempSync(join(tmpdir(), "sovereign-skills-"));
  const store = createSkillStore({ persistPath: join(root, "skills.json") });
  const source = store.create({ name: "Review", description: "Safe review", instructions: "Review the result", steps: ["check"], requestedCapabilities: ["workspace"] });
  const exported = store.exportSkill(source.id);
  assert.equal(exported.assignedTeamIds, undefined);
  const imported = store.importSkill(exported).skill;
  const duplicate = store.duplicateSkill(source.id);
  assert.equal(imported.assignedTeamIds.length, 0);
  assert.equal(duplicate.assignedTeamIds.length, 0);
});
