// Production provider roster builder.
//
// V3 extends the reviewed v1.1.1 role roster with persistent Coworker identities. Internal
// planner/worker/reviewer/synthesizer agents remain orchestration machinery, while every
// active Coworker gets a dedicated provider-backed runtime identity and a unique trusted
// scheduling capability. Coworker product state still carries no execution authority.

export const PROVIDER_ROLES = Object.freeze(["planner", "worker", "reviewer", "synthesizer"]);
const PROVIDER_HARNESSES = Object.freeze({
    codex: "codex",
    claude: "claude-code",
});
const PROVIDERS = Object.freeze(Object.keys(PROVIDER_HARNESSES));
export const WORKER_NODE_SUPERVISOR = "worker-node-supervisor";
export const WORKER_NODE_DISPATCHER = "worker-node-dispatcher";

import { join } from "node:path";
import { normalizeModelBinding } from "./model-binding.js";
import { accountIsolationNamespace } from "./provider-account.js";

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

// Usable = detected AND enabled AND not explicitly signed out/capacity limited. Passive auth probing can
// legitimately fail to verify a working login ("unverified"); blocking on that guesswork
// would lock out working setups, so unverified providers are allowed in and any real auth
// failure surfaces later as an honest harness error with repair guidance — never as a
// silent Echo fallback.
export function providerUsable(discoveryResult, settings, provider) {
    if (!discoveryResult?.found)
        return false;
    if (!providerEnabled(settings, provider))
        return false;
    if (["signed-out", "capacity-limited", "unavailable"].includes(discoveryResult.health)
        || ["signed-out", "capacity-limited"].includes(discoveryResult.auth?.state))
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

function harnessConfig(provider, _role, fakeLaunchers, model) {
    const harnessKind = PROVIDER_HARNESSES[provider];
    if (!harnessKind)
        throw new Error(`provider ${provider} has no registered executable harness`);
    const fake = fakeLaunchers?.[provider];
    if (fake)
        return { kind: harnessKind, command: fake.command, prefixArgs: [...fake.prefixArgs] };
    // Workspaces chosen by the operator may be plain folders; Codex must not refuse
    // non-git directories. The execution cwd itself arrives per task through the
    // trusted execution context, never through static harness configuration.
    return provider === "codex"
        ? { kind: "codex", skipGitRepoCheck: true, ...(model ? { model } : {}) }
        : { kind: "claude-code" };
}

function hasRegisteredHarness(provider, usableProviders) {
    return Boolean(PROVIDER_HARNESSES[provider]) && usableProviders?.[provider] === true;
}

export function coworkerAgentId(coworkerId) {
    if (typeof coworkerId !== "string" || !/^coworker_[a-f0-9]{16}$/i.test(coworkerId))
        throw new Error(`invalid coworker id for runtime binding: ${coworkerId}`);
    return `coworker-agent-${coworkerId.slice("coworker_".length).toLowerCase()}`;
}

export function coworkerCapability(coworkerId) {
    coworkerAgentId(coworkerId);
    return `coworker:${coworkerId}`;
}

function effectiveModelBinding(coworker) {
    const legacy = coworker?.providerPreference ?? "auto";
    const raw = coworker?.modelBinding;
    // Public coworker projections retain the legacy preference but intentionally omit
    // provider/model details.  Rehydrate only the safe legacy provider for compatibility
    // with older callers; the full main-process list already carries the binding.
    const normalized = raw && typeof raw === "object" && raw.provider === undefined && legacy !== "auto"
        ? normalizeModelBinding({ ...raw, provider: legacy, ...(legacy === "codex" && raw.model === undefined ? { model: "luna" } : {}) }, { legacyPreference: legacy })
        : normalizeModelBinding(raw, { legacyPreference: legacy });
    // Efficient is the current Codex subscription lane. Keep its concrete target
    // explicit in the trusted main-process binding so a runtime rebuild can detect
    // and apply an operator-requested model change.
    return normalized.profile === "efficient" && normalized.provider === "codex" && !normalized.model
        ? { ...normalized, model: "luna" }
        : normalized;
}

export function chooseCoworkerProvider(coworker, usableProviders = {}) {
    const binding = effectiveModelBinding(coworker);
    const explicit = binding.provider;
    if (binding.profile === "deep") {
        // Deep never silently falls back to an efficient/lighter model.  A future healthy
        // Web Sol discovery can satisfy this profile; an explicitly pinned strong Codex
        // model can also satisfy it without changing the user's requested tier.
        if (hasRegisteredHarness("chatgpt-web", usableProviders))
            return "chatgpt-web";
        if (explicit === "codex" && /(?:sol|strong)/i.test(binding.model ?? "") && hasRegisteredHarness("codex", usableProviders))
            return "codex";
        if (!explicit && usableProviders["codex-strong"] && hasRegisteredHarness("codex", usableProviders))
            return "codex";
        return undefined;
    }
    if (binding.profile === "economy") {
        if (explicit && hasRegisteredHarness(explicit, usableProviders) && usableProviders.economy === true)
            return explicit;
        if (!explicit && usableProviders.economy === true) {
            if (hasRegisteredHarness("codex", usableProviders)) return "codex";
            if (hasRegisteredHarness("claude", usableProviders)) return "claude";
        }
        return undefined;
    }
    if (explicit)
        return hasRegisteredHarness(explicit, usableProviders) ? explicit : undefined;
    // Automatic and Efficient are deliberately Codex-first.  This is a product routing
    // default, never a model-generated authority decision.
    if (hasRegisteredHarness("codex", usableProviders))
        return "codex";
    if (hasRegisteredHarness("claude", usableProviders))
        return "claude";
    return undefined;
}

function buildCoworkerAgents({ coworkers, usableProviders, fakeLaunchers, getCoworkerAppAccess }) {
    const agents = [];
    const bindings = {};
    for (const coworker of Array.isArray(coworkers) ? coworkers : []) {
        if (!coworker || coworker.state !== "active")
            continue;
        const modelBinding = effectiveModelBinding(coworker);
        const provider = chooseCoworkerProvider(coworker, usableProviders);
        const accountNamespace = provider && modelBinding.providerAccountId
            ? accountIsolationNamespace(provider, modelBinding.providerAccountId)
            : undefined;
        if (!provider) {
            bindings[coworker.id] = {
                ready: false,
                profile: modelBinding.profile,
                reason: modelBinding.profile === "deep"
                    ? "Deep profile is unavailable; configure a healthy Deep provider or pinned strong model"
                    : modelBinding.profile === "economy"
                        ? "Economy profile is unavailable; configure an economy provider"
                        : modelBinding.provider
                            ? `preferred provider ${modelBinding.provider} is unavailable`
                            : "no usable provider",
            };
            continue;
        }
        const id = coworkerAgentId(coworker.id);
        const appAccess = typeof getCoworkerAppAccess === "function" ? getCoworkerAppAccess(coworker.id) : undefined;
        const governedTools = Array.isArray(appAccess?.tools) ? [...new Set(appAccess.tools)] : [];
        const agent = {
            id,
            name: `${coworker.name} · ${provider === "codex" ? "Codex" : "Claude Code"}`,
            role: "worker",
            capabilities: ["general", coworkerCapability(coworker.id)],
            harness: harnessConfig(provider, "coworker", fakeLaunchers, modelBinding.model),
            maxConcurrency: 1,
            ...(governedTools.length ? { governedTools } : {}),
        };
        agents.push(agent);
        bindings[coworker.id] = {
            ready: true,
            agentId: id,
            provider,
            profile: modelBinding.profile,
            ...(accountNamespace ? { accountNamespace } : {}),
            harnessKind: agent.harness.kind,
            ...(governedTools.length ? { governedTools: [...governedTools], connectedAppIds: [...(appAccess?.appIds ?? [])] } : {}),
        };
    }
    return { agents, bindings };
}

export function buildProviderRoster({ discovery, settings, fakeLaunchers, computerAvailable = false, coworkers = [], includeWorkerNodeDispatcher = false, getCoworkerAppAccess } = {}) {
    if (!discovery || typeof discovery !== "object")
        throw new Error("provider roster requires discovery results");

    // Explicit Demo Mode always wins: it is an operator opt-in to run Echo-only wiring
    // checks, and the UI must never mix silent Echo into a provider roster.
    if (settings?.demoMode === true)
        return { ...buildDemoRoster(), forcedBySettings: true, coworkerBindings: {} };

    const usableProviders = {
        codex: providerUsable(discovery.codex, settings, "codex"),
        claude: providerUsable(discovery.claude, settings, "claude"),
    };
    if (!usableProviders.codex && !usableProviders.claude) {
        const workerNodeAgents = includeWorkerNodeDispatcher
            ? [
                {
                    id: WORKER_NODE_SUPERVISOR,
                    name: "Worker Node Supervisor",
                    role: "supervisor",
                    capabilities: ["planning"],
                    // This identity owns local plan records only. It is never eligible
                    // for task execution; the dispatcher below is the sole Worker Node
                    // execution identity.
                    harness: { kind: "worker-node" },
                },
                {
                    id: WORKER_NODE_DISPATCHER,
                    name: "Worker Node Dispatcher",
                    role: "worker",
                    capabilities: ["worker-node"],
                    harness: { kind: "worker-node" },
                    maxConcurrency: 4,
                },
            ]
            : [];
        return {
            mode: "provider",
            ready: false,
            providers: usableProviders,
            roles: includeWorkerNodeDispatcher ? { planner: WORKER_NODE_SUPERVISOR } : {},
            agents: workerNodeAgents,
            coworkerBindings: Object.fromEntries((Array.isArray(coworkers) ? coworkers : [])
                .filter((entry) => entry?.state === "active")
                .map((entry) => [entry.id, { ready: false, reason: "no usable provider" }])),
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
        if (typeof wanted === "string" && candidates[wanted]?.role === role)
            roles[role] = wanted;
    }
    // Reviewer independence is structural: an override (or a hand-edited settings file)
    // that collapses reviewer onto the worker falls back to defaults instead of bricking
    // startup or weakening the review gate.
    if (roles.reviewer === roles.worker) {
        const defaults = defaultRolesFor(usableProviders);
        roles.reviewer = defaults.reviewer;
        if (roles.worker === roles.reviewer)
            throw new Error("roster has no independent reviewer identity available");
    }

    const orchestrationAgents = PROVIDER_ROLES.map((role) => {
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
    // orchestration worker identity gains browser tooling ONLY when a managed driver is
    // provisioned. Persistent coworker computer profiles are a separate V3 grant surface.
    if (computerAvailable) {
        const workerAgent = orchestrationAgents.find((agent) => agent.id === roles.worker);
        if (workerAgent && !workerAgent.capabilities.includes("browser"))
            workerAgent.capabilities.push("browser");
        if (workerAgent)
            workerAgent.governedTools = ["computer"];
    }

    const coworkerRuntime = buildCoworkerAgents({ coworkers, usableProviders, fakeLaunchers, getCoworkerAppAccess });
    // This identity is a narrow protocol adapter. It is never a planner/reviewer role,
    // never receives browser/computer capabilities, and is only compatible with tasks
    // explicitly stamped with the worker-node trusted context.
    const workerNodeDispatcher = {
        id: WORKER_NODE_DISPATCHER,
        name: "Worker Node Dispatcher",
        role: "worker",
        capabilities: ["worker-node"],
        harness: { kind: "worker-node" },
        maxConcurrency: 4,
    };
    const agents = includeWorkerNodeDispatcher
        ? [...orchestrationAgents, ...coworkerRuntime.agents, workerNodeDispatcher]
        : [...orchestrationAgents, ...coworkerRuntime.agents];

    return {
        mode: "provider",
        ready: true,
        providers: usableProviders,
        roles,
        agents,
        coworkerBindings: coworkerRuntime.bindings,
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
        coworkerBindings: {},
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
    // Role selectors are allowed to choose only the trusted orchestration identity for
    // that exact role. Persistent coworker agents can never be smuggled into the hidden
    // planner/worker/reviewer/synthesizer machinery through UI settings.
    if (!new RegExp(`^(?:codex|claude)-${role}$`).test(agent.id))
        throw new Error(`${agentId} is not compatible with orchestration role ${role}`);
    if (role === "reviewer") {
        const workerId = roster.roles.worker;
        if (workerId && workerId === agentId)
            throw new Error("reviewer must stay independent from the executing worker");
    }
    if (role === "planner" && agent.role !== "supervisor")
        throw new Error("planner must be the supervisor identity");
    return { ok: true, role, agentId };
}
