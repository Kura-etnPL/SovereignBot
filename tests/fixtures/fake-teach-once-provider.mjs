#!/usr/bin/env node

// Deterministic provider boundary for the focused Teach Once integration test. The
// test still exercises the real Orchestrator -> command harness -> Coworker task path;
// this fixture only makes the provider response reproducible and contains no secrets.
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin)
    input += chunk;

const draft = {
    name: "Prepare report",
    description: "Create a report from the current site.",
    instructions: "Use semantic Computer actions and verify the visible result.",
    inputs: [{ name: "report_period", type: "string", description: "Report period.", required: true }],
    steps: [
        "Click the Create report button.",
        "Enter {{input:report_period}} into Report period.",
        "Verify that Report is ready.",
    ],
    expectedOutput: "Report is ready",
    requestedCapabilities: ["computer"],
    validators: ["contains: Report is ready"],
};

if (!input.includes("synthesize Teach Once SkillDraft"))
    process.exitCode = 2;
else
    process.stdout.write(JSON.stringify({ text: JSON.stringify(draft) }));
