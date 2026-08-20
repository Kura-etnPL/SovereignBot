#!/usr/bin/env node
import { loadConfig, writeDefaultConfig, DEFAULT_CONFIG_PATH } from "./config.js";
import { createRuntime } from "./runtime.js";
import { startServer } from "./server.js";

function valueAfter(args, flag) {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
}

function capabilities(args) {
    const values = [];
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--cap" && args[index + 1])
            values.push(args[index + 1]);
    }
    return values;
}

function help() {
    console.log(`SovereignBot 0.2.0

Usage:
  sovereignbot init [--config path]
  sovereignbot serve [--config path]
  sovereignbot submit <title> [--input json] [--cap capability] [--agent id] [--config path]
  sovereignbot run [--config path]
  sovereignbot retry <task-id> [--config path]
  sovereignbot status [--config path]
  sovereignbot audit verify [--config path]
`);
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const configPath = valueAfter(args, "--config") ?? DEFAULT_CONFIG_PATH;
    if (!command || command === "help" || command === "--help") {
        help();
        return;
    }
    if (command === "init") {
        const written = await writeDefaultConfig(configPath);
        console.log(`created ${written}`);
        return;
    }

    const config = await loadConfig(configPath);
    const runtime = await createRuntime(config);
    if (command === "serve") {
        const server = await startServer(runtime);
        console.log(`SovereignBot listening on ${server.url}`);
        const stop = async () => {
            await server.close();
            process.exit(0);
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        return;
    }
    if (command === "submit") {
        const title = args[1];
        if (!title || title.startsWith("--"))
            throw new Error("submit requires a task title");
        const inputText = valueAfter(args, "--input");
        const input = inputText ? JSON.parse(inputText) : undefined;
        const task = await runtime.orchestrator.submit({
            title,
            input,
            requiredCapabilities: capabilities(args),
            preferredAgentId: valueAfter(args, "--agent"),
        });
        console.log(JSON.stringify(task, null, 2));
        return;
    }
    if (command === "run") {
        console.log(JSON.stringify(await runtime.orchestrator.runUntilIdle(), null, 2));
        return;
    }
    if (command === "retry") {
        const taskId = args[1];
        if (!taskId || taskId.startsWith("--"))
            throw new Error("retry requires a task id");
        console.log(JSON.stringify(await runtime.orchestrator.retry(taskId), null, 2));
        return;
    }
    if (command === "status") {
        console.log(JSON.stringify(await runtime.orchestrator.listTasks(), null, 2));
        return;
    }
    if (command === "audit" && args[1] === "verify") {
        console.log(JSON.stringify(await runtime.audit.verify(), null, 2));
        return;
    }
    help();
    process.exitCode = 1;
}

main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
});
