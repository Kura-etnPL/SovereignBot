import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateComputerActionList, validateComputerEnvelope } from "../../src/worker-computer-protocol.js";
import { createComputerTargetController } from "../src/main/computer-target-controller.js";
import { createCoworkerDispatcher } from "../src/main/coworker-dispatcher.js";
import { createEventTriggerController } from "../src/main/event-trigger-controller.js";
import { createJobController } from "../src/main/job-controller.js";
import { createRoutineController } from "../src/main/routine-controller.js";
import { validateIpcRequest } from "../src/main/lib/ipc-schema.js";
import { validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";

const NODE_ID = "worker_0000000000000001";
const SECOND_NODE_ID = "worker_0000000000000002";
const COMPUTER_ID = "computer_0000000000000001";
const OWNER_ID = "coworker_0000000000000001";
const TEAM_ID = "team_0000000000000001";
const PROJECT_ONE = "project_0000000000000001";
const PROJECT_TWO = "project_0000000000000002";
const WORKSPACE_ONE = "workspace_0000000000000001";
const WORKSPACE_TWO = "workspace_0000000000000002";

function root(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }

function makeWorkerRegistry() {
  const requests = new Map();
  let state = "online";
  const workspaces = [{ id: WORKSPACE_ONE, name: "Project one" }, { id: WORKSPACE_TWO, name: "Project two" }];
  const client = {
    async computerHealth() { return { protocol: "sovereign-worker-computer/1", computer: { id: COMPUTER_ID, name: "Loopback Worker Computer", state, capacity: 1, currentLoad: 0, capabilities: ["snapshot", "navigate", "click", "type", "key", "scroll", "list_files", "read_file", "write_file", "request_help"] } }; },
    async computerAction(envelope) {
      validateComputerEnvelope(envelope);
      const prior = requests.get(envelope.requestId);
      if (prior) return { ...prior, duplicate: true };
      const result = { operation: envelope.operation, snapshotId: envelope.operation === "snapshot" ? "snapshot_0000000000000001" : undefined, applied: envelope.operation !== "snapshot" };
      const response = { protocol: "sovereign-worker-computer/1", requestId: envelope.requestId, status: "completed", summary: "completed", result };
      requests.set(envelope.requestId, response);
      return { ...response, duplicate: false };
    },
  };
  const registry = {
    async resolveComputerTarget(nodeId, workspaceId, computerId) {
      if (nodeId !== NODE_ID) throw new Error("unknown Worker Node");
      if (!workspaces.some((entry) => entry.id === workspaceId)) throw new Error("selected workspace is not advertised by the Worker Node");
      const health = await client.computerHealth();
      if (health.computer.id !== computerId) throw new Error("selected Worker Computer is not advertised by the Worker Node");
      if (state !== "online") throw new Error("selected Worker Computer is unavailable");
      return { node: { nodeId: NODE_ID, name: "Loopback Worker", status: "online" }, workspace: workspaces.find((entry) => entry.id === workspaceId), computer: health.computer, client };
    },
    list() { return { nodes: [{ nodeId: NODE_ID, name: "Loopback Worker", status: "online", enabled: true, workspaces, computer: { id: COMPUTER_ID, name: "Loopback Worker Computer", state, capacity: 1, currentLoad: 0, capabilities: ["snapshot", "type"] } }, { nodeId: SECOND_NODE_ID, name: "Capacity Limited Worker", status: "online", enabled: true, workspaces, computer: { id: "computer_0000000000000002", name: "Capacity Limited Computer", state: "capacity-limited", capacity: 1, currentLoad: 1, capabilities: ["snapshot", "type"] } }] }; },
    setState(value) { state = value; },
  };
  return { registry, requests };
}

function makeRuntime() {
  return { orchestrator: { async listTasks() { return []; } } };
}

test("P4 Worker Computer protocol is bounded, credential-free, and replay-safe", () => {
  const base = {
    protocol: "sovereign-worker-computer/1", requestId: "computer_request_0000000000000001",
    jobId: "job_0000000000000001", ownerCoworkerId: OWNER_ID, workspaceId: WORKSPACE_ONE,
    computerId: COMPUTER_ID, operation: "type", input: { snapshotId: "snapshot_1", ref: "status", text: "hello" },
    attempt: 0, createdAt: "2026-09-02T00:00:00.000Z",
  };
  assert.equal(validateComputerEnvelope(base).operation, "type");
  assert.throws(() => validateComputerEnvelope({ ...base, input: { ...base.input, text: "bearer: leaked" } }), /private|secret|runtime/i);
  assert.throws(() => validateComputerEnvelope({ ...base, input: { snapshotId: "snapshot_1", ref: "status", text: "C:\\private\\secret.txt" } }), /private|secret/i);
  assert.throws(() => validateComputerEnvelope({ ...base, operation: "type", input: { snapshotId: "snapshot_1", ref: "status", text: "x=10 y=20" } }), /coordinate/i);
  assert.throws(() => validateComputerEnvelope({ ...base, operation: "read_file", input: { path: "../escape" } }), /relative workspace path/i);
  assert.throws(() => validateComputerActionList([{ operation: "takeover", input: { actorId: OWNER_ID } }]), /cannot use/i);
  assert.throws(() => validateIpcRequest("job:submit", { title: "x", objective: "y", ownerCoworkerId: OWNER_ID, computerTarget: { kind: "worker-computer", nodeId: NODE_ID, workspaceId: WORKSPACE_ONE, computerId: COMPUTER_ID }, computerActions: [{ operation: "type", input: { snapshotId: "s", ref: "r", text: "ok" } }], command: "powershell" }), /unknown|not accepted/i);
  const teamRequest = validateV3IpcRequest("team:computerTask", { title: "Team computer task", objective: "Use the bounded Worker Computer", ownerCoworkerId: OWNER_ID, teamId: TEAM_ID, computerTarget: { kind: "worker-computer", nodeId: NODE_ID, workspaceId: WORKSPACE_ONE, computerId: COMPUTER_ID } });
  assert.equal(teamRequest.computerActions[0].operation, "snapshot");
});

test("P4 offline canary routes Job, Routine, Event Trigger, and Team task through one Worker Computer controller", async () => {
  const dataDir = root("sovereign-p4-worker-computer-");
  const workspaceOnePath = join(dataDir, "workspace-one");
  const workspaceTwoPath = join(dataDir, "workspace-two");
  mkdirSync(workspaceOnePath, { recursive: true });
  mkdirSync(workspaceTwoPath, { recursive: true });
  try {
    const { registry, requests } = makeWorkerRegistry();
    const registryView = registry.list();
    assert.equal(registryView.nodes.length, 2);
    assert.equal(registryView.nodes[1].computer.state, "capacity-limited");
    const audits = [];
    const controller = createComputerTargetController({ workerNodeStore: registry, audit: { async append(entry) { audits.push(entry); } } });
    const coworkerStore = { get(id) { if (id !== OWNER_ID) throw new Error("unknown coworker"); return { id, name: "Worker operator", state: "active", workspaceIds: [WORKSPACE_ONE, WORKSPACE_TWO] }; } };
    const services = { workspacePath(id) { return id === WORKSPACE_ONE ? workspaceOnePath : id === WORKSPACE_TWO ? workspaceTwoPath : undefined; } };
    const projectService = { resolveScope(id) { if (id === PROJECT_ONE) return { projectId: id, state: "active", workspaceId: WORKSPACE_ONE, coworkerIds: [OWNER_ID], teamIds: [TEAM_ID] }; if (id === PROJECT_TWO) return { projectId: id, state: "active", workspaceId: WORKSPACE_TWO, coworkerIds: [OWNER_ID], teamIds: [TEAM_ID] }; throw new Error("unknown project"); } };
    const teamService = { get(id) { if (id !== TEAM_ID) throw new Error("unknown team"); return { id, state: "active", coworkerIds: [OWNER_ID] }; } };
    const runtime = makeRuntime();
    const jobs = createJobController({ dataDir, runtime, roster: () => ({ ready: false }), coworkerStore, services, workerNodeStore: registry, computerTargetController: controller, projectService, teamService, supervisorAgentId: "supervisor" });
    const target = { kind: "worker-computer", nodeId: NODE_ID, workspaceId: WORKSPACE_ONE, computerId: COMPUTER_ID };
    const job = jobs.submitJob({ title: "Manual Worker Computer", objective: "Take a bounded snapshot and type a safe status.", ownerCoworkerId: OWNER_ID, computerTarget: target, computerActions: [{ operation: "snapshot", input: {} }, { operation: "type", input: { snapshotId: "snapshot_0000000000000001", ref: "status", text: "ready" } }], internalContext: { projectId: PROJECT_ONE, teamId: TEAM_ID, workspaceId: WORKSPACE_ONE } });
    await jobs.flush();
    assert.equal(jobs.getJob(job.id).status, "completed");
    assert.equal(jobs.getJob(job.id).computerTarget.computerId, COMPUTER_ID);
    assert.equal(audits.filter((entry) => entry.type === "computer.worker_action_completed").length, 2);
    const actionCount = requests.size;
    const replay = await controller.execute({ job: { ...job, computerTarget: target }, actions: [{ operation: "snapshot", input: {} }] });
    assert.equal(replay.actions[0].duplicate, true);
    assert.equal(requests.size, actionCount);

    const routines = createRoutineController({ dataDir, jobController: jobs, coworkerStore, services, projectService, teamService, computerTargetController: controller, makeId: () => "routine_0000000000000001", makeHistoryId: () => "run_0000000000000001" });
    const routine = routines.create({ name: "Worker Computer routine", coworkerId: OWNER_ID, teamId: TEAM_ID, projectId: PROJECT_ONE, workspaceId: WORKSPACE_ONE, instruction: "Run the bounded computer check.", computerTarget: target, computerActions: [{ operation: "snapshot", input: {} }], schedule: { type: "custom", intervalMinutes: 60 } });
    const routineRun = routines.runNow(routine.id);
    await jobs.wakeDueJobs();
    await jobs.flush();
    assert.equal(jobs.getJob(routineRun.job.id).status, "completed");
    assert.equal(routines.history(routine.id).history[0].status, "completed");

    let watcherCallback;
    const events = createEventTriggerController({ dataDir, routineController: routines, services, quietMs: 0, scheduleTimer: (fn) => { fn(); return 0; }, cancelTimer: () => {}, watchFactory: (_root, _options, callback) => { watcherCallback = callback; return { close() {} }; }, makeId: () => "trigger_0000000000000001", makeEventId: () => "event_0000000000000001" });
    const trigger = events.create({ name: "Worker Computer event", routineId: routine.id, workspaceId: WORKSPACE_ONE, pathPrefix: "inbox" });
    events.start();
    watcherCallback("change", "inbox/status.json");
    await events.flush();
    await jobs.wakeDueJobs();
    await jobs.flush();
    assert.equal(events.get(trigger.id).lastStatus, "fired");
    assert.equal(routines.history(routine.id).history[0].source, "event");

    const conversations = { get() { throw new Error("conversation not used"); } };
    const dispatcher = createCoworkerDispatcher({ dataDir, runtime, roster: () => ({ ready: false }), coworkerStore, conversationStore: conversations, services, jobController: jobs, teamFlow: teamService });
    const teamJob = dispatcher.dispatchComputerTask({ title: "Team Worker Computer task", objective: "Run the shared bounded check.", ownerCoworkerId: OWNER_ID, teamId: TEAM_ID, projectId: PROJECT_ONE, workspaceId: WORKSPACE_ONE, computerTarget: target, computerActions: [{ operation: "snapshot", input: {} }] });
    await jobs.flush();
    assert.equal(jobs.getJob(teamJob.id).status, "completed");

    registry.setState("offline");
    const unhealthy = jobs.submitJob({ title: "Unavailable Worker Computer", objective: "Must require attention.", ownerCoworkerId: OWNER_ID, computerTarget: target, internalContext: { projectId: PROJECT_ONE, workspaceId: WORKSPACE_ONE } });
    await jobs.flush();
    assert.equal(jobs.getJob(unhealthy.id).status, "needs_attention");
    assert.throws(() => jobs.submitJob({ title: "Cross project", objective: "Reject scope mismatch.", ownerCoworkerId: OWNER_ID, computerTarget: target, internalContext: { projectId: PROJECT_TWO, workspaceId: WORKSPACE_TWO } }), /workspace|Computer target/);
    assert.equal(JSON.stringify(registry.list()).includes("endpoint"), false);
    assert.equal(JSON.stringify(audits).includes("C:\\\\private"), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
