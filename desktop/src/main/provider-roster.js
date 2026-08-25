// Production provider roster builder (Desktop v1.1.1 BLOCKER A/D).
//
// The roster is the ONLY path from passive provider discovery to real runtime agents.
// It is constructed exclusively in the main process from: Core resolver-backed discovery
// results, validated desktop settings, and (test/E2E only) env-declared fake-provider
// launchers. Renderers and planner output can never mint agents, commands, or cwds.
//
// Normal production mode contains zero Echo agents. Echo exists only in explicit Demo
// Mode (settings.demoMode) and in unit fixtures.

export const PROVIDER_ROLES = Object.freeze(["planner", "worker", "reviewer", "synthesizer"]);
const PROVIDERS = Object.freeze(["codex", "claude"]);

import { join } from "node:path";

const ROLE_CAPABILITIES = Object.freeze({
    codex: Object.freeze({
        planner: Object.freeze(["planning"]),
        worker: Object.freeze(["coding", "research", "general"]),
        reviewer: Object.freeze(["review", "research"]),
        synthesizer: Object.freeze(["synthesis", "general"]),
    }),
    claude: Object.freeze({
        planner: Object.freeze(["planning"]),
        worker: Object.freeze(["coding", "research", "general"]),
        reviewer: Object.freeze(["review", "research"]),
        synthesizer: Object.freeze(["synthesis", "general"]),
    }),
});

function providerEnabled(settings, provider) {
    return settings?.providers?.[provider]?.enabled !== false;
}

// Usable = detected AND enabled AND not explicitly signed out. Passive auth probing can
// legitimately fail to verify a working login ("unverified"); blocking on that guesswork
// would lock out working setups, so unverified providers are allowed in and any real auth
// failure surfaces later as an honest harness error with repair guidance — never as a
// silent Echo fallback.
export function providerUsable(discoveryResult, settings, provider) {
    if (!discoveryResult?.found)
        return false;
    if (!providerEnabled(settings, provider))
        return false;
    if (discoveryResult.auth?.state === "signed-out")
        return false;
    return true;
}

// Test/E2E-only fake provider launchers, declared exclusively through environment
// variables by CI and installer E2E. Both parts are mandatory so a half-configured
// environment fails loudly instead of silently mixing fake and real providers.
export function resolveFakeProviderLaunch(env) {
    const nodePath = env.FAKE_PROVIDER_NODE;
    const dir = env.FAKE_PROVIDER_DIR;
    const provider = env.provider;
    if (!nodePath && !dir)
        return undefined;
    if (!nodePath)
        throw new Error("FAKE_PROVIDER_DIR set without a fake provider node path (FAKE_PROVIDER_NODE)");
    if (!dir)
        throw new Error("FAKE_PROVIDER_NODE set without a fake provider shims dir (FAKE_PROVIDER_DIR)");
    return launchFor(nodePath, dir, provider);
}

function launchFor(nodePath, dir, provider) {
    if (provider !== "codex" && provider !== "claude")
        throw new Error(`unknown fake provider: ${provider}`);
    return { command: String(nodePath), prefixArgs: [join(String(dir), `fake-provider-${provider}.mjs`)] };
}

const DEFAULT_BOTH = Object.freeze({
    planner: "claude-planner",
    worker: "codex-worker",
    reviewer: "claude-reviewer",
    synthesizer: "claude-synthesizer",
});

function defaultRolesFor(usable) {
    if (usable.codex && usable.claude)
        return { ...DEFAULT_BOTH };
    const only = usable.codex ? "codex" : "claude";
    return {
        planner: `${only}-planner`,
        worker: `${only}-worker`,
        reviewer: `${only}-reviewer`,
        synthesizer: `${only}-synthesizer`,
    };
}

function agentName(provider, role) {
    const providerLabel = provider === "codex" ? "Codex" : "Claude Code";
    const roleLabel = role[0].toUpperCase() + role.slice(1);
    return `${providerLabel} ${roleLabel}`;
}

function harnessConfig(provider, role, fakeLaunchers) {
    const fake = fakeLaunchers?.[provider];
    if (fake)
        return { kind: provider === "codex" ? "codex" : "claude-code", command: fake.command, prefixArgs: [...fake.prefixArgs] };
    // Workspaces chosen by the operator may be plain folders; Codex must not refuse
    // non-git directories. The execution cwd itself arrives per task through the
    // trusted execution context, never through static harness configuration.
    return provider === "codex" ? { kind: "codex", skipGitRepoCheck: true } : { kind: "claude-code" };
}

export function buildProviderRoster({ discovery, settings, fakeLaunchers, computerAvailable = false } = {}) {
    if (!discovery || typeof discovery !== "object")
        throw new Error("provider roster requires discovery results");

    // Explicit Demo Mode always wins: it is an operator opt-in to run Echo-only wiring
    // checks, and the UI must never mix silent Echo into a provider roster.
    if (settings?.demoMode === true)
        return { ...buildDemoRoster(), forcedBySettings: true };

    const usableProviders = {
        codex: providerUsable(discovery.codex, settings, "codex"),
        claude: providerUsable(discovery.claude, settings, "claude"),
    };
    if (!usableProviders.codex && !usableProviders.claude) {
        return {
            mode: "provider",
            ready: false,
            providers: usableProviders,
            roles: {},
            agents: [],
        };
    }

    const candidates = {};
    for (const provider of PROVIDERS) {
        if (!usableProviders[provider])
            continue;
        for (const role of PROVIDER_ROLES)
            candidates[`${provider}-${role}`] = { provider, role };
    }

    const overrides = settings?.roles ?? {};
    const roles = defaultRolesFor(usableProviders);
    for (const role of PROVIDER_ROLES) {
        const wanted = overrides[role];
        if (typeof wanted === "string" && candidates[wanted])
            roles[role] = wanted;
    }

    // Reviewer independence is structural: it must be a different identity than the worker.
    if (roles.reviewer === roles.worker)
        throw new Error("roster reviewer and worker must be distinct identities");

    const agents = PROVIDER_ROLES.map((role) => {
        const id = roles[role];
        const { provider } = candidates[id];
        return {
            id,
            name: agentName(provider, role),
            role: role === "planner" ? "supervisor" : "worker",
            capabilities: [...ROLE_CAPABILITIES[provider][role]],
            harness: harnessConfig(provider, role, fakeLaunchers),
        };
    });

    // Governed computer access is opt-in by infrastructure, not by model request: the
    // worker identity gains browser tooling ONLY when a managed driver is provisioned.
    // The task-bound bridge keeps it scoped to running tasks (Core enforces this).
    if (computerAvailable) {
        const workerAgent = agents.find((agent) => agent.id === roles.worker);
        if (workerAgent && !workerAgent.capabilities.includes("browser"))
            workerAgent.capabilities.push("browser");
        workerAgent.governedTools = ["computer"];
    }

    return {
        mode: "provider",
        ready: true,
        providers: usableProviders,
        roles,
        agents,
    };
}

export function buildDemoRoster() {
    return {
        mode: "demo",
        ready: true,
        providers: { codex: false, claude: false },
        roles: { planner: "demo-supervisor", worker: "demo-worker", reviewer: undefined, synthesizer: undefined },
        agents: [
            {
                id: "demo-supervisor",
                name: "Demo Supervisor",
                role: "supervisor",
                capabilities: ["planning"],
                harness: { kind: "echo" },
            },
            {
                id: "demo-worker",
                name: "Demo Worker",
                role: "worker",
                capabilities: ["demo"],
                harness: { kind: "echo" },
            },
        ],
    };
}

// Per-identity authorization: the runaway guard stays first, then exactly one allow per
// rostered agent matched on agentId. No broad category-wide allow rules.
export function buildPolicyRules(agents) {
    return [
        {
            id: "deny-runaway-loop",
            effect: "deny",
            match: { category: "harness", operation: "run", repeatAtLeast: 10 },
        },
        ...agents.map((agent) => ({
            id: `allow-${agent.id}`,
            effect: "allow",
            match: { category: "harness", operation: "run", agentId: agent.id },
        })),
    ];
}

export function validateRoleAssignment(roster, { role, agentId }) {
    if (!PROVIDER_ROLES.includes(role))
        throw new Error(`unknown role: ${role}`);
    const agent = roster.agents.find((candidate) => candidate.id === agentId);
    if (!agent)
        throw new Error(`unknown agent id: ${agentId}`);
    if (role === "reviewer") {
        const workerId = roster.roles.worker;
        if (workerId && workerId === agentId)
            throw new Error("reviewer must stay independent from the executing worker");
    }
    if (role === "planner" && agent.role !== "supervisor")
        throw new Error("planner must be the supervisor identity");
    return { ok: true, role, agentId };
}
