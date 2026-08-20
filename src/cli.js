#!/usr/bin/env node
import { loadConfig, writeDefaultConfig, DEFAULT_CONFIG_PATH } from "./config.js";
import { createRuntime } from "./runtime.js";
import { startServer } from "./server.js";

function valueAfter(args, flag) {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
}

function valuesAfter(args, flag) {
    const values = [];
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === flag && args[index + 1])
            values.push(args[index + 1]);
    }
    return values;
}

function parseJsonOption(args, flag) {
    const text = valueAfter(args, flag);
    return text ? JSON.parse(text) : undefined;
}

function requiredPositional(args, index, name) {
    const value = args[index];
    if (!value || value.startsWith("--"))
        throw new Error(`${name} is required`);
    return value;
}

function help() {
    console.log(`SovereignBot 0.3.0

Usage:
  sovereignbot init [--config path]
  sovereignbot serve [--config path]
  sovereignbot submit <title> [--input json] [--cap capability] [--agent id]
  sovereignbot plan <title> --owner <supervisor-id> [--input json]
  sovereignbot delegate <parent-id> <title> --actor <supervisor-id> [--cap capability] [--agent id] [--depends task-id] [--review]
  sovereignbot run
  sovereignbot retry <task-id>
  sovereignbot cancel <task-id> [--reason text] [--no-cascade]
  sovereignbot progress <task-id> --actor <worker-id> --event <id> [--percent n] [--message text]
  sovereignbot review <task-id> <approve|changes_requested> --reviewer <agent-id> --event <id> [--notes text]
  sovereignbot aggregate <plan-id> --actor <supervisor-id>
  sovereignbot graph <task-id>
  sovereignbot events <task-id>
  sovereignbot status
  sovereignbot audit verify
  sovereignbot computer token <agent-id>
  sovereignbot computer operator-token
  sovereignbot computer list

Every command accepts [--config path]. Repeated flags such as --cap and --depends may be supplied more than once.
Computer bearer tokens are printed only by local CLI bootstrap commands; the HTTP API never returns them.
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
            await runtime.close();
            process.exit(0);
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        return;
    }

    if (command === "computer") {
        const subcommand = args[1];
        if (subcommand === "token") {
            const agentId = requiredPositional(args, 2, "computer agent id");
            console.log(JSON.stringify(await runtime.computer.agentCredentials(agentId), null, 2));
            return;
        }
        if (subcommand === "operator-token") {
            console.log(JSON.stringify(await runtime.computer.operatorCredentials(), null, 2));
            return;
        }
        if (subcommand === "list") {
            console.log(JSON.stringify(await runtime.computer.listComputers(), null, 2));
            return;
        }
        throw new Error("computer requires token <agent-id>, operator-token, or list");
    }

    if (command === "submit") {
        const title = requiredPositional(args, 1, "submit task title");
        const task = await runtime.orchestrator.submit({
            title,
            input: parseJsonOption(args, "--input"),
            requiredCapabilities: valuesAfter(args, "--cap"),
            preferredAgentId: valueAfter(args, "--agent"),
        });
        console.log(JSON.stringify(task, null, 2));
        return;
    }

    if (command === "plan") {
        const title = requiredPositional(args, 1, "plan title");
        const ownerAgentId = valueAfter(args, "--owner");
        if (!ownerAgentId)
            throw new Error("plan requires --owner <supervisor-id>");
        console.log(JSON.stringify(await runtime.orchestrator.createPlan({
            title,
            input: parseJsonOption(args, "--input"),
            ownerAgentId,
        }), null, 2));
        return;
    }

    if (command === "delegate") {
        const parentTaskId = requiredPositional(args, 1, "parent task id");
        const title = requiredPositional(args, 2, "delegated task title");
        const actorAgentId = valueAfter(args, "--actor");
        if (!actorAgentId)
            throw new Error("delegate requires --actor <supervisor-id>");
        const reviewCaps = valuesAfter(args, "--review-cap");
        console.log(JSON.stringify(await runtime.orchestrator.delegate(
            parentTaskId,
            {
                title,
                input: parseJsonOption(args, "--input"),
                requiredCapabilities: valuesAfter(args, "--cap"),
                preferredAgentId: valueAfter(args, "--agent"),
                dependencyIds: valuesAfter(args, "--depends"),
                review: args.includes("--review")
                    ? {
                        required: true,
                        requiredCapabilities: reviewCaps.length ? reviewCaps : ["review"],
                        independent: !args.includes("--self-review"),
                    }
                    : undefined,
            },
            actorAgentId,
        ), null, 2));
        return;
    }

    if (command === "run") {
        console.log(JSON.stringify(await runtime.orchestrator.runUntilIdle(), null, 2));
        return;
    }

    if (command === "retry") {
        const taskId = requiredPositional(args, 1, "retry task id");
        console.log(JSON.stringify(await runtime.orchestrator.retry(taskId), null, 2));
        return;
    }

    if (command === "cancel") {
        const taskId = requiredPositional(args, 1, "cancel task id");
        console.log(JSON.stringify(await runtime.orchestrator.cancel(taskId, {
            reason: valueAfter(args, "--reason"),
            cascade: !args.includes("--no-cascade"),
        }), null, 2));
        return;
    }

    if (command === "progress") {
        const taskId = requiredPositional(args, 1, "progress task id");
        const actorAgentId = valueAfter(args, "--actor");
        const eventId = valueAfter(args, "--event");
        if (!actorAgentId || !eventId)
            throw new Error("progress requires --actor <worker-id> and --event <id>");
        const percentText = valueAfter(args, "--percent");
        console.log(JSON.stringify(await runtime.orchestrator.reportProgress(
            taskId,
            {
                eventId,
                percent: percentText === undefined ? undefined : Number(percentText),
                message: valueAfter(args, "--message"),
                data: parseJsonOption(args, "--data"),
            },
            actorAgentId,
        ), null, 2));
        return;
    }

    if (command === "review") {
        const taskId = requiredPositional(args, 1, "review task id");
        const decision = requiredPositional(args, 2, "review decision");
        const reviewerAgentId = valueAfter(args, "--reviewer");
        const eventId = valueAfter(args, "--event");
        if (!reviewerAgentId || !eventId)
            throw new Error("review requires --reviewer <agent-id> and --event <id>");
        console.log(JSON.stringify(await runtime.orchestrator.reviewTask(
            taskId,
            { decision, eventId, notes: valueAfter(args, "--notes") },
            reviewerAgentId,
        ), null, 2));
        return;
    }

    if (command === "aggregate") {
        const planId = requiredPositional(args, 1, "plan id");
        const actorAgentId = valueAfter(args, "--actor");
        if (!actorAgentId)
            throw new Error("aggregate requires --actor <supervisor-id>");
        console.log(JSON.stringify(await runtime.orchestrator.aggregatePlan(planId, actorAgentId), null, 2));
        return;
    }

    if (command === "graph") {
        const taskId = requiredPositional(args, 1, "graph task id");
        console.log(JSON.stringify(await runtime.orchestrator.getTaskGraph(taskId), null, 2));
        return;
    }

    if (command === "events") {
        const taskId = requiredPositional(args, 1, "events task id");
        console.log(JSON.stringify(await runtime.orchestrator.listTaskEvents(taskId), null, 2));
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
