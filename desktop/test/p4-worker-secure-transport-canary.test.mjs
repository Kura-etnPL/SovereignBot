import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createOpaqueRelay, createSecureChannelPair, createSecureWorkerComputerClient, attachSecureWorkerComputerServer } from "../../src/worker-secure-transport.js";
import { createWorkerTrustStore } from "../../src/worker-trust-store.js";
import { createComputerTargetController } from "../src/main/computer-target-controller.js";
import { createCoworkerDispatcher } from "../src/main/coworker-dispatcher.js";
import { createEventTriggerController } from "../src/main/event-trigger-controller.js";
import { createJobController } from "../src/main/job-controller.js";
import { createRoutineController } from "../src/main/routine-controller.js";
import { createWorkerNodeStore } from "../src/main/worker-node-store.js";

const NODE_ID = "worker_0000000000000001";
const COMPUTER_ID = "computer_0000000000000001";
const OWNER_ID = "coworker_0000000000000001";
const TEAM_ID = "team_0000000000000001";
const PROJECT_ID = "project_0000000000000001";
const WORKSPACE_ID = "workspace_0000000000000001";

function root(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }

test("Desktop secure registry routes the existing Job/Routine/Event/Team path through LAN trust", async () => {
  const dataDir = root("sovereign-p4-secure-desktop-");
  const workerDir = root("sovereign-p4-secure-worker-");
  const workspacePath = join(dataDir, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const audits = [];
  let computerState = "online";
  let computerLoad = 0;
  const requests = new Map();
  try {
    const desktopTrust = createWorkerTrustStore({ dataDir, name: "Desktop Windows", platform: "win32" });
    const workerTrust = createWorkerTrustStore({ dataDir: workerDir, name: "Worker Linux", platform: "linux" });
    const workerClient = {
      async health() { return { protocol: "sovereign-worker/1", node: { id: NODE_ID, name: "LAN Linux Worker", platform: "linux", arch: "x64" }, ready: true, capabilities: ["snapshot", "type"], workspaces: [{ id: WORKSPACE_ID, name: "Secure workspace" }], computer: { id: COMPUTER_ID, name: "LAN Linux Computer", state: computerState, capacity: 1, currentLoad: 0, capabilities: ["snapshot", "type", "takeover", "release"] } }; },
      async computerHealth() { return { protocol: "sovereign-worker-computer/1", computer: { id: COMPUTER_ID, name: "LAN Linux Computer", state: computerState, capacity: 1, currentLoad: computerLoad, capabilities: ["snapshot", "type", "takeover", "release"] } }; },
    };
    const relay = createOpaqueRelay();
    let secureClient;
    const workerNodeStore = createWorkerNodeStore({ dataDir, trustStore: desktopTrust, clientFactory: () => workerClient, secureClientFactory: () => {
      if (!secureClient) {
        const pair = createSecureChannelPair({ leftIdentity: desktopTrust.identity(), rightIdentity: workerTrust.identity(), leftTrust: desktopTrust.getPeer(workerTrust.identity().deviceId), rightTrust: workerTrust.getPeer(desktopTrust.identity().deviceId), transport: "lan", relay });
        attachSecureWorkerComputerServer(pair.right, {
          computerHealth: workerClient.computerHealth,
          computerAction: async (envelope) => {
            if (![WORKSPACE_ID].includes(envelope.workspaceId)) throw new Error("workspace mismatch");
            if (!["online", "capacity-limited"].includes(computerState)) throw new Error("health unavailable");
            const prior = requests.get(envelope.requestId);
            if (prior) return { ...prior, duplicate: true };
            const result = { operation: envelope.operation, actorId: envelope.input.actorId };
            const response = { protocol: "sovereign-worker-computer/1", requestId: envelope.requestId, status: "completed", summary: "secure bounded action completed", result };
            requests.set(envelope.requestId, response);
            return { ...response, duplicate: false };
          },
        });
        secureClient = createSecureWorkerComputerClient(pair.left);
      }
      return secureClient;
    } });

    const paired = await workerNodeStore.pair({ protocol: "sovereign-worker/1", nodeId: NODE_ID, name: "LAN Linux Worker", endpoint: "http://127.0.0.1:43123", token: "a".repeat(43) });
    const offer = workerNodeStore.trust.beginPairing(NODE_ID, { transport: "lan", ttlMs: 60_000 }).offer;
    const response = workerTrust.acceptPairing(offer, offer.code, { trustTtlMs: 60_000 });
    const trusted = workerNodeStore.trust.completePairing(NODE_ID, offer, response);
    assert.equal(trusted.trust.status, "trusted");
    assert.equal(trusted.trust.transport, "lan");
    assert.equal(JSON.stringify(workerNodeStore.list()).includes("endpoint"), false);
    assert.equal(JSON.stringify(workerNodeStore.list()).includes("PrivateKey"), false);

    const registry = workerNodeStore;
    const controller = createComputerTargetController({ workerNodeStore: registry, audit: { async append(entry) { audits.push(entry); } } });
    const coworkerStore = { get(id) { if (id !== OWNER_ID) throw new Error("unknown coworker"); return { id, name: "Secure operator", state: "active", workspaceIds: [WORKSPACE_ID] }; } };
    const services = { workspacePath(id) { return id === WORKSPACE_ID ? workspacePath : undefined; } };
    const projectService = { resolveScope(id) { if (id !== PROJECT_ID) throw new Error("unknown project"); return { projectId: id, state: "active", workspaceId: WORKSPACE_ID, coworkerIds: [OWNER_ID], teamIds: [TEAM_ID] }; } };
    const teamService = { get(id) { if (id !== TEAM_ID) throw new Error("unknown team"); return { id, state: "active", coworkerIds: [OWNER_ID] }; } };
    const runtime = { orchestrator: { async listTasks() { return []; } } };
    const jobs = createJobController({ dataDir, runtime, roster: () => ({ ready: false }), coworkerStore, services, workerNodeStore: registry, computerTargetController: controller, projectService, teamService, supervisorAgentId: "supervisor" });
    const target = { kind: "worker-computer", nodeId: NODE_ID, workspaceId: WORKSPACE_ID, computerId: COMPUTER_ID };
    assert.equal((await registry.resolveComputerTarget(NODE_ID, WORKSPACE_ID, COMPUTER_ID)).computer.id, COMPUTER_ID);
    const job = jobs.submitJob({ title: "Secure LAN Computer", objective: "Run a bounded snapshot.", ownerCoworkerId: OWNER_ID, computerTarget: target, computerActions: [{ operation: "snapshot", input: {} }], internalContext: { projectId: PROJECT_ID, teamId: TEAM_ID, workspaceId: WORKSPACE_ID } });
    await jobs.flush();
    assert.equal(jobs.getJob(job.id).status, "completed", JSON.stringify(jobs.getJob(job.id)));
    assert.equal((await controller.takeover({ job, actorId: OWNER_ID })).operation, "takeover");
    assert.equal((await controller.release({ job, actorId: OWNER_ID })).operation, "release");

    const routines = createRoutineController({ dataDir, jobController: jobs, coworkerStore, services, projectService, teamService, computerTargetController: controller, makeId: () => "routine_0000000000000001", makeHistoryId: () => "run_0000000000000001" });
    const routine = routines.create({ name: "Secure routine", coworkerId: OWNER_ID, teamId: TEAM_ID, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, instruction: "Run secure snapshot", computerTarget: target, computerActions: [{ operation: "snapshot", input: {} }], schedule: { type: "custom", intervalMinutes: 60 } });
    const routineRun = routines.runNow(routine.id); await jobs.wakeDueJobs(); await jobs.flush();
    assert.equal(jobs.getJob(routineRun.job.id).status, "completed");
    let watcherCallback;
    const events = createEventTriggerController({ dataDir, routineController: routines, services, quietMs: 0, scheduleTimer: (fn) => { fn(); return 0; }, cancelTimer: () => {}, watchFactory: (_root, _options, callback) => { watcherCallback = callback; return { close() {} }; }, makeId: () => "trigger_0000000000000001", makeEventId: () => "event_0000000000000001" });
    const trigger = events.create({ name: "Secure event", routineId: routine.id, workspaceId: WORKSPACE_ID, pathPrefix: "inbox" }); events.start(); watcherCallback("change", "inbox/status.json"); await events.flush(); await jobs.wakeDueJobs(); await jobs.flush();
    assert.equal(events.get(trigger.id).lastStatus, "fired");
    const dispatcher = createCoworkerDispatcher({ dataDir, runtime, roster: () => ({ ready: false }), coworkerStore, conversationStore: { get() { throw new Error("conversation not used"); } }, services, jobController: jobs, teamFlow: teamService });
    const teamJob = dispatcher.dispatchComputerTask({ title: "Secure team task", objective: "Run secure snapshot", ownerCoworkerId: OWNER_ID, teamId: TEAM_ID, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, computerTarget: target, computerActions: [{ operation: "snapshot", input: {} }] }); await jobs.flush();
    assert.equal(jobs.getJob(teamJob.id).status, "completed");

    const rotating = workerNodeStore.trust.rotate(NODE_ID);
    assert.equal(rotating.trust.status, "rotating");
    const rotatedOffer = workerNodeStore.trust.beginPairing(NODE_ID, { transport: "lan", ttlMs: 60_000 }).offer;
    const rotatedResponse = workerTrust.acceptPairing(rotatedOffer, rotatedOffer.code, { trustTtlMs: 60_000 });
    workerNodeStore.trust.completePairing(NODE_ID, rotatedOffer, rotatedResponse);
    secureClient = undefined;
    assert.equal((await registry.resolveComputerTarget(NODE_ID, WORKSPACE_ID, COMPUTER_ID)).computer.id, COMPUTER_ID);

    computerState = "capacity-limited";
    computerLoad = 1;
    const limited = jobs.submitJob({ title: "Capacity rejection", objective: "Must require attention", ownerCoworkerId: OWNER_ID, computerTarget: target, internalContext: { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID } }); await jobs.flush();
    assert.equal(jobs.getJob(limited.id).status, "needs_attention");
    workerNodeStore.trust.revoke(NODE_ID);
    const revoked = jobs.submitJob({ title: "Revoked rejection", objective: "Must require attention", ownerCoworkerId: OWNER_ID, computerTarget: target, internalContext: { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID } }); await jobs.flush();
    assert.equal(jobs.getJob(revoked.id).status, "needs_attention");
    assert.ok(relay.inspect().length >= 12);
    assert.equal(JSON.stringify(relay.inspect()).includes("Secure LAN Computer"), false);
    assert.ok(audits.some((entry) => entry.type === "computer.worker_action_completed"));
    assert.ok(audits.some((entry) => entry.type === "computer.worker_action_failed"));
  } finally { rmSync(dataDir, { recursive: true, force: true }); rmSync(workerDir, { recursive: true, force: true }); }
});
