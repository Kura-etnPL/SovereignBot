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
    const coworkerStore = { get(id) { const value = coworkers.find((entry) => entry.id === id); if (!value) throw new Error(`unknown coworker: ${id}`); return value; }, list() { return { coworkers }; } };
    const teamService = { get(id) { const value = teams.find((entry) => entry.id === id); if (!value) throw new Error(`unknown team: ${id}`); return value; }, list() { return { teams }; } };
    const conversationStore = { get(id) { if (id !== conversation.id) throw new Error(`unknown conversation: ${id}`); return structuredClone(conversation); }, list() { return { conversations: [{ id: conversation.id }] }; } };
    const artifactStore = { get(id) { if (id !== "artifact_a") throw new Error(`unknown artifact: ${id}`); return { id, title: "Release Notes", conversationId: conversation.id }; } };
    const jobs = { getJob(id) { if (id !== "job_a") throw new Error(`unknown job: ${id}`); return { id, title: "Completed release job", status: "completed", ownerCoworkerId: "coworker_a", conversationId: conversation.id }; } };
    const services = { workspacePath(id) { return id === "workspace_a" ? join(root, "workspace-a") : undefined; } };
    const make = (store = memory) => createMemoryService({ runtime: { memory: store }, services, coworkerStore, teamService, conversationStore, artifactStore, getJobs: () => jobs });
    return { memory, make };
}

test("Memory production canary separates suggestion approval, three scopes, provenance, lifecycle, and restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-memory-canary-"));
    try {
        const { memory, make } = harness(root);
        const service = make();
        assert.deepEqual(validateV3IpcRequest("memory:list", { scope: "coworker", ownerId: "coworker_a", query: "release", limit: 10 }), { scope: "coworker", ownerId: "coworker_a", query: "release", limit: 10, includeForgotten: false });
        assert.throws(() => validateV3IpcRequest("memory:update", { scope: "team", ownerId: "team_a", memoryId: "memory_a", patch: { content: "x", scope: "coworker" } }), /unexpected|authority|scope/);
        assert.throws(() => validateV3IpcRequest("memory:list", { scope: "team", ownerId: "team_a", budget: 1 }), /unexpected|budget/);
        await assert.rejects(() => service.suggest({ scope: "coworker", ownerId: "coworker_a", draft: { title: "Injected", content: "bad", scope: "team", approved: true }, source: { type: "conversation", sourceId: "conv_a" } }), /draft field is not allowed/);
        const create = (scope, ownerId, title) => service.suggest({ scope, ownerId, draft: { key: "release-rule", title, content: `${title} content`, tags: ["release"] }, source: { type: "conversation", sourceId: "conv_a" } });
        const suggestions = await Promise.all([
            create("coworker", "coworker_a", "Private memory"),
            create("team", "team_a", "Shared memory"),
            create("project", "team_a", "Project memory"),
        ]);
        assert.equal((await service.list({ scope: "coworker", ownerId: "coworker_a" })).memories.length, 0);
        await Promise.all(suggestions.map((entry) => service.approveSuggestion(entry.suggestionId)));
        assert.equal((await service.list({ scope: "coworker", ownerId: "coworker_a" })).memories[0].title, "Private memory");
        assert.equal((await service.list({ scope: "team", ownerId: "team_a" })).memories[0].title, "Shared memory");
        assert.equal((await service.list({ scope: "project", ownerId: "team_a" })).memories[0].title, "Project memory");
        const privateMemory = (await service.list({ scope: "coworker", ownerId: "coworker_a" })).memories[0];
        const sharedMemory = (await service.list({ scope: "team", ownerId: "team_a" })).memories[0];
        await assert.rejects(() => service.get({ scope: "coworker", ownerId: "coworker_b", memoryId: privateMemory?.id ?? "missing" }), /outside|not found/);
        await assert.rejects(() => service.get({ scope: "team", ownerId: "team_b", memoryId: sharedMemory.id }), /outside|not found/);

        const updated = await service.update({ scope: "coworker", ownerId: "coworker_a", memoryId: privateMemory.id, patch: { title: "Edited memory", content: "Edited content", tags: ["edited"] } });
        assert.equal(updated.title, "Edited memory");
        assert.deepEqual(await service.sourceTrace({ scope: "coworker", ownerId: "coworker_a", memoryId: privateMemory.id }), { type: "conversation", label: "Project Room" });
        await service.pin({ scope: "coworker", ownerId: "coworker_a", memoryId: privateMemory.id, pinned: true });
        assert.equal((await service.get({ scope: "coworker", ownerId: "coworker_a", memoryId: privateMemory.id })).pinned, true);
        await service.forget({ scope: "coworker", ownerId: "coworker_a", memoryId: privateMemory.id });
        assert.equal((await service.list({ scope: "coworker", ownerId: "coworker_a" })).memories.length, 0);
        assert.equal((await service.list({ scope: "coworker", ownerId: "coworker_a", includeForgotten: true })).memories[0].state, "forgotten");
        await service.delete({ scope: "team", ownerId: "team_a", memoryId: (await service.list({ scope: "team", ownerId: "team_a" })).memories[0].id });

        const artifactSuggestion = await service.suggestFromArtifact({ scope: "project", ownerId: "team_a", draft: { title: "Artifact fact", content: "From artifact" }, source: { type: "artifact", sourceId: "artifact_a" } });
        await service.approveSuggestion(artifactSuggestion.suggestionId);
        const jobSuggestion = await service.suggestFromJob({ scope: "coworker", ownerId: "coworker_a", draft: { title: "Job fact", content: "From completed job" }, source: { type: "job", sourceId: "job_a" } });
        await service.approveSuggestion(jobSuggestion.suggestionId);
        const correctionSuggestion = await service.suggestCorrection({ scope: "team", ownerId: "team_a", messageId: "msg_a", draft: { title: "Correction", content: "Keep the checklist" } });
        await service.approveSuggestion(correctionSuggestion.suggestionId);
        const fact = await service.putFact({ scope: "team", ownerId: "team_a", draft: { title: "Durable fact", content: "Approved by operator" } });
        assert.equal(fact.source.type, "fact");
        const persistedText = JSON.stringify(await memory.search({ query: "artifact fact" }));
        assert.equal(persistedText.includes("workspace_a"), false);

        const restarted = make(new MemoryStore(join(root, "memory.jsonl")));
        assert.equal((await restarted.list({ scope: "coworker", ownerId: "coworker_a" })).memories.length, 1);
        assert.equal((await restarted.list({ scope: "team", ownerId: "team_a" })).memories.length, 2);
        assert.equal((await restarted.list({ scope: "project", ownerId: "team_a" })).memories.length, 2);
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
