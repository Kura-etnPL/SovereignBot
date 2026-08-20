import { spawn } from "node:child_process";
import { constants, accessSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
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

function resolveWindowsNpmLauncher() {
    const shim = findOnPath("codex.cmd");
    if (!shim)
        return undefined;
    const js = join(dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!existsSync(js))
        return undefined;
    return { command: process.execPath, prefixArgs: [js], source: "npm-shim" };
}

export function resolveCodexLaunch(config = {}) {
    const configured = config.command ?? process.env.SOVEREIGNBOT_CODEX_BIN;
    if (configured) {
        if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(configured)) {
            throw new Error(
                "Codex harness will not execute .cmd/.bat through a shell. Point harness.command or SOVEREIGNBOT_CODEX_BIN at codex.exe (or use prefixArgs with Node and codex.js).",
            );
        }
        return { command: configured, prefixArgs: config.prefixArgs ?? [], source: "configured" };
    }

    if (process.platform === "win32") {
        const exe = findOnPath("codex.exe");
        if (exe)
            return { command: exe, prefixArgs: [], source: "path" };

        const appExe = process.env.LOCALAPPDATA
            ? join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe")
            : undefined;
        if (appExe && executableExists(appExe))
            return { command: appExe, prefixArgs: [], source: "codex-app" };

        const npmLauncher = resolveWindowsNpmLauncher();
        if (npmLauncher)
            return npmLauncher;
    }
    else {
        const binary = findOnPath("codex");
        if (binary)
            return { command: binary, prefixArgs: [], source: "path" };
    }

    throw new Error(
        "Codex CLI was not found. Install/sign in to Codex, add it to PATH, or set harness.command / SOVEREIGNBOT_CODEX_BIN.",
    );
}

function taskPrompt(task) {
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

function classifyFailure({ spawnError, stderr, code, signal, timedOut, cancelled }) {
    if (cancelled)
        return "Codex execution cancelled";
    if (timedOut)
        return "Codex execution timed out";
    if (spawnError?.code === "ENOENT") {
        return "Codex CLI executable was not found. Install Codex or configure harness.command.";
    }
    const detail = `${spawnError?.message ?? ""}\n${stderr}`.trim();
    if (/not logged in|sign.?in|authentication|unauthori[sz]ed|\b401\b|token.*expired/i.test(detail)) {
        return "Codex authentication is unavailable. Run `codex` and sign in with ChatGPT, then retry the task.";
    }
    if (spawnError)
        return `Codex failed to start: ${spawnError.message}`;
    const exit = signal ? `signal ${signal}` : `code ${code ?? 1}`;
    const safeDetail = stderr.trim().slice(-4000);
    return safeDetail ? `Codex exited with ${exit}: ${safeDetail}` : `Codex exited with ${exit}`;
}

export class CodexHarness {
    config;
    constructor(config = {}) {
        this.config = config;
    }

    async run(context) {
        let launch;
        try {
            launch = resolveCodexLaunch(this.config);
        }
        catch (error) {
            return { ok: false, error: error.message };
        }

        const existingSessionId = context.task.harnessState?.sessionId;
        const args = [...launch.prefixArgs, "exec", "--json"];
        if (this.config.model)
            args.push("--model", this.config.model);
        if (this.config.cwd)
            args.push("--cd", this.config.cwd);
        if (this.config.skipGitRepoCheck)
            args.push("--skip-git-repo-check");
        if (this.config.sandbox)
            args.push("--sandbox", this.config.sandbox);
        if (existingSessionId)
            args.push("resume", existingSessionId);

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
            return { ok: false, error: classifyFailure({ spawnError: error, stderr: "", cancelled, timedOut }) };
        }

        let stderr = "";
        let spawnError;
        let sessionId = existingSessionId;
        let finalResponse = "";
        let usage = null;
        let eventCount = 0;
        let turnFailure;

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", (error) => (spawnError = error));

        const exitPromise = new Promise((resolve) => {
            child.once("close", (code, signal) => resolve({ code, signal }));
        });

        try {
            child.stdin.end(taskPrompt(context.task));
            const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
            for await (const line of lines) {
                if (!line.trim())
                    continue;
                let event;
                try {
                    event = JSON.parse(line);
                }
                catch (error) {
                    throw new Error(`invalid Codex JSONL event: ${line.slice(0, 500)}`, { cause: error });
                }
                eventCount += 1;
                if (event.type === "thread.started" && event.thread_id) {
                    sessionId = event.thread_id;
                    if (context.updateHarnessState) {
                        await context.updateHarnessState({ kind: "codex", sessionId });
                    }
                }
                else if (event.type === "item.completed" && event.item?.type === "agent_message") {
                    finalResponse = event.item.text ?? "";
                }
                else if (event.type === "turn.completed") {
                    usage = event.usage ?? null;
                }
                else if (event.type === "turn.failed") {
                    turnFailure = event.error?.message ?? "Codex turn failed";
                }
            }

            const { code, signal } = await exitPromise;
            if (spawnError || code !== 0 || signal) {
                return {
                    ok: false,
                    error: classifyFailure({ spawnError, stderr, code, signal, timedOut, cancelled }),
                    metadata: { sessionId, eventCount, code, signal, launcher: launch.source },
                };
            }
            if (turnFailure) {
                return { ok: false, error: turnFailure, metadata: { sessionId, eventCount, launcher: launch.source } };
            }
            if (!sessionId) {
                return {
                    ok: false,
                    error: "Codex completed without emitting thread.started; the session cannot be resumed safely.",
                    metadata: { eventCount, launcher: launch.source },
                };
            }
            return {
                ok: true,
                output: { text: finalResponse, sessionId, usage },
                metadata: { sessionId, eventCount, launcher: launch.source, resumed: Boolean(existingSessionId) },
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
            return { ok: false, error: error.message, metadata: { sessionId, eventCount, launcher: launch.source } };
        }
        finally {
            clearTimeout(timeout);
            context.signal.removeEventListener("abort", onAbort);
        }
    }
}
