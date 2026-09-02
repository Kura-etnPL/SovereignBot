import test from "node:test";
import assert from "node:assert/strict";
import { createSearchService } from "../src/main/search-service.js";
import { createCommandPaletteService } from "../src/main/command-palette-service.js";
import { validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";

const projectA = "project_aaaaaaaaaaaaaaaa";
const projectB = "project_bbbbbbbbbbbbbbbb";
const teamA = "team_aaaaaaaaaaaaaaaa";
const teamB = "team_bbbbbbbbbbbbbbbb";
const channelA = "channel_aaaaaaaaaaaaaaaa";
const channelB = "channel_bbbbbbbbbbbbbbbb";
const conversationA = "conv_aaaaaaaaaaaaaaaa";
const conversationB = "conv_bbbbbbbbbbbbbbbb";
const coworkerA = "coworker_aaaaaaaaaaaaaaaa";
const coworkerB = "coworker_bbbbbbbbbbbbbbbb";
const artifactA = "artifact_aaaaaaaaaaaaaaaa";
const artifactB = "artifact_bbbbbbbbbbbbbbbb";
const skillA = "skill_aaaaaaaaaaaaaaaa";
const skillB = "skill_bbbbbbbbbbbbbbbb";
const playbookA = "playbook_aaaaaaaaaaaaaaaa";
const playbookB = "playbook_bbbbbbbbbbbbbbbb";
const routineA = "routine_aaaaaaaaaaaaaaaa";
const routineB = "routine_bbbbbbbbbbbbbbbb";
const jobA = "job_aaaaaaaaaaaaaaaa";
const historyA = "history_aaaaaaaaaaaaaaaa";

function fixture() {
    const projects = [
        { projectId: projectA, name: "Alpha Project", state: "active", available: true, updatedAt: "2026-09-02T00:00:02.000Z", teams: [{ id: teamA, name: "Alpha Team", channels: [{ id: channelA, name: "Alpha Channel", conversationId: conversationA }] }], coworkers: [{ id: coworkerA, name: "Alpha Coworker" }] },
        { projectId: projectB, name: "Beta Project", state: "active", available: true, updatedAt: "2026-09-02T00:00:01.000Z", teams: [{ id: teamB, name: "Beta Team", channels: [{ id: channelB, name: "Beta Channel", conversationId: conversationB }] }], coworkers: [{ id: coworkerB, name: "Beta Coworker" }] },
        { projectId: "project_cccccccccccccccc", name: "Archived Project", state: "archived", available: true, updatedAt: "2026-09-02T00:00:03.000Z", teams: [], coworkers: [] },
    ];
    const teams = [
        { id: teamA, name: "Alpha Team", coworkerIds: [coworkerA], channels: [{ id: channelA, name: "Alpha Channel", conversationId: conversationA, updatedAt: "2026-09-02T00:00:02.000Z", archived: false }] },
        { id: teamB, name: "Beta Team", coworkerIds: [coworkerB], channels: [{ id: channelB, name: "Beta Channel", conversationId: conversationB, updatedAt: "2026-09-02T00:00:01.000Z", archived: false }] },
    ];
    const conversations = [{ id: conversationA, title: "Alpha Conversation", kind: "team", messageCount: 2, updatedAt: "2026-09-02T00:00:02.000Z" }, { id: conversationB, title: "Beta Conversation", kind: "team", messageCount: 1, updatedAt: "2026-09-02T00:00:01.000Z" }];
    const coworkers = [{ id: coworkerA, name: "Alpha Coworker", role: "Alpha role", state: "active", updatedAt: "2026-09-02T00:00:02.000Z" }, { id: coworkerB, name: "Beta Coworker", role: "Beta role", state: "active", updatedAt: "2026-09-02T00:00:01.000Z" }, { id: "coworker_cccccccccccccccc", name: "Archived Coworker", role: "hidden", state: "archived", updatedAt: "2026-09-02T00:00:03.000Z" }];
    const skills = [{ id: skillA, name: "Alpha Skill", description: "Alpha method", state: "active", assignedTeamIds: [teamA], assignedCoworkerIds: [], updatedAt: "2026-09-02T00:00:02.000Z" }, { id: skillB, name: "Beta Skill", description: "Beta method", state: "active", assignedTeamIds: [teamB], assignedCoworkerIds: [], updatedAt: "2026-09-02T00:00:01.000Z" }];
    const playbooks = [{ id: playbookA, name: "Alpha Playbook", description: "Alpha method", state: "active", assignedTeams: [{ id: teamA }], assignedChannels: [], updatedAt: "2026-09-02T00:00:02.000Z" }, { id: playbookB, name: "Beta Playbook", description: "Beta method", state: "active", assignedTeams: [{ id: teamB }], assignedChannels: [], updatedAt: "2026-09-02T00:00:01.000Z" }];
    const routines = [{ id: routineA, name: "Alpha Routine", enabled: true, coworkerId: coworkerA, workspaceId: "ws_alpha", updatedAt: "2026-09-02T00:00:02.000Z" }, { id: routineB, name: "Beta Routine", enabled: false, coworkerId: coworkerB, workspaceId: "ws_beta", updatedAt: "2026-09-02T00:00:01.000Z" }];
    const jobs = [{ id: jobA, title: "Alpha release job", objective: "Review Alpha release", status: "completed", conversationId: conversationA, updatedAt: "2026-09-02T00:00:02.000Z" }];
    const history = [{ id: historyA, activity: "Alpha snapshot", eventType: "computer.snapshot", source: "computer", summary: "Alpha workspace snapshot", coworkerId: coworkerA, timestamp: "2026-09-02T00:00:02.000Z", status: "completed" }];
    const memoryRows = [{ id: "mem_aaaaaaaaaaaaaaaa", title: "Alpha durable memory", content: "Alpha release checklist", tags: ["release"], scope: "project", ownerId: projectA, state: "active", updatedAt: "2026-09-02T00:00:03.000Z", source: { type: "conversation", label: "Alpha Conversation", navigation: { view: "conversation", conversationId: conversationA } } }];
    let projectListCalls = 0;
    const projectsApi = { list: async () => { projectListCalls += 1; return { projects }; }, resolveProject: (id) => ({ workspaceId: id === projectA ? "ws_alpha" : "ws_beta" }), resolveScope: (id) => id === projectA ? { projectId: id, workspaceId: "ws_alpha", teamIds: [teamA], channelIds: [channelA], conversationIds: [conversationA], coworkerIds: [coworkerA] } : { projectId: id, workspaceId: "ws_beta", teamIds: [teamB], channelIds: [channelB], conversationIds: [conversationB], coworkerIds: [coworkerB] } };
    const service = createSearchService({
        projectService: projectsApi,
        teamService: { list: () => ({ teams }) },
        conversationStore: { list: () => ({ conversations }) },
        coworkerStore: { list: () => ({ coworkers }) },
        artifactStore: { list: () => ({ artifacts: [{ id: artifactA, title: "Alpha Artifact", fileName: "alpha.txt", conversationId: conversationA, createdAt: "2026-09-02T00:00:02.000Z" }, { id: artifactB, title: "Beta Artifact", fileName: "beta.txt", conversationId: conversationB, createdAt: "2026-09-02T00:00:01.000Z" }] }) },
        skillStore: { list: () => ({ skills }) },
        productSurfaces: { listPlaybooks: () => ({ playbooks }) },
        getRoutines: () => ({ routines }),
        memoryService: { indexRecords: async () => memoryRows },
        getJobs: () => ({ listJobs: () => ({ jobs }) }),
        getHistory: async () => ({ history }),
    });
    return { service, projectsApi, routines, memoryRows, getProjectListCalls: () => projectListCalls };
}

test("global search is bounded, typed, recent/relevant, and Project scoped", async () => {
    const { service, getProjectListCalls, memoryRows } = fixture();
    const result = await service.query({ query: "Alpha", limit: 100 });
    assert.ok(result.results.some((entry) => entry.type === "projects" && entry.id === projectA));
    assert.ok(result.results.some((entry) => entry.type === "channels" && entry.id === channelA));
    assert.ok(result.results.some((entry) => entry.type === "conversations" && entry.id === conversationA));
    assert.ok(result.results.some((entry) => entry.type === "artifacts" && entry.id === artifactA));
    assert.ok(result.results.some((entry) => entry.type === "skills" && entry.id === skillA));
    assert.ok(result.results.some((entry) => entry.type === "playbooks" && entry.id === playbookA));
    assert.ok(result.results.some((entry) => entry.type === "routines" && entry.id === routineA));
    assert.ok(result.results.some((entry) => entry.type === "jobs" && entry.id === jobA));
    assert.ok(result.results.some((entry) => entry.type === "history" && entry.id === historyA));
    const memory = result.results.find((entry) => entry.type === "memory" && entry.id === "mem_aaaaaaaaaaaaaaaa");
    assert.ok(memory);
    assert.deepEqual(memory.navigation, { view: "memory", memoryId: "mem_aaaaaaaaaaaaaaaa", scope: "project", ownerId: projectA, projectId: projectA });
    assert.equal(memory.action, "open");
    assert.ok(result.results.every((entry) => !["path", "cwd", "session", "provider", "account", "authority"].some((term) => JSON.stringify(entry).toLowerCase().includes(term))));
    const scoped = await service.query({ query: "Beta", projectId: projectA, limit: 100 });
    assert.deepEqual(scoped.results, []);
    const archived = await service.query({ query: "Archived", limit: 100 });
    assert.deepEqual(archived.results, []);
    const archivedVisible = await service.query({ query: "Archived", status: "archived", limit: 100 });
    assert.ok(archivedVisible.results.some((entry) => entry.type === "projects"));
    const typed = await service.query({ query: "Alpha", types: ["skills"] });
    assert.ok(typed.results.every((entry) => entry.type === "skills"));
    assert.ok(result.results[0].score >= result.results.at(-1).score);
    await service.query({ query: "Alpha", limit: 1 });
    assert.equal(getProjectListCalls(), 1);
    memoryRows.push({ id: "mem_bbbbbbbbbbbbbbbb", title: "Beta durable memory", content: "Beta review note", tags: ["review"], scope: "project", ownerId: projectB, state: "active", updatedAt: "2026-09-02T00:00:04.000Z", source: { type: "fact", label: "Approved durable fact" } });
    assert.equal((await service.query({ query: "Beta", types: ["memory"], limit: 100 })).results.length, 0);
    service.invalidate();
    assert.equal((await service.query({ query: "Beta", types: ["memory"], limit: 100 })).results[0].id, "mem_bbbbbbbbbbbbbbbb");
});

test("search treats path, URL, and shell-looking input as data and never exposes it", async () => {
    const { service } = fixture();
    const result = await service.query({ query: "E:\\private\\secret https://evil.invalid && whoami", limit: 100 });
    assert.equal(result.results.length, 0);
    assert.doesNotThrow(() => JSON.stringify(result));
    await assert.rejects(() => service.query({ query: "\u0000" }), /control characters/);
});

test("palette exposes only seven fixed actions and delegates to trusted callbacks", async () => {
    const calls = [];
    const palette = createCommandPaletteService({
        createCoworker: (args) => { calls.push(["coworker", args]); return { ok: true }; },
        createTeam: (args) => { calls.push(["team", args]); return { ok: true }; },
        createChannel: (args) => { calls.push(["channel", args]); return { ok: true }; },
        runRoutine: (id) => { calls.push(["routine", id]); return { ok: true }; },
        teachSkill: (args) => { calls.push(["teach", args]); return { ok: true }; },
        openComputer: (args) => { calls.push(["computer", args]); return { action: "open-computer", coworkerId: args.coworkerId }; },
    });
    assert.deepEqual(palette.list().commands.map((entry) => entry.id), ["new-coworker", "new-team", "new-channel", "run-routine", "teach-skill", "open-computer", "search"]);
    await palette.execute({ commandId: "new-coworker", args: { name: "New", role: "Role", instructions: "" } });
    await palette.execute({ commandId: "new-team", args: { title: "Team", coworkerIds: [coworkerA, coworkerB] } });
    await palette.execute({ commandId: "new-channel", args: { teamId: teamA, name: "Channel" } });
    await palette.execute({ commandId: "run-routine", args: { routineId: routineA } });
    await palette.execute({ commandId: "teach-skill", args: { coworkerId: coworkerA, name: "Skill", description: "" } });
    await palette.execute({ commandId: "open-computer", args: { coworkerId: coworkerA } });
    await palette.execute({ commandId: "search", args: {} });
    assert.equal(calls.length, 6);
    await assert.rejects(() => palette.execute({ commandId: "new-channel", args: { teamId: teamA, name: "x", cwd: "E:\\private" } }), /unknown field/);
    await assert.rejects(() => palette.execute({ commandId: "run-routine", args: { routineId: "routine_forged" } }), /trusted opaque identifier/);
    await assert.rejects(() => palette.execute({ commandId: "not-a-command", args: {} }), /unknown command id/);
});

test("Search and Palette IPC schemas reject authority and unknown fields", () => {
    assert.deepEqual(validateV3IpcRequest("search:query", { query: "alpha", types: ["memory"], status: "archived", limit: 10 }), { query: "alpha", types: ["memory"], status: "archived", limit: 10 });
    assert.throws(() => validateV3IpcRequest("search:query", { query: "x", cwd: "E:\\private" }), /unexpected request field|not accepted/);
    assert.throws(() => validateV3IpcRequest("palette:execute", { paletteId: "run-routine", args: { routineId: routineA }, command: "whoami" }), /not accepted|unexpected request field/);
    assert.throws(() => validateV3IpcRequest("palette:execute", { paletteId: "open-computer", args: { coworkerId: coworkerA, agentId: "forged" } }), /unexpected request field/);
});
