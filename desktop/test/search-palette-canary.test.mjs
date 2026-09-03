import test from "node:test";
import assert from "node:assert/strict";
import { createSearchService, SEARCH_MATCH_REASONS } from "../src/main/search-service.js";
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

function fixture({ fullScan = false, messageRecords = [], latestPreview, beforeBuild, includeSearchRecords = true, conversationTitle = "Alpha Conversation", artifactSearchRecords } = {}) {
    const projects = [
        { projectId: projectA, name: "Alpha Project", state: "active", available: true, updatedAt: "2026-09-02T00:00:02.000Z", teams: [{ id: teamA, name: "Alpha Team", channels: [{ id: channelA, name: "Alpha Channel", conversationId: conversationA }] }], coworkers: [{ id: coworkerA, name: "Alpha Coworker" }] },
        { projectId: projectB, name: "Beta Project", state: "active", available: true, updatedAt: "2026-09-02T00:00:01.000Z", teams: [{ id: teamB, name: "Beta Team", channels: [{ id: channelB, name: "Beta Channel", conversationId: conversationB }] }], coworkers: [{ id: coworkerB, name: "Beta Coworker" }] },
        { projectId: "project_cccccccccccccccc", name: "Archived Project", state: "archived", available: true, updatedAt: "2026-09-02T00:00:03.000Z", teams: [], coworkers: [] },
    ];
    const teams = [
        { id: teamA, name: "Alpha Team", coworkerIds: [coworkerA], channels: [{ id: channelA, name: "Alpha Channel", conversationId: conversationA, updatedAt: "2026-09-02T00:00:02.000Z", archived: false }] },
        { id: teamB, name: "Beta Team", coworkerIds: [coworkerB], channels: [{ id: channelB, name: "Beta Channel", conversationId: conversationB, updatedAt: "2026-09-02T00:00:01.000Z", archived: false }] },
    ];
    const conversations = [{ id: conversationA, title: conversationTitle, kind: "team", messageCount: 2, updatedAt: "2026-09-02T00:00:02.000Z", ...(latestPreview ? { lastMessage: { id: "msg_ffffffffffffffff", senderId: coworkerA, textPreview: latestPreview, createdAt: "2026-09-02T00:00:02.000Z" } } : {}) }, { id: conversationB, title: "Beta Conversation", kind: "team", messageCount: 1, updatedAt: "2026-09-02T00:00:01.000Z" }];
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
        conversationStore: { list: () => ({ conversations }), ...(includeSearchRecords ? { searchRecords: () => messageRecords } : {}) },
        coworkerStore: { list: () => ({ coworkers }) },
        artifactStore: { list: () => ({ artifacts: [{ id: artifactA, title: "Alpha Artifact", fileName: "alpha.txt", conversationId: conversationA, createdAt: "2026-09-02T00:00:02.000Z" }, { id: artifactB, title: "Beta Artifact", fileName: "beta.txt", conversationId: conversationB, createdAt: "2026-09-02T00:00:01.000Z" }] }), ...(artifactSearchRecords ? { searchRecords: () => ({ artifacts: artifactSearchRecords }) } : {}) },
        skillStore: { list: () => ({ skills }) },
        productSurfaces: { listPlaybooks: () => ({ playbooks }) },
        getRoutines: () => ({ routines }),
        memoryService: { indexRecords: async () => memoryRows },
        getJobs: () => ({ listJobs: () => ({ jobs }) }),
        getHistory: async () => ({ history }),
        internal: fullScan || beforeBuild ? { ...(fullScan ? { fullScan: true } : {}), ...(beforeBuild ? { beforeBuild } : {}) } : undefined,
    });
    return { service, projectsApi, routines, memoryRows, getProjectListCalls: () => projectListCalls };
}

test("conversation Search indexes retained message history and returns one safe anchored result", async () => {
    const targetMessageId = "msg_1234567890abcdef";
    const messageRecords = Array.from({ length: 450 }, (_, index) => ({
        conversationId: conversationA,
        messageId: index === 7 ? targetMessageId : `msg_${String(index + 1).padStart(16, "0")}`,
        text: index === 7 ? "P44 ancient quartz needle" : `Unrelated retained conversation message ${index}`,
        createdAt: `2026-09-02T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    }));
    const { service } = fixture({ messageRecords });
    const result = await service.query({ query: "P44 ancient quartz needle", types: ["conversations"], limit: 10 });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].id, conversationA);
    assert.equal(result.results[0].messageId, targetMessageId);
    assert.match(result.results[0].matchSnippet, /quartz needle/i);
    assert.equal(Object.hasOwn(result.results[0], "messageText"), false);
    assert.equal(Object.hasOwn(result.results[0], "searchText"), false);
    assert.equal(Object.hasOwn(result.results[0], "projectIds"), false);
    const stats = service.diagnostics();
    assert.ok(stats.candidateCount < stats.corpusCount);
    assert.ok(stats.matchEvaluations <= stats.candidateCount);
});

test("conversation Search redacts sensitive message patterns before indexing while preserving ordinary text", async () => {
    const messageRecords = [
        { conversationId: conversationA, messageId: "msg_abcdefabcdefabcd", text: "token=P44HiddenSecretValue C:\\Users\\Eternal\\private\\note.txt", createdAt: "2026-09-02T00:00:01.000Z" },
        { conversationId: conversationA, messageId: "msg_bcdefabcdefabcde", text: "P44 ordinary history phrase remains searchable", createdAt: "2026-09-02T00:00:02.000Z" },
    ];
    const { service } = fixture({ messageRecords });
    const secret = await service.query({ query: "P44HiddenSecretValue", types: ["conversations"], limit: 10 });
    assert.deepEqual(secret.results, []);
    const ordinary = await service.query({ query: "ordinary history phrase", types: ["conversations"], limit: 10 });
    assert.equal(ordinary.results[0].messageId, "msg_bcdefabcdefabcde");
    assert.match(ordinary.results[0].matchSnippet, /ordinary history phrase/i);
});

test("Artifact Search indexes bounded text content without leaking raw content", async () => {
    const artifactSearchRecords = [
        { id: artifactA, title: "P45 Text Artifact", fileName: "report.md", mimeType: "text/markdown", conversationId: conversationA, createdAt: "2026-09-02T00:00:04.000Z", searchText: "P45 unique artifact body" },
        { id: artifactB, title: "P45 Secret Artifact", fileName: "secret.md", mimeType: "text/markdown", conversationId: conversationB, createdAt: "2026-09-02T00:00:03.000Z", searchText: "token=P45HiddenArtifactSecret C:\\Users\\Eternal\\private\\secret.md" },
    ];
    const { service } = fixture({ artifactSearchRecords });
    const result = await service.query({ query: "P45 unique artifact body", types: ["artifacts"], limit: 10 });
    assert.equal(result.results[0]?.id, artifactA);
    assert.match(result.results[0]?.matchSnippet ?? "", /unique artifact body/i);
    assert.equal(Object.hasOwn(result.results[0], "searchText"), false);
    assert.equal(Object.hasOwn(result.results[0], "projectIds"), false);
    const secret = await service.query({ query: "P45HiddenArtifactSecret", types: ["artifacts"], limit: 10 });
    assert.deepEqual(secret.results, []);
});

test("conversation message candidates do not repeat titles and win content ties with the summary", async () => {
    const messageRecords = [{ conversationId: conversationA, messageId: "msg_cdefabcdefabcdef", text: "P44 tie content phrase", createdAt: "2026-09-02T00:00:03.000Z" }];
    const { service } = fixture({ messageRecords, latestPreview: "P44 tie content phrase" });
    const title = await service.query({ query: "Alpha Conversation", types: ["conversations"], limit: 10 });
    assert.ok(title.results.some((entry) => entry.id === conversationA));
    assert.ok(title.results.every((entry) => !Object.hasOwn(entry, "messageId")));
    const content = await service.query({ query: "P44 tie content phrase", types: ["conversations"], limit: 10 });
    assert.equal(content.results[0].messageId, "msg_cdefabcdefabcdef");
    messageRecords.push({ conversationId: conversationA, messageId: "msg_defabcdefabcdefa", text: "P44 Fresh Tail Invalidation", createdAt: "2026-09-02T00:00:04.000Z" });
    service.invalidate();
    const fresh = await service.query({ query: "P44 Fresh Tail Invalidation", types: ["conversations"], limit: 10 });
    assert.equal(fresh.results[0].messageId, "msg_defabcdefabcdefa");
});

test("conversation title-exact results beat lower-scoring message content matches", async () => {
    const messageRecords = [{ conversationId: conversationA, messageId: "msg_efabcdefabcdefab", text: "Alpha Conversation", createdAt: "2026-09-02T00:00:03.000Z" }];
    const { service } = fixture({ messageRecords, latestPreview: "Alpha Conversation" });
    const result = await service.query({ query: "Alpha Conversation", types: ["conversations"], limit: 10 });
    const alpha = result.results.find((entry) => entry.id === conversationA);
    assert.equal(alpha.matchReason.key, "title-exact");
    assert.equal(Object.hasOwn(alpha, "messageId"), false);
});

test("full-history Conversation Search keeps message content out of the summary projection", async () => {
    const messageRecords = [{ conversationId: conversationA, messageId: "msg_summarydedupe0001", text: "P44 body unique", createdAt: "2026-09-02T00:00:03.000Z" }];
    const { service } = fixture({ messageRecords, latestPreview: "P44 body unique", conversationTitle: "P44 History Search Team" });
    const content = await service.query({ query: "P44 body unique", types: ["conversations"], limit: 10 });
    assert.equal(content.results[0]?.messageId, "msg_summarydedupe0001");
    const title = await service.query({ query: "P44 History Search Team", types: ["conversations"], limit: 10 });
    assert.equal(title.results[0]?.id, conversationA);
    assert.equal(Object.hasOwn(title.results[0], "messageId"), false);
});

test("conversation Search preserves last-message preview fallback without full-history records", async () => {
    const { service } = fixture({ includeSearchRecords: false, latestPreview: "P44 fallback preview" });
    const result = await service.query({ query: "P44 fallback preview", types: ["conversations"], limit: 10 });
    assert.equal(result.results[0]?.id, conversationA);
    assert.equal(Object.hasOwn(result.results[0], "messageId"), false);
});

test("conversation Search invalidation cannot let an old build clear the current build", async () => {
    const deferred = () => {
        let release;
        const promise = new Promise((resolve) => { release = resolve; });
        return { promise, release };
    };
    const firstBuild = deferred();
    const currentBuild = deferred();
    const buildStarts = [];
    const buildStartWaiters = [];
    let observedBuilds = 0;
    const nextBuildStart = () => buildStarts.length > observedBuilds
        ? Promise.resolve()
        : new Promise((resolve) => buildStartWaiters.push(resolve));
    const messageRecords = [];
    const { service } = fixture({
        messageRecords,
        beforeBuild: ({ generation }) => {
            const barrier = buildStarts.length === 0 ? firstBuild : currentBuild;
            buildStarts.push({ generation, barrier });
            buildStartWaiters.shift()?.();
            return barrier.promise;
        },
    });

    const initialQuery = service.query({ query: "P44 race fresh", types: ["conversations"], limit: 10 });
    await nextBuildStart();
    observedBuilds = buildStarts.length;
    const fresh = { conversationId: conversationA, messageId: "msg_racefresh000001", text: "P44 race fresh", createdAt: "2026-09-02T00:00:05.000Z" };
    messageRecords.push(fresh);
    // The real store observer calls invalidate synchronously after append; this
    // test models that exact ordering while the first build is still blocked.
    service.invalidate();
    const currentQuery = service.query({ query: "P44 race fresh", types: ["conversations"], limit: 10 });
    await nextBuildStart();
    observedBuilds = buildStarts.length;
    assert.deepEqual(buildStarts.map(({ generation }) => generation), [0, 1]);
    firstBuild.release();
    await Promise.resolve();
    currentBuild.release();
    const [initial, current] = await Promise.all([initialQuery, currentQuery]);
    assert.equal(initial.results[0]?.messageId, fresh.messageId);
    assert.equal(current.results[0]?.messageId, fresh.messageId);
    assert.equal(initial.indexedAt, current.indexedAt);
    assert.equal(service.diagnostics().indexGeneration, service.diagnostics().generation);
    assert.equal(buildStarts.length, 2);
});

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
    const paged = await service.query({ query: "Alpha", limit: 1 });
    assert.equal(paged.results.length, 1);
    assert.equal(paged.total, result.results.length);
    assert.equal(paged.hasMore, true);
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

test("search relevance is field-aware, tolerant of useful partial phrases, and stable", async () => {
    const { service, memoryRows } = fixture();
    memoryRows.push({ id: "mem_cccccccccccccccc", title: "Reference note", content: "Unrelated body", tags: ["launch"], scope: "project", ownerId: projectA, state: "active", updatedAt: "2026-09-02T00:00:05.000Z", source: { type: "fact", label: "Approved fact" } });
    memoryRows.push({ id: "mem_dddddddddddddddd", title: "项目复盘记忆", content: "发布检查清单", tags: ["发布"], scope: "project", ownerId: projectA, state: "active", updatedAt: "2026-09-02T00:00:06.000Z", source: { type: "fact", label: "已批准事实" } });
    service.invalidate();

    const exact = await service.query({ query: "Alpha Project", types: ["projects"], limit: 10 });
    assert.equal(exact.results[0].matchReason.key, "title-exact");
    assert.ok(exact.results[0].matchReason.fields.includes("title"));
    assert.equal(exact.results[0].matchReason.coverage, 1);

    const phrase = await service.query({ query: "release checklist", types: ["memory"], limit: 10 });
    assert.equal(phrase.results[0].matchReason.key, "phrase");
    assert.ok(phrase.results[0].matchReason.fields.includes("content"));

    const tag = await service.query({ query: "launch", types: ["memory"], limit: 10 });
    assert.equal(tag.results[0].id, "mem_cccccccccccccccc");
    assert.equal(tag.results[0].matchReason.key, "tags");
    assert.deepEqual(tag.results[0].matchReason.fields, ["tags"]);
    assert.ok(SEARCH_MATCH_REASONS.includes(tag.results[0].matchReason.key));
    assert.equal(Object.hasOwn(tag.results[0], "tags"), false);
    assert.equal(Object.hasOwn(tag.results[0], "searchText"), false);

    const chinese = await service.query({ query: "发布", types: ["memory"], limit: 10 });
    assert.equal(chinese.results[0].id, "mem_dddddddddddddddd");
    assert.ok(["tags", "title-contains", "content"].includes(chinese.results[0].matchReason.key));

    const partial = await service.query({ query: "Alpha missing", types: ["projects"], limit: 10 });
    assert.equal(partial.results[0].id, projectA);
    assert.equal(partial.results[0].matchReason.coverage, 0.5);
    const weak = await service.query({ query: "workspace missing", types: ["history"], limit: 10 });
    assert.deepEqual(weak.results, []);

    const again = await service.query({ query: "Alpha", types: ["projects", "memory"], limit: 100 });
    assert.deepEqual(again.results.map(({ id, score, matchReason }) => ({ id, score, matchReason })), (await service.query({ query: "Alpha", types: ["projects", "memory"], limit: 100 })).results.map(({ id, score, matchReason }) => ({ id, score, matchReason })));
});

test("non-empty Search queries use a no-loss bounded candidate index before scoring", async () => {
    const { service } = fixture();
    const result = await service.query({ query: "Alpha Project", types: ["projects"], limit: 10 });
    const stats = service.diagnostics();
    assert.equal(result.results[0].id, projectA);
    assert.equal(stats.indexed, true);
    assert.ok(stats.candidateCount < stats.corpusCount);
    assert.ok(stats.matchEvaluations <= stats.candidateCount);
    assert.equal(Object.hasOwn(result, "diagnostics"), false);
});

test("indexed Search results equal the internal full-scan oracle across match fields", async () => {
    const indexedFixture = fixture();
    const oracleFixture = fixture({ fullScan: true });
    const cjk = { id: "mem_cccccccccccccccc", title: "项目复盘记忆", content: "发布检查清单", tags: ["发布"], scope: "project", ownerId: projectA, state: "active", updatedAt: "2026-09-02T00:00:06.000Z", source: { type: "fact", label: "已批准事实" } };
    indexedFixture.memoryRows.push(cjk);
    oracleFixture.memoryRows.push(structuredClone(cjk));
    indexedFixture.service.invalidate();
    oracleFixture.service.invalidate();
    const cases = [
        { query: "Alpha Project", types: ["projects"] },
        { query: "launch", types: ["memory"] },
        { query: "发", types: ["memory"] },
        { query: "alpha.txt", types: ["artifacts"] },
        { query: "release checklist", types: ["memory"] },
        { query: "Alpha missing", types: ["projects"] },
    ];
    for (const input of cases) {
        const indexed = await indexedFixture.service.query({ ...input, limit: 100 });
        const oracle = await oracleFixture.service.query({ ...input, limit: 100 });
        assert.deepEqual(indexed.results, oracle.results, input.query);
        assert.equal(indexed.total, oracle.total, input.query);
    }
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
