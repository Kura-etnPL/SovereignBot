#!/usr/bin/env node
// Fake Claude Code CLI for Desktop packaged/installed E2E (CI only — never shipped).
// Implements the stream-json contract ClaudeCodeHarness consumes:
//   --version | --help | auth status | -p --output-format stream-json [--resume ID]
// Phase branching mirrors fake-provider-codex.mjs so the full goal pipeline (planner,
// worker, independent reviewer with one changes_requested cycle, synthesizer) runs on
// provider harnesses inside the packaged app. Transcript canary identical.

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

const resumeIndex = args.indexOf("--resume");
const resumed = resumeIndex >= 0;
const sessionId = resumed ? args[resumeIndex + 1] : `fake-claude-session-${Date.now().toString(36)}`;
const cwd = process.cwd();
const kind = phase();

if (args.includes("--help")) {
    process.stdout.write([
        "Usage: claude [options]",
        "",
        "Commands:",
        "  login         Sign in to Claude Code",
        "",
        "Print mode streams results as JSON.",
    ].join("\n"));
    process.exit(0);
}
if (args.includes("--version")) {
    process.stdout.write("fake-provider claude 1.0.0 (Claude Code)\n");
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
emit({ type: "system", subtype: "init", session_id: sessionId, model: "fake-model", tools: [], plugins: [] });
emit({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: text,
    usage: { input_tokens: 1, output_tokens: 1 },
});

try {
    if (process.env.FAKE_PROVIDER_TRANSCRIPT)
        appendFileSync(process.env.FAKE_PROVIDER_TRANSCRIPT, `${JSON.stringify({
            provider: "claude",
            phase: kind,
            cwd,
            resumed,
            sessionId,
            at: new Date().toISOString(),
        })}\n`, "utf8");
}
catch {
}
