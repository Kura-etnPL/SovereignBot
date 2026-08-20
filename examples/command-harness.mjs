#!/usr/bin/env node
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
console.log(
  JSON.stringify({
    ok: true,
    message: `Harness received task: ${request.task.title}`,
    agent: request.agent.id,
  }),
);
