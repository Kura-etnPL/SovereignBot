<div align="center">

# SovereignBot

**Local-first AI coworkers with durable memory, supervisor/worker orchestration, governed computer actions, and no mandatory cloud control plane.**

[Architecture](docs/architecture.md) · [Task graph](docs/task-graph.md) · [Codex](docs/codex.md) · [Claude Code](docs/claude-code.md) · [Computer](docs/computer.md) · [WebDriver sidecar](docs/webdriver-sidecar.md) · [Roadmap](docs/roadmap.md) · [Security](SECURITY.md)

</div>

SovereignBot separates **intelligence from authority**. Workers can be local processes or independently authenticated subscription CLIs such as Codex and Claude Code, while SovereignBot owns durable task state, routing, policy, review, memory, computer authority, and audit.

Core principles:

- **local durable state** — no required hosted memory/thread backend;
- **no mandatory metered model API** — the runtime boots without provider credentials;
- **resumable Codex + Claude Code workers** using locally installed CLIs;
- **supervisor → worker DAGs** with explicit ownership, progress, retry, cancellation, and independent review;
- **governed browser/computer actions** with task-bound worker tokens and fail-closed policy;
- **structured W3C WebDriver sidecar** rather than Playwright/CDP/coordinate vision in core;
- **per-worker browser profile/workspace/session identity**;
- **human takeover + separate secret-entry channel**;
- **tamper-evident SHA-256 audit chain**.

> **Status: v0.3.** The sovereign core, resumable Codex/Claude Code harnesses, supervisor-worker protocol, governed-computer core, authenticated computer API, and production Chrome/Edge/Firefox WebDriver sidecar are implemented. Real Chrome E2E runs in CI.

## Quick start

Requires Node.js 22+ and has zero third-party Node runtime dependencies.

```bash
npm run check
npm test
node src/cli.js init
node src/cli.js submit "hello sovereign runtime" --cap demo --input '{"value":42}'
node src/cli.js run
node src/cli.js audit verify
```

`init` creates `.sovereignbot/config.json`. Runtime state under `.sovereignbot/` is ignored by Git.

## Supervisor → worker

A supervisor owns a durable plan but is not automatically allowed to execute worker tasks.

```bash
node src/cli.js plan "Ship feature X" --owner supervisor --config my-agents.json

node src/cli.js delegate <plan-id> "Research" \
  --actor supervisor --cap research --config my-agents.json

node src/cli.js delegate <plan-id> "Implement" \
  --actor supervisor --cap coding --depends <research-task-id> --review \
  --config my-agents.json

node src/cli.js run --config my-agents.json
node src/cli.js graph <plan-id> --config my-agents.json
```

The task graph persists dependencies, worker acceptance/ownership, progress, review history, attempts, results, and cancellation history. Failed dependencies block downstream harness launch.

Reviewable work stops at `awaiting_review`. An independent reviewer can request changes, retry the same resumable worker session, then approve it. See [docs/task-graph.md](docs/task-graph.md).

## Codex worker

Use an independently installed/signed-in Codex CLI; SovereignBot does not require a provider API key.

```bash
codex --version
node src/cli.js submit "Inspect and improve this repository" \
  --cap coding --config examples/codex-agent.config.json
node src/cli.js run --config examples/codex-agent.config.json
```

The adapter persists `thread.started` immediately and resumes failed/review-retry work with the captured session. See [docs/codex.md](docs/codex.md).

## Claude Code worker

Use the independently installed official Claude Code CLI:

```bash
claude --version
node src/cli.js submit "Inspect and improve this repository" \
  --cap coding --config examples/claude-code-agent.config.json
node src/cli.js run --config examples/claude-code-agent.config.json
```

The adapter uses print-mode streaming JSON, persists `system/init.session_id`, resumes sessions, and maps supported progress/retry events into the durable task protocol. See [docs/claude-code.md](docs/claude-code.md).

## Production governed browser

Configure the driver-neutral computer core to use the bundled WebDriver sidecar:

```json
{
  "computer": {
    "allowPrivateHosts": false,
    "driver": {
      "kind": "webdriver-sidecar",
      "browser": "chrome",
      "headless": false
    }
  }
}
```

See [examples/webdriver-sidecar.config.json](examples/webdriver-sidecar.config.json).

The matching WebDriver executable must be independently available. Supported profiles are `chrome`, `edge`, and `firefox`.

The production action path is deliberately layered:

```text
agent bearer token
  -> current running task belongs to this agent
  -> hard safety checks
  -> Governor deny/allow/fail-closed decision
  -> audit decision
  -> private sidecar handle
  -> WebDriver/browser side effect
```

A leaked worker token cannot be paired with an invented task id or another worker's task.

### Structured refs, not raw browser handles

A sidecar snapshot turns raw WebDriver element ids into private random handles. `ComputerGateway` then assigns a server-held `snapshotId` and public refs. Workers receive only safe element metadata.

A new snapshot invalidates old handles. Browser reset/restart rotates the browser session lease, so old elements fail closed.

### Per-worker isolation

Every configured worker has a distinct:

- bearer token;
- browser profile directory;
- workspace;
- sidecar process/browser session;
- snapshot/ref cache.

This is process/profile isolation. Stronger container/VM isolation can wrap the same sidecar contract without changing orchestration.

### Connection-time egress checks

Browser HTTP(S) is forced through the sidecar's local proxy. The proxy resolves DNS for each connection, checks every returned address, then connects to the already-validated concrete IP.

Metadata, link-local, multicast, benchmark/documentation/reserved ranges are always denied. Ordinary private/loopback/ULA networks are denied unless `computer.allowPrivateHosts` is explicitly enabled.

This materially reduces DNS-rebinding/TOCTOU risk, but is not represented as equivalent to an OS network namespace. See [docs/webdriver-sidecar.md](docs/webdriver-sidecar.md).

## Human takeover and secrets

A worker may request human help; subsequent agent computer actions then fail closed. A separate operator token can take/release control and run browser lifecycle operations.

Secrets use a dedicated route. Plaintext is handed directly to `typeSecret`; secret failures use fixed public/audit error messages, and credential-shaped audit fields are redacted before hash persistence.

Bootstrap bearer tokens locally — they are not returned by HTTP:

```bash
node src/cli.js computer token <worker-id> --config <config>
node src/cli.js computer operator-token --config <config>
```

## Computer API

Run the loopback server:

```bash
node src/cli.js serve --config examples/webdriver-sidecar.config.json
```

Worker routes require that worker's bearer token **and** a current running `taskId` owned by that worker:

```text
POST /computers/:agentId/snapshot
POST /computers/:agentId/navigate
POST /computers/:agentId/click
POST /computers/:agentId/type
POST /computers/:agentId/key
POST /computers/:agentId/scroll
POST /computers/:agentId/files/list
POST /computers/:agentId/files/read
POST /computers/:agentId/files/write
POST /computers/:agentId/help
POST /computers/:agentId/secret-request
```

Operator-token routes:

```text
GET  /computers
GET  /computers/:agentId/control
GET  /computers/:agentId/health
POST /computers/:agentId/control/take
POST /computers/:agentId/control/release
POST /computers/:agentId/lifecycle/start
POST /computers/:agentId/lifecycle/stop
POST /computers/:agentId/lifecycle/reset
POST /computers/:agentId/secrets/:requestId/supply
```

Computer lifecycle requests/outcomes are audited. Side-effecting browser actions are never automatically retried after transport loss.

## Important harness boundary

Configuring the governed computer service does **not** silently replace every internal shell/browser tool inside Codex or Claude Code.

To let a model use this browser safely, expose the `/computers/...` capability through a controlled adapter/MCP tool that supplies the worker token and current task id. Giving the model raw WebDriver/CDP access would bypass the authority boundary.

## Other runtime capabilities

### Durable memory

Append-only JSONL memory is scoped as `global`, `agent:<id>`, or `task:<id>`. Final results are saved to task/agent scopes; review candidates remain separate until approved.

### Policy

Policy evaluation is:

**deny rules → allow rules → deny by default**.

Rules can match harness/computer category, operation/intent, agent, target, page host, element metadata, file metadata, key input, and repeat count. Runtime hard denials are non-overridable.

### Workflow history + security audit

- `task-events.jsonl` reconstructs workflow/progress/review history;
- `audit.jsonl` stores security decisions and important transitions in a hash chain.

```bash
node src/cli.js audit verify
```

Editing/removing a historic audit row breaks verification.

## CI

Normal regression coverage runs on:

- Ubuntu + Node 22/24
- Windows + Node 22/24

A separate `browser-e2e` job uses real Chrome + ChromeDriver on Ubuntu 24.04 and verifies:

```text
navigate -> structured snapshot -> type -> secret type -> click -> result -> reset -> stale lease refusal
```

## Project principles

1. **No authority by implication.** Reasoning ability does not grant action permission.
2. **No mandatory hosted brain.** Durable state works locally.
3. **No mandatory provider API.** The core runs without model credentials.
4. **No single-agent assumption.** Planning, work, review, and specialists are first-class.
5. **No shared-context requirement.** Delegation passes explicit state/results.
6. **No silent policy fallback.** Missing/broken policy fails closed.
7. **No unaudited governed action path.** Governed integrations pass through the Governor.
8. **No silent automation downgrade.** A missing production driver fails clearly rather than falling back to coordinate vision.

## Next

The highest-value next layer is the **governed tool bridge**: expose computer/MCP capabilities to Codex/Claude Code workers without handing them raw driver authority, then build the local operator UI over the already-durable task/policy/audit state.

See [docs/roadmap.md](docs/roadmap.md).

## License

MIT.
