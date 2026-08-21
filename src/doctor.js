import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AuditLog } from "./audit.js";
import { resolveClaudeCodeLaunch } from "./claude-code-harness.js";
import { resolveCodexLaunch } from "./codex-harness.js";
import { loadConfig } from "./config.js";
import { policyHash } from "./policy-version-store.js";

const STATUS_RANK = { ok: 0, warning: 1, error: 2 };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_STALE_SCAN = 4000;

function check(id, status, summary, details, remediation) {
    return {
        id,
        status,
        summary,
        ...(details === undefined ? {} : { details }),
        ...(remediation === undefined ? {} : { remediation }),
    };
}

function overall(checks) {
    let result = "ok";
    for (const item of checks) {
        if (STATUS_RANK[item.status] > STATUS_RANK[result])
            result = item.status;
    }
    return result;
}

async function exists(path) {
    try {
        return await lstat(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}

async function executableFile(path) {
    if (!path)
        return false;
    try {
        const info = await stat(path);
        if (!info.isFile())
            return false;
        await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}

function windowsExecutableNames(command, env = process.env) {
    const ext = parse(command).ext;
    if (ext)
        return [command];
    const pathExt = String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean);
    return [command, ...pathExt.map((value) => `${command}${value.toLowerCase()}`), ...pathExt.map((value) => `${command}${value.toUpperCase()}`)];
}

async function resolveExecutable(command, { env = process.env, cwd = process.cwd() } = {}) {
    if (!command)
        return undefined;
    const hasSeparator = command.includes("/") || command.includes("\\");
    if (isAbsolute(command) || hasSeparator) {
        const candidate = isAbsolute(command) ? command : resolve(cwd, command);
        return await executableFile(candidate) ? candidate : undefined;
    }
    const names = process.platform === "win32" ? windowsExecutableNames(command, env) : [command];
    for (const pathEntry of String(env.PATH ?? "").split(delimiter).filter(Boolean)) {
        const cleanEntry = pathEntry.replace(/^"|"$/g, "");
        for (const name of names) {
            const candidate = join(cleanEntry, name);
            if (await executableFile(candidate))
                return candidate;
        }
    }
    return undefined;
}

function runStatusCommand(command, args, { timeoutMs = 5000 } = {}) {
    const result = spawnSync(command, args, {
        shell: false,
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error)
        return { kind: result.error.code === "ETIMEDOUT" ? "timeout" : "error" };
    if (result.status === 0)
        return { kind: "authenticated" };
    if (result.status === 1)
        return { kind: "not-authenticated" };
    return { kind: "unknown", exitCode: result.status };
}

async function nearestExistingDirectory(path) {
    let candidate = resolve(path);
    while (true) {
        const info = await exists(candidate);
        if (info?.isDirectory())
            return candidate;
        const parent = dirname(candidate);
        if (parent === candidate)
            return undefined;
        candidate = parent;
    }
}

async function checkDataDir(config, checks) {
    const dataDir = resolve(config.dataDir);
    if (dataDir === parse(dataDir).root) {
        checks.push(check("runtime.dataDir", "error", "dataDir is a filesystem root", { path: dataDir }, "Choose a dedicated user-writable SovereignBot data directory."));
        return { dataDir, exists: false };
    }
    const info = await exists(dataDir);
    if (!info) {
        const parent = await nearestExistingDirectory(dirname(dataDir));
        if (!parent) {
            checks.push(check("runtime.dataDir", "error", "No existing parent directory is available for dataDir", { path: dataDir }, "Create a writable parent directory."));
            return { dataDir, exists: false };
        }
        try {
            await access(parent, constants.R_OK | constants.W_OK);
            checks.push(check("runtime.dataDir", "ok", "dataDir is not initialized yet; nearest parent is writable", { path: dataDir, parent }));
        }
        catch {
            checks.push(check("runtime.dataDir", "error", "dataDir does not exist and its parent is not writable", { path: dataDir, parent }, "Choose a writable dataDir."));
        }
        return { dataDir, exists: false };
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
        checks.push(check("runtime.dataDir", "error", "dataDir is not a normal directory", { path: dataDir }, "Use a dedicated non-symlink directory."));
        return { dataDir, exists: true };
    }
    try {
        await access(dataDir, constants.R_OK | constants.W_OK);
        const probe = join(dataDir, `.doctor-write-${process.pid}-${randomUUID()}`);
        await writeFile(probe, "doctor\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
        await unlink(probe);
        checks.push(check("runtime.dataDir", "ok", "dataDir is readable and writable", { path: dataDir }));
    }
    catch (error) {
        checks.push(check("runtime.dataDir", "error", "dataDir is not safely writable", { path: dataDir, code: error.code }, "Fix directory ownership/permissions before starting SovereignBot."));
    }
    return { dataDir, exists: true };
}

async function parseJsonIfPresent(path) {
    try {
        return { present: true, value: JSON.parse(await readFile(path, "utf8")) };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return { present: false };
        return { present: true, error };
    }
}

async function parseJsonlIfPresent(path) {
    try {
        const raw = await readFile(path, "utf8");
        let rows = 0;
        for (const line of raw.split(/\r?\n/)) {
            if (!line.trim())
                continue;
            JSON.parse(line);
            rows += 1;
        }
        return { present: true, rows };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return { present: false };
        return { present: true, error };
    }
}

async function checkDurableFiles(dataDir, checks) {
    const tasks = await parseJsonIfPresent(join(dataDir, "tasks.json"));
    if (tasks.error || (tasks.present && !Array.isArray(tasks.value)))
        checks.push(check("state.tasks", "error", "tasks.json is invalid", undefined, "Restore tasks.json from a known-good backup before running work."));
    else
        checks.push(check("state.tasks", "ok", tasks.present ? `tasks.json parsed (${tasks.value.length} tasks)` : "tasks.json not created yet"));

    for (const [id, file] of [["state.memory", "memory.jsonl"], ["state.taskEvents", "task-events.jsonl"]]) {
        const parsed = await parseJsonlIfPresent(join(dataDir, file));
        checks.push(parsed.error
            ? check(id, "error", `${file} contains invalid JSONL`, undefined, `Restore or repair ${file} before relying on durable state.`)
            : check(id, "ok", parsed.present ? `${file} parsed (${parsed.rows} rows)` : `${file} not created yet`));
    }
}

async function checkAudit(dataDir, checks) {
    const auditPath = join(dataDir, "audit.jsonl");
    const info = await exists(auditPath);
    if (!info) {
        checks.push(check("security.audit", "ok", "Audit log not created yet"));
        return;
    }
    try {
        const audit = new AuditLog(auditPath);
        const result = await audit.verify();
        checks.push(result.ok
            ? check("security.audit", "ok", `Audit hash chain verified (${result.count} rows)`)
            : check("security.audit", "error", `Audit hash chain failed at sequence ${result.seq ?? "unknown"}`, { reason: result.reason }, "Restore a known-good audit/state backup; do not continue governed work with an untrusted audit chain."));
    }
    catch {
        checks.push(check("security.audit", "error", "Audit log could not be parsed/verified", undefined, "Restore a known-good audit/state backup."));
    }
}

async function checkPolicyState(config, dataDir, checks) {
    const root = join(dataDir, "policy-versions");
    const rootInfo = await exists(root);
    if (!rootInfo) {
        checks.push(check("security.policyVersion", "ok", "Versioned policy state is not initialized yet; first runtime start will bootstrap the validated config policy"));
        return;
    }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        checks.push(check("security.policyVersion", "error", "policy-versions root is not a normal directory"));
        return;
    }
    const transaction = await parseJsonIfPresent(join(root, "transaction.json"));
    if (transaction.present) {
        checks.push(check(
            "security.policyTransaction",
            "error",
            transaction.error ? "Policy transaction marker is unreadable" : "Policy activation/recovery marker is unresolved",
            transaction.error ? undefined : { kind: transaction.value?.kind, transactionId: transaction.value?.transactionId },
            "Restart with intact state to reconcile a committed marker, or restore from backup. Do not delete the marker blindly.",
        ));
    }
    else {
        checks.push(check("security.policyTransaction", "ok", "No unresolved policy transaction marker"));
    }

    const active = await parseJsonIfPresent(join(root, "active.json"));
    const versionsDir = join(root, "versions");
    const versionNames = await readdir(versionsDir).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const jsonVersions = versionNames.filter((name) => name.endsWith(".json"));
    if (!active.present) {
        checks.push(jsonVersions.length
            ? check("security.policyVersion", "error", "Policy versions exist but active.json is missing", { versionCount: jsonVersions.length }, "Restore active.json from backup; runtime startup intentionally refuses config fallback.")
            : check("security.policyVersion", "warning", "Policy version directory exists but no active version is initialized"));
        return;
    }
    if (active.error) {
        checks.push(check("security.policyVersion", "error", "active.json is invalid JSON"));
        return;
    }
    const pointer = active.value;
    if (typeof pointer?.versionId !== "string" || !/^[0-9a-f]{64}$/.test(pointer?.hash ?? "")) {
        checks.push(check("security.policyVersion", "error", "active policy pointer schema/hash is invalid"));
        return;
    }
    const version = await parseJsonIfPresent(join(versionsDir, `${pointer.versionId}.json`));
    if (!version.present || version.error) {
        checks.push(check("security.policyVersion", "error", "Active policy version is missing or unreadable", { versionId: pointer.versionId }, "Restore the matching immutable policy version from backup."));
        return;
    }
    try {
        const actual = policyHash(version.value.policy);
        if (actual !== pointer.hash || actual !== version.value.hash) {
            checks.push(check("security.policyVersion", "error", "Active policy version hash does not match pointer/version metadata", { versionId: pointer.versionId }, "Restore a known-good policy version/pointer pair."));
            return;
        }
        const configHash = policyHash(config.policy);
        checks.push(check(
            "security.policyVersion",
            "ok",
            configHash === actual ? "Active policy version is verified and matches config policy" : "Active policy version is verified and intentionally differs from config policy",
            { versionId: pointer.versionId, hash: actual },
        ));
    }
    catch {
        checks.push(check("security.policyVersion", "error", "Active policy document is invalid or unsupported"));
    }
}

async function checkRepeatState(dataDir, checks) {
    const parsed = await parseJsonIfPresent(join(dataDir, "repeat-state.json"));
    if (!parsed.present) {
        checks.push(check("security.repeatState", "ok", "Repeat safety state not created yet"));
        return;
    }
    if (parsed.error || parsed.value?.version !== 1 || !parsed.value.entries || typeof parsed.value.entries !== "object" || Array.isArray(parsed.value.entries)) {
        checks.push(check("security.repeatState", "error", "repeat-state.json is invalid or unsupported", undefined, "Restore a known-good repeat-state or perform an explicit migration/repair."));
        return;
    }
    for (const [fingerprint, timestamps] of Object.entries(parsed.value.entries)) {
        if (!/^[0-9a-f]{64}$/.test(fingerprint) || !Array.isArray(timestamps) || timestamps.some((at) => !Number.isFinite(at))) {
            checks.push(check("security.repeatState", "error", "repeat-state.json contains an invalid fingerprint/timestamp entry"));
            return;
        }
    }
    checks.push(check("security.repeatState", "ok", `Repeat safety state parsed (${Object.keys(parsed.value.entries).length} active fingerprints)`));
}

async function checkAgentHarness(agent, checks) {
    const id = `provider.${agent.id}`;
    if (agent.harness.kind === "echo") {
        checks.push(check(id, "ok", "Built-in echo harness requires no external executable"));
        return;
    }
    if (agent.harness.kind === "command") {
        const executable = await resolveExecutable(agent.harness.command, { cwd: agent.harness.cwd });
        if (!executable) {
            checks.push(check(id, "error", "Configured command harness executable was not found", { harnessKind: "command" }, "Fix harness.command/PATH before scheduling this worker."));
            return;
        }
        if (agent.harness.cwd) {
            const cwd = await exists(resolve(agent.harness.cwd));
            if (!cwd?.isDirectory()) {
                checks.push(check(id, "error", "Command harness cwd does not exist or is not a directory", { executable }, "Fix harness.cwd."));
                return;
            }
        }
        checks.push(check(id, "ok", "Command harness executable is available", { executable }));
        return;
    }

    let launch;
    try {
        launch = agent.harness.kind === "codex"
            ? resolveCodexLaunch(agent.harness)
            : resolveClaudeCodeLaunch(agent.harness);
    }
    catch (error) {
        checks.push(check(id, "error", `${agent.harness.kind} CLI is unavailable`, undefined, error.message));
        return;
    }
    const executable = await resolveExecutable(launch.command, { cwd: agent.harness.cwd });
    if (!executable) {
        checks.push(check(id, "error", `${agent.harness.kind} launcher executable was not found`, { source: launch.source }, "Install the CLI or fix the configured launcher."));
        return;
    }

    if (launch.source === "configured") {
        checks.push(check(id, "warning", `${agent.harness.kind} custom launcher is present; authentication was not executed/probed`, { executable, source: launch.source }, "Run the custom launcher's own local auth-status command manually if needed. Doctor never executes arbitrary configured harness commands."));
        return;
    }

    const args = agent.harness.kind === "codex"
        ? [...(launch.prefixArgs ?? []), "login", "status"]
        : [...(launch.prefixArgs ?? []), "auth", "status"];
    const result = runStatusCommand(executable, args);
    if (result.kind === "authenticated")
        checks.push(check(id, "ok", `${agent.harness.kind} CLI is present and reports authenticated`, { source: launch.source }));
    else if (result.kind === "not-authenticated")
        checks.push(check(id, "error", `${agent.harness.kind} CLI is present but reports not authenticated`, { source: launch.source }, agent.harness.kind === "codex" ? "Run `codex login`/Codex sign-in before scheduling this worker." : "Run `claude auth login` before scheduling this worker."));
    else
        checks.push(check(id, "warning", `${agent.harness.kind} CLI is present but local auth status could not be confirmed`, { source: launch.source, status: result.kind }, "Check authentication manually; doctor did not run a model prompt."));
}

async function findWebDriver(browser, driver) {
    if (driver.webdriverCommand)
        return resolveExecutable(driver.webdriverCommand, { cwd: driver.cwd });
    const envName = browser === "firefox" ? "GECKOWEBDRIVER" : browser === "edge" ? "EDGEWEBDRIVER" : "CHROMEWEBDRIVER";
    const hinted = process.env[envName];
    if (hinted) {
        const info = await exists(hinted);
        if (info?.isFile() && await executableFile(hinted))
            return hinted;
        if (info?.isDirectory()) {
            const name = process.platform === "win32"
                ? (browser === "firefox" ? "geckodriver.exe" : browser === "edge" ? "msedgedriver.exe" : "chromedriver.exe")
                : (browser === "firefox" ? "geckodriver" : browser === "edge" ? "msedgedriver" : "chromedriver");
            const nested = join(hinted, name);
            if (await executableFile(nested))
                return nested;
        }
    }
    const name = process.platform === "win32"
        ? (browser === "firefox" ? "geckodriver.exe" : browser === "edge" ? "msedgedriver.exe" : "chromedriver.exe")
        : (browser === "firefox" ? "geckodriver" : browser === "edge" ? "msedgedriver" : "chromedriver");
    return resolveExecutable(name);
}

async function findBrowser(browser, driver) {
    if (driver.browserBinary)
        return await executableFile(resolve(driver.browserBinary)) ? resolve(driver.browserBinary) : undefined;
    if (process.platform === "win32") {
        const bases = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
        const relative = browser === "firefox"
            ? ["Mozilla Firefox", "firefox.exe"]
            : browser === "edge"
                ? ["Microsoft", "Edge", "Application", "msedge.exe"]
                : ["Google", "Chrome", "Application", "chrome.exe"];
        for (const base of bases) {
            const candidate = join(base, ...relative);
            if (await executableFile(candidate))
                return candidate;
        }
    }
    else if (process.platform === "darwin") {
        const candidate = browser === "firefox"
            ? "/Applications/Firefox.app/Contents/MacOS/firefox"
            : browser === "edge"
                ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
                : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        if (await executableFile(candidate))
            return candidate;
    }
    const names = browser === "firefox"
        ? ["firefox"]
        : browser === "edge"
            ? ["microsoft-edge", "microsoft-edge-stable", "msedge"]
            : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
    for (const name of names) {
        const found = await resolveExecutable(name);
        if (found)
            return found;
    }
    return undefined;
}

async function checkComputer(config, dataDir, checks) {
    const needsComputer = config.agents.some((agent) => agent.governedTools?.includes("computer"));
    const driver = config.computer?.driver;
    if (!driver) {
        checks.push(needsComputer
            ? check("computer.driver", "error", "A worker requests governed computer tools but no production computer driver is configured", undefined, "Configure computer.driver.kind=webdriver-sidecar.")
            : check("computer.driver", "ok", "No production computer driver is configured or required by current agents"));
        return;
    }
    const browser = driver.browser ?? "chrome";
    if (driver.sidecarCommand) {
        const sidecar = await resolveExecutable(driver.sidecarCommand, { cwd: driver.cwd });
        if (!sidecar)
            checks.push(check("computer.sidecar", "error", "Configured sidecar command was not found", undefined, "Fix computer.driver.sidecarCommand/cwd."));
        else
            checks.push(check("computer.sidecar", "ok", "Configured sidecar command is available", { executable: sidecar }));
    }
    else {
        checks.push(check("computer.sidecar", "ok", "Bundled sidecar will use the current Node executable"));
    }

    if (driver.webdriverUrl) {
        checks.push(check("computer.webdriver", "warning", "External loopback WebDriver endpoint is configured but doctor does not actively probe it", { endpoint: driver.webdriverUrl }, "Use an explicit active health check only when you intend to start/connect runtime components."));
    }
    else {
        const webdriver = await findWebDriver(browser, driver);
        checks.push(webdriver
            ? check("computer.webdriver", "ok", `${browser} WebDriver executable is available`, { executable: webdriver })
            : check("computer.webdriver", "error", `${browser} WebDriver executable was not found`, undefined, "Install/configure the matching WebDriver executable."));
    }

    const browserExecutable = await findBrowser(browser, driver);
    checks.push(browserExecutable
        ? check("computer.browser", "ok", `${browser} browser executable was found passively`, { executable: browserExecutable })
        : check("computer.browser", driver.browserBinary ? "error" : "warning", `${browser} browser executable was not found in known passive locations`, undefined, driver.browserBinary ? "Fix computer.driver.browserBinary." : "Install the browser or configure computer.driver.browserBinary. WebDriver may still discover a nonstandard installation, but doctor will not launch it to test."));

    const computersRoot = join(dataDir, "computers");
    const root = await exists(computersRoot);
    if (root?.isSymbolicLink()) {
        checks.push(check("computer.storage", "error", "Computer registry root is a symbolic link", undefined, "Move computer state to a normal directory."));
        return;
    }
    let unsafe = 0;
    for (const agent of config.agents) {
        const key = Buffer.from(String(agent.id), "utf8").toString("base64url");
        for (const name of ["profile", "workspace"]) {
            const info = await exists(join(computersRoot, key, name));
            if (info?.isSymbolicLink())
                unsafe += 1;
        }
    }
    checks.push(unsafe
        ? check("computer.storage", "error", "One or more computer profile/workspace roots are symbolic links", { unsafeRoots: unsafe }, "Replace them with normal directories before governed computer use.")
        : check("computer.storage", "ok", root ? "Computer profile/workspace roots have no detected symlink escape roots" : "Computer registry not initialized yet"));
}

async function scanStale(dataDir) {
    const root = await exists(dataDir);
    if (!root?.isDirectory())
        return { count: 0, categories: {} };
    let visited = 0;
    const categories = {};
    const add = (category) => { categories[category] = (categories[category] ?? 0) + 1; };
    const walk = async (dir, depth) => {
        if (depth > 4 || visited >= MAX_STALE_SCAN)
            return;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (visited++ >= MAX_STALE_SCAN)
                break;
            const path = join(dir, entry.name);
            if (entry.name.includes(".tmp-")) add("atomic-temp");
            if (entry.name.includes(".new-")) add("replacement-temp");
            if (entry.name.includes(".old-")) add("recovery-backup");
            if (entry.name === ".bootstrap") add("bootstrap-dir");
            if (entry.name === ".staging") add("staging-dir");
            if (/\.(?:bootstrap|claude-mcp)\.json$/.test(entry.name) && basename(dir) === "tool-bridges") add("tool-bridge-bootstrap");
            if (entry.isDirectory() && !entry.isSymbolicLink())
                await walk(path, depth + 1);
        }
    };
    await walk(dataDir, 0);
    return { count: Object.values(categories).reduce((sum, value) => sum + value, 0), categories, truncated: visited >= MAX_STALE_SCAN };
}

export async function runDoctor(configPath, options = {}) {
    const checks = [];
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push(nodeMajor >= 22
        ? check("runtime.node", "ok", `Node.js ${process.versions.node} is supported`)
        : check("runtime.node", "error", `Node.js ${process.versions.node} is unsupported`, undefined, "Install Node.js 22 or newer."));

    let config;
    try {
        config = await loadConfig(configPath);
        checks.push(check("runtime.config", "ok", "Configuration parsed and validated", { path: resolve(configPath) }));
    }
    catch (error) {
        checks.push(check("runtime.config", "error", "Configuration failed to parse/validate", { path: resolve(configPath), error: String(error.message).slice(0, 600) }, "Fix the config before starting SovereignBot."));
        const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), overall: overall(checks), checks };
        return report;
    }

    const data = await checkDataDir(config, checks);
    const host = String(config.bindHost ?? "127.0.0.1").toLowerCase().replace(/^\[|\]$/g, "");
    checks.push(LOOPBACK.has(host)
        ? check("runtime.bind", "ok", "Runtime is bound to loopback; built-in operator console boundary is preserved", { bindHost: config.bindHost ?? "127.0.0.1" })
        : check("runtime.bind", "warning", "Runtime bind is non-loopback; built-in operator console will be disabled", { bindHost: config.bindHost }, "Keep operator authority on loopback unless using a separately designed remote-control layer."));
    if (config.computer?.allowPrivateHosts)
        checks.push(check("computer.privateHosts", "warning", "Private-host browser navigation is explicitly enabled", undefined, "Keep this disabled unless workers intentionally need RFC1918/loopback targets."));
    else
        checks.push(check("computer.privateHosts", "ok", "Private-host browser navigation remains disabled by default"));

    if (data.exists) {
        await checkDurableFiles(data.dataDir, checks);
        await checkAudit(data.dataDir, checks);
        await checkPolicyState(config, data.dataDir, checks);
        await checkRepeatState(data.dataDir, checks);
    }
    else {
        checks.push(check("security.audit", "ok", "Audit state will initialize on first runtime start"));
        checks.push(check("security.policyVersion", "ok", "Policy version state will bootstrap on first runtime start"));
        checks.push(check("security.policyTransaction", "ok", "No runtime data exists, so no unresolved policy transaction is present"));
        checks.push(check("security.repeatState", "ok", "Repeat safety state will initialize on first runtime start"));
    }

    for (const agent of config.agents)
        await checkAgentHarness(agent, checks);
    await checkComputer(config, data.dataDir, checks);

    const stale = await scanStale(data.dataDir);
    checks.push(stale.count
        ? check("recovery.staleArtifacts", "warning", `Found ${stale.count} possible stale temporary/recovery artifacts`, { categories: stale.categories, truncated: stale.truncated }, "Inspect these artifacts before deleting them; doctor never performs destructive cleanup.")
        : check("recovery.staleArtifacts", "ok", "No known stale temporary/recovery artifacts were detected"));

    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        overall: overall(checks),
        checks,
        passive: true,
        guarantees: {
            providerModelPromptsExecuted: false,
            browserStarted: false,
            webdriverStarted: false,
            automaticRepairPerformed: false,
        },
    };
}

export function formatDoctorReport(report) {
    const symbol = { ok: "OK", warning: "WARN", error: "ERROR" };
    const lines = [`SovereignBot doctor: ${report.overall.toUpperCase()}`];
    for (const item of report.checks) {
        lines.push(`[${symbol[item.status]}] ${item.id}: ${item.summary}`);
        if (item.remediation)
            lines.push(`       -> ${item.remediation}`);
    }
    return `${lines.join("\n")}\n`;
}

export function doctorExitCode(report) {
    return report.overall === "error" ? 1 : 0;
}
