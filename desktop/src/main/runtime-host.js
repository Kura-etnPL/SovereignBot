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

// The vendored Core payload is the reviewed Core source tree copied at build time by
// scripts/sync-core.mjs and recorded file-by-file with SHA-256s in vendor/core/core-manifest.json.
// Startup re-verifies every file and refuses to run a stale or tampered copy.
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

// Provider launch resolvers are reused from the vendored Core so Desktop discovery and
// actual harness launches can never disagree about where a provider lives.
export async function loadCoreResolvers() {
    const codex = await import(pathToFileURL(join(VENDOR_ROOT, "src", "codex-harness.js")).href);
    const claude = await import(pathToFileURL(join(VENDOR_ROOT, "src", "claude-code-harness.js")).href);
    return { resolveCodexLaunch: codex.resolveCodexLaunch, resolveClaudeCodeLaunch: claude.resolveClaudeCodeLaunch };
}

// Desktop RuntimeHost (v1.1.1): the runtime is built FROM the production provider roster —
// never "echo first, providers attached later". Startup order:
//   verify vendored Core -> pin internal Node -> load resolvers -> passive provider
//   detection -> settings -> roster build -> createRuntime(real roster).
// Echo agents exist only in explicit Demo Mode; normal mode with no ready provider starts
// with an empty roster and refuses goal submission honestly.
export async function startRuntimeHost({ dataDir, getSettings }) {
    if (typeof getSettings !== "function")
        throw new Error("runtime host requires a settings reader");
    verifyVendorCore();
    const internalNode = prepareInternalNode();

    const { createRuntime } = await loadCore();
    const coreModules = await loadCoreResolvers();

    // Test/E2E-only fake provider shims are declared exclusively through environment
    // variables. A half-configured pair throws here instead of silently mixing fakes
    // into production runs.
    const fakeLaunchers = {
        codex: resolveFakeProviderLaunch({ ...process.env, provider: "codex" }),
        claude: resolveFakeProviderLaunch({ ...process.env, provider: "claude" }),
    };

    async function detectProviders() {
        // Fake-provider shims (CI/installer E2E only) go through the SAME passive
        // probing path as real CLIs, so the E2E exercises the production detection
        // pipeline end-to-end rather than a parallel fake branch.
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

    // A provisioned managed chromedriver becomes the production runtime's computer
    // driver configuration; the worker identity only gains governed browser tooling
    // when this returns a real executable (BLOCKER: provisioned drivers must actually
    // reach the runtime instead of decorating the Control Center).
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

    function summarizeRoster(roster, discovery) {
        return {
            mode: roster.mode,
            ready: roster.ready,
            roles: { ...roster.roles },
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

    async function build(initial) {
        const settings = getSettings();
        const nextDiscovery = initial ? await detectProviders() : discovery;
        const computer = computerRuntimeConfig();
        const nextRoster = buildProviderRoster({
            discovery: nextDiscovery,
            settings,
            fakeLaunchers,
            computerAvailable: Boolean(computer.path),
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
        });
        discovery = nextDiscovery;
        roster = nextRoster;
        summary = summarizeRoster(roster, discovery);
        computerPath = computer.path;
        return nextRuntime;
    }

    runtime = await build(true);

    return {
        runtime,
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
        // True while any Core task is queued/running/awaiting review — historical terminal
        // tasks do not block a roster rebuild.
        async hasActiveWork() {
            return (await runtime.orchestrator.listTasks()).some((task) => ACTIVE_TASK_STATUSES.has(task.status));
        },
        // Explicit refresh path for the Control Center button / post-login re-detection.
        // Never hot-swaps identities under active work; returns an honest deferral reason.
        async refreshProviders({ isBusy } = {}) {
            const nextDiscovery = await detectProviders();
            const nextRoster = buildProviderRoster({
                discovery: nextDiscovery,
                settings: getSettings(),
                fakeLaunchers,
            });
            const sameShape =
                nextRoster.mode === roster.mode
                && JSON.stringify(nextRoster.roles) === JSON.stringify(roster.roles)
                && JSON.stringify(nextRoster.agents.map((agent) => [agent.id, agent.capabilities, agent.harness.kind]))
                    === JSON.stringify(roster.agents.map((agent) => [agent.id, agent.capabilities, agent.harness.kind]))
                && (computerRuntimeConfig().path ?? "") === (computerPath ?? "");
            if (sameShape) {
                discovery = nextDiscovery;
                summary = summarizeRoster(roster, discovery);
                return { applied: false, reason: "unchanged" };
            }
            if (typeof isBusy === "function" && isBusy())
                return { applied: false, reason: "goal-in-progress" };
            if (await this.hasActiveWork())
                return { applied: false, reason: "active-work" };

            // Build the replacement first (so a failed build never leaves us without a
            // runtime), then retire the old one. build() swaps the closure refs.
            const previous = runtime;
            await build(false);
            await previous.close();
            return { applied: true };
        },
        async close() {
            await runtime.close();
        },
    };
}
