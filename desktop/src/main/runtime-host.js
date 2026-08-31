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
export async function startRuntimeHost({ dataDir, getSettings, getCoworkers = () => [], workerNodeClientResolver }) {
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
                interactiveLoginAvailable: false,
            };
        }
        catch (error) {
            return { provider: label, found: false, reason: String(error?.message ?? error) };
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
                codex: {
                    found: Boolean(discovery.codex?.found),
                    enabled: getSettings().providers.codex.enabled,
                    authState: discovery.codex?.auth?.state ?? undefined,
                    usable: roster.providers.codex === true,
                },
                claude: {
                    found: Boolean(discovery.claude?.found),
                    enabled: getSettings().providers.claude.enabled,
                    authState: discovery.claude?.auth?.state ?? undefined,
                    usable: roster.providers.claude === true,
                },
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
            includeWorkerNodeDispatcher: Boolean(workerNodeClientResolver),
        });
        const nextRuntime = await createRuntime({
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
            includeWorkerNodeDispatcher: Boolean(workerNodeClientResolver),
        });
        const sameShape =
            nextRoster.mode === roster.mode
            && JSON.stringify(nextRoster.roles) === JSON.stringify(roster.roles)
            && JSON.stringify(nextRoster.coworkerBindings ?? {}) === JSON.stringify(roster.coworkerBindings ?? {})
            && JSON.stringify(nextRoster.agents.map((agent) => [agent.id, agent.capabilities, agent.harness.kind, agent.governedTools ?? []]))
                === JSON.stringify(roster.agents.map((agent) => [agent.id, agent.capabilities, agent.harness.kind, agent.governedTools ?? []]))
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
