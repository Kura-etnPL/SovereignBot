import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore } from "../../src/memory.js";
import { createMemoryService } from "../src/main/memory-service.js";
import { validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";

function harness(root) {
    const memory = new MemoryStore(join(root, "memory.jsonl"));
    const coworkers = [
        { id: "coworker_a", name: "Alice", role: "Owner", state: "active" },
        { id: "coworker_b", name: "Bob", role: "Reviewer", state: "active" },
    ];
    const conversation = { id: "conv_a", kind: "team", title: "Project Room", participants: ["user", "coworker_a", "coworker_b"], messages: [{ id: "msg_a", senderId: "user", text: "Keep the release checklist", createdAt: new Date().toISOString() }] };
    const teams = [
        { id: "team_a", name: "Alpha Team", coworkerIds: ["coworker_a", "coworker_b"], channels: [{ id: "channel_a", name: "Project", kind: "project", conversationId: "conv_a", workspaceId: "workspace_a" }] },
        { id: "team_b", name: "Beta Team", coworkerIds: ["coworker_b"], channels: [] },
    ];
    const projects = {
        project_aaaaaaaaaaaaaaaa: { projectId: "project_aaaaaaaaaaaaaaaa", workspaceId: "workspace_a", state: "active" },
        project_bbbbbbbbbbbbbbbb: { projectId: "project_bbbbbbbbbbbbbbbb", workspaceId: "workspace_b", state: "active" },
    };
    const coworkerStore = { get(id) { const value = coworkers.find((entry) => entry.id === id); if (!value) throw new Error(`unknown coworker: ${id}`); return value; }, list() { return { coworkers }; } };
    const teamService = { get(id) { const value = teams.find((entry) => entry.id === id); if (!value) throw new Error(`unknown team: ${id}`); return value; }, list() { return { teams }; } };
    const conversationStore = { get(id) { if (id !== conversation.id) throw new Error(`unknown conversation: ${id}`); return structuredClone(conversation); }, list() { return { conversations: [{ id: conversation.id }] }; } };
    const artifactStore = { get(id) { if (id !== "artifact_a") throw new Error(`unknown artifact: ${id}`); return { id, title: "Release Notes", conversationId: conversation.id }; } };
    const jobs = { getJob(id) { if (id !== "job_a") throw new Error(`unknown job: ${id}`); return { id, title: "Completed release job", status: "completed", ownerCoworkerId: "coworker_a", conversationId: conversation.id }; } };
    const services = { workspacePath(id) { return id === "workspace_a" ? join(root, "workspace-a") : undefined; } };
    const make = (store = memory) => createMemoryService({ runtime: { memory: store }, services, coworkerStore, teamService, conversationStore, artifactStore, getJobs: () => jobs, projectResolver: (id) => projects[id] });
    return { memory, make, projects };
}

test("Memory production canary separates suggestion approval, three scopes, provenance, lifecycle, and restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-memory-canary-"));
    try {
        const { memory, make, projects } = harness(root);
        const service = make();
        assert.deepEqual(validateV3IpcRequest("memory:list", { scope: "coworker", ownerId: "coworker_a", query: "release", limit: 10 }), { scope: "coworker", ownerId: "coworker_a", query: "release", limit: 10, includeForgotten: false });
        assert.deepEqual(validateV3IpcRequest("memory:putFact", { scope: "project", ownerId: "project_aaaaaaaaaaaaaaaa", draft: { title: "Operator fact", content: "Keep the release checklist", tags: ["release", "checklist"] } }), { scope: "project", ownerId: "project_aaaaaaaaaaaaaaaa", draft: { title: "Operator fact", content: "Keep the release checklist", tags: ["release", "checklist"] } });
        assert.throws(() => validateV3IpcRequest("memory:putFact", { scope: "team", ownerId: "team_a", draft: { title: "No", content: "No" } }), /Project memory/);
        assert.throws(() => validateV3IpcRequest("memory:putFact", { scope: "project", ownerId: "project_aaaaaaaaaaaaaaaa", draft: { title: "No", content: "No", approved: true } }), /not accepted|unexpected/);
        assert.throws(() => validateV3IpcRequest("memory:list", { scope: "project", ownerId: "team_a" }), /Project identifier/);
        assert.deepEqual(validateV3IpcRequest("memory:listSuggestions", {}), {});
        assert.deepEqual(validateV3IpcRequest("memory:approveSuggestion", { suggestionId: "suggestion_aaaaaaaaaaaaaaaa" }), { suggestionId: "suggestion_aaaaaaaaaaaaaaaa" });
        assert.throws(() => validateV3IpcRequest("memory:update", { scope: "team", ownerId: "team_a", memoryId: "memory_a", patch: { content: "x", scope: "coworker" } }), /unexpected|authority|scope/);
        assert.throws(() => validateV3IpcRequest("memory:list", { scope: "team", ownerId: "team_a", budget: 1 }), /unexpected|budget/);
        await assert.rejects(() => service.suggest({ scope: "coworker", ownerId: "coworker_a", draft: { title: "Injected", content: "bad", scope: "team", approved: true }, source: { type: "conversation", sourceId: "conv_a" } }), /draft field is not allowed/);
        const create = (scope, ownerId, title) => service.suggest({ scope, ownerId, draft: { key: "release-rule", title, content: `${title} content`, tags: ["release"] }, source: { type: "conversation", sourceId: "conv_a" } });
        const suggestions = await Promise.all([
            create("coworker", "coworker_a", "Private memory"),
            create("team", "team_a", "Shared memory"),
            create("project", "project_aaaaaaaaaaaaaaaa", "Project memory"),
        ]);
        assert.equal((await service.list({ scope: "coworker", ownerId: "coworker_a" })).memories.length, 0);
        assert.equal((await service.listSuggestions()).suggestions.length, 3);
        await Promise.all(suggestions.map((entry) => service.approveSuggestion(entry.suggestionId)));
        assert.equal((await service.listSuggestions()).suggestions.length, 0);
        assert.equal((await service.list({ scope: "coworker", ownerId: "coworker_a" })).memories[0].title, "Private memory");
        assert.equal((await service.list({ scope: "team", ownerId: "team_a" })).memories[0].title, "Shared memory");
        assert.equal((await service.list({ scope: "project", ownerId: "project_aaaaaaaaaaaaaaaa" })).memories[0].title, "Project memory");
        const privateMemory = (await service.list({ scope: "coworker", ownerId: "coworker_a" })).memories[0];
        const sharedMemory = (await service.list({ scope: "team", ownerId: "team_a" })).memories[0];
        await assert.rejects(() => service.get({ scope: "coworker", ownerId: "coworker_b", memoryId: privateMemory?.id ?? "missing" }), /outside|not found/);
        await assert.rejects(() => service.get({ scope: "team", ownerId: "team_b", memoryId: sharedMemory.id }), /outside|not found/);

        const updated = await service.update({ scope: "coworker", ownerId: "coworker_a", memoryId: privateMemory.id, patch: { title: "Edited memory", content: "Edited content", tags: ["edited"] } });
        assert.equal(updated.title, "Edited memory");
        const trace = await service.sourceTrace({ scope: "coworker", ownerId: "coworker_a", memoryId: privateMemory.id });
        assert.equal(trace.type, "conversation");
        assert.equal(trace.label, "Project Room");
        assert.deepEqual(trace.navigation, { view: "conversation", conversationId: "conv_a" });
        await service.pin({ scope: "coworker", ownerId: "coworker_a", memoryId: privateMemory.id, pinned: true });
        assert.equal((await service.get({ scope: "coworker", ownerId: "coworker_a", memoryId: privateMemory.id })).pinned, true);
        await service.forget({ scope: "coworker", ownerId: "coworker_a", memoryId: privateMemory.id });
        assert.equal((await service.list({ scope: "coworker", ownerId: "coworker_a" })).memories.length, 0);
        assert.equal((await service.list({ scope: "coworker", ownerId: "coworker_a", includeForgotten: true })).memories[0].state, "forgotten");
        await service.delete({ scope: "team", ownerId: "team_a", memoryId: (await service.list({ scope: "team", ownerId: "team_a" })).memories[0].id });

        const artifactSuggestion = await service.suggestFromArtifact({ scope: "project", ownerId: "project_aaaaaaaaaaaaaaaa", draft: { title: "Artifact fact", content: "From artifact" }, source: { type: "artifact", sourceId: "artifact_a" } });
        await service.approveSuggestion(artifactSuggestion.suggestionId);
        const jobSuggestion = await service.suggestFromJob({ scope: "coworker", ownerId: "coworker_a", draft: { title: "Job fact", content: "From completed job" }, source: { type: "job", sourceId: "job_a" } });
        await service.approveSuggestion(jobSuggestion.suggestionId);
        const correctionSuggestion = await service.suggestCorrection({ scope: "team", ownerId: "team_a", messageId: "msg_a", draft: { title: "Correction", content: "Keep the checklist" } });
        await service.approveSuggestion(correctionSuggestion.suggestionId);
        const fact = await service.putFact({ scope: "team", ownerId: "team_a", draft: { title: "Durable fact", content: "Approved by operator" } });
        assert.equal(fact.source.type, "fact");
        const projectFact = await service.putFact({ scope: "project", ownerId: "project_aaaaaaaaaaaaaaaa", draft: { title: "Project operator fact", content: "Approved in Project Memory", tags: ["operator"] } });
        assert.equal(projectFact.scope, "project");
        assert.equal(projectFact.source.type, "fact");
        projects.project_aaaaaaaaaaaaaaaa.state = "archived";
        await assert.rejects(() => service.putFact({ scope: "project", ownerId: "project_aaaaaaaaaaaaaaaa", draft: { title: "Blocked", content: "Archived Projects are read-only" } }), /read-only/);
        projects.project_aaaaaaaaaaaaaaaa.state = "active";
        const persistedText = JSON.stringify(await memory.search({ query: "artifact fact" }));
        assert.equal(persistedText.includes("workspace_a"), false);

        const restarted = make(new MemoryStore(join(root, "memory.jsonl")));
        assert.equal((await restarted.list({ scope: "coworker", ownerId: "coworker_a" })).memories.length, 1);
        assert.equal((await restarted.list({ scope: "team", ownerId: "team_a" })).memories.length, 2);
        assert.equal((await restarted.list({ scope: "project", ownerId: "project_aaaaaaaaaaaaaaaa" })).memories.length, 3);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Memory source and job boundaries fail closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-memory-negative-"));
    try {
        const { make } = harness(root);
        const service = make();
        await assert.rejects(() => service.suggestFromJob({ scope: "team", ownerId: "team_a", draft: { title: "No", content: "No" }, source: { type: "job", sourceId: "missing" } }), /unknown job|unavailable/);
        await assert.rejects(() => service.suggest({ scope: "team", ownerId: "team_b", draft: { title: "No", content: "No" }, source: { type: "conversation", sourceId: "conv_a" } }), /outside|unknown/);
        await assert.rejects(() => service.suggest({ scope: "team", ownerId: "team_a", draft: { title: "No", content: "No" }, source: { type: "conversation", sourceId: "conv_a", approved: true } }), /source/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Memory relevance is scoped, deterministic, bounded, and shared by forgotten search", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-memory-relevance-"));
    try {
        const { memory, make } = harness(root);
        const service = make();
        const projectId = "project_aaaaaaaaaaaaaaaa";
        const put = (title, content, tags = [], pinned = false) => memory.put({ scope: `project:${projectId}`, key: title.toLowerCase().replaceAll(" ", "-"), value: { title, content }, tags, pinned });
        const exact = await put("Release Checklist", "Deploy safely after the release review.", ["operations", "release"]);
        await put("Release Playbook", "A general release workflow.", ["release"]);
        await put("Pinned Release Note", "A small operational reminder.", ["release"], true);
        await put("发布说明", "中文检索内容。", ["中文"]);
        const forgotten = await put("Forgotten Release Note", "Do not use this old note.", ["release"]);
        await service.forget({ scope: "project", ownerId: projectId, memoryId: forgotten.memoryId });
        await service.putFact({ scope: "coworker", ownerId: "coworker_a", draft: { title: "Release Checklist", content: "Private coworker copy", tags: ["operations"] } });

        const exactResult = await service.list({ scope: "project", ownerId: projectId, query: "release checklist", limit: 10 });
        assert.equal(exactResult.memories[0].id, exact.memoryId);
        assert.equal(exactResult.memories[0].matchReason.key, "title-exact");
        assert.deepEqual(exactResult.memories[0].matchReason.fields, ["content", "key", "tags", "title"]);
        const tagResult = await service.list({ scope: "project", ownerId: projectId, query: "operations" });
        assert.equal(tagResult.memories[0].matchReason.key, "tags");
        const phraseResult = await service.list({ scope: "project", ownerId: projectId, query: "deploy safely" });
        assert.equal(phraseResult.memories[0].id, exact.memoryId);
        assert.equal(phraseResult.memories[0].matchReason.key, "phrase");
        const chineseResult = await service.list({ scope: "project", ownerId: projectId, query: "发布" });
        assert.ok(["key-prefix", "title-prefix"].includes(chineseResult.memories[0].matchReason.key));
        const emptyResult = await service.list({ scope: "project", ownerId: projectId, query: "", limit: 3 });
        assert.equal(emptyResult.memories[0].title, "Pinned Release Note");
        assert.equal(emptyResult.memories[0].matchReason.key, "recent");
        assert.equal(emptyResult.resultCount, 3);
        assert.equal((await service.list({ scope: "project", ownerId: projectId, query: "release checklist" })).memories.some((entry) => entry.title === "Forgotten Release Note"), false);
        const forgottenResult = await service.list({ scope: "project", ownerId: projectId, query: "forgotten release", includeForgotten: true });
        assert.equal(forgottenResult.memories[0].id, forgotten.memoryId);
        assert.equal(forgottenResult.memories[0].state, "forgotten");
        assert.equal((await service.list({ scope: "project", ownerId: projectId, query: "release checklist" })).memories.length, 1);
        assert.equal((await service.list({ scope: "coworker", ownerId: "coworker_a", query: "release checklist" })).memories.length, 1);
        await assert.rejects(() => service.list({ scope: "project", ownerId: projectId, query: "x".repeat(301) }), /exceeds 300/);
        await assert.rejects(() => service.list({ scope: "project", ownerId: projectId, query: "x", limit: 101 }), /from 1 to 100/);
        await assert.rejects(() => service.list({ scope: "project", ownerId: projectId, query: 42 }), /must be a string/);
        await assert.rejects(() => service.list({ scope: "project", ownerId: projectId, query: "x", includeForgotten: "yes" }), /includeForgotten/);
        const restarted = make(new MemoryStore(join(root, "memory.jsonl")));
        const firstOrder = await restarted.list({ scope: "project", ownerId: projectId, query: "release", limit: 10, includeForgotten: true });
        const secondOrder = await restarted.list({ scope: "project", ownerId: projectId, query: "release", limit: 10, includeForgotten: true });
        assert.deepEqual(firstOrder.memories, secondOrder.memories);
        assert.ok(firstOrder.memories.every((entry) => entry.scope === "project" && !/(provider|session|credential|token|secret|password|cwd|path)/i.test(JSON.stringify(entry))));
    } finally { rmSync(root, { recursive: true, force: true }); }
});
