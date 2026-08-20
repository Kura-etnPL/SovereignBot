import { spawn } from "node:child_process";
import { constants, accessSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

function executableExists(path) {
    try {
        accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}

function findOnPath(name) {
    const pathValue = process.env.PATH ?? "";
    const separator = process.platform === "win32" ? ";" : ":";
    for (const entry of pathValue.split(separator).filter(Boolean)) {
        const candidate = join(entry.replace(/^"|"$/g, ""), name);
        if (executableExists(candidate))
            return candidate;
    }
    return undefined;
}

export function resolveClaudeCodeLaunch(config = {}) {
    const configured = config.command ?? process.env.SOVEREIGNBOT_CLAUDE_BIN;
    if (configured) {
        if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(configured)) {
            throw new Error(
                "Claude Code harness will not execute .cmd/.bat through a shell. Point harness.command or SOVEREIGNBOT_CLAUDE_BIN at the native claude.exe binary.",
            );
        }
        return { command: configured, prefixArgs: config.prefixArgs ?? [], source: "configured" };
    }

    if (process.platform === "win32") {
        const pathBinary = findOnPath("claude.exe");
        if (pathBinary)
            return { command: pathBinary, prefixArgs: [], source: "path" };
        const native = join(process.env.USERPROFILE ?? homedir(), ".local", "bin", "claude.exe");
        if (executableExists(native))
            return { command: native, prefixArgs: [], source: "native-install" };
    }
    else {
        const pathBinary = findOnPath("claude");
        if (pathBinary)
            return { command: pathBinary, prefixArgs: [], source: "path" };
        const native = join(homedir(), ".local", "bin", "claude");
        if (executableExists(native))
            return { command: native, prefixArgs: [], source: "native-install" };
    }

    throw new Error(
        "Claude Code CLI was not found. Install/sign in to Claude Code, add the native binary to PATH, or set harness.command / SOVEREIGNBOT_CLAUDE_BIN.",
    );
}

function taskInput(task) {
    const parts = [task.title.trim()];
    if (task.input !== undefined) {
        parts.push(
            typeof task.input === "string"
                ? task.input
                : `Task input (JSON):\n${JSON.stringify(task.input, null, 2)}`,
        );
    }
    if (task.review?.latest?.decision === "changes_requested" && task.review.latest.notes) {
        parts.push(`Review feedback to address in this retry:\n${task.review.latest.notes}`);
    }
    return parts.join("\n\n");
}

function classifyFailure({ spawnError, stderr, code, signal, timedOut, cancelled, resultError }) {
    if (cancelled)
        return "Claude Code execution cancelled";
    if (timedOut)
        return "Claude Code execution timed out";
    if (spawnError?.code === "ENOENT") {
        return "Claude Code CLI executable was not found. Install Claude Code or configure harness.command.";
    }
    const detail = `${spawnError?.message ?? ""}\n${stderr}\n${resultError ?? ""}`.trim();
    if (/not logged in|sign.?in|authentication|unauthori[sz]ed|authentication_failed|oauth_org_not_allowed|\b401\b|token.*expired/i.test(detail)) {
        return "Claude Code authentication is unavailable. Run `claude` and sign in, then retry the task.";
    }
    if (resultError)
        return resultError;
    if (spawnError)
        return `Claude Code failed to start: ${spawnError.message}`;
    const exit = signal ? `signal ${signal}` : `code ${code ?? 1}`;
    const safeDetail = stderr.trim().slice(-4000);
    return safeDetail ? `Claude Code exited with ${exit}: ${safeDetail}` : `Claude Code exited with ${exit}`;
}

function progressFromEvent(event) {
    if (event.type === "system" && event.subtype === "task_progress") {
        return {
            eventId: event.uuid,
            message: event.summary ?? event.description ?? "Claude Code background task progress",
            data: {
                source: "claude-code",
                subtype: event.subtype,
                taskId: event.task_id,
                lastToolName: event.last_tool_name,
                usage: event.usage,
            },
        };
    }
    if (event.type === "system" && event.subtype === "api_retry") {
        return {
            eventId: event.uuid,
            message: `Claude Code API retry ${event.attempt}/${event.max_retries}`,
            data: {
                source: "claude-code",
                subtype: event.subtype,
                attempt: event.attempt,
                maxRetries: event.max_retries,
                retryDelayMs: event.retry_delay_ms,
                error: event.error,
                errorStatus: event.error_status,
            },
        };
    }
    return undefined;
}

export class ClaudeCodeHarness {
    config;

    constructor(config = {}) {
        this.config = config;
    }

    async run(context) {
        let launch;
        try {
            launch = resolveClaudeCodeLaunch(this.config);
        }
        catch (error) {
            return { ok: false, error: error.message };
        }

        const existingSessionId = context.task.harnessState?.sessionId;
        const args = [
            ...launch.prefixArgs,
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
        ];
        if (this.config.model)
            args.push("--model", this.config.model);
        if (this.config.permissionMode)
            args.push("--permission-mode", this.config.permissionMode);
        if (this.config.maxTurns !== undefined)
            args.push("--max-turns", String(this.config.maxTurns));
        if (this.config.noChrome)
            args.push("--no-chrome");

        if (context.toolBridge?.claudeConfigPath)
            args.push("--mcp-config", context.toolBridge.claudeConfigPath);

        const allowedTools = new Set([
            ...(Array.isArray(this.config.allowedTools) ? this.config.allowedTools : []),
            ...(context.toolBridge?.claudeToolNames ?? []),
        ]);
        if (allowedTools.size)
            args.push("--allowedTools", [...allowedTools].join(","));
        if (Array.isArray(this.config.disallowedTools) && this.config.disallowedTools.length)
            args.push("--disallowedTools", this.config.disallowedTools.join(","));
        if (existingSessionId)
            args.push("--resume", existingSessionId);

        // Claude Code officially supports piped context plus a small print-mode query. Keeping the
        // task body on stdin avoids platform command-line length limits for long delegated work.
        args.push(this.config.query ?? "Execute the task instructions supplied on stdin. Return the completed work result.");

        const controller = new AbortController();
        let cancelled = context.signal.aborted;
        const onAbort = () => {
            cancelled = true;
            controller.abort();
        };
        context.signal.addEventListener("abort", onAbort, { once: true });
        if (context.signal.aborted)
            controller.abort();

        let timedOut = false;
        const timeoutMs = this.config.timeoutMs ?? 60 * 60_000;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        let child;
        try {
            child = spawn(launch.command, args, {
                shell: false,
                cwd: this.config.cwd,
                env: this.config.inheritEnv === false
                    ? { ...this.config.env }
                    : { ...process.env, ...this.config.env },
                stdio: ["pipe", "pipe", "pipe"],
                signal: controller.signal,
            });
        }
        catch (error) {
            clearTimeout(timeout);
            context.signal.removeEventListener("abort", onAbort);
            return {
                ok: false,
                error: classifyFailure({ spawnError: error, stderr: "", timedOut, cancelled }),
            };
        }

        let stderr = "";
        let spawnError;
        let sessionId = existingSessionId;
        let resultEvent;
        let eventCount = 0;
        let progressCount = 0;

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", (error) => (spawnError = error));
        const exitPromise = new Promise((resolve) => {
            child.once("close", (code, signal) => resolve({ code, signal }));
        });

        try {
            child.stdin.end(taskInput(context.task));
            const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
            for await (const line of lines) {
                if (!line.trim())
                    continue;
                let event;
                try {
                    event = JSON.parse(line);
                }
                catch (error) {
                    throw new Error(`invalid Claude Code stream-json event: ${line.slice(0, 500)}`, { cause: error });
                }
                eventCount += 1;

                if (event.type === "system" && event.subtype === "init" && event.session_id) {
                    sessionId = event.session_id;
                    if (context.updateHarnessState)
                        await context.updateHarnessState({ kind: "claude-code", sessionId });
                }

                const progress = progressFromEvent(event);
                if (progress && context.reportProgress) {
                    await context.reportProgress(progress);
                    progressCount += 1;
                }

                if (event.type === "result") {
                    resultEvent = event;
                    if (!sessionId && event.session_id) {
                        sessionId = event.session_id;
                        if (context.updateHarnessState)
                            await context.updateHarnessState({ kind: "claude-code", sessionId });
                    }
                }
            }

            const { code, signal } = await exitPromise;
            const resultError = resultEvent && resultEvent.subtype !== "success"
                ? (resultEvent.errors ?? []).join("; ") || `Claude Code result ended as ${resultEvent.subtype}`
                : undefined;
            if (spawnError || code !== 0 || signal || resultError) {
                return {
                    ok: false,
                    error: classifyFailure({ spawnError, stderr, code, signal, timedOut, cancelled, resultError }),
                    metadata: {
                        sessionId,
                        eventCount,
                        progressCount,
                        code,
                        signal,
                        launcher: launch.source,
                        resultSubtype: resultEvent?.subtype,
                        governedTools: Boolean(context.toolBridge),
                    },
                };
            }
            if (!resultEvent) {
                return {
                    ok: false,
                    error: "Claude Code completed without a result event.",
                    metadata: { sessionId, eventCount, progressCount, launcher: launch.source, governedTools: Boolean(context.toolBridge) },
                };
            }
            if (!sessionId) {
                return {
                    ok: false,
                    error: "Claude Code completed without a session id; the task cannot be resumed safely.",
                    metadata: { eventCount, progressCount, launcher: launch.source, governedTools: Boolean(context.toolBridge) },
                };
            }

            return {
                ok: true,
                output: {
                    text: resultEvent.result ?? "",
                    sessionId,
                    usage: resultEvent.usage ?? null,
                    numTurns: resultEvent.num_turns,
                    terminalReason: resultEvent.terminal_reason,
                },
                metadata: {
                    sessionId,
                    eventCount,
                    progressCount,
                    launcher: launch.source,
                    resumed: Boolean(existingSessionId),
                    resultSubtype: resultEvent.subtype,
                    governedTools: Boolean(context.toolBridge),
                },
            };
        }
        catch (error) {
            try {
                if (!child.killed)
                    child.kill();
            }
            catch {
            }
            await exitPromise.catch(() => undefined);
            return {
                ok: false,
                error: error.message,
                metadata: { sessionId, eventCount, progressCount, launcher: launch.source, governedTools: Boolean(context.toolBridge) },
            };
        }
        finally {
            clearTimeout(timeout);
            context.signal.removeEventListener("abort", onAbort);
        }
    }
}
