import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMemoryComputerDriverFactory } from "../../src/computer-driver.js";
import { createRuntime } from "../../src/runtime.js";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createThisPcService } from "../src/main/this-pc-service.js";
import { validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";

const PROJECT_A = "project_aaaaaaaaaaaaaaaa";
const PROJECT_B = "project_bbbbbbbbbbbbbbbb";

function runtimeConfig(dataDir, agents) {
  return {
    dataDir,
    bindHost: "127.0.0.1",
    port: 0,
    agents: agents.map((id) => ({ id, name: id, role: "worker", capabilities: [], harness: { kind: "echo", delayMs: 60_000 } })),
    policy: { rules: [
      { id: "allow-harness", effect: "allow", match: { category: "harness" } },
      { id: "allow-computer", effect: "allow", match: { category: "computer" } },
    ] },
  };
}

async function waitFor(runtime, taskId, status) {
  for (let index = 0; index < 100; index += 1) {
    const task = (await runtime.orchestrator.listTasks()).find((entry) => entry.id === taskId);
    if (task?.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task did not reach ${status}`);
}

test("This PC product boundary reuses governed Computer authority and stays safe", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "sovereign-this-pc-"));
  const coworkerRoot = await mkdtemp(join(tmpdir(), "sovereign-this-pc-coworkers-"));
  const store = createCoworkerStore({
    persistPath: join(coworkerRoot, "coworkers.json"),
    makeId: (() => { let n = 0; return () => `coworker_${String(++n).padStart(16, "0")}`; })(),
  });
  const sharedA = store.create({ name: "Shared A", role: "Shared operator", computerMode: "shared-login" });
  const sharedB = store.create({ name: "Shared B", role: "Shared reviewer", computerMode: "shared-login" });
  const privateA = store.create({ name: "Private A", role: "Private operator", computerMode: "private-profile", computerProfileId: "profile_a" });
  const privateB = store.create({ name: "Private B", role: "Private reviewer", computerMode: "private-profile", computerProfileId: "profile_b" });
  const bindings = new Map([
    [sharedA.id, "agent-a"], [sharedB.id, "agent-b"], [privateA.id, "agent-c"], [privateB.id, "agent-d"],
  ]);
  const scopes = new Map([
    [PROJECT_A, { projectId: PROJECT_A, state: "active", conversationIds: ["conv_project_a"], coworkerIds: [sharedA.id, sharedB.id] }],
    [PROJECT_B, { projectId: PROJECT_B, state: "active", conversationIds: ["conv_project_b"], coworkerIds: [privateA.id, privateB.id] }],
  ]);
  const projectService = { resolveScope: (projectId) => scopes.get(projectId) ?? (() => { throw new Error("unknown Project"); })() };
  const artifactStore = { list: () => ({ artifacts: [{ id: "artifact_aaaaaaaaaaaaaaaa", title: "Release result C:\\private\\secret.txt token=never", fileName: "release.md", mimeType: "text/markdown", size: 12, createdAt: "2026-09-02T00:00:00.000Z", conversationId: "conv_project_a", storageRelativePath: "private/secret" }] }) };
  const factory = createMemoryComputerDriverFactory();
  const runtime = await createRuntime(runtimeConfig(dataDir, ["agent-a", "agent-b", "agent-c", "agent-d"]), { computerDriverFactory: factory });
  const service = createThisPcService({
    projectService,
    coworkerStore: store,
    artifactStore,
    runtime,
    getBinding: (coworkerId) => ({ ready: true, agentId: bindings.get(coworkerId), coworkerId }),
  });

  try {
    assert.deepEqual(validateV3IpcRequest("thisPc:list", { projectId: PROJECT_A }), { projectId: PROJECT_A });
    assert.throws(() => validateV3IpcRequest("thisPc:list", { projectId: PROJECT_A, agentId: "agent-a" }), /authority|unexpected/);
    const initial = await service.list({ projectId: PROJECT_A });
    assert.equal(initial.computers.length, 2, "shared Project exposes both Coworkers");
    assert.equal(initial.computers.every((entry) => !("agentId" in entry) && !("taskId" in entry)), true);
    assert.equal((await service.list({ projectId: PROJECT_B })).computers.every((entry) => entry.context.kind === "private"), true);

    const task = await runtime.orchestrator.submit({ title: "Shared governed Computer work", preferredAgentId: "agent-a", input: { coworkerId: sharedA.id, conversationId: "conv_project_a" } });
    const runningPromise = runtime.orchestrator.runNext();
    await waitFor(runtime, task.id, "running");
    factory.forComputer((await runtime.computerRegistry.list()).find((entry) => entry.agentId === "agent-a")).setPage("https://example.com/app?session=hidden", [{ ref: "go", backendRef: "backend-secret", role: "button", name: "Continue" }]);
    const taskB = await runtime.orchestrator.submit({ title: "Second shared lane", preferredAgentId: "agent-b", input: { coworkerId: sharedB.id, conversationId: "conv_project_a" } });
    const runningPromiseB = runtime.orchestrator.runNext();
    await waitFor(runtime, taskB.id, "running");

    const ready = (await service.list({ projectId: PROJECT_A })).computers.find((entry) => entry.coworkerId === sharedA.id);
    assert.equal(ready.status, "working");
    assert.equal(ready.artifacts[0].fileName, "release.md");
    assert.equal(ready.artifacts[0].storageRelativePath, undefined);
    const safeSnapshot = await service.snapshot(PROJECT_A, sharedA.id);
    assert.equal(safeSnapshot.site, "example.com");
    assert.equal(safeSnapshot.elements[0].name, "Continue");
    assert.equal(safeSnapshot.elements[0].backendRef, undefined);
    await runtime.computer.writeFile("agent-a", task.id, { path: "notes/release.txt", content: "safe" });
    const files = (await service.list({ projectId: PROJECT_A })).computers.find((entry) => entry.coworkerId === sharedA.id).files;
    assert.equal(files.some((entry) => entry.name === "notes"), true);
    assert.equal(files.some((entry) => "path" in entry), false);
    await runtime.computer.click("agent-a", task.id, { snapshotId: safeSnapshot.snapshotId, ref: "go" });

    await service.takeOver(PROJECT_A, sharedA.id);
    await assert.rejects(() => service.takeOver(PROJECT_A, sharedB.id), /Shared Computer context is already controlled/);
    await assert.rejects(() => runtime.computer.click("agent-a", task.id, { snapshotId: safeSnapshot.snapshotId, ref: "go" }), /human control is active/);
    const handBack = await service.handBack(PROJECT_A, sharedA.id);
    assert.equal(handBack.status, "working");
    const resumedSnapshot = await service.snapshot(PROJECT_A, sharedA.id);
    await runtime.computer.click("agent-a", task.id, { snapshotId: resumedSnapshot.snapshotId, ref: "go" });

    await assert.rejects(() => service.snapshot(PROJECT_B, sharedA.id), /not a member/);
    await assert.rejects(() => runtime.computer.snapshot("agent-b", task.id), /not owned/);
    await assert.rejects(() => runtime.computer.navigate("agent-a", task.id, "javascript:alert(1)"), /http\/https/);
    store.update(privateB.id, { computerProfileId: "profile_a" });
    await assert.rejects(() => service.list({ projectId: PROJECT_B }), /Private Computer context cannot be reused/);

    const publicPayload = JSON.stringify(await service.list({ projectId: PROJECT_A }));
    for (const forbidden of ["backend-secret", "session=hidden", "C:\\private", "storageRelativePath", "agent-a", "driver", "coordinate", "token=never"]) assert.equal(publicPayload.includes(forbidden), false, `must not leak ${forbidden}`);
    assert.equal((await runtime.audit.verify()).ok, true);
    await runtime.orchestrator.cancel(task.id, { reason: "This PC canary complete" });
    await runtime.orchestrator.cancel(taskB.id, { reason: "This PC canary complete" });
    await runningPromise;
    await runningPromiseB;
  }
  finally {
    await runtime.close();
  }
});
