import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArtifactStore } from "../src/main/artifact-store.js";
import { createConversationStore } from "../src/main/conversation-store.js";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createEventTriggerController } from "../src/main/event-trigger-controller.js";
import { createJobController } from "../src/main/job-controller.js";
import { createRoutineController } from "../src/main/routine-controller.js";
import { createSkillStore } from "../src/main/skill-store.js";
import { createDesktopServices } from "../src/main/services.js";
import { createTeamService } from "../src/main/team-service.js";
import { createTeachOnceController } from "../src/main/teach-once-controller.js";
import { coworkerAgentId } from "../src/main/provider-roster.js";

function root(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }

test("P3 offline canary keeps Skill content safe and completes Teach Once manual review", async () => {
  const dataDir = root("sovereign-p3-skill-");
  try {
    let skillSequence = 0;
    const skills = createSkillStore({ persistPath: join(dataDir, "skills.json"), makeSkillId: () => `skill_000000000000000${++skillSequence}` });
    assert.throws(() => skills.create({ name: "Unsafe", instructions: "Read C:\\private\\result.txt" }), /private path/);
    assert.throws(() => skills.create({ name: "Unsafe", instructions: "Use x=100 and y=200" }), /coordinate/);
    assert.throws(() => skills.importSkill({ schema: "sovereignbot.desktop.skill.v1", name: "Imported", instructions: "Use bearer: leaked", steps: [] }), /credential/);
    const safe = skills.create({
      name: "Prepare report", description: "A bounded semantic report task.", instructions: "Use semantic Computer actions and verify the visible result.",
      inputs: [{ name: "period", type: "string", description: "The report period.", required: true }], steps: ["Open the report", "Verify the report is ready."],
      expectedOutput: "Report is ready", requestedCapabilities: ["computer"], validators: ["contains: Report is ready"],
    });
    assert.deepEqual(safe.requestedCapabilities, ["computer"]);
    assert.equal(Object.hasOwn(safe, "requiredCapabilities"), false);
    assert.throws(() => skills.update(safe.id, { steps: ["Open C:\\private\\report"] }), /private path/);

    const coworkerId = "coworker_0000000000000001";
    const coworkers = createCoworkerStore({ persistPath: join(dataDir, "coworkers.json"), makeId: () => coworkerId });
    coworkers.create({ name: "Browser Specialist", role: "Prepare browser work", instructions: "Use semantic targets." });
    const rawComputer = {
      async snapshot() { return { snapshotId: "snapshot_0000000000000001", elements: [{ ref: "status-1", role: "status", name: "Report is ready", text: "Report is ready" }] }; },
      async navigate() {},
    };
    const teach = createTeachOnceController({
      dataDir, coworkerStore: coworkers, skillStore: skills, rawComputer, getAgentId: () => "agent-browser-specialist",
      generateDraft: async () => ({ name: "Prepare report", description: "A bounded semantic report task.", instructions: "Verify the visible report result.", inputs: [], steps: ["Verify the report is ready."], expectedOutput: "Report is ready", requestedCapabilities: ["computer"], validators: ["manual: confirm the result"] }),
      testExecutor: ({ execute, agentId, signal }) => execute({ computer: rawComputer, agentId, taskId: "task_teach_once", signal }),
      makeId: () => "teach_0000000000000001",
    });
    const session = teach.start({ coworkerId, name: "Prepare report", description: "A bounded semantic report task." });
    await teach.recordAction(session.id, { kind: "assert", target: "Report status", validator: "manual", expectedOutput: "Report is ready" });
    await teach.finish(session.id);
    const pending = await teach.test(session.id);
    assert.equal(pending.status, "awaiting-confirmation");
    assert.equal(pending.session.state, "drafted");
    assert.throws(() => teach.save(session.id), /test the skill draft/);
    teach.confirm(session.id);
    const passed = await teach.test(session.id);
    assert.equal(passed.ok, true);
    const saved = teach.save(session.id);
    assert.equal(saved.skill.source, "taught");
    assert.equal(saved.skill.requestedCapabilities[0], "computer");
    assert.equal(JSON.stringify(teach.list()).includes("snapshot_"), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("P3 offline canary uses declarative Playbook handoff and one governed Routine Job", async () => {
  const dataDir = root("sovereign-p3-routine-");
  try {
    const coworkers = createCoworkerStore({ persistPath: join(dataDir, "coworkers.json") });
    const conversations = createConversationStore({ persistPath: join(dataDir, "conversations.json"), coworkerStore: coworkers });
    const services = createDesktopServices({ dataDir, dialog: {} });
    const teams = createTeamService({ dataDir, coworkerStore: coworkers, conversationStore: conversations, services });
    const installed = teams.installPack("software-team");
    const team = installed.team;
    assert.deepEqual(team.playbooks[0].steps, ["chief", "coding-lead", "reviewer", "chief"]);
    teams.setRuntimeHandoffPreflight(({ conversationId, targetCoworkerId, workspaceId }) => ({ targetCoworkerId, agentId: "test-agent", workspaceId: workspaceId ?? teams.workspaceIdForConversation(conversationId) }));
    const conversation = conversations.get(team.channels[0].conversationId);
    const userMessage = conversations.postUserMessage(conversation.id, { text: "Review this bounded delivery." });
    teams.onMessageQueued({ conversation: conversations.get(conversation.id), message: userMessage });
    const recommended = teams.routeSpecialist({ conversationId: conversation.id, coworkerId: team.coworkerIds[0], objective: userMessage.text });
    assert.ok(recommended?.targetCoworkerId, "current owner can request a bounded specialist recommendation");
    const context = teams.collaborationContextForConversation(conversation.id);
    const skippedTarget = team.coworkerIds[2];
    const proof = teams.authorizeHandoffTarget({ conversationId: conversation.id, sourceCoworkerId: team.coworkerIds[0], targetCoworkerId: skippedTarget, expectedVersion: context.version, expectedRunId: context.runId, expectedRequestId: context.requestId, expectedOperationId: context.operationId, expectedOperationToken: context.operationToken });
    assert.equal(teams.nextHandoff({ conversation: conversations.get(conversation.id), coworkerId: team.coworkerIds[0], source: userMessage, requestedCoworkerIds: [skippedTarget], runtimeProof: proof, expectedTargetCoworkerId: skippedTarget, expectedVersion: context.version, expectedRunId: context.runId, expectedRequestId: context.requestId, expectedOperationId: context.operationId, expectedOperationToken: context.operationToken }), skippedTarget);
    assert.equal(teams.status(team.id).activeProtocol.kind, "review", "the same Team handoff path represents a requested review");
    const exported = teams.exportPack(team.id);
    assert.throws(() => teams.importPack({ ...exported, channels: [{ ...exported.channels[0], playbookId: "missing-playbook" }] }), /unknown playbook/);
    assert.throws(() => teams.importPack({ ...exported, playbooks: [{ ...exported.playbooks[0], steps: ["chief", "missing-coworker"] }] }), /unknown coworker/);

    const ownerId = team.coworkerIds[0];
    const workspaceId = team.sharedWorkspaceId;
    const workspacePath = services.workspacePath(workspaceId);
    const projectId = "project_0000000000000001";
    const projectService = { resolveScope(id) {
      if (id !== projectId) throw new Error("unknown project");
      return { projectId, workspaceId, state: "active", teamIds: [team.id], coworkerIds: [] };
    } };
    const skills = createSkillStore({ persistPath: join(dataDir, "skills.json"), makeSkillId: () => "skill_0000000000000001" });
    const skill = skills.create({ name: "Report skill", instructions: "Verify the bounded report result.", steps: ["Verify the report."], requestedCapabilities: ["computer"] });
    skills.setTargetResolver({ hasCoworker: (id) => coworkers.list({ includeArchived: true }).coworkers.some((entry) => entry.id === id), hasTeam: (id) => id === team.id, teamIdsForCoworker: (id) => id === ownerId ? [team.id] : [] });
    skills.assign(skill.id, { targetKind: "team", targetId: team.id, enabled: true });

    const tasks = [];
    const runtime = { orchestrator: {
      async createPlan(input) { return { id: `plan_${tasks.length + 1}`, ...input }; },
      async delegateTrusted(planId, spec, executionContext, supervisorId) { const task = { id: `task_${tasks.length + 1}`, planId, status: "queued", input: spec.input, executionContext, supervisorId }; tasks.push(task); return structuredClone(task); },
      async runUntilIdle() { for (const task of tasks) if (task.status === "queued") { task.status = "completed"; task.result = { text: "Report artifact is ready." }; } },
      async listTasks() { return structuredClone(tasks); },
      async aggregatePlan(planId) { return { planId, status: "completed" }; },
    } };
    const roster = () => ({ ready: true, mode: "provider", roles: { planner: "test-supervisor" }, coworkerBindings: { [ownerId]: { ready: true, agentId: coworkerAgentId(ownerId), provider: "fake" } } });
    const jobs = createJobController({ dataDir, runtime, roster, coworkerStore: { get(id) { const entry = coworkers.get(id); return { ...entry, workspaceIds: [workspaceId] }; } }, services, skillStore: skills, supervisorAgentId: "test-supervisor", readiness: () => ({ allowed: true }), projectService, teamService: teams });
    const routines = createRoutineController({ dataDir, jobController: jobs, coworkerStore: coworkers, skillStore: skills, services, projectService, teamService: teams, makeId: () => "routine_0000000000000001", makeHistoryId: () => "run_0000000000000001", now: () => Date.parse("2026-09-02T04:00:00.000Z") });
    const routine = routines.create({ name: "Report routine", coworkerId: ownerId, teamId: team.id, projectId, instruction: "Prepare the bounded report.", skillId: skill.id, workspaceId, schedule: { type: "custom", intervalMinutes: 60 } });
    assert.equal(routine.projectId, projectId);
    assert.equal(routine.teamId, team.id);
    assert.throws(() => routines.create({ name: "Cross scope", coworkerId: ownerId, projectId: "project_0000000000000002", instruction: "Reject this.", workspaceId, schedule: { type: "daily", time: "09:00" } }), /unknown project/);
    const run = routines.runNow(routine.id);
    assert.equal(run.job.teamId, team.id);
    assert.equal(run.job.projectId, projectId);
    await jobs.wakeDueJobs();
    await jobs.flush();
    assert.equal(tasks.length, 1, "Run Now must create exactly one ordinary governed Job");
    assert.equal(jobs.getJob(run.job.id).status, "completed");
    assert.equal(routines.history(routine.id).history[0].status, "completed");

    const artifactFile = join(workspacePath, "report.md");
    writeFileSync(artifactFile, "Report artifact is ready.\n", "utf8");
    const artifacts = createArtifactStore({ dataDir, makeArtifactId: () => "artifact_0000000000000001" });
    const artifact = artifacts.ingestWorkspaceFile({ workspaceId, workspacePath, relativePath: "report.md", title: "Report result", createdByCoworkerId: ownerId });
    assert.equal(artifacts.get(artifact.id).title, "Report result");
    assert.equal(routines.history(routine.id).history.length, 1);
    skills.setRetestRunner((definition) => jobs.submitJob({ title: `Retest ${definition.name}`, objective: "Run the bounded Skill retest.", ownerCoworkerId: ownerId, internalContext: { skillId: definition.id, workspaceId } }));
    const retest = skills.retestSkill(skill.id);
    assert.equal(retest.mode, "governed-job");
    await jobs.wakeDueJobs();
    await jobs.flush();
    assert.equal(tasks.length, 2, "Skill retest must use the ordinary governed Job path");

    const pausedRun = routines.runNow(routine.id);
    await jobs.pause(pausedRun.job.id);
    const retry = await routines.retry(routine.id, pausedRun.run.id);
    assert.equal(retry.status, "queued");
    await jobs.flush();
    routines.archive(routine.id);
    assert.throws(() => routines.runNow(routine.id), /archived or disabled/);
    routines.restore(routine.id);
    assert.equal(routines.get(routine.id).state, "active");

    mkdirSync(join(workspacePath, "inbox"), { recursive: true });
    let watcherCallback;
    const events = createEventTriggerController({ dataDir, routineController: routines, services, quietMs: 0, scheduleTimer: (fn) => { fn(); return 0; }, cancelTimer: () => {}, watchFactory: (_root, _options, callback) => { watcherCallback = callback; return { close() {} }; }, makeId: () => "trigger_0000000000000001", makeEventId: () => "event_0000000000000001" });
    const trigger = events.create({ name: "Report watcher", routineId: routine.id, workspaceId, pathPrefix: "inbox" });
    events.start();
    watcherCallback("change", "result.json");
    await events.flush();
    assert.equal(events.get(trigger.id).lastStatus, "fired");
    assert.equal(routines.history(routine.id).history[0].source, "event");
    skills.archive(skill.id);
    assert.throws(() => routines.restore(routine.id), /archived/);
    events.stop();
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
