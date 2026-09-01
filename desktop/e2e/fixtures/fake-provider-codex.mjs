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

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin)
    prompt += chunk;

function phase() {
    if (/Propose an execution plan|REJECTED by the strict validator/.test(prompt))
        return "planning";
    if (/SOVEREIGN_REVIEW:|^review:/m.test(prompt) || /candidateResult|previousReviewNotes/.test(prompt))
        return "review";
    if (/originalGoal|"outcome"|Synthesize/.test(prompt))
        return "synthesis";
    return "work";
}

function fanoutPhase() {
    if (process.env.FAKE_PROVIDER_FANOUT_CANARY !== "1" || !/FANOUT_CANARY/.test(prompt)) return undefined;
    if (/independent fan-out child/i.test(prompt)) return "fanout-child";
    if (/required independent review of parallel specialist results/i.test(prompt)) return "fanout-review";
    if (/original owner's join step/i.test(prompt)) return "fanout-join";
    if (/For independent parallel work/i.test(prompt)) return "fanout-owner";
    return undefined;
}

function fanoutRoster() {
    const ids = prompt.match(/coworker_[a-f0-9]{16}/gi) ?? [];
    return [...new Set(ids)];
}

const resumeIndex = args.indexOf("resume");
const resumed = resumeIndex >= 0;
const sessionId = resumed ? args[resumeIndex + 1] : `fake-codex-session-${Date.now().toString(36)}`;
const cwd = process.cwd();
const kind = fanoutPhase() ?? phase();
const negativeFanout = /negative-stop/.test(prompt);

// The V4.5 real Worker Node gate can hold one explicitly marked task long enough
// to exercise confirmed remote cancellation. Normal fake-provider contracts remain
// immediate and deterministic.
const cancelHoldMs = Number(process.env.FAKE_PROVIDER_DELAY_MS ?? 0);
if (cancelHoldMs > 0 && /V45_CANCEL_HOLD/.test(prompt))
    await new Promise((resolve) => setTimeout(resolve, Math.min(cancelHoldMs, 60_000)));

if (kind === "fanout-child")
    await new Promise((resolve) => setTimeout(resolve, negativeFanout ? 1_200 : 260));

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
if (kind === "fanout-owner") {
    const [firstChild, secondChild, reviewer] = fanoutRoster();
    const stopMarker = negativeFanout ? " negative-stop" : "";
    text = `parallel bounded work requested\nSOVEREIGN_FANOUT: ${JSON.stringify({
        reviewerCoworkerId: reviewer,
        children: [
            { key: "research", coworkerId: firstChild, task: `Research the bounded acceptance criteria.${stopMarker}` },
            { key: "implement", coworkerId: secondChild, task: `Implement the bounded change and report the result.${stopMarker}` },
        ],
    })}`;
}
else if (kind === "fanout-child") {
    const childKey = /independent fan-out child ([a-z0-9_-]+)/i.exec(prompt)?.[1] ?? "specialist";
    const artifactLine = childKey === "implement"
        ? `\nSOVEREIGN_ARTIFACTS: [{"path":"fanout-implementation.md","title":"Fanout implementation"}]`
        : "";
    if (childKey === "implement")
        writeFileSync(join(cwd, "fanout-implementation.md"), "# Fanout implementation\n\nDeterministic bounded child result.\n", "utf8");
    text = `FANOUT CHILD RESULT(fake): ${childKey} submitted${artifactLine}`;
}
else if (kind === "fanout-review") {
    text = `FANOUT REVIEW RESULT(fake): independent results approved\nSOVEREIGN_REVIEW: "approved"`;
}
else if (kind === "fanout-join") {
    text = "FANOUT JOIN RESULT(fake): Chief completed synthesis.";
}
else if (kind === "planning") {
    text = `${"```json"}\n${JSON.stringify(PROPOSAL)}\n${"```"}`;
}
else if (kind === "review") {
    const artifactLine = process.env.FAKE_PROVIDER_TEAM_CANARY === "1"
        ? `\nSOVEREIGN_ARTIFACTS: [{"path":"delivery-result.md","title":"Software delivery result"}]`
        : "";
    if (process.env.FAKE_PROVIDER_TEAM_CANARY === "1")
        writeFileSync(join(cwd, "delivery-result.md"), "# Software delivery result\n\nDeterministic reviewer artifact.\n", "utf8");
    text = resumed || /previousReviewNotes/.test(prompt)
        ? `fix verified${artifactLine}\nSOVEREIGN_REVIEW: "approved"`
        : `add tests${artifactLine}\nSOVEREIGN_REVIEW: "changes-requested"`;
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
    const cwdLine = process.env.FAKE_PROVIDER_INCLUDE_CWD === "0" ? "" : `\ncwd=${cwd}`;
    text = `WORKER RESULT(fake)${cwdLine}\n${prompt.trim().slice(0, 200)}`;
    if (process.env.FAKE_PROVIDER_TEAM_CANARY === "1" && /You are Reviewer\./m.test(prompt)) {
        writeFileSync(join(cwd, "delivery-result.md"), "# Software delivery result\n\nDeterministic reviewer artifact.\n", "utf8");
        text = `${text}\nSOVEREIGN_ARTIFACTS: [{"path":"delivery-result.md","title":"Software delivery result"}]`;
    }
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "thread.started", thread_id: sessionId });
emit({ type: "item.completed", item: { type: "agent_message", text } });
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });

try {
    if (process.env.FAKE_PROVIDER_TRANSCRIPT) {
        const productCanary = process.env.FAKE_PROVIDER_TEAM_CANARY === "1";
        const transcriptEntry = {
            provider: "codex",
            phase: kind,
            resumed,
            at: new Date().toISOString(),
            ...(productCanary ? {} : { cwd, sessionId }),
        };
        appendFileSync(process.env.FAKE_PROVIDER_TRANSCRIPT, `${JSON.stringify(transcriptEntry)}\n`, "utf8");
    }
}
catch {
    // Transcript is a CI diagnostic; never fail the fake provider over it.
}
