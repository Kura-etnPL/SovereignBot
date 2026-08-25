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

function redact(text) {
    return String(text ?? "").replace(SECRET_SHAPED, "[REDACTED]");
}

export function probeOnce({ command, args, timeoutMs = PROBE_TIMEOUT_MS }) {
    return new Promise((resolve) => {
        let child;
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
            child.kill();
        }, timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", (error) => {
            clearTimeout(timer);
            resolve({ ok: false, reason: redact(error.message) });
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            resolve({ ok: true, code, stdout: redact(stdout.slice(0, 8000)), stderr: redact(stderr.slice(0, 4000)) });
        });
    });
}

// Extract candidate auth-status invocations from --help text without executing them.
export function findAuthStatusCandidates(helpText) {
    const lines = String(helpText ?? "").split(/\r?\n/);
    const candidates = [];
    for (const line of lines) {
        const trimmed = line.trim();
        // List rows separate the command column from the description with a wide gap;
        // multi-word subcommands ("auth status") must not be disqualified by their
        // single-space internal separator.
        if (!trimmed || !/\s{2,}/.test(trimmed))
            continue;
        if (/login|auth/i.test(trimmed) && /status|whoami|show|check|list/i.test(trimmed)) {
            const words = trimmed.replace(/^[-*\s]+/, "").split(/\s+/).filter((word) => /^[a-z][\w:-]*$/i.test(word));
            if (words.length && !words.some((word) => /^-/.test(word)))
                candidates.push(words.join(" "));
        }
    }
    return [...new Set(candidates)].slice(0, 4);
}

async function collectHelp(command, prefixArgs = []) {
    const result = await probeOnce({ command, args: [...prefixArgs, "--help"] });
    if (!result.ok || result.code !== 0)
        return "";
    return `${result.stdout}\n${result.stderr}`;
}

export { collectHelp };

async function readVersionLine(command, prefixArgs, versionArgs) {
    const result = await probeOnce({ command, args: [...prefixArgs, ...versionArgs] });
    if (!result.ok)
        return undefined;
    const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
    return line ? redact(line.slice(0, 120)) : undefined;
}

async function determineAuthStatus(command, prefixArgs, helpText) {
    for (const candidate of findAuthStatusCandidates(helpText)) {
        const result = await probeOnce({ command, args: [...prefixArgs, ...candidate.split(" ")] });
        if (!result.ok)
            continue;
        const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
        // Only trust explicit signed-in/signed-out language; anything ambiguous stays
        // "unverified" rather than guessing.
        if (/logged?\s*in|signed\s*in|authenticated/.test(combined) && !/not\s+(logged|signed)\s*in/.test(combined))
            return { state: "signed-in", via: candidate };
        if (/not\s+(logged|signed)\s*in|unauthenticated|please\s+(log|sign)\s*in|need.*log.?in/.test(combined))
            return { state: "signed-out", via: candidate };
    }
    return { state: "unverified" };
}

export async function describeProvider(resolver, label, versionArgs) {
    try {
        const launch = resolver();
        const prefixArgs = Array.isArray(launch.prefixArgs) ? [...launch.prefixArgs] : [];
        const helpText = await collectHelp(launch.command, prefixArgs);
        const [versionLine, auth] = await Promise.all([
            readVersionLine(launch.command, prefixArgs, versionArgs),
            determineAuthStatus(launch.command, prefixArgs, helpText),
        ]);
        return {
            provider: label,
            found: true,
            source: launch.source,
            commandPathHidden: true,
            version: versionLine,
            auth,
            interactiveLoginAvailable: /\blogin\b/i.test(helpText),
        };
    }
    catch (error) {
        return { provider: label, found: false, reason: redact(error.message) };
    }
}
