import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { AuditLog } from "./audit.js";
import { resolveClaudeCodeLaunch } from "./claude-code-harness.js";
import { resolveCodexLaunch } from "./codex-harness.js";
import { loadConfig } from "./config.js";
import { policyHash } from "./policy-version-store.js";

const STATUS_RANK = { ok: 0, warning: 1, error: 2 };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_STALE_SCAN = 4000;
const POLICY_VERSION_ID = /^policy_[0-9a-f-]{36}$/;
const POLICY_HASH = /^[0-9a-f]{64}$/;
const ACTIVE_PROVIDER_TASK = new Set(["accepted", "running"]);
const NONTERMINAL_PROVIDER_TASK = new Set(["queued", "accepted", "running", "changes_requested"]);

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

function finalizeReport(checks) {
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

async function exists(path) {
    try {
        return await lstat(path);
    }
    catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR")
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
    return [
        command,
        ...pathExt.map((value) => `${command}${value.toLowerCase()}`),
        ...pathExt.map((value) => `${command}${value.toUpperCase()}`),
    ];
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
        if (info?.isDirectory() && !info.isSymbolicLink())
            return candidate;
        const parent = dirname(candidate);
        if (parent === candidate)
            return undefined;
        candidate = parent;
    }
}

async function writableDirectoryState(path, { allowMissing = true } = {}) {
    const absolute = resolve(path);
    const info = await exists(absolute);
    if (info) {
        if (!info.isDirectory() || info.isSymbolicLink())
            return { ok: false, reason: "not-normal-directory", path: absolute };
        try {
            await access(absolute, constants.R_OK | constants.W_OK);
            return { ok: true, path: absolute, exists: true };
        }
        catch {
            return { ok: false, reason: "not-readable-writable", path: absolute };
        }
    }
    if (!allowMissing)
        return { ok: false, reason: "missing", path: absolute };
    const parent = await nearestExistingDirectory(dirname(absolute));
    if (!parent)
        return { ok: false, reason: "no-existing-parent", path: absolute };
    try {
        await access(parent, constants.R_OK | constants.W_OK);
        return { ok: true, path: absolute, exists: false, parent };
    }
    catch {
        return { ok: false, reason: "parent-not-readable-writable", path: absolute, parent };
    }
}

async function checkDataDir(config, checks) {
    const dataDir = resolve(config.dataDir);
    if (dataDir === parse(dataDir).root) {
        checks.push(check(
            "runtime.dataDir",
            "error",
            "dataDir is a filesystem root",
            { path: dataDir },
            "Choose a dedicated user-writable SovereignBot data directory.",
        ));
        return { dataDir, exists: false };
    }
    const state = await writableDirectoryState(dataDir);
    if (!state.ok) {
        checks.push(check(
            "runtime.dataDir",
            "error",
            "dataDir is not a safe readable/writable directory",
            { path: dataDir, reason: state.reason, parent: state.parent },
            "Use a dedicated normal directory with read/write permission; do not point dataDir at a symlink/junction-like root.",
        ));
        return { dataDir, exists: Boolean(await exists(dataDir)) };
    }
    checks.push(check(
        "runtime.dataDir",
        "ok",
        state.exists
            ? "dataDir is a normal readable/writable directory"
            : "dataDir is not initialized yet; its nearest normal parent is readable/writable",
        { path: dataDir, ...(state.parent ? { parent: state.parent } : {}) },
    ));
    return { dataDir, exists: Boolean(state.exists) };
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
    let taskRows = [];
    if (tasks.error || (tasks.present && !Array.isArray(tasks.value))) {
        checks.push(check(
            "state.tasks",
            "error",
            "tasks.json is invalid",
            undefined,
            "Restore tasks.json from a known-good backup before running work.",
        ));
    }
    else {
        taskRows = tasks.present ? tasks.value : [];
        checks.push(check("state.tasks", "ok", tasks.present ? `tasks.json parsed (${taskRows.length} tasks)` : "tasks.json not created yet"));
    }

    for (const [id, file] of [["state.memory", "memory.jsonl"], ["state.taskEvents", "task-events.jsonl"]]) {
        const parsed = await parseJsonlIfPresent(join(dataDir, file));
        checks.push(parsed.error
            ? check(id, "error", `${file} contains invalid JSONL`, undefined, `Restore or repair ${file} before relying on durable state.`)
            : check(id, "ok", parsed.present ? `${file} parsed (${parsed.rows} rows)` : `${file} not created yet`));
    }
    return taskRows;
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
            : check(
                "security.audit",
                "error",
                `Audit hash chain failed at sequence ${result.seq ?? "unknown"}`,
                { reason: result.reason },
                "Restore a known-good audit/state backup; do not continue governed work with an untrusted audit chain.",
            ));
    }
    catch {
        checks.push(check(
            "security.audit",
            "error",
            "Audit log could not be parsed/verified",
            undefined,
            "Restore a known-good audit/state backup.",
        ));
    }
}

function validDateString(value) {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validatePolicyPointer(pointer) {
    if (!pointer || pointer.schemaVersion !== 1)
        return "active policy pointer has an unsupported schema";
    if (typeof pointer.versionId !== "string" || !POLICY_VERSION_ID.test(pointer.versionId))
        return "active policy pointer has an invalid versionId";
    if (!POLICY_HASH.test(pointer.hash ?? ""))
        return "active policy pointer has an invalid hash";
    if (!validDateString(pointer.activatedAt))
        return "active policy pointer has an invalid activatedAt";
    return undefined;
}

function validatePolicyTransaction(transaction) {
    if (!transaction || transaction.schemaVersion !== 1)
        return "policy transaction marker has an unsupported schema";
    if (!["bootstrap", "activation"].includes(transaction.kind))
        return "policy transaction marker has an invalid kind";
    if (typeof transaction.transactionId !== "string" || !transaction.transactionId.startsWith("policytx_"))
        return "policy transaction marker has an invalid transactionId";
    if (typeof transaction.toVersionId !== "string" || !POLICY_VERSION_ID.test(transaction.toVersionId))
        return "policy transaction marker has an invalid toVersionId";
    if (transaction.fromVersionId !== undefined && transaction.fromVersionId !== null
        && (typeof transaction.fromVersionId !== "string" || !POLICY_VERSION_ID.test(transaction.fromVersionId)))
        return "policy transaction marker has an invalid fromVersionId";
    if (!POLICY_HASH.test(transaction.toHash ?? ""))
        return "policy transaction marker has an invalid toHash";
    return undefined;
}

function validatePolicyVersionDocument(version, pointer) {
    if (!version || version.schemaVersion !== 1)
        return "active policy version has an unsupported schema";
    if (typeof version.id !== "string" || !POLICY_VERSION_ID.test(version.id) || version.id !== pointer.versionId)
        return "active policy version id is invalid or does not match the pointer";
    if (!POLICY_HASH.test(version.hash ?? ""))
        return "active policy version has an invalid hash";
    if (!validDateString(version.createdAt))
        return "active policy version has an invalid createdAt";
    if (version.parentVersionId !== undefined && version.parentVersionId !== null
        && (typeof version.parentVersionId !== "string" || !POLICY_VERSION_ID.test(version.parentVersionId)))
        return "active policy version has an invalid parentVersionId";
    if (version.label !== undefined && typeof version.label !== "string")
        return "active policy version has an invalid label";
    return undefined;
}

async function checkPolicyState(config, dataDir, checks) {
    const root = join(dataDir, "policy-versions");
    try {
        const rootInfo = await exists(root);
        if (!rootInfo) {
            checks.push(check("security.policyVersion", "ok", "Versioned policy state is not initialized yet; first runtime start will bootstrap the validated config policy"));
            checks.push(check("security.policyTransaction", "ok", "No policy transaction marker exists"));
            return;
        }
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
            checks.push(check("security.policyVersion", "error", "policy-versions root is not a normal directory", undefined, "Restore policy state under a normal non-symlink directory."));
            checks.push(check("security.policyTransaction", "error", "Policy transaction state cannot be trusted while policy-versions root is unsafe"));
            return;
        }

        const transaction = await parseJsonIfPresent(join(root, "transaction.json"));
        if (transaction.present) {
            const markerReason = transaction.error ? "Policy transaction marker is unreadable" : validatePolicyTransaction(transaction.value);
            checks.push(check(
                "security.policyTransaction",
                "error",
                markerReason || "Policy activation/recovery marker is unresolved",
                markerReason ? undefined : { kind: transaction.value.kind, transactionId: transaction.value.transactionId },
                "Restart with intact state to reconcile a committed marker, or restore from backup. Do not delete the marker blindly.",
            ));
        }
        else {
            checks.push(check("security.policyTransaction", "ok", "No unresolved policy transaction marker"));
        }

        const versionsDir = join(root, "versions");
        const versionsInfo = await exists(versionsDir);
        if (versionsInfo && (!versionsInfo.isDirectory() || versionsInfo.isSymbolicLink())) {
            checks.push(check("security.policyVersion", "error", "Policy versions directory is not a normal directory", undefined, "Restore the immutable policy version directory from a known-good backup."));
            return;
        }
        let versionNames = [];
        if (versionsInfo)
            versionNames = await readdir(versionsDir);
        const jsonVersions = versionNames.filter((name) => name.endsWith(".json"));

        const active = await parseJsonIfPresent(join(root, "active.json"));
        if (!active.present) {
            checks.push(jsonVersions.length
                ? check("security.policyVersion", "error", "Policy versions exist but active.json is missing", { versionCount: jsonVersions.length }, "Restore active.json from backup; runtime startup intentionally refuses config fallback.")
                : check("security.policyVersion", "warning", "Policy version directory exists but no active version is initialized"));
            return;
        }
        if (active.error) {
            checks.push(check("security.policyVersion", "error", "active.json is invalid JSON", undefined, "Restore a valid active policy pointer from backup."));
            return;
        }
        const pointer = active.value;
        const pointerReason = validatePolicyPointer(pointer);
        if (pointerReason) {
            checks.push(check("security.policyVersion", "error", pointerReason, undefined, "Restore a valid active policy pointer from backup."));
            return;
        }
        if (!versionsInfo) {
            checks.push(check("security.policyVersion", "error", "active.json exists but the policy versions directory is missing", { versionId: pointer.versionId }, "Restore the matching immutable policy version directory from backup."));
            return;
        }

        // versionId is validated before it is ever interpolated into a filesystem path.
        const version = await parseJsonIfPresent(join(versionsDir, `${pointer.versionId}.json`));
        if (!version.present || version.error) {
            checks.push(check("security.policyVersion", "error", "Active policy version is missing or unreadable", { versionId: pointer.versionId }, "Restore the matching immutable policy version from backup."));
            return;
        }
        const versionReason = validatePolicyVersionDocument(version.value, pointer);
        if (versionReason) {
            checks.push(check("security.policyVersion", "error", versionReason, { versionId: pointer.versionId }, "Restore a valid immutable policy version from backup."));
            return;
        }
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
        checks.push(check(
            "security.policyVersion",
            "error",
            "Policy version state could not be inspected safely",
            undefined,
            "Check filesystem permissions and restore policy state from a known-good backup if necessary.",
        ));
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
        if (!POLICY_HASH.test(fingerprint) || !Array.isArray(timestamps) || timestamps.some((at) => !Number.isFinite(at))) {
            checks.push(check("security.repeatState", "error", "repeat-state.json contains an invalid fingerprint/timestamp entry"));
            return;
        }
    }
    checks.push(check("security.repeatState", "ok", `Repeat safety state parsed (${Object.keys(parsed.value.entries).length} active fingerprints)`));
}

function requiredProviderAgents(tasks) {
    const required = new Set();
    for (const task of tasks) {
        if (!task || task.kind === "plan")
            continue;
        if (task.assignedAgentId && ACTIVE_PROVIDER_TASK.has(task.status))
            required.add(task.assignedAgentId);
        if (task.assignedAgentId && task.harnessState?.sessionId && NONTERMINAL_PROVIDER_TASK.has(task.status))
            required.add(task.assignedAgentId);
        if (task.preferredAgentId && task.status === "queued")
            required.add(task.preferredAgentId);
    }
    return required;
}

async function checkAgentHarness(agent, checks, requiredNow = false) {
    const id = `provider.${agent.id}`;
    if (agent.harness.kind === "echo") {
        checks.push(check(id, "ok", "Built-in echo harness requires no external executable"));
        return;
    }
    if (agent.harness.cwd) {
        const cwdInfo = await exists(resolve(agent.harness.cwd));
        if (!cwdInfo?.isDirectory()) {
            checks.push(check(id, "error", "Harness cwd does not exist or is not a directory", undefined, "Fix harness.cwd before scheduling this worker."));
            return;
        }
    }
    if (agent.harness.kind === "command") {
        const executable = await resolveExecutable(agent.harness.command, { cwd: agent.harness.cwd });
        if (!executable) {
            checks.push(check(
                id,
                requiredNow ? "error" : "warning",
                requiredNow ? "Configured command harness is required by current work but its executable was not found" : "Configured command harness executable was not found; no current task requires it",
                { harnessKind: "command", requiredNow },
                "Fix harness.command/PATH before scheduling this worker.",
            ));
            return;
        }
        checks.push(check(id, "ok", "Command harness executable is available", { executable, requiredNow }));
        return;
    }

    let launch;
    try {
        launch = agent.harness.kind === "codex"
            ? resolveCodexLaunch(agent.harness)
            : resolveClaudeCodeLaunch(agent.harness);
    }
    catch {
        checks.push(check(
            id,
            requiredNow ? "error" : "warning",
            requiredNow ? `${agent.harness.kind} CLI is required by current work but unavailable` : `${agent.harness.kind} CLI is unavailable; no current task requires it`,
            { requiredNow },
            `Install/sign in to the ${agent.harness.kind} CLI before scheduling this worker.`,
        ));
        return;
    }
    const executable = await resolveExecutable(launch.command, { cwd: agent.harness.cwd });
    if (!executable) {
        checks.push(check(
            id,
            requiredNow ? "error" : "warning",
            requiredNow ? `${agent.harness.kind} launcher is required by current work but was not found` : `${agent.harness.kind} launcher executable was not found; no current task requires it`,
            { source: launch.source, requiredNow },
            "Install the CLI or fix the configured launcher.",
        ));
        return;
    }

    if (launch.source === "configured") {
        checks.push(check(
            id,
            "warning",
            `${agent.harness.kind} custom launcher is present; authentication was not executed/probed`,
            { executable, source: launch.source, requiredNow },
            "Check the custom launcher's authentication manually. Doctor never executes arbitrary configured harness commands.",
        ));
        return;
    }

    const args = agent.harness.kind === "codex"
        ? [...(launch.prefixArgs ?? []), "login", "status"]
        : [...(launch.prefixArgs ?? []), "auth", "status"];
    const result = runStatusCommand(executable, args);
    if (result.kind === "authenticated") {
        checks.push(check(id, "ok", `${agent.harness.kind} CLI is present and reports authenticated`, { source: launch.source, requiredNow }));
    }
    else if (result.kind === "not-authenticated") {
        checks.push(check(
            id,
            requiredNow ? "error" : "warning",
            requiredNow ? `${agent.harness.kind} CLI is required by current work but reports not authenticated` : `${agent.harness.kind} CLI reports not authenticated; no current task requires it`,
            { source: launch.source, requiredNow },
            agent.harness.kind === "codex" ? "Run `codex login` before scheduling this worker." : "Run `claude auth login` before scheduling this worker.",
        ));
    }
    else {
        checks.push(check(
            id,
            "warning",
            `${agent.harness.kind} CLI is present but local auth status could not be confirmed`,
            { source: launch.source, requiredNow, status: result.kind },
            "Check authentication manually; doctor did not run a model prompt.",
        ));
    }
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

function verifyWebDriverUrl(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        return parsed.protocol === "http:"
            && LOOPBACK.has(host)
            && !parsed.username
            && !parsed.password;
    }
    catch {
        return false;
    }
}

async function checkComputerStorage(config, dataDir, checks) {
    const paths = [{ kind: "registry", path: join(dataDir, "computers") }];
    for (const agent of config.agents) {
        const key = Buffer.from(String(agent.id), "utf8").toString("base64url");
        const root = join(dataDir, "computers", key);
        paths.push({ kind: "agent-root", path: root });
        paths.push({ kind: "profile", path: join(root, "profile") });
        paths.push({ kind: "workspace", path: join(root, "workspace") });
    }

    const failures = {};
    let existing = 0;
    for (const entry of paths) {
        const state = await writableDirectoryState(entry.path);
        if (state.exists)
            existing += 1;
        if (!state.ok)
            failures[state.reason] = (failures[state.reason] ?? 0) + 1;
    }
    if (Object.keys(failures).length) {
        checks.push(check(
            "computer.storage",
            "error",
            "One or more computer registry/profile/workspace roots are unsafe or not writable",
            { failures, inspectedRoots: paths.length },
            "Use normal non-symlink/junction-like directories with read/write permission before governed computer use.",
        ));
        return;
    }
    checks.push(check(
        "computer.storage",
        "ok",
        existing ? "Computer registry/profile/workspace roots are normal and writable where present" : "Computer registry is not initialized yet; its parent path is writable",
        { inspectedRoots: paths.length, existingRoots: existing },
    ));
}

async function checkComputer(config, dataDir, checks) {
    const needsComputer = config.agents.some((agent) => agent.governedTools?.includes("computer"));
    const driver = config.computer?.driver;
    if (!driver) {
        checks.push(needsComputer
            ? check("computer.driver", "error", "A worker requests governed computer tools but no production computer driver is configured", undefined, "Configure computer.driver.kind=webdriver-sidecar.")
            : check("computer.driver", "ok", "No production computer driver is configured or required by current agents"));
        await checkComputerStorage(config, dataDir, checks);
        return;
    }
    const browser = driver.browser ?? "chrome";
    checks.push(check("computer.driver", "ok", `Configured production computer driver is ${driver.kind}/${browser}`));

    if (driver.sidecarCommand) {
        const sidecar = await resolveExecutable(driver.sidecarCommand, { cwd: driver.cwd });
        checks.push(sidecar
            ? check("computer.sidecar", "ok", "Configured sidecar command is available", { executable: sidecar })
            : check("computer.sidecar", "error", "Configured sidecar command was not found", undefined, "Fix computer.driver.sidecarCommand/cwd."));
    }
    else {
        checks.push(check("computer.sidecar", "ok", "Bundled sidecar will use the current Node executable"));
    }

    if (driver.webdriverUrl) {
        checks.push(verifyWebDriverUrl(driver.webdriverUrl)
            ? check("computer.webdriver", "ok", "Configured WebDriver endpoint is loopback HTTP and credential-free; doctor did not actively probe it", { endpoint: driver.webdriverUrl })
            : check("computer.webdriver", "error", "Configured WebDriver endpoint is not a safe loopback credential-free HTTP endpoint", undefined, "Use a loopback HTTP WebDriver URL without embedded credentials."));
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

    await checkComputerStorage(config, dataDir, checks);
}

async function scanStale(dataDir) {
    const root = await exists(dataDir);
    if (!root?.isDirectory() || root.isSymbolicLink())
        return { count: 0, categories: {}, readErrors: 0, truncated: false };
    let visited = 0;
    let readErrors = 0;
    const categories = {};
    const add = (category) => { categories[category] = (categories[category] ?? 0) + 1; };
    const walk = async (dir, depth) => {
        if (depth > 4 || visited >= MAX_STALE_SCAN)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            readErrors += 1;
            return;
        }
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
    return {
        count: Object.values(categories).reduce((sum, value) => sum + value, 0),
        categories,
        readErrors,
        truncated: visited >= MAX_STALE_SCAN,
    };
}

export async function runDoctor(configPath, options = {}) {
    void options;
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
        checks.push(check(
            "runtime.config",
            "error",
            "Configuration failed to parse/validate",
            { path: resolve(configPath), error: String(error.message).slice(0, 600) },
            "Fix the config before starting SovereignBot.",
        ));
        return finalizeReport(checks);
    }

    const data = await checkDataDir(config, checks);
    const host = String(config.bindHost ?? "127.0.0.1").toLowerCase().replace(/^\[|\]$/g, "");
    checks.push(LOOPBACK.has(host)
        ? check("runtime.bind", "ok", "Runtime is bound to loopback; built-in operator console boundary is preserved", { bindHost: config.bindHost ?? "127.0.0.1" })
        : check("runtime.bind", "warning", "Runtime bind is non-loopback; built-in operator console will be disabled", { bindHost: config.bindHost }, "Keep operator authority on loopback unless using a separately designed remote-control layer."));
    checks.push(config.computer?.allowPrivateHosts
        ? check("computer.privateHosts", "warning", "Private-host browser navigation is explicitly enabled", undefined, "Keep this disabled unless workers intentionally need RFC1918/loopback targets.")
        : check("computer.privateHosts", "ok", "Private-host browser navigation remains disabled by default"));

    let tasks = [];
    if (data.exists) {
        tasks = await checkDurableFiles(data.dataDir, checks);
        await checkAudit(data.dataDir, checks);
        await checkPolicyState(config, data.dataDir, checks);
        await checkRepeatState(data.dataDir, checks);
    }
    else {
        checks.push(check("state.tasks", "ok", "tasks.json will initialize on first task write"));
        checks.push(check("state.memory", "ok", "memory.jsonl will initialize on first memory write"));
        checks.push(check("state.taskEvents", "ok", "task-events.jsonl will initialize on first task event"));
        checks.push(check("security.audit", "ok", "Audit state will initialize on first runtime start"));
        checks.push(check("security.policyVersion", "ok", "Policy version state will bootstrap on first runtime start"));
        checks.push(check("security.policyTransaction", "ok", "No runtime data exists, so no unresolved policy transaction is present"));
        checks.push(check("security.repeatState", "ok", "Repeat safety state will initialize on first runtime start"));
    }

    const requiredAgents = requiredProviderAgents(tasks);
    for (const agent of config.agents)
        await checkAgentHarness(agent, checks, requiredAgents.has(agent.id));
    await checkComputer(config, data.dataDir, checks);

    const stale = await scanStale(data.dataDir);
    if (stale.count || stale.readErrors || stale.truncated) {
        checks.push(check(
            "recovery.staleArtifacts",
            "warning",
            stale.count
                ? `Found ${stale.count} possible stale temporary/recovery artifacts`
                : "Stale-artifact scan was incomplete",
            { categories: stale.categories, readErrors: stale.readErrors, truncated: stale.truncated },
            "Inspect state manually before deleting anything; doctor never performs destructive cleanup.",
        ));
    }
    else {
        checks.push(check("recovery.staleArtifacts", "ok", "No known stale temporary/recovery artifacts were detected"));
    }

    return finalizeReport(checks);
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
