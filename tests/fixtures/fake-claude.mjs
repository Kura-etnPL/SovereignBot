#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (process.env.SOVEREIGNBOT_CAPTURE_ARGS)
    await writeFile(process.env.SOVEREIGNBOT_CAPTURE_ARGS, JSON.stringify(args), "utf8");
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin)
    stdin += chunk;

const resumeIndex = args.indexOf("--resume");
const resumed = resumeIndex >= 0;
const sessionId = resumed ? args[resumeIndex + 1] : "fake-claude-session-001";

console.log(JSON.stringify({
    type: "system",
    subtype: "init",
    uuid: "init-1",
    session_id: sessionId,
    model: "fake-model",
    tools: [],
    plugins: [],
}));

if (!resumed && stdin.includes("FAIL_AFTER_START")) {
    console.error("simulated Claude Code failure after session creation");
    process.exit(7);
}

if (stdin.includes("AUTH_FAIL")) {
    console.error("authentication_failed: not logged in");
    process.exit(1);
}

if (stdin.includes("MALFORMED")) {
    console.log("{this is not valid json");
    process.exit(0);
}

if (stdin.includes("HANG")) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
}

console.log(JSON.stringify({
    type: "system",
    subtype: "task_progress",
    task_id: "fake-bg-task",
    description: "working",
    summary: "fake Claude progress",
    usage: { total_tokens: 12, tool_uses: 1, duration_ms: 25 },
    uuid: "progress-1",
    session_id: sessionId,
}));

console.log(JSON.stringify({
    type: "result",
    subtype: "success",
    uuid: "result-1",
    session_id: sessionId,
    duration_ms: 50,
    duration_api_ms: 20,
    is_error: false,
    num_turns: 2,
    result: `${resumed ? "resumed" : "new"}:${sessionId}:${stdin.trim()}`,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: {},
    permission_denials: [],
    terminal_reason: "completed"
}));
