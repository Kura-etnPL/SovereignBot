#!/usr/bin/env node
// Fake Codex CLI for Desktop packaged/installed E2E (CI only — never shipped in the
// release payload). Implements the exact JSONL protocol CodexHarness consumes:
//   --version | --help | auth status | exec --json [--cd X] [resume ID]
// Phase payloads are chosen from the stdin prompt exactly like a real model would see
// it: planner instruction -> proposal JSON, review request -> strict decision (first
// pass changes_requested with notes, retry approves), synthesis -> final text,
// anything else -> worker result that RECORDS ITS REAL process.cwd().
// Every invocation appends one transcript line to $FAKE_PROVIDER_TRANSCRIPT for the
// E2E canary: phase coverage, trusted-cwd equality and session-resume continuity.

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin)
    prompt += chunk;

function phase() {
    if (/Propose an execution plan|REJECTED by the strict validator/.test(prompt))
        return "planning";
    if (/^review:/m.test(prompt) || /candidateResult|previousReviewNotes/.test(prompt))
        return "review";
    if (/originalGoal|"outcome"|Synthesize/.test(prompt))
        return "synthesis";
    return "work";
}

const resumeIndex = args.indexOf("resume");
const resumed = resumeIndex >= 0;
const sessionId = resumed ? args[resumeIndex + 1] : `fake-codex-session-${Date.now().toString(36)}`;
const cwd = process.cwd();
const kind = phase();

// The V4.5 real Worker Node gate can hold one explicitly marked task long enough
// to exercise confirmed remote cancellation. Normal fake-provider contracts remain
// immediate and deterministic.
const cancelHoldMs = Number(process.env.FAKE_PROVIDER_DELAY_MS ?? 0);
if (cancelHoldMs > 0 && /V45_CANCEL_HOLD/.test(prompt))
    await new Promise((resolve) => setTimeout(resolve, Math.min(cancelHoldMs, 60_000)));

if (args.includes("--help")) {
    process.stdout.write([
        "Usage: codex <command>",
        "",
        "Commands:",
        "  auth status   Show current authentication status",
        "  login         Sign in to Codex with ChatGPT",
        "  exec          Run Codex non-interactively",
        "",
    ].join("\n"));
    process.exit(0);
}
if (args.includes("--version")) {
    process.stdout.write("fake-provider codex 1.0.0\n");
    process.exit(0);
}
if (args.includes("auth")) {
    process.stdout.write("Logged in as fake-user@providers.test\n");
    process.exit(0);
}

const PROPOSAL = {
    title: "fix login flow",
    synthesis: true,
    steps: [
        { key: "research", title: "Research the failure", instructions: "Locate the faulty validation.", capability: "research", dependsOn: [] },
        { key: "implement", title: "Implement the fix", instructions: "Apply the corrected validation.", capability: "coding", dependsOn: ["research"], reviewRequired: true },
    ],
};

let text;
if (kind === "planning") {
    text = `${"```json"}\n${JSON.stringify(PROPOSAL)}\n${"```"}`;
}
else if (kind === "review") {
    text = /previousReviewNotes/.test(prompt)
        ? JSON.stringify({ decision: "approve", notes: "fix verified" })
        : JSON.stringify({ decision: "changes_requested", notes: "add tests" });
}
else if (kind === "synthesis") {
    let goal = "";
    try {
        goal = JSON.parse(prompt).originalGoal ?? "";
    }
    catch {
        goal = prompt.slice(0, 80);
    }
    text = `SYNTHESIS(fake): goal completed. ${String(goal).slice(0, 120)}`;
}
else {
    text = `WORKER RESULT(fake)\ncwd=${cwd}\n${prompt.trim().slice(0, 200)}`;
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "thread.started", thread_id: sessionId });
emit({ type: "item.completed", item: { type: "agent_message", text } });
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });

try {
    if (process.env.FAKE_PROVIDER_TRANSCRIPT)
        appendFileSync(process.env.FAKE_PROVIDER_TRANSCRIPT, `${JSON.stringify({
            provider: "codex",
            phase: kind,
            cwd,
            resumed,
            sessionId,
            at: new Date().toISOString(),
        })}\n`, "utf8");
}
catch {
    // Transcript is a CI diagnostic; never fail the fake provider over it.
}
