# Claude Code CLI harness

SovereignBot can use an already-installed Claude Code CLI as a governed worker. SovereignBot launches the user's own official `claude` executable; it does not redistribute Claude Code, broker Claude authentication, or require SovereignBot itself to hold an Anthropic API key.

## Prerequisites

1. Install Claude Code using an official Anthropic-supported method.
2. Run `claude` and complete the authentication appropriate for your account/environment.
3. Verify the native executable is available:

```bash
claude --version
```

SovereignBot normally discovers `claude`/`claude.exe` on `PATH`. It also checks Anthropic's native install path (`~/.local/bin/claude`, or `%USERPROFILE%\.local\bin\claude.exe` on Windows).

If needed, set either:

- `harness.command` in the worker configuration; or
- `SOVEREIGNBOT_CLAUDE_BIN` in the environment.

On Windows, SovereignBot refuses to launch `.cmd`/`.bat` shims through a shell. Point it at the native `claude.exe` instead.

## Run a Claude Code worker

```bash
node src/cli.js submit "Inspect this repository and implement one high-value fix" \
  --cap coding \
  --config examples/claude-code-agent.config.json

node src/cli.js run --config examples/claude-code-agent.config.json
```

The adapter uses Claude Code print mode with newline-delimited streaming JSON. The task body is piped on stdin and a small fixed query tells Claude Code to execute those piped instructions. This avoids platform command-line length limits for long delegated tasks.

## Resumable sessions

Claude Code emits a `system/init` message at the start of the stream. Its `session_id` is persisted immediately into the task's `harnessState`, before the full agent loop finishes.

If the process later fails, retry the same task:

```bash
node src/cli.js retry <task-id> --config examples/claude-code-agent.config.json
node src/cli.js run --config examples/claude-code-agent.config.json
```

The next run adds `--resume <session-id>`. SovereignBot pins a resumable session to the same worker identity that created it.

Review feedback from a `changes_requested` stage is included in the piped task instructions on retry, so a resumable Claude Code session can continue from its existing context while seeing the reviewer's latest requested changes.

## Live progress

The streaming interface exposes system progress events. SovereignBot maps supported events into its durable task-progress protocol:

- Claude Code background/subagent `task_progress` events;
- Claude Code API retry events.

The upstream event UUID becomes the SovereignBot idempotency key, so replayed progress events do not duplicate workflow history.

## Result shape

A successful task result stores a compact subset of the Claude Code result event:

```json
{
  "text": "final Claude Code result",
  "sessionId": "...",
  "usage": {},
  "numTurns": 3,
  "terminalReason": "completed"
}
```

Claude Code's `total_cost_usd` field is deliberately not copied into the task result. SovereignBot does not reinterpret upstream cost estimates as billing data, especially when the user's Claude Code access is subscription-backed or otherwise externally managed.

## Configuration

```json
{
  "id": "claude-worker",
  "name": "Claude Code Worker",
  "role": "worker",
  "capabilities": ["coding", "review"],
  "harness": {
    "kind": "claude-code",
    "cwd": ".",
    "timeoutMs": 3600000
  }
}
```

Optional harness fields:

- `command`: explicit native Claude Code executable.
- `prefixArgs`: arguments inserted before Claude Code flags; only valid with an explicit `command`, mainly for wrappers/tests.
- `model`: optional model override passed to Claude Code.
- `cwd`: process working directory.
- `timeoutMs`: hard worker timeout.
- `maxTurns`: positive integer forwarded to Claude Code print mode.
- `permissionMode`: explicit Claude Code permission mode. Omit it to preserve the user's normal Claude Code configuration.
- `allowedTools` / `disallowedTools`: optional tool lists forwarded to Claude Code.
- `noChrome`: disable Claude Code Chrome integration for the session.
- `env`: extra environment variables.
- `inheritEnv`: defaults to true.
- `query`: advanced override for the small query accompanying piped task instructions.

The example configuration does not enable `bypassPermissions` or any equivalent broad bypass. If an operator explicitly chooses a permissive Claude Code configuration, that remains part of the worker's effective trust boundary.

## Governance boundary in v0.2

**SovereignBot currently governs whether the Claude Code harness may launch/resume. It does not yet intercept every Bash, file, MCP, browser, network, or other tool action that Claude Code performs internally.**

Those internal operations remain subject to Claude Code's own settings, permission rules, sandbox availability, hooks, plugins, MCP configuration, and OS account permissions until SovereignBot's governed-computer/MCP layer is implemented.

This adapter therefore does not claim that giving a Claude Code worker broad local permissions becomes safe merely because the harness launch was governed.

## Authentication and distribution boundary

SovereignBot does not embed the Claude Agent SDK for this adapter and does not offer an Anthropic/claude.ai sign-in flow of its own. The operator installs and authenticates the official Claude Code CLI independently, then SovereignBot launches that local executable.

Users and downstream distributors are responsible for complying with Anthropic's current Claude Code terms and authentication requirements. Do not package private credentials, session files, or account tokens into SovereignBot configuration or repositories.

## Failure behavior

The adapter provides explicit failures for:

- native Claude Code executable not found;
- authentication/sign-in unavailable;
- non-zero process exit;
- timeout or cancellation;
- malformed `stream-json` output;
- Claude Code result subtypes that indicate execution failure;
- successful process exit with no result event;
- missing session id, because resumability cannot then be guaranteed.

CI uses a fake Claude Code executable, so project tests never require a live Anthropic account, subscription, API key, or model call.
