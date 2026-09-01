import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyVendorTree } from "./lib/vendor-integrity.js";
import { describeProvider } from "./lib/provider-discovery.js";
import { loadJsonState } from "./lib/desktop-state.js";
import { buildPolicyRules, buildProviderRoster, resolveFakeProviderLaunch } from "./provider-roster.js";
import { prepareInternalNode } from "./internal-node.js";

const DESKTOP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENDOR_ROOT = join(DESKTOP_ROOT, "vendor", "core");
const VENDOR_MANIFEST_PATH = join(VENDOR_ROOT, "core-manifest.json");

const ACTIVE_TASK_STATUSES = new Set(["queued", "accepted", "running", "awaiting_review", "changes_requested"]);

function isGeneratedRosterAllowRule(rule) {
    if (!rule || rule.effect !== "allow" || typeof rule.id !== "string" || !rule.id.startsWith("allow-"))
        return false;
    const agentId = rule.id.slice("allow-".length);
    return Boolean(agentId)
        && JSON.stringify(rule.match) === JSON.stringify({ category: "harness", operation: "run", agentId });
}

function reconcileRosterPolicy(currentPolicy, agents) {
    const generated = buildPolicyRules(agents);
    const desiredAllows = generated.filter((rule) => rule.effect === "allow");
    const desiredById = new Map(desiredAllows.map((rule) => [rule.id, rule]));
    const retained = [];
    for (const rule of currentPolicy.rules) {
        if (isGeneratedRosterAllowRule(rule))
            continue;
        retained.push(rule);
    }
    const conflicts = retained.filter((rule) => desiredById.has(rule.id));
    if (conflicts.length)
        throw new Error(`policy contains conflicting roster rule ids: ${conflicts.map((rule) => rule.id).join(", ")}`);

    const rules = [...retained, ...desiredAllows];
    if (JSON.stringify(rules) === JSON.stringify(currentPolicy.rules))
        return { policy: currentPolicy, changed: false, checks: [] };

    const policy = { ...currentPolicy, rules };
    const checks = desiredAllows.map((rule) => ({
        action: {
            category: "harness",
            operation: "run",
            agentId: rule.match.agentId,
        },
        expect: { allowed: true, ruleId: rule.id },
    }));
    const guard = rules.find((rule) => rule.id === "deny-runaway-loop" && rule.effect === "deny");
    const probeAgentId = desiredAllows[0]?.match.agentId ?? "roster-policy-probe";
    if (guard) {
        checks.push({
            action: { category: "harness", operation: "run", agentId: probeAgentId },
            repeatCount: 10,
            expect: { allowed: false, ruleId: guard.id },
        });
    }
    if (!checks.length)
        throw new Error("cannot reconcile roster policy without a dry-run check");
    return { policy, changed: true, checks };
}

function readVendorManifest() {
    return JSON.parse(readFileSync(VENDOR_MANIFEST_PATH, "utf8"));
}

function listVendorFiles() {
    const out = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === "core-manifest.json")
                continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory())
                walk(full);
            else if (entry.isFile())
                out.push(relative(VENDOR_ROOT, full).replaceAll("\\", "/"));
        }
    };
    walk(VENDOR_ROOT);
    return out;
}

export function verifyVendorCore() {
    return verifyVendorTree({
        rootDir: VENDOR_ROOT,
        manifest: readVendorManifest(),
        listFiles: listVendorFiles,
        readFileBuffer: (rel) => readFileSync(join(VENDOR_ROOT, rel)),
        sha256Buffer: (buffer) => createHash("sha256").update(buffer).digest("hex"),
    });
}

let cachedCore = undefined;

async function loadCore() {
    cachedCore ??= await import(pathToFileURL(join(VENDOR_ROOT, "src", "runtime.js")).href);
    return cachedCore;
}

export async function loadCoreResolvers() {
    const codex = await import(pathToFileURL(join(VENDOR_ROOT, "src", "codex-harness.js")).href);
    const claude = await import(pathToFileURL(join(VENDOR_ROOT, "src", "claude-code-harness.js")).href);
    return { resolveCodexLaunch: codex.resolveCodexLaunch, resolveClaudeCodeLaunch: claude.resolveClaudeCodeLaunch };
}

// V3 RuntimeHost is built from three trusted inputs: provider discovery, validated Desktop
// settings, and the persistent Coworker Registry. Coworkers are converted into dedicated
// provider-backed runtime agents only here; renderer messages and model output never mint
// runtime identities or capabilities.
export async function startRuntimeHost({ dataDir, getSettings, getCoworkers = () => [], getCoworkerAppAccess = () => undefined, workerNodeClientResolver }) {
    if (typeof getSettings !== "function")
        throw new Error("runtime host requires a settings reader");
    if (typeof getCoworkers !== "function")
        throw new Error("runtime host requires a coworker reader");
    verifyVendorCore();
    const internalNode = prepareInternalNode();

    const { createRuntime } = await loadCore();
    const coreModules = await loadCoreResolvers();

    const fakeLaunchers = {
        codex: resolveFakeProviderLaunch({ ...process.env, provider: "codex" }),
        claude: resolveFakeProviderLaunch({ ...process.env, provider: "claude" }),
    };

    function resolveFast(resolver, label, fakeLauncher) {
        try {
            const launch = fakeLauncher
                ? { command: fakeLauncher.command, prefixArgs: fakeLauncher.prefixArgs, source: "fake-shim" }
                : resolver({});
            return {
                provider: label,
                found: true,
                source: launch.source,
                commandPathHidden: true,
                auth: { state: "unverified" },
                health: "ready",
                interactiveLoginAvailable: false,
            };
        }
        catch (error) {
            return { provider: label, found: false, health: "unavailable", reason: String(error?.message ?? error) };
        }
    }

    // Desktop startup must never wait on vendor CLIs. Resolving a reviewed launcher is a
    // local filesystem/PATH check only; --help/version/auth probes happen after the window
    // is available through refreshProviders(). `unverified` is intentionally usable by the
    // roster and any real auth failure still surfaces from the provider harness honestly.
    function resolveProvidersFast() {
        return {
            codex: resolveFast(coreModules.resolveCodexLaunch, "codex", fakeLaunchers.codex),
            claude: resolveFast(coreModules.resolveClaudeCodeLaunch, "claude-code", fakeLaunchers.claude),
        };
    }

    async function detectProviders() {
        const [codex, claude] = await Promise.all([
            describeProvider(
                () => (fakeLaunchers.codex
                    ? { command: fakeLaunchers.codex.command, prefixArgs: fakeLaunchers.codex.prefixArgs, source: "fake-shim" }
                    : coreModules.resolveCodexLaunch({})),
                "codex",
                ["--version"],
            ),
            describeProvider(
                () => (fakeLaunchers.claude
                    ? { command: fakeLaunchers.claude.command, prefixArgs: fakeLaunchers.claude.prefixArgs, source: "fake-shim" }
                    : coreModules.resolveClaudeCodeLaunch({})),
                "claude-code",
                ["--version"],
            ),
        ]);
        return { codex, claude };
    }

    function computerRuntimeConfig() {
        const record = loadJsonState(join(dataDir, "desktop-state", "drivers.json"), null);
        const exe = record?.cacheDirRelative && record?.exe
            ? join(dataDir, "desktop-state", record.cacheDirRelative, record.exe)
            : undefined;
        if (!exe || !existsSync(exe) || !record.digestVerified)
            return { path: undefined };
        return {
            path: exe,
            config: {
                driver: {
                    kind: "webdriver-sidecar",
                    browser: record.browser === "edge" ? "edge" : "chrome",
                    webdriverCommand: exe,
                    headless: true,
                },
            },
        };
    }

    function coworkerSnapshot() {
        const value = getCoworkers();
        if (Array.isArray(value))
            return structuredClone(value);
        if (Array.isArray(value?.coworkers))
            return structuredClone(value.coworkers);
        throw new Error("coworker reader must return an array or {coworkers}");
    }

    function summarizeRoster(roster, discovery) {
        const settings = getSettings();
        const publicProvider = (key) => {
            const result = discovery[key] ?? {};
            const authState = result.auth?.state;
            const disabled = settings.providers?.[key]?.enabled === false;
            const health = disabled ? "unavailable" : result.health
                ?? (!result.found ? "unavailable"
                    : authState === "signed-out" ? "signed-out"
                        : authState === "capacity-limited" ? "capacity-limited" : "ready");
            return {
                found: Boolean(result.found),
                enabled: !disabled,
                health,
                ...(disabled ? { reason: "Provider disabled in Settings" } : result.reason ? { reason: String(result.reason).slice(0, 300) } : {}),
                authState,
                usable: roster.providers[key] === true,
            };
        };
        return {
            mode: roster.mode,
            ready: roster.ready,
            roles: { ...roster.roles },
            coworkerBindings: structuredClone(roster.coworkerBindings ?? {}),
            agents: roster.agents.map((agent) => ({
                id: agent.id,
                name: agent.name,
                role: agent.role,
                capabilities: [...agent.capabilities],
                harnessKind: agent.harness.kind,
            })),
            providers: {
                codex: publicProvider("codex"),
                claude: publicProvider("claude"),
            },
        };
    }

    let runtime;
    let discovery;
    let roster;
    let summary;
    let computerPath;
    let refreshChain = Promise.resolve();

    async function build(nextDiscovery) {
        const settings = getSettings();
        const computer = computerRuntimeConfig();
        const nextRoster = buildProviderRoster({
            discovery: nextDiscovery,
            settings,
            fakeLaunchers,
            computerAvailable: Boolean(computer.path),
            coworkers: coworkerSnapshot(),
            getCoworkerAppAccess,
            includeWorkerNodeDispatcher: Boolean(workerNodeClientResolver),
        });
        let nextRuntime;
        try {
            nextRuntime = await createRuntime({
                dataDir,
                bindHost: "127.0.0.1",
                port: 0,
                agents: nextRoster.agents,
                ...(computer.config ? { computer: computer.config } : {}),
                policy: {
                    repeatWindowMs: 180000,
                    rules: buildPolicyRules(nextRoster.agents),
                },
            }, workerNodeClientResolver ? { workerNodeClientResolver } : {});

            // PolicyVersionStore intentionally keeps the active policy across a runtime
            // rebuild.  Reconcile only the exact per-agent rules generated from the
            // trusted roster, preserving operator rules and the runaway deny guard.  This
            // keeps a newly installed Coworker fail-closed until its additive rule has
            // passed the core PolicyManager dry-run/apply transaction.
            const reconciliation = reconcileRosterPolicy(nextRuntime.policyManager.current().policy, nextRoster.agents);
            if (reconciliation.changed) {
                await nextRuntime.policyManager.apply({
                    policy: reconciliation.policy,
                    checks: reconciliation.checks,
                    actor: "desktop-runtime-roster",
                    label: "reconcile active Coworker roster",
                });
            }
        }
        catch (error) {
            try { await nextRuntime?.close(); } catch {}
            throw error;
        }
        discovery = nextDiscovery;
        roster = nextRoster;
        summary = summarizeRoster(roster, discovery);
        computerPath = computer.path;
        return nextRuntime;
    }

    runtime = await build(resolveProvidersFast());

    async function hasActiveWorkNow() {
        return (await runtime.orchestrator.listTasks()).some((task) => ACTIVE_TASK_STATUSES.has(task.status));
    }

    async function refreshProvidersOnce({ isBusy } = {}) {
        const nextDiscovery = await detectProviders();
        const computer = computerRuntimeConfig();
        const nextRoster = buildProviderRoster({
            discovery: nextDiscovery,
            settings: getSettings(),
            fakeLaunchers,
            computerAvailable: Boolean(computer.path),
            coworkers: coworkerSnapshot(),
            getCoworkerAppAccess,
            includeWorkerNodeDispatcher: Boolean(workerNodeClientResolver),
        });
        const sameShape =
            nextRoster.mode === roster.mode
            && JSON.stringify(nextRoster.roles) === JSON.stringify(roster.roles)
            && JSON.stringify(nextRoster.coworkerBindings ?? {}) === JSON.stringify(roster.coworkerBindings ?? {})
            && JSON.stringify(nextRoster.agents.map((agent) => [agent.id, agent.capabilities, agent.harness.kind, agent.harness.model ?? "", agent.governedTools ?? []]))
                === JSON.stringify(roster.agents.map((agent) => [agent.id, agent.capabilities, agent.harness.kind, agent.harness.model ?? "", agent.governedTools ?? []]))
            && (computer.path ?? "") === (computerPath ?? "");
        if (sameShape) {
            discovery = nextDiscovery;
            summary = summarizeRoster(roster, discovery);
            return { applied: false, reason: "unchanged" };
        }
        if (typeof isBusy === "function" && isBusy())
            return { applied: false, reason: "goal-in-progress" };
        if (await hasActiveWorkNow())
            return { applied: false, reason: "active-work" };

        const previous = runtime;
        runtime = await build(nextDiscovery);
        await previous.close();
        return { applied: true };
    }

    return {
        get runtime() {
            return runtime;
        },
        get internalNodeSource() {
            return internalNode.source;
        },
        dataDir,
        get plannerAgentId() {
            return roster.roles.planner;
        },
        get mode() {
            return roster.mode;
        },
        coreModules,
        rosterSummary() {
            return structuredClone(summary);
        },
        async hasActiveWork() {
            return hasActiveWorkNow();
        },
        refreshProviders({ isBusy } = {}) {
            const run = refreshChain.then(() => refreshProvidersOnce({ isBusy }));
            refreshChain = run.catch(() => {});
            return run;
        },
        async close() {
            await runtime.close();
        },
    };
}
