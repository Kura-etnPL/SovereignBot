import { spawn } from "node:child_process";
import { collectHelp, findAuthStatusCandidates } from "./lib/provider-discovery.js";

// Provider sign-in helper (BLOCKER D). The renderer may only name the provider; the main
// process resolves the real CLI through the reviewed Core resolvers and derives fixed,
// help-documented login arguments. SovereignBot never sees credentials, never passes
// renderer-supplied commands/args/env, and re-detects passively after the CLI exits.

export function findLoginCandidates(helpText) {
    const lines = String(helpText ?? "").split(/\r?\n/);
    const candidates = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !/\s{2,}/.test(trimmed))
            continue;
        if (!/\b(?:login|sign.?in)\b/i.test(trimmed))
            continue;
        if (/status|logout|whoami/i.test(trimmed))
            continue;
        const words = trimmed.replace(/^[-*\s]+/, "").split(/\s+/).filter((word) => /^[a-z][\w:-]*$/i.test(word));
        if (words.length && !words.some((word) => /^-/.test(word)))
            candidates.push(words.join(" "));
    }
    return [...new Set(candidates)].slice(0, 4);
}

function launchLoginProcess({ command, args }) {
    return new Promise((resolve) => {
        let child;
        try {
            // Console-subsystem CLIs get a visible console window of their own
            // (windowsHide stays false on purpose): the user completes the interactive
            // login there, exactly as they would in a terminal.
            child = spawn(command, args, { shell: false, stdio: "ignore", windowsHide: false });
        }
        catch (error) {
            resolve({ launched: false, reason: String(error?.message ?? error).slice(0, 200) });
            return;
        }
        child.once("error", (error) => resolve({ launched: true, exitReason: String(error?.message ?? error).slice(0, 200) }));
        child.once("close", () => resolve({ launched: true }));
    });
}

export async function openProviderLogin({ resolver, label }) {
    if (typeof resolver !== "function")
        throw new Error(`provider ${label} has no launch resolver`);
    const launch = resolver();
    const helpText = await collectHelp(launch.command, launch.prefixArgs ?? []);
    const candidates = findLoginCandidates(helpText).filter((candidate) => candidate !== label);
    // Fall back to opening the CLI itself when no dedicated login subcommand is
    // documented; the interactive entry point still lets the user sign in.
    const args = [...(launch.prefixArgs ?? []), ...(candidates[0]?.split(" ") ?? [])];
    const result = await launchLoginProcess({ command: launch.command, args });
    return {
        ...result,
        usedSubcommand: candidates[0] ?? undefined,
        authStatusProbe: findAuthStatusCandidates(helpText)[0],
    };
}
