import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Passive provider discovery for the Desktop first-run experience.
//
// Rules:
//  - executable resolution reuses the reviewed Core resolvers (no parallel PATH logic);
//  - readiness never sends a model prompt and never consumes quota;
//  - subcommand syntax for auth/version probing is discovered from the CLI's own --help
//    output instead of hardcoding vendor commands that may drift;
//  - every probe uses shell:false, fixed argv, a short timeout, hidden windows, and
//    secret-shaped redaction over captured output before anything is surfaced.

const PROBE_TIMEOUT_MS = 10_000;
const SECRET_SHAPED = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|[A-Za-z0-9+/=_-]{40,})/g;
const READ_ONLY_AUTH_ROOTS = new Set(["auth", "login"]);

function redact(text) {
    return String(text ?? "").replace(SECRET_SHAPED, "[REDACTED]");
}

export function probeOnce({ command, args, timeoutMs = PROBE_TIMEOUT_MS }) {
    return new Promise((resolve) => {
        let child;
        let timedOut = false;
        try {
            child = spawn(command, args, {
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
        }
        catch (error) {
            resolve({ ok: false, reason: redact(error.message) });
            return;
        }
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", (error) => {
            clearTimeout(timer);
            resolve({ ok: false, timedOut, reason: redact(error.message) });
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            resolve({ ok: true, code, timedOut, stdout: redact(stdout.slice(0, 8000)), stderr: redact(stderr.slice(0, 4000)) });
        });
    });
}

function commandColumn(line) {
    const trimmed = String(line ?? "").trim().replace(/^[-*]\s+/, "");
    if (!trimmed || !/\s{2,}/.test(trimmed))
        return undefined;
    if (/^(?:usage|commands?|subcommands?|options?|arguments?):?\b/i.test(trimmed))
        return undefined;
    const command = trimmed.split(/\s{2,}/, 1)[0].trim();
    if (!command || command.startsWith("-"))
        return undefined;
    const words = command.split(/\s+/).filter((word) => /^[a-z][\w:-]*$/i.test(word));
    return words.length ? words.join(" ") : undefined;
}

function commandRows(helpText) {
    return String(helpText ?? "").split(/\r?\n/).map((line) => {
        const trimmed = line.trim().replace(/^[-*]\s+/, "");
        const command = commandColumn(line);
        const description = command && /\s{2,}/.test(trimmed)
            ? trimmed.slice(command.length).trim()
            : "";
        return { command, description };
    }).filter((row) => row.command);
}

function prefixNestedCommands(helpText, prefix) {
    return String(helpText ?? "").split(/\r?\n/).map((line) => {
        const command = commandColumn(line);
        if (!command)
            return line;
        const trimmed = line.trim().replace(/^[-*]\s+/, "");
        const description = trimmed.slice(command.length).trim();
        return `  ${prefix} ${command}${description ? `        ${description}` : ""}`;
    }).join("\n");
}

// Extract candidate auth-status invocations from --help text without executing them.
export function findAuthStatusCandidates(helpText) {
    const candidates = [];
    for (const { command, description } of commandRows(helpText)) {
        // `login` and `auth` alone are roots, not status operations. Keeping them out
        // here is important: discovery must never turn a passive probe into an
        // interactive login attempt.
        if (/(?:^|\s)(?:status|whoami)(?:\s|$)/i.test(command)
            || (/(?:login|auth)/i.test(description) && /status|whoami|show|check|current/i.test(description))) {
            candidates.push(command);
        }
    }
    return [...new Set(candidates)].slice(0, 4);
}

async function collectHelp(command, prefixArgs = []) {
    const result = await probeOnce({ command, args: [...prefixArgs, "--help"] });
    if (!result.ok || result.code !== 0)
        return "";
    const rootHelp = `${result.stdout}\n${result.stderr}`;
    // Codex exposes `login status` under `login --help`, while other CLIs expose
    // `auth status` at the root. Discover only these documented read-only roots and
    // never execute a guessed login/auth action.
    const nested = [];
    for (const root of commandRows(rootHelp).map((row) => row.command).filter((entry) => READ_ONLY_AUTH_ROOTS.has(entry))) {
        const nestedResult = await probeOnce({ command, args: [...prefixArgs, root, "--help"] });
        if (nestedResult.ok && nestedResult.code === 0 && !nestedResult.timedOut)
            nested.push(prefixNestedCommands(`${nestedResult.stdout}\n${nestedResult.stderr}`, root));
    }
    return [rootHelp, ...nested].join("\n");
}

export { collectHelp };

async function readVersionLine(command, prefixArgs, versionArgs) {
    const result = await probeOnce({ command, args: [...prefixArgs, ...versionArgs] });
    if (!result.ok)
        return { line: undefined, probe: result };
    const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
    return { line: line ? redact(line.slice(0, 120)) : undefined, probe: result };
}

export function classifyAuthText(text, via) {
    const combined = String(text ?? "").toLowerCase();
    if (/rate.?limit|quota|capacity|too many requests|usage limit|limit exceeded|temporarily unavailable|try again later/.test(combined))
        return { state: "capacity-limited", via };
    if (/logged?\s*in|signed\s*in|authenticated/.test(combined) && !/not\s+(logged|signed)\s*in/.test(combined))
        return { state: "signed-in", via };
    if (/not\s+(logged|signed)\s*in|unauthenticated|please\s+(log|sign)\s*in|need.*log.?in/.test(combined))
        return { state: "signed-out", via };
    return undefined;
}

async function determineAuthStatus(command, prefixArgs, helpText) {
    for (const candidate of findAuthStatusCandidates(helpText)) {
        const result = await probeOnce({ command, args: [...prefixArgs, ...candidate.split(" ")] });
        if (!result.ok || result.timedOut)
            continue;
        // Only trust explicit signed-in/signed-out language; anything ambiguous stays
        // "unverified" rather than guessing.
        const classification = classifyAuthText(`${result.stdout}\n${result.stderr}`, candidate);
        if (classification)
            return classification;
    }
    return { state: "unverified" };
}

export async function describeProvider(resolver, label, versionArgs) {
    try {
        const launch = resolver();
        const prefixArgs = Array.isArray(launch.prefixArgs) ? [...launch.prefixArgs] : [];
        const helpText = await collectHelp(launch.command, prefixArgs);
        const [versionResult, auth] = await Promise.all([
            readVersionLine(launch.command, prefixArgs, versionArgs),
            determineAuthStatus(launch.command, prefixArgs, helpText),
        ]);
        if (!versionResult.probe.ok || versionResult.probe.timedOut || versionResult.probe.code !== 0)
            return { provider: label, found: false, health: "unavailable", reason: "provider version probe failed" };
        return {
            provider: label,
            found: true,
            source: launch.source,
            commandPathHidden: true,
            version: versionResult.line,
            auth,
            health: auth.state === "signed-out" ? "signed-out" : auth.state === "capacity-limited" ? "capacity-limited" : "ready",
            interactiveLoginAvailable: /\blogin\b/i.test(helpText),
        };
    }
    catch (error) {
        return { provider: label, found: false, health: "unavailable", reason: redact(error.message) };
    }
}
