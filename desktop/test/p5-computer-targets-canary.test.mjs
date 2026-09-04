import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createComputerTargetController } from "../src/main/computer-target-controller.js";
import { createLocalIsolatedComputer } from "../src/main/local-isolated-computer.js";
import { validateIpcRequest } from "../src/main/lib/ipc-schema.js";
import { validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";

const execFileAsync = promisify(execFile);
const NODE_ID = "worker_0123456789abcdef";
const WORKSPACE_ID = "workspace_p5";
const COMPUTER_ID = "computer_p5";

async function dockerReady() {
    try {
        await execFileAsync(process.platform === "win32" ? "docker.exe" : "docker", ["info", "--format", "{{.ServerVersion}}"], { windowsHide: true });
        await execFileAsync(process.platform === "win32" ? "docker.exe" : "docker", ["image", "inspect", "ubuntu:24.04", "--format", "{{.Id}}"], { windowsHide: true });
        return true;
    } catch { return false; }
}

function workerStore({ secure = false } = {}) {
    const client = {
        async computerHealth() { return { computer: { id: COMPUTER_ID, state: "online", capacity: 1, currentLoad: 0, capabilities: ["snapshot", "write_file", "takeover", "release"] } }; },
        async computerAction(envelope) { return { requestId: envelope.requestId, status: "completed", result: { secure: true, operation: envelope.operation } }; },
    };
    return {
        list() { return { nodes: secure ? [{ nodeId: NODE_ID, enabled: true, status: "online", trust: { status: "trusted", transport: "lan" }, workspaces: [{ id: WORKSPACE_ID, name: "P5", }], computer: { id: COMPUTER_ID, state: "online", capacity: 1, currentLoad: 0, capabilities: ["snapshot"] } }] : [] }; },
        async resolveComputerTarget() { return { computer: { state: "online", capacity: 1, currentLoad: 0 }, client }; },
        async resolveVmTarget() { return { computer: { state: "online", capacity: 1, currentLoad: 0 }, client }; },
    };
}

test("P5 LocalIsolated uses a real Docker boundary for snapshot and workspace-relative file actions", async (t) => {
    if (!(await dockerReady())) return t.skip("Docker daemon or the pre-existing ubuntu:24.04 image is unavailable");
    const root = await mkdtemp(join(tmpdir(), "sovereignbot-p5-local-"));
    const audits = [];
    try {
        const local = createLocalIsolatedComputer({ services: { workspacePath: (id) => id === WORKSPACE_ID ? root : undefined }, audit: { append: async (entry) => audits.push(entry) } });
        const controller = createComputerTargetController({ workerNodeStore: workerStore(), localIsolatedComputer: local, audit: { append: async (entry) => audits.push(entry) } });
        const job = { id: "job_0123456789abcdef", ownerCoworkerId: "coworker_p5", workspaceId: WORKSPACE_ID, computerTarget: { kind: "local-isolated", profileId: "docker-local-isolated", workspaceId: WORKSPACE_ID } };
        const result = await controller.execute({ job, actions: [{ operation: "snapshot", input: {} }, { operation: "write_file", input: { path: "result.txt", content: "isolated" } }, { operation: "read_file", input: { path: "result.txt" } }] });
        assert.equal(result.actions[0].result.isolated, true);
        assert.equal(result.actions[2].result.content, "isolated");
        assert.equal(await readFile(join(root, "result.txt"), "utf8"), "isolated");
        assert.ok(audits.some((entry) => entry.type === "computer.local_isolated_action_succeeded"));
        assert.throws(() => controller.normalizeTarget({ kind: "local-isolated", profileId: "docker-local-isolated", workspaceId: WORKSPACE_ID, path: "C:\\secret" }), /unsupported|profile target/i);
        await local.close();
        const timeoutLocal = createLocalIsolatedComputer({ services: { workspacePath: (id) => id === WORKSPACE_ID ? root : undefined }, timeoutMs: 1 });
        await assert.rejects(() => timeoutLocal.execute({ operation: "snapshot", jobId: "job_0123456789abcdee", workspaceId: WORKSPACE_ID }), /TIMEOUT|timed out/i);
        await timeoutLocal.close();
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("P5 VM target requires secure Worker trust and uses the same bounded controller", async () => {
    const controller = createComputerTargetController({ workerNodeStore: workerStore({ secure: true }), audit: { append: async () => {} } });
    const result = await controller.execute({ job: { id: "job_0123456789abcdee", ownerCoworkerId: "coworker_p5", computerTarget: { kind: "vm", nodeId: NODE_ID, workspaceId: WORKSPACE_ID, computerId: COMPUTER_ID } }, actions: [{ operation: "snapshot", input: {} }] });
    assert.equal(result.target.kind, "vm");
    assert.equal(result.actions[0].result.secure, true);
    assert.equal(validateIpcRequest("job:submit", { title: "x", objective: "y", ownerCoworkerId: "coworker_p5", computerTarget: { kind: "vm", nodeId: NODE_ID, workspaceId: WORKSPACE_ID, computerId: COMPUTER_ID } }).computerTarget.kind, "vm");
});

test("P5 cloud target is opt-in, budget-gated, idempotent, and unavailable without a trusted profile", async () => {
    const entries = {};
    let charged = 0;
    const budget = {
        snapshot: () => ({ entries: structuredClone(entries) }),
        reserve({ taskId }) { if (entries[taskId]) return { reused: true }; return { reused: false, amount: 1 }; },
        settle(taskId, { success }) { if (success) { entries[taskId] = { amount: 1 }; charged += 1; } },
    };
    let calls = 0;
    const profile = { profileId: "cloud-canary", enabled: true, estimate: 1, budget: 1, perRunCap: 1, totalCap: 1, currency: "USD", resolve: async () => ({ computer: { state: "online", capacity: 1, currentLoad: 0 }, computerAction: async (envelope) => { calls += 1; return { requestId: envelope.requestId, result: { cloud: true } }; } }) };
    const controller = createComputerTargetController({ workerNodeStore: workerStore(), cloudProfiles: [profile], cloudBudget: budget, audit: { append: async () => {} } });
    const baseJob = { id: "job_0123456789abcdef", ownerCoworkerId: "coworker_p5", computerTarget: { kind: "cloud", profileId: "cloud-canary", workspaceId: WORKSPACE_ID, optIn: false } };
    await assert.rejects(() => controller.execute({ job: baseJob, actions: [{ operation: "snapshot", input: {} }] }), /opt-in/i);
    const job = { ...baseJob, computerTarget: { ...baseJob.computerTarget, optIn: true } };
    const first = await controller.execute({ job, actions: [{ operation: "snapshot", input: {} }] });
    const second = await controller.execute({ job, actions: [{ operation: "snapshot", input: {} }] });
    assert.equal(first.actions[0].result.cloud, true);
    assert.equal(second.duplicate, true);
    assert.equal(calls, 1);
    assert.equal(charged, 1);
    const zero = createComputerTargetController({ workerNodeStore: workerStore(), cloudProfiles: [{ ...profile, profileId: "cloud-zero", budget: 0 }], cloudBudget: budget, audit: { append: async () => {} } });
    await assert.rejects(() => zero.execute({ job: { ...job, id: "job_0123456789abcdff", computerTarget: { kind: "cloud", profileId: "cloud-zero", workspaceId: WORKSPACE_ID, optIn: true } }, actions: [{ operation: "snapshot", input: {} }] }), /budget gate/i);
    const empty = createComputerTargetController({ workerNodeStore: workerStore(), audit: { append: async () => {} } });
    await assert.rejects(() => empty.execute({ job: { ...job, computerTarget: { kind: "cloud", profileId: "missing", workspaceId: WORKSPACE_ID, optIn: true } }, actions: [{ operation: "snapshot", input: {} }] }), /unavailable|disabled/i);
});

test("P5 IPC target shapes reject raw endpoint/path/credential material", () => {
    assert.equal(validateV3IpcRequest("team:computerTask", { title: "x", objective: "y", ownerCoworkerId: "coworker_p5", teamId: "team_p5", computerTarget: { kind: "cloud", profileId: "cloud-canary", workspaceId: WORKSPACE_ID, optIn: true } }).computerTarget.kind, "cloud");
    assert.throws(() => validateIpcRequest("job:submit", { title: "x", objective: "y", ownerCoworkerId: "coworker_p5", computerTarget: { kind: "cloud", profileId: "cloud-canary", workspaceId: WORKSPACE_ID, optIn: true, endpoint: "https://x" } }), /unexpected|unknown|unsupported/i);
    assert.throws(() => validateV3IpcRequest("team:computerTask", { title: "x", objective: "y", ownerCoworkerId: "coworker_p5", teamId: "team_p5", computerTarget: { kind: "local-isolated", profileId: "docker-local-isolated", workspaceId: WORKSPACE_ID }, computerActions: [{ operation: "write_file", input: { path: "../escape", content: "x" } }] }), /relative|invalid/i);
});
