import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore } from "../../src/memory.js";
import { createMemoryService } from "../src/main/memory-service.js";
import { createProjectService } from "../src/main/project-service.js";
import { validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";

function fixture(root) {
    const workspaces = new Map();
    const addWorkspace = (id, label, kind = "shared-project") => { const path = join(root, id); mkdirSync(path, { recursive: true }); workspaces.set(id, { id, label, kind, path, addedAt: new Date().toISOString() }); };
    addWorkspace("workspace_a", "Alpha workspace");
    addWorkspace("workspace_b", "Beta workspace");
    const coworkers = [{ id: "coworker_a", name: "Alice", state: "active", workspaceIds: ["workspace_a"] }, { id: "coworker_b", name: "Bob", state: "active", workspaceIds: ["workspace_b"] }];
    const teams = [
        { id: "team_a", name: "Alpha Team", sharedWorkspaceId: "workspace_a", coworkerIds: ["coworker_a"], playbooks: [], flow: { status: "available" }, channels: [{ id: "channel_a", name: "Alpha Channel", conversationId: "conv_a", workspaceId: "workspace_a" }] },
        { id: "team_b", name: "Beta Team", sharedWorkspaceId: "workspace_b", coworkerIds: ["coworker_b"], playbooks: [], flow: { status: "available" }, channels: [{ id: "channel_b", name: "Beta Channel", conversationId: "conv_b", workspaceId: "workspace_b" }] },
    ];
    const services = {
        workspacePath(id) { return workspaces.get(id)?.path; },
        workspaceLabel(id) { return workspaces.get(id)?.label; },
        listWorkspacesInternal() { return { schema: "sovereignbot.desktop.workspaces.v1", workspaces: [...workspaces.values()] }; },
        createManagedWorkspace({ label, kind = "shared-project", idHint }) { const id = `workspace_${idHint.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`; addWorkspace(id, label, kind); return { workspace: workspaces.get(id), path: workspaces.get(id).path }; },
    };
    const coworkerStore = { list() { return { coworkers }; }, get(id) { const value = coworkers.find((entry) => entry.id === id); if (!value) throw new Error("unknown coworker"); return value; } };
    const teamService = { list() { return { teams }; }, get(id) { const value = teams.find((entry) => entry.id === id); if (!value) throw new Error("unknown team"); return value; } };
    const conversations = new Map([
        ["conv_a", { id: "conv_a", title: "Alpha", participants: ["user", "coworker_a"], messages: [] }],
        ["conv_b", { id: "conv_b", title: "Beta", participants: ["user", "coworker_b"], messages: [] }],
    ]);
    const conversationStore = { get(id) { const value = conversations.get(id); if (!value) throw new Error("unknown conversation"); return structuredClone(value); }, list() { return { conversations: [...conversations].map(([id]) => ({ id })) }; } };
    const artifactStore = { list() { return { artifacts: [] }; }, get() { throw new Error("unknown artifact"); } };
    const skillStore = { list() { return { skills: [] }; } };
    const connectedApps = { list() { return { apps: [] }; } };
    const jobs = { entries: [], listJobs() { return { jobs: this.entries }; } };
    const projectService = createProjectService({ dataDir: root, services, teamService, coworkerStore, artifactStore, skillStore, connectedApps, getJobs: () => jobs, getRoutines: () => ({ routines: [] }), getEventTriggers: () => ({ triggers: [] }), getComputers: async () => [] });
    const memory = new MemoryStore(join(root, "memory.jsonl"));
    const memoryService = createMemoryService({ runtime: { memory }, services, coworkerStore, teamService, conversationStore, artifactStore, projectResolver: (id) => projectService.resolveProject(id) });
    projectService.setMemoryService(memoryService);
    return { services, teamService, coworkerStore, artifactStore, skillStore, connectedApps, projectService, memoryService, jobs, root };
}

test("Project production-boundary canary migrates, scopes, archives, exports, backs up, and restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-project-canary-"));
    try {
        assert.deepEqual(validateV3IpcRequest("project:create", { name: "New Product" }), { name: "New Product" });
        assert.throws(() => validateV3IpcRequest("project:create", { name: "Injected", workspaceId: "workspace_a" }), /unexpected request field/);
        assert.throws(() => validateV3IpcRequest("project:create", { name: "Injected", path: "C:\\\\secret" }), /unexpected request field/);
        const current = fixture(root);
        const { projectService, memoryService, jobs, root: dataRoot } = current;
        const migrated = await projectService.list({ includeArchived: true });
        assert.equal(migrated.projects.length, 2);
        assert.equal("workspaceId" in migrated.projects[0], false);
        assert.equal(JSON.stringify(migrated).includes(root), false);
        const alpha = migrated.projects.find((entry) => entry.name === "Alpha Team");
        const beta = migrated.projects.find((entry) => entry.name === "Beta Team");
        assert.ok(alpha && beta);
        const created = await projectService.create({ name: "New Product" });
        assert.equal(created.name, "New Product");
        await assert.rejects(() => projectService.create({ name: "Bad", workspaceId: "workspace_a" }), /only name/);
        await projectService.open(alpha.projectId);
        assert.equal((await projectService.list()).projects[0].projectId, alpha.projectId);

        const suggestion = await memoryService.suggest({ scope: "project", ownerId: alpha.projectId, draft: { title: "Alpha fact", content: "Only Alpha may read this. C:\\\\secret\\\\token.txt secret=never-export-this" }, source: { type: "conversation", sourceId: "conv_a" } });
        await memoryService.approveSuggestion(suggestion.suggestionId);
        assert.equal((await memoryService.list({ scope: "project", ownerId: alpha.projectId })).memories.length, 1);
        await assert.rejects(() => memoryService.suggest({ scope: "project", ownerId: beta.projectId, draft: { title: "Spoof", content: "No" }, source: { type: "conversation", sourceId: "conv_a" } }), /outside|unknown/);

        jobs.entries.push({ id: "job_active", status: "working", workspaceId: projectService.resolveProject(alpha.projectId).workspaceId, conversationId: "conv_a" });
        await assert.rejects(() => projectService.archive(alpha.projectId), /active Jobs/);
        jobs.entries[0].status = "completed";
        await projectService.archive(alpha.projectId);
        assert.equal((await projectService.get(alpha.projectId)).state, "archived");
        await projectService.restore(alpha.projectId);
        assert.equal((await projectService.get(alpha.projectId)).state, "active");

        const exported = await projectService.export(alpha.projectId);
        assert.equal(exported.schema, "sovereignbot.project-export.v1");
        assert.equal(JSON.stringify(exported).includes("workspaceId"), false);
        assert.equal(JSON.stringify(exported).includes(dataRoot), false);
        assert.equal(JSON.stringify(exported).includes("never-export-this"), false);
        const backup = await projectService.backup(alpha.projectId);
        assert.equal(backup.backedUp, true);
        assert.equal(existsSync(join(root, "desktop-state", "project-backups", `${alpha.projectId}.json`)), true);
        const backupText = (await import("node:fs")).readFileSync(join(root, "desktop-state", "project-backups", `${alpha.projectId}.json`), "utf8");
        assert.equal(backupText.includes(dataRoot), false);
        assert.equal(backupText.includes("workspaceId"), false);
        const restarted = createProjectService({ dataDir: root, services: current.services, teamService: current.teamService, coworkerStore: current.coworkerStore, artifactStore: current.artifactStore, skillStore: current.skillStore, connectedApps: current.connectedApps, getJobs: () => jobs, getRoutines: () => ({ routines: [] }), getEventTriggers: () => ({ triggers: [] }), getComputers: async () => [] });
        assert.equal((await restarted.list({ includeArchived: true })).projects.length, 3);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
