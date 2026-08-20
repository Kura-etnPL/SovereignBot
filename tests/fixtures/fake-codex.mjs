#!/usr/bin/env node

const args = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin)
    prompt += chunk;

const resumeIndex = args.indexOf("resume");
const resumed = resumeIndex >= 0;
const sessionId = resumed ? args[resumeIndex + 1] : "fake-codex-session-001";

console.log(JSON.stringify({ type: "thread.started", thread_id: sessionId }));

if (!resumed && prompt.includes("FAIL_AFTER_START")) {
    console.error("simulated Codex failure after session creation");
    process.exit(7);
}

if (prompt.includes("MALFORMED")) {
    console.log("{this is not valid json");
    process.exit(0);
}

if (prompt.includes("HANG")) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
}

console.log(JSON.stringify({
    type: "item.completed",
    item: {
        type: "agent_message",
        text: `${resumed ? "resumed" : "new"}:${sessionId}:${prompt.trim()}`,
    },
}));
console.log(JSON.stringify({
    type: "turn.completed",
    usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        output_tokens: 5,
    },
}));
