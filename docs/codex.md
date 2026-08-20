# Codex CLI harness

SovereignBot can use an already-installed Codex CLI as a governed worker. The adapter talks to the local `codex` executable; it does not require SovereignBot to hold a provider API key or to become the owner of Codex authentication.

## Prerequisites

1. Install a current Codex CLI.
2. Run `codex` once and sign in with the ChatGPT account/plan you want Codex to use.
3. Verify the executable is available:

```bash
codex --version
```

SovereignBot will normally discover the executable from `PATH`. On Windows it also checks the Codex app install location and the common global npm layout without invoking `.cmd` files through a shell.

If auto-discovery is not enough, set either:

- `harness.command` in the worker configuration; or
- `SOVEREIGNBOT_CODEX_BIN` in the environment.

## Run a Codex worker

Start from the included configuration:

```bash
node src/cli.js submit "Inspect this repository and identify one high-value fix" \
  --cap coding \
  --config examples/codex-agent.config.json

node src/cli.js run --config examples/codex-agent.config.json
```

A Codex harness run uses the non-interactive `codex exec --json` interface and sends the task prompt on stdin.

## Resumable sessions

When Codex emits `thread.started`, SovereignBot immediately persists the returned thread/session id into the task's `harnessState` before waiting for the turn to finish.

That means a task can fail after Codex has created its session without losing the continuation point. Retry the same task:

```bash
node src/cli.js retry <task-id> --config examples/codex-agent.config.json
node src/cli.js run --config examples/codex-agent.config.json
```

The next run uses `codex exec ... resume <session-id>` and pins the task to the same SovereignBot worker identity. A captured session is never silently moved to another agent.

The control API exposes the same transition through:

```text
POST /tasks/:id/retry
```

## What is persisted

The local task record may contain:

```json
{
  "harnessState": {
    "kind": "codex",
    "sessionId": "..."
  }
}
```

The audit trail records that harness state changed, but does not copy the session id into the audit payload.

A successful result has the shape:

```json
{
  "text": "final Codex response",
  "sessionId": "...",
  "usage": {}
}
```

Usage is whatever the installed Codex version emits in its `turn.completed` event; SovereignBot does not reinterpret it as billing data.

## Configuration

```json
{
  "id": "codex-worker",
  "name": "Codex Worker",
  "role": "worker",
  "capabilities": ["coding", "review"],
  "harness": {
    "kind": "codex",
    "cwd": ".",
    "timeoutMs": 3600000
  }
}
```

Optional harness fields:

- `command`: explicit Codex executable/path.
- `prefixArgs`: arguments inserted before `exec`; only valid with an explicit `command`. This is useful for test/wrapper launchers such as `node path/to/codex.js`.
- `model`: optional Codex model override.
- `cwd`: working directory passed to Codex.
- `skipGitRepoCheck`: forwards Codex's non-git-repository opt-out.
- `sandbox`: optional Codex sandbox mode.
- `timeoutMs`: hard worker timeout.
- `env`: extra environment variables.
- `inheritEnv`: defaults to true.

SovereignBot deliberately does **not** turn on Codex's dangerous bypass flags or replace the user's Codex sandbox/approval configuration.

## Governance boundary in v0.2

The important limitation is explicit: **v0.2 governs the decision to launch/resume the Codex worker, not every tool call Codex performs inside its own session.**

The Governor can currently allow or deny the harness launch, apply repeat guards, bind it to an agent/task, and audit that decision before process creation. Once the locally authenticated Codex process is running, its internal shell/MCP/computer actions are still governed by Codex's own configuration and sandbox.

Fine-grained SovereignBot interception of browser, file, MCP, network, and computer actions is a later governed-computer milestone. Until then, treat a Codex worker's configured working directory and its inherited Codex permissions as part of your trust boundary.

## Failure behavior

The adapter returns actionable failures for common cases:

- Codex executable not found;
- authentication/sign-in unavailable;
- non-zero process exit;
- timeout or cancellation;
- malformed JSONL output;
- Codex turn failure;
- successful exit without a session id, which SovereignBot refuses because it cannot guarantee resumability.

CI tests use a fake Codex executable, so project CI never needs a real OpenAI account or live model usage.
