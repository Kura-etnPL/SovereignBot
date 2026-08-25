import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
    buildProviderRoster,
    buildPolicyRules,
    resolveFakeProviderLaunch,
    validateRoleAssignment,
} from "../src/main/provider-roster.js";

const READY = (overrides = {}) => ({
    found: true,
    source: "path",
    auth: { state: "signed-in", via: "auth status" },
    ...overrides,
});

function discovery(codex = READY(), claude = READY()) {
    return { codex, claude };
}

test("normal mode roster is built from ready providers and contains zero echo agents", () => {
    const { mode, ready, agents, roles } = buildProviderRoster({
        discovery: discovery(),
        settings: {},
    });
    assert.equal(mode, "provider");
    assert.equal(ready, true);
    assert.equal(agents.length, 4);
    for (const agent of agents)
        assert.ok(["codex", "claude-code"].includes(agent.harness.kind), `${agent.id} must be a real provider harness`);
    assert.deepEqual(roles, {
        planner: "claude-planner",
        worker: "codex-worker",
        reviewer: "claude-reviewer",
        synthesizer: "claude-synthesizer",
    });
    const planner = agents.find((agent) => agent.id === "claude-planner");
    assert.equal(planner.role, "supervisor");
    assert.deepEqual(planner.capabilities, ["planning"]);
    const worker = agents.find((agent) => agent.id === "codex-worker");
    assert.deepEqual(worker.capabilities, ["coding", "research", "general"]);
    const reviewer = agents.find((agent) => agent.id === "claude-reviewer");
    assert.deepEqual(reviewer.capabilities, ["review", "research"]);
});

test("a single ready provider fills every role with distinct identities of its own kind", () => {
    const { agents, roles } = buildProviderRoster({
        discovery: discovery(READY(), { found: false }),
        settings: {},
    });
    assert.equal(agents.length, 4);
    for (const agent of agents) {
        assert.equal(agent.harness.kind, "codex");
        assert.match(agent.id, /^codex-/);
    }
    assert.deepEqual([...new Set(Object.values(roles))].sort(), [
        "codex-planner",
        "codex-reviewer",
        "codex-synthesizer",
        "codex-worker",
    ]);
});

test("no usable provider means an empty roster unless Demo Mode is explicitly on", () => {
    const off = buildProviderRoster({
        discovery: discovery({ found: false }, { found: false }),
        settings: {},
    });
    assert.equal(off.ready, false);
    assert.equal(off.agents.length, 0);
    assert.equal(off.mode, "provider");

    const signedOut = buildProviderRoster({
        discovery: discovery(READY({ auth: { state: "signed-out" } }), { found: false }),
        settings: {},
    });
    assert.equal(signedOut.ready, false);

    const demo = buildProviderRoster({
        discovery: discovery({ found: false }, { found: false }),
        settings: { demoMode: true },
    });
    assert.equal(demo.mode, "demo");
    assert.equal(demo.agents.length, 2);
    for (const agent of demo.agents)
        assert.equal(agent.harness.kind, "echo");

    const forcedDemo = buildProviderRoster({
        discovery: discovery(),
        settings: { demoMode: true },
    });
    assert.equal(forcedDemo.mode, "demo");
});

test("role overrides apply only to identities that exist in the current candidate set", () => {
    const overridden = buildProviderRoster({
        discovery: discovery(),
        settings: { roles: { worker: "claude-worker", synthesizer: "missing-agent" } },
    });
    assert.equal(overridden.roles.worker, "claude-worker");
    assert.equal(overridden.roles.synthesizer, "claude-synthesizer");

    const ghostWorker = buildProviderRoster({
        discovery: discovery(READY(), { found: false }),
        settings: { roles: { worker: "claude-worker" } },
    });
    assert.equal(ghostWorker.roles.worker, "codex-worker");
});

test("policy authorizes exactly the roster identities after the runaway guard", () => {
    const { agents } = buildProviderRoster({ discovery: discovery(), settings: {} });
    const rules = buildPolicyRules(agents);
    assert.equal(rules[0].id, "deny-runaway-loop");
    assert.equal(rules[0].effect, "deny");
    const allows = rules.slice(1);
    assert.deepEqual(allows.map((rule) => rule.match.agentId).sort(), agents.map((agent) => agent.id).sort());
    for (const rule of allows) {
        assert.equal(rule.effect, "allow");
        assert.deepEqual(rule.match, { category: "harness", operation: "run", agentId: rule.match.agentId });
    }
});

test("role assignment validation refuses unknown roles, ghost agents, and invalid cross-role/self-review setups", () => {
    const roster = {
        agents: [
            { id: "codex-worker", role: "worker" },
            { id: "codex-reviewer", role: "reviewer" },
        ],
        roles: { planner: undefined, worker: "codex-worker", reviewer: "codex-reviewer", synthesizer: undefined },
    };
    assert.throws(() => validateRoleAssignment(roster, { role: "boss", agentId: "codex-worker" }), /role/);
    assert.throws(() => validateRoleAssignment(roster, { role: "worker", agentId: "ghost" }), /unknown agent/);
    assert.throws(
        () => validateRoleAssignment(roster, { role: "reviewer", agentId: "codex-worker" }),
        /independent|not compatible/,
    );
    assert.equal(validateRoleAssignment(roster, { role: "worker", agentId: "codex-worker" }).ok, true);
});

test("fake-provider shims are configured through explicit env-provided node and directory only", () => {
    const launch = resolveFakeProviderLaunch({
        FAKE_PROVIDER_NODE: "E:/fake/node.exe",
        FAKE_PROVIDER_DIR: "E:/fake/shims",
        provider: "codex",
    });
    assert.deepEqual(launch, {
        command: "E:/fake/node.exe",
        prefixArgs: [join("E:/fake/shims", "fake-provider-codex.mjs")],
    });
    assert.throws(() => resolveFakeProviderLaunch({ FAKE_PROVIDER_DIR: "E:/fake/shims", provider: "codex" }), /node/);
    assert.throws(() => resolveFakeProviderLaunch({ FAKE_PROVIDER_NODE: "E:/fake/node.exe", provider: "codex" }), /dir/i);

    const shimmed = buildProviderRoster({
        discovery: discovery(),
        settings: {},
        fakeLaunchers: { codex: launch, claude: undefined },
    });
    const worker = shimmed.agents.find((agent) => agent.id === "codex-worker");
    assert.equal(worker.harness.command, "E:/fake/node.exe");
    assert.deepEqual(worker.harness.prefixArgs, [join("E:/fake/shims", "fake-provider-codex.mjs")]);
    const reviewer = shimmed.agents.find((agent) => agent.id === "claude-reviewer");
    assert.equal(reviewer.harness.command, undefined);
});

test("a provisioned verified driver grants the worker governed browser tooling only", () => {
    const withComputer = buildProviderRoster({
        discovery: discovery(),
        settings: {},
        computerAvailable: true,
    });
    const worker = withComputer.agents.find((agent) => agent.id === "codex-worker");
    assert.deepEqual(worker.governedTools, ["computer"]);
    assert.ok(worker.capabilities.includes("browser"));
    for (const agent of withComputer.agents.filter((entry) => entry.id !== "codex-worker"))
        assert.equal(agent.governedTools, undefined);

    const without = buildProviderRoster({ discovery: discovery(), settings: {} });
    assert.equal(without.agents.find((agent) => agent.id === "codex-worker").governedTools, undefined);
});
