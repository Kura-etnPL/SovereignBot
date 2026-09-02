import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProjectService } from "../src/main/project-service.js";
import { validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";

function arrayLengths(value, path = "root", result = []) {
    if (Array.isArray(value)) {
        result.push({ path, length: value.length });
        value.forEach((entry, index) => arrayLengths(entry, `${path}[${index}]`, result));
    } else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) arrayLengths(entry, `${path}.${key}`, result);
    return result;
}

test("Project command-center projection is grouped, bounded, scoped, and unavailable-safe", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-project-command-center-"));
    const paths = new Map();
    const addWorkspace = (id) => { const path = join(root, id); mkdirSync(path, { recursive: true }); paths.set(id, path); };
    addWorkspace("workspace_a"); addWorkspace("workspace_b");
    const projects = ["project_0000000000000001", "project_0000000000000002"];
    const teams = [
        { id: "team_0000000000000001", name: "Alpha Team", sharedWorkspaceId: "workspace_a", coworkerIds: ["coworker_0000000000000001"], playbooks: [{ id: "playbook_0000000000000001", name: "Alpha Playbook", description: "Alpha method" }], flow: { status: "available" }, channels: [{ id: "channel_0000000000000001", name: "Alpha Channel", conversationId: "conv_0000000000000001", workspaceId: "workspace_a", archived: true }] },
        { id: "team_0000000000000002", name: "Beta Team", sharedWorkspaceId: "workspace_b", coworkerIds: ["coworker_0000000000000002"], playbooks: [], flow: { status: "available" }, channels: [{ id: "channel_0000000000000002", name: "Beta Channel", conversationId: "conv_0000000000000002", workspaceId: "workspace_b" }] },
    ];
    const coworkers = [{ id: "coworker_0000000000000001", name: "Alpha Coworker", state: "active", workspaceIds: ["workspace_a"] }, { id: "coworker_0000000000000002", name: "Beta Coworker", state: "active", workspaceIds: ["workspace_b"] }];
    const artifacts = [{ id: "artifact_0000000000000001", title: "Alpha Result", fileName: "alpha.md", mimeType: "text/markdown", size: 10, conversationId: "conv_0000000000000001", createdAt: "2026-09-03T00:00:00.000Z", published: true }, { id: "artifact_0000000000000002", title: "Beta Result", fileName: "beta.md", mimeType: "text/markdown", size: 10, conversationId: "conv_0000000000000002", createdAt: "2026-09-03T00:00:00.000Z", published: true }];
    const services = { workspacePath: (id) => paths.get(id), listWorkspacesInternal: () => ({ workspaces: [...paths].map(([id, path]) => ({ id, path })) }), createManagedWorkspace: ({ idHint }) => { const id = `workspace_${idHint}`; addWorkspace(id); return { workspace: { id }, path: paths.get(id) }; } };
    const teamService = { list: () => ({ teams }), get: (id) => teams.find((entry) => entry.id === id) };
    const coworkerStore = { list: () => ({ coworkers }), get: (id) => coworkers.find((entry) => entry.id === id) };
    const artifactStore = { list: ({ conversationId } = {}) => ({ artifacts: artifacts.filter((entry) => !conversationId || entry.conversationId === conversationId) }) };
    const skillStore = { list: () => ({ skills: [{ id: "skill_0000000000000001", name: "Alpha Skill", description: "Alpha guidance", state: "archived", assignedTeamIds: [teams[0].id], assignedCoworkerIds: [] }, { id: "skill_0000000000000002", name: "Beta Skill", description: "Beta guidance", state: "active", assignedTeamIds: [teams[1].id], assignedCoworkerIds: [] }] }) };
    const connectedApps = { listForScope: () => ({ apps: [{ id: "app-alpha", name: "Alpha App", description: "Alpha connector", status: "connected", assignedTeamIds: [teams[0].id], assignedCoworkerIds: [] }, { id: "app-beta", name: "Beta App", description: "Beta connector", status: "connected", assignedTeamIds: [teams[1].id], assignedCoworkerIds: [] }] }) };
    let idIndex = 0;
    const projectService = createProjectService({
        dataDir: root, services, teamService, coworkerStore, artifactStore, skillStore, connectedApps,
        getRoutines: () => ({ routines: [{ id: "routine_0000000000000001", name: "Alpha Routine", projectId: projects[0], workspaceId: "workspace_a", coworkerId: coworkers[0].id, state: "active", enabled: true, lastStatus: "ready" }, { id: "routine_0000000000000002", name: "Beta Routine", workspaceId: "workspace_b", coworkerId: coworkers[1].id, state: "active", enabled: true }] }),
        getEventTriggers: () => ({ triggers: [{ id: "trigger_0000000000000001", name: "Alpha Trigger", routineId: "routine_0000000000000001", workspaceId: "workspace_a", enabled: false, lastStatus: "disabled", pathPrefix: "inbox" }, { id: "trigger_0000000000000002", name: "Beta Trigger", workspaceId: "workspace_b", enabled: true, lastStatus: "ready", pathPrefix: "inbox" }] }),
        getPlaybooks: () => ({ playbooks: [{ id: "playbook_0000000000000001", name: "Alpha Playbook", description: "Alpha method", state: "active", assignedTeams: [{ id: teams[0].id, name: teams[0].name }] }, { id: "playbook_0000000000000002", name: "Beta Playbook", description: "Beta method", state: "active", assignedTeams: [{ id: teams[1].id, name: teams[1].name }] }] }),
        makeId: () => projects[idIndex++],
    });
    try {
        const listed = await projectService.list({ includeArchived: true, limit: 10 });
        const alpha = listed.projects.find((entry) => entry.projectId === projects[0]);
        const beta = listed.projects.find((entry) => entry.projectId === projects[1]);
        assert.ok(alpha && beta);
        assert.deepEqual(Object.keys(alpha.contents), ["teams", "channels", "coworkers", "files", "artifacts", "skills", "playbooks", "routines", "triggers", "memory", "connectedApps"]);
        assert.equal(alpha.contents.teams.total, 1);
        assert.equal(alpha.contents.channels.items[0].state, "archived");
        assert.deepEqual(alpha.contents.artifacts.items.map((entry) => entry.title), ["Alpha Result"]);
        assert.deepEqual(alpha.contents.skills.items.map((entry) => entry.name), ["Alpha Skill"]);
        assert.deepEqual(alpha.contents.playbooks.items.map((entry) => entry.name), ["Alpha Playbook"]);
        assert.deepEqual(alpha.contents.routines.items.map((entry) => entry.name), ["Alpha Routine"]);
        assert.deepEqual(alpha.contents.triggers.items.map((entry) => entry.name), ["Alpha Trigger"]);
        assert.deepEqual(alpha.contents.connectedApps.items.map((entry) => entry.name), ["Alpha App"]);
        assert.equal(alpha.counts.files, 1);
        assert.equal(alpha.counts.artifacts, 1);
        assert.equal(JSON.stringify(alpha).includes("Beta"), false);
        assert.equal(JSON.stringify(alpha).match(/workspace|pathPrefix|mimeType.*path/gi), null);
        assert.equal(alpha.contents.channels.items[0].navigation.view, "conversation");
        assert.equal(alpha.contents.memory.items.length, 0);
        assert.equal(beta.contents.teams.items[0].name, "Beta Team");

        for (let index = 0; index < 60; index += 1) {
            teams.push({ id: `team_alpha_extra_${index}`, name: `Alpha Extra Team ${index}`, sharedWorkspaceId: "workspace_a", coworkerIds: [], playbooks: [], flow: { status: "available" }, channels: Array.from({ length: 60 }, (_, channelIndex) => ({ id: `channel_alpha_extra_${index}_${channelIndex}`, name: `Alpha Extra Channel ${index}-${channelIndex}`, conversationId: `conv_alpha_extra_${index}_${channelIndex}`, workspaceId: "workspace_a" })) });
            coworkers.push({ id: `coworker_alpha_extra_${index}`, name: `Alpha Extra Coworker ${index}`, state: "active", workspaceIds: ["workspace_a"] });
        }
        connectedApps.listForScope = () => ({ apps: Array.from({ length: 60 }, (_, index) => ({ id: `app-alpha-extra-${index}`, name: `Alpha Extra App ${index}`, description: "bounded local app", status: "connected", assignedTeamIds: [teams[0].id], assignedCoworkerIds: [] })) });
        projectService.setMemoryService({ list: async () => ({ memories: Array.from({ length: 60 }, (_, index) => ({ id: `memory_alpha_extra_${index}`, title: `Alpha Extra Memory ${index}`, content: "bounded memory", tags: [], state: "active", pinned: false, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z", source: { type: "conversation", sourceId: "conv_0000000000000001", label: "C:\\private\\token.txt token=must-not-leak", navigation: { view: "conversation", conversationId: "conv_0000000000000001", path: "C:\\private", token: "must-not-leak", provider: "forged-provider", nested: { capability: "forged" } } } })) }) });
        const saturated = await projectService.get(projects[0]);
        assert.ok(saturated.contents.teams.total > 50);
        assert.equal(saturated.contents.teams.items.length, 50);
        assert.equal(saturated.teams.length, 50);
        assert.ok(saturated.teams.every((team) => team.channels.length <= 50));
        assert.equal(saturated.coworkers.length, 50);
        assert.equal(saturated.connectedApps.length, 50);
        assert.equal(saturated.memory.length, 50);
        assert.ok(arrayLengths(saturated).every(({ length }) => length <= 50));
        assert.equal(saturated.contents.memory.items[0].source.navigation.path, undefined);
        assert.equal(saturated.contents.memory.items[0].source.navigation.token, undefined);
        assert.equal(saturated.contents.memory.items[0].source.navigation.provider, undefined);
        assert.deepEqual(saturated.contents.memory.items[0].source.navigation, { view: "conversation", conversationId: "conv_0000000000000001" });
        assert.equal(JSON.stringify(saturated).includes("must-not-leak"), false);
        assert.equal(JSON.stringify(saturated).includes("forged-provider"), false);
        assert.equal(JSON.stringify(saturated).includes('"provider"'), false);
        const exported = await projectService.export(projects[0]);
        assert.equal(exported.project.teams.length, 61);
        assert.equal(exported.project.teams.find((team) => team.name === "Alpha Extra Team 0").channels.length, 60);
        assert.equal(exported.project.coworkers.length, 61);
        assert.equal(exported.project.connectedApps.length, 60);
        assert.equal(exported.project.memory.length, 60);

        paths.delete("workspace_a");
        const unavailable = await projectService.get(projects[0]);
        assert.equal(unavailable.available, false);
        assert.equal(unavailable.contents.teams.total, 0);
        await assert.rejects(() => projectService.open(projects[0]), /workspace is unavailable/);
        await assert.rejects(() => projectService.archive(projects[0]), /workspace is unavailable/);
        await assert.rejects(() => projectService.export(projects[0]), /workspace is unavailable/);
        await assert.rejects(() => projectService.backup(projects[0]), /workspace is unavailable/);
        assert.throws(() => validateV3IpcRequest("project:get", { projectId: projects[0], workspacePath: "C:\\secret" }), /unexpected request field/);
        assert.throws(() => validateV3IpcRequest("project:list", { limit: 101 }), /limit/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
