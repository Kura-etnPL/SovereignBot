#!/usr/bin/env node
import { loadConfig, writeDefaultConfig, DEFAULT_CONFIG_PATH } from "./config.js";
import { applyCrashRecovery, inspectCrashRecovery } from "./crash-recovery.js";
import { doctorExitCode, formatDoctorReport, runDoctor } from "./doctor.js";
import { createRuntime } from "./runtime.js";
import { startServer } from "./server.js";
import { createStateBackup, exportState, inspectStateBackup, restoreStateBackup } from "./state-transfer.js";
import { providerContinuityRefs, publicProgressView, publicRuntimeRecords, publicTaskGraphView, publicTaskListView, publicTaskView } from "./task-view.js";

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

async function taskRefs(runtime) {
    return providerContinuityRefs(await runtime.orchestrator.listTasks());
}

async function publicRuntimeTask(runtime, task) {
    return publicTaskView(task, await taskRefs(runtime));
}

async function publicRuntimeProgress(runtime, progress) {
    return publicProgressView(progress, await taskRefs(runtime));
}

function help() {
    console.log(`SovereignBot 0.4-dev

Usage:
  sovereignbot init [--config path]
  sovereignbot doctor [--json] [--config path]
  sovereignbot backup <output-directory> [--include-computer-state] [--config path]
  sovereignbot restore <backup-directory> [--replace] [--config path]
  sovereignbot export <output-directory> [--config path]
  sovereignbot recover [--apply] [--quarantine path] [--config path]
  sovereignbot serve [--config path]
  sovereignbot operator-session [--ttl-minutes 30] [--label local-operator]
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
Doctor is passive with respect to model work/browser startup: it never runs a model prompt or starts WebDriver/browser merely to inspect readiness.
Backup/restore/export run before normal runtime construction. Stop the runtime before backup or restore for an offline-consistent v1.0 snapshot.
Default backup excludes computer tokens/workspaces/browser profiles. --include-computer-state explicitly creates a sensitive full-computer continuity backup.
Export is redacted/non-restorable and never contains computer credentials/browser profiles, operator sessions, or governed bridge capabilities.
Recover is read-only by default. --apply explicitly quarantines only recognized stale runtime artifacts and assumes all runtime/browser worker processes are stopped.
Computer bearer tokens are printed only by local CLI bootstrap commands; the HTTP API never returns them.
Provider resume/session references remain internal runtime state; ordinary task/status/graph output exposes only hasResumableSession.
Operator-console sessions are short-lived and separate from the durable computer operator token.
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
    if (command === "doctor") {
        const report = await runDoctor(configPath);
        if (args.includes("--json"))
            console.log(JSON.stringify(report, null, 2));
        else
            process.stdout.write(formatDoctorReport(report));
        process.exitCode = doctorExitCode(report);
        return;
    }

    if (command === "recover") {
        const config = await loadConfig(configPath);
        const apply = args.includes("--apply");
        const quarantine = valueAfter(args, "--quarantine");
        if (!apply && quarantine)
            throw new Error("--quarantine is valid only with recover --apply");
        if (!apply) {
            console.log(JSON.stringify(await inspectCrashRecovery(config), null, 2));
            return;
        }
        process.stderr.write(
            "WARNING: recover --apply is an offline operation. Stop SovereignBot, provider workers, browser/WebDriver processes, and governed tool subprocesses before continuing. Recognized crash artifacts will be moved into a private sibling quarantine, not deleted.\n",
        );
        console.log(JSON.stringify(await applyCrashRecovery(config, { quarantine }), null, 2));
        return;
    }

    if (["backup", "restore", "export"].includes(command)) {
        const config = await loadConfig(configPath);
        if (command === "backup") {
            const output = requiredPositional(args, 1, "backup output directory");
            const includeComputerState = args.includes("--include-computer-state");
            if (includeComputerState) {
                process.stderr.write(
                    "WARNING: this full-computer backup may contain worker/operator bearer tokens, workspace data, browser cookies, and logged-in browser profiles. Store it as sensitive credential material.\n",
                );
            }
            console.log(JSON.stringify(await createStateBackup(config, output, { includeComputerState }), null, 2));
            return;
        }
        if (command === "restore") {
            const input = requiredPositional(args, 1, "backup directory");
            const manifest = await inspectStateBackup(input);
            if (manifest.sensitiveComputerState === true) {
                process.stderr.write(
                    "WARNING: this backup contains sensitive computer continuity state and may restore browser login sessions and durable computer bearer tokens.\n",
                );
            }
            console.log(JSON.stringify(await restoreStateBackup(config, input, { replace: args.includes("--replace") }), null, 2));
            return;
        }
        const output = requiredPositional(args, 1, "export output directory");
        console.log(JSON.stringify(await exportState(config, output), null, 2));
        return;
    }

    const config = await loadConfig(configPath);
    const runtime = await createRuntime(config);

    if (command === "serve") {
        const server = await startServer(runtime);
        console.log(`SovereignBot listening on ${server.url}`);
        console.log(`Operator console: ${server.url}/ui/`);
        const stop = async () => {
            await server.close();
            await runtime.close();
            process.exit(0);
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        return;
    }

    if (command === "operator-session") {
        const ttlText = valueAfter(args, "--ttl-minutes");
        const ttlMinutes = ttlText === undefined ? 30 : Number(ttlText);
        if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0)
            throw new Error("--ttl-minutes must be a positive number");
        const session = await runtime.operatorSessions.issue({
            ttlMs: Math.round(ttlMinutes * 60_000),
            label: valueAfter(args, "--label") ?? "local-operator",
        });
        console.log(JSON.stringify({
            token: session.token,
            expiresAt: new Date(session.expiresAt).toISOString(),
            consolePath: "/ui/",
            note: "Paste this token into the local operator console. The raw token is not stored by SovereignBot.",
        }, null, 2));
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
        const task = await runtime.orchestrator.submit({ title, input: parseJsonOption(args, "--input"), requiredCapabilities: valuesAfter(args, "--cap"), preferredAgentId: valueAfter(args, "--agent") });
        console.log(JSON.stringify(await publicRuntimeTask(runtime, task), null, 2)); return;
    }
    if (command === "plan") {
        const title = requiredPositional(args, 1, "plan title"); const ownerAgentId = valueAfter(args, "--owner");
        if (!ownerAgentId) throw new Error("plan requires --owner <supervisor-id>");
        console.log(JSON.stringify(await publicRuntimeTask(runtime, await runtime.orchestrator.createPlan({ title, input: parseJsonOption(args, "--input"), ownerAgentId })), null, 2)); return;
    }
    if (command === "delegate") {
        const parentTaskId = requiredPositional(args, 1, "parent task id"); const title = requiredPositional(args, 2, "delegated task title"); const actorAgentId = valueAfter(args, "--actor");
        if (!actorAgentId) throw new Error("delegate requires --actor <supervisor-id>");
        const reviewCaps = valuesAfter(args, "--review-cap");
        const delegated = await runtime.orchestrator.delegate(parentTaskId, { title, input: parseJsonOption(args, "--input"), requiredCapabilities: valuesAfter(args, "--cap"), preferredAgentId: valueAfter(args, "--agent"), dependencyIds: valuesAfter(args, "--depends"), review: args.includes("--review") ? { required: true, requiredCapabilities: reviewCaps.length ? reviewCaps : ["review"], independent: !args.includes("--self-review") } : undefined }, actorAgentId);
        console.log(JSON.stringify(await publicRuntimeTask(runtime, delegated), null, 2)); return;
    }
    if (command === "run") {
        const finished = await runtime.orchestrator.runUntilIdle();
        const refs = await taskRefs(runtime);
        console.log(JSON.stringify(finished.map((task) => publicTaskView(task, refs)), null, 2)); return;
    }
    if (command === "retry") { console.log(JSON.stringify(await publicRuntimeTask(runtime, await runtime.orchestrator.retry(requiredPositional(args, 1, "retry task id"))), null, 2)); return; }
    if (command === "cancel") { const taskId = requiredPositional(args, 1, "cancel task id"); console.log(JSON.stringify(await publicRuntimeTask(runtime, await runtime.orchestrator.cancel(taskId, { reason: valueAfter(args, "--reason"), cascade: !args.includes("--no-cascade") })), null, 2)); return; }
    if (command === "progress") {
        const taskId = requiredPositional(args, 1, "progress task id"); const actorAgentId = valueAfter(args, "--actor"); const eventId = valueAfter(args, "--event");
        if (!actorAgentId || !eventId) throw new Error("progress requires --actor <worker-id> and --event <id>");
        const percentText = valueAfter(args, "--percent");
        const progress = await runtime.orchestrator.reportProgress(taskId, { eventId, percent: percentText === undefined ? undefined : Number(percentText), message: valueAfter(args, "--message"), data: parseJsonOption(args, "--data") }, actorAgentId);
        console.log(JSON.stringify(await publicRuntimeProgress(runtime, progress), null, 2)); return;
    }
    if (command === "review") {
        const taskId = requiredPositional(args, 1, "review task id"); const decision = requiredPositional(args, 2, "review decision"); const reviewerAgentId = valueAfter(args, "--reviewer"); const eventId = valueAfter(args, "--event");
        if (!reviewerAgentId || !eventId) throw new Error("review requires --reviewer <agent-id> and --event <id>");
        console.log(JSON.stringify(await publicRuntimeTask(runtime, await runtime.orchestrator.reviewTask(taskId, { decision, eventId, notes: valueAfter(args, "--notes") }, reviewerAgentId)), null, 2)); return;
    }
    if (command === "aggregate") { const planId = requiredPositional(args, 1, "plan id"); const actorAgentId = valueAfter(args, "--actor"); if (!actorAgentId) throw new Error("aggregate requires --actor <supervisor-id>"); console.log(JSON.stringify(await publicRuntimeTask(runtime, await runtime.orchestrator.aggregatePlan(planId, actorAgentId)), null, 2)); return; }
    if (command === "graph") { console.log(JSON.stringify(publicTaskGraphView(await runtime.orchestrator.getTaskGraph(requiredPositional(args, 1, "graph task id"))), null, 2)); return; }
    if (command === "events") { const events=await runtime.orchestrator.listTaskEvents(requiredPositional(args, 1, "events task id")); const tasks=await runtime.orchestrator.listTasks(); console.log(JSON.stringify(publicRuntimeRecords(events,tasks), null, 2)); return; }
    if (command === "status") { console.log(JSON.stringify(publicTaskListView(await runtime.orchestrator.listTasks()), null, 2)); return; }
    if (command === "audit" && args[1] === "verify") { console.log(JSON.stringify(await runtime.audit.verify(), null, 2)); return; }

    help(); process.exitCode = 1;
}

main().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
